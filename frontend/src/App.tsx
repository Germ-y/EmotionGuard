import { useMemo, useRef, useState } from "react";
import { analyzeUtterance, AnalyzeResponse, EventType } from "./lib/api";
import { Jungle } from "./lib/audio/jungle";

type LogEntry = AnalyzeResponse & {
  id: string;
  text: string;
  time: string;
};

const CFG = {
  outputDelay: 1.5,
  meterGain: 400,
  muteMs: 2000,
  raisedSustainMs: 250,
  raisedFlagWindow: 3000,
  warningMessages: [
    "폭언을 하시면 정상적인 상담이 어렵습니다. 폭언을 중단해 주십시오.",
    "고객님, 마음을 가라앉히시고 차분히 말씀해 주셔야 도움을 드릴 수 있습니다.",
    "폭언을 하시면 상담이 어렵습니다. 계속하시면 관계법령에 따라 법적 조치가 가능하고 처벌을 받을 수 있습니다.",
    "더 이상의 상담이 어렵습니다. 통화를 종료하겠습니다.",
  ],
};

const eventLabel: Record<EventType, string> = {
  normal: "정상",
  abuse: "욕설",
  sexual: "성희롱",
  raised: "고성",
  "abuse-raised": "욕설+고성",
};

function now() {
  return new Date().toLocaleTimeString("ko-KR", { hour12: false });
}

function pitchOffsetForLevel(level: number, threshold: number, gender: "male" | "female") {
  if (level < threshold) return 0;
  const over = (level - threshold) / (100 - threshold);
  const curve = gender === "female" ? { base: 0.07, span: 0.1 } : { base: 0.1, span: 0.15 };
  return -(curve.base + curve.span * Math.min(1, over));
}

export default function App() {
  const [active, setActive] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [threshold, setThreshold] = useState(38);
  const [gender, setGender] = useState<"male" | "female">("male");
  const [interimText, setInterimText] = useState("상담을 시작하면 실시간 음성 인식 결과가 표시됩니다.");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [muted, setMuted] = useState(false);
  const [status, setStatus] = useState("대기 중");
  const [error, setError] = useState("");

  const audioRef = useRef<{
    stream?: MediaStream;
    ctx?: AudioContext;
    analyser?: AnalyserNode;
    jungle?: Jungle;
    outGain?: GainNode;
    raf?: number;
    raisedSustainMs: number;
    raisedLatched: boolean;
    lastRaisedTs: number;
    recognition?: SpeechRecognition;
    timer?: number;
  }>({ raisedSustainMs: 0, raisedLatched: false, lastRaisedTs: 0 });

  const counts = useMemo(() => {
    return logs.reduce(
      (acc, log) => {
        acc[log.eventType] += 1;
        return acc;
      },
      { normal: 0, abuse: 0, sexual: 0, raised: 0, "abuse-raised": 0 } as Record<EventType, number>,
    );
  }, [logs]);

  const stage = Math.min(4, counts.abuse + counts.raised + counts["abuse-raised"]);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");

  async function startAudio() {
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false, channelCount: 1 },
    });
    const ctx = new AudioContextCtor();
    if (ctx.state === "suspended") await ctx.resume();

    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);

    const jungle = new Jungle(ctx);
    const delay = ctx.createDelay(2);
    const outGain = ctx.createGain();
    delay.delayTime.value = CFG.outputDelay;
    outGain.gain.value = 1;

    source.connect(jungle.input);
    jungle.output.connect(delay);
    delay.connect(outGain);
    outGain.connect(ctx.destination);

    audioRef.current = { ...audioRef.current, stream, ctx, analyser, jungle, outGain };
    runMeter();
  }

  function runMeter() {
    const state = audioRef.current;
    if (!state.analyser || !state.jungle) return;

    const buffer = new Float32Array(state.analyser.fftSize);
    let lastTs = performance.now();

    const loop = () => {
      const current = audioRef.current;
      if (!current.analyser || !current.jungle) return;

      current.analyser.getFloatTimeDomainData(buffer);
      const rms = Math.sqrt(buffer.reduce((sum, item) => sum + item * item, 0) / buffer.length);
      const nextLevel = Math.min(100, rms * CFG.meterGain);
      setLevel((prev) => prev + (nextLevel - prev) * 0.35);

      const t = performance.now();
      const dt = t - lastTs;
      lastTs = t;

      const offset = pitchOffsetForLevel(nextLevel, threshold, gender);
      current.jungle.setPitchOffset(offset);
      setStatus(offset < 0 ? "고성 완화 중" : muted ? "묵음 처리 중" : "정상 전달");

      if (nextLevel >= threshold) {
        current.raisedSustainMs += dt;
        if (current.raisedSustainMs >= CFG.raisedSustainMs && !current.raisedLatched) {
          current.raisedLatched = true;
          current.lastRaisedTs = Date.now();
          setInterimText("큰 목소리 감지 - 음정을 낮춰 전달합니다.");
        }
      } else if (nextLevel < threshold * 0.8) {
        current.raisedSustainMs = 0;
        current.raisedLatched = false;
      }

      current.raf = requestAnimationFrame(loop);
    };

    state.raf = requestAnimationFrame(loop);
  }

  function muteOutput() {
    const { ctx, outGain } = audioRef.current;
    if (!ctx || !outGain) return;

    const t = ctx.currentTime;
    const gain = outGain.gain;
    gain.cancelScheduledValues(t);
    gain.setValueAtTime(gain.value, t);
    gain.linearRampToValueAtTime(0.0001, t + 0.04);
    gain.setValueAtTime(0.0001, t + CFG.muteMs / 1000);
    gain.linearRampToValueAtTime(1, t + CFG.muteMs / 1000 + 0.06);
    setMuted(true);
    window.setTimeout(() => setMuted(false), CFG.muteMs);
  }

  function speak(text: string) {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "ko-KR";
    utterance.pitch = 1.15;
    utterance.rate = 0.92;
    window.speechSynthesis.speak(utterance);
  }

  async function processText(text: string) {
    const clean = text.trim();
    if (!clean) return;

    const raised = Date.now() - audioRef.current.lastRaisedTs < CFG.raisedFlagWindow;
    try {
      const result = await analyzeUtterance(clean, raised);
      const entry: LogEntry = { ...result, id: crypto.randomUUID(), text: clean, time: now() };
      setLogs((prev) => [entry, ...prev].slice(0, 100));

      if (result.abusive || result.sexual) muteOutput();
      if (result.eventType !== "normal") setInterimText(`${eventLabel[result.eventType]} 감지 - ${result.maskedText}`);

      if (result.sexual) {
        speak("방금 발언은 성희롱에 해당될 수 있습니다. 말씀을 가려서 해 주십시오.");
      } else if (result.abusive || raised) {
        speak(CFG.warningMessages[Math.min(stage, CFG.warningMessages.length - 1)]);
      }
    } catch {
      setError("분석 서버 연결에 실패했습니다. backend 서버가 실행 중인지 확인해주세요.");
    }
  }

  function startRecognition() {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
      setError("이 브라우저는 Web Speech API를 지원하지 않습니다. Chrome 또는 Edge를 권장합니다.");
      return;
    }

    const recognition = new Recognition();
    recognition.lang = "ko-KR";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.onresult = (event) => {
      let interim = "";
      let final = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) final += transcript;
        else interim += transcript;
      }
      if (interim) setInterimText(interim);
      if (final) void processText(final);
    };
    recognition.onend = () => {
      if (audioRef.current.recognition) recognition.start();
    };
    recognition.onerror = (event) => setError(`음성 인식 오류: ${event.error}`);
    recognition.start();
    audioRef.current.recognition = recognition;
  }

  async function startSession() {
    setError("");
    setLogs([]);
    setElapsed(0);
    setInterimText("상담을 듣고 있습니다.");
    setActive(true);

    try {
      await startAudio();
      startRecognition();
      speak("안녕하세요. 원활한 상담을 위해 통화 내용이 녹음됩니다.");
      audioRef.current.timer = window.setInterval(() => setElapsed((prev) => prev + 1), 1000);
    } catch {
      setActive(false);
      setError("마이크 권한이 필요합니다.");
    }
  }

  function stopSession() {
    const state = audioRef.current;
    state.recognition?.stop();
    state.stream?.getTracks().forEach((track) => track.stop());
    if (state.raf) cancelAnimationFrame(state.raf);
    if (state.timer) clearInterval(state.timer);
    void state.ctx?.close();
    window.speechSynthesis.cancel();
    audioRef.current = { raisedSustainMs: 0, raisedLatched: false, lastRaisedTs: 0 };
    setActive(false);
    setLevel(0);
    setMuted(false);
    setStatus("대기 중");
    setInterimText("상담이 종료되었습니다.");
  }

  return (
    <main className="app">
      <header className="topbar">
        <div>
          <strong className="brand"><span>Emotion</span>Guard</strong>
          <p>감정노동자 보호를 위한 실시간 AI 음성 보호 솔루션</p>
        </div>
        <button className={active ? "danger" : "primary"} onClick={active ? stopSession : startSession}>
          {active ? "상담 종료" : "상담 시작"}
        </button>
      </header>

      <section className="stage">
        {[1, 2, 3, 4].map((item) => (
          <span key={item} className={stage >= item ? "on" : ""}>{item}단계</span>
        ))}
      </section>

      {error && <div className="banner">{error}</div>}

      <section className="grid">
        <div className="panel main">
          <div className="timer">{mm}:{ss}</div>
          <div className="stt">{interimText}</div>
          <div className="meter">
            <label>음량</label>
            <div className="track">
              <div className="fill" style={{ width: `${level}%` }} />
              <i style={{ left: `${threshold}%` }} />
            </div>
            <strong>{Math.round(level)}</strong>
          </div>
          <div className="controls">
            <label>
              고성 기준
              <input type="range" min={20} max={80} value={threshold} onChange={(event) => setThreshold(Number(event.target.value))} />
            </label>
            <div className="segmented">
              <button className={gender === "male" ? "selected" : ""} onClick={() => setGender("male")}>남성</button>
              <button className={gender === "female" ? "selected" : ""} onClick={() => setGender("female")}>여성</button>
            </div>
            <span className={muted ? "pill mute" : "pill"}>{muted ? "묵음 처리 중" : status}</span>
          </div>
        </div>

        <aside className="panel">
          <h2>감지 현황</h2>
          <dl className="stats">
            <div><dt>욕설</dt><dd>{counts.abuse}</dd></div>
            <div><dt>욕설+고성</dt><dd>{counts["abuse-raised"]}</dd></div>
            <div><dt>고성</dt><dd>{counts.raised}</dd></div>
            <div><dt>성희롱</dt><dd>{counts.sexual}</dd></div>
          </dl>
          <h2>실시간 로그</h2>
          <div className="logs">
            {logs.length === 0 && <p className="empty">아직 감지된 로그가 없습니다.</p>}
            {logs.map((log) => (
              <article key={log.id} className={`log ${log.eventType}`}>
                <small>{log.time} · {eventLabel[log.eventType]} · {log.source}</small>
                <p>{log.maskedText}</p>
              </article>
            ))}
          </div>
        </aside>
      </section>
    </main>
  );
}
