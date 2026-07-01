import { useMemo, useRef, useState } from "react";
import { AnalysisMode, analyzeUtterance, AnalyzeResponse, EventType } from "./lib/api";
import { Jungle } from "./lib/audio/jungle";

type LogEntry = AnalyzeResponse & {
  id: string;
  text: string;
  time: string;
};

const CFG = {
  audioFrameMs: 20,
  contextWindowMs: 3000,
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
  sexualMessages: [
    "방금 발언은 성희롱에 해당될 수 있습니다. 말씀을 가려서 해 주십시오.",
    "성적 발언이 반복되고 있습니다. 즉시 중단하지 않으시면 관계 법령에 따라 법적 조치가 가능합니다.",
  ],
};

const eventLabel: Record<EventType, string> = {
  normal: "정상",
  abuse: "욕설",
  sexual: "성희롱",
  raised: "고성",
  "abuse-raised": "욕설+고성",
};

const pathLabel: Record<AnalysisMode, string> = {
  immediate: "즉시 보호",
  context_snapshot: "3초 문맥",
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

function initialCounts() {
  return { normal: 0, abuse: 0, sexual: 0, raised: 0, "abuse-raised": 0 } as Record<EventType, number>;
}

export default function App() {
  const [active, setActive] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [threshold, setThreshold] = useState(38);
  const [gender, setGender] = useState<"male" | "female">("male");
  const [interimText, setInterimText] = useState("상담을 시작하면 실시간 STT 인터림과 보호 상태가 표시됩니다.");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [muted, setMuted] = useState(false);
  const [status, setStatus] = useState("대기 중");
  const [contextStatus, setContextStatus] = useState("3초 문맥 스냅샷 대기");
  const [error, setError] = useState("");

  const countersRef = useRef(initialCounts());
  const contextBufferRef = useRef<string[]>([]);
  const seenEventRef = useRef(new Set<string>());
  const announcingRef = useRef(false);

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
    contextTimer?: number;
  }>({ raisedSustainMs: 0, raisedLatched: false, lastRaisedTs: 0 });

  const counts = useMemo(() => {
    return logs.reduce((acc, log) => {
      acc[log.eventType] += 1;
      return acc;
    }, initialCounts());
  }, [logs]);

  const abuseStage = Math.min(4, counts.abuse + counts.raised + counts["abuse-raised"]);
  const sexualStage = Math.min(2, counts.sexual);
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
    const outputCursorDelay = ctx.createDelay(2);
    const outGain = ctx.createGain();
    outputCursorDelay.delayTime.value = CFG.outputDelay;
    outGain.gain.value = 1;

    source.connect(jungle.input);
    jungle.output.connect(outputCursorDelay);
    outputCursorDelay.connect(outGain);
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
      setStatus(offset < 0 ? "고성 구간 피치/볼륨 완화" : muted ? "욕설 구간 묵음 처리" : "보호된 상담사 청취 출력");

      if (!announcingRef.current && nextLevel >= threshold) {
        current.raisedSustainMs += dt;
        if (current.raisedSustainMs >= CFG.raisedSustainMs && !current.raisedLatched) {
          current.raisedLatched = true;
          current.lastRaisedTs = Date.now();
          setInterimText("RMS 고성 분석 감지 - 출력 커서에서 음정을 낮춰 전달합니다.");
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
    announcingRef.current = true;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "ko-KR";
    utterance.pitch = 1.15;
    utterance.rate = 0.92;
    utterance.onend = utterance.onerror = () => {
      announcingRef.current = false;
    };
    window.speechSynthesis.speak(utterance);
  }

  function appendLog(result: AnalyzeResponse, text: string) {
    const fingerprint = `${result.eventType}:${result.maskedText}`;
    if (seenEventRef.current.has(fingerprint)) return false;
    seenEventRef.current.add(fingerprint);

    countersRef.current[result.eventType] += 1;
    const entry: LogEntry = { ...result, id: crypto.randomUUID(), text, time: now() };
    setLogs((prev) => [entry, ...prev].slice(0, 100));
    return true;
  }

  function applyPolicy(result: AnalyzeResponse, text: string) {
    const shouldLog =
      result.eventType !== "normal" ||
      result.emotion === "angry" ||
      result.emotion === "threatening" ||
      result.policyActions.includes("report");

    if (shouldLog && !appendLog(result, text)) return;

    if (result.detectionPath === "immediate") {
      if (result.policyActions.includes("mute")) muteOutput();
      if (result.eventType !== "normal") setInterimText(`${eventLabel[result.eventType]} 감지 - ${result.maskedText}`);
    } else if (result.eventType !== "normal") {
      setContextStatus(`Claude 문맥 판단: ${eventLabel[result.eventType]} / ${result.emotion}`);
    } else {
      setContextStatus("Claude 문맥 판단: 특이 위험 없음");
    }

    if (!result.policyActions.includes("warn_tts")) return;

    if (result.eventType === "sexual") {
      const next = Math.min(2, countersRef.current.sexual);
      speak(CFG.sexualMessages[Math.max(0, next - 1)]);
      return;
    }

    if (result.eventType !== "normal") {
      const next = Math.min(4, countersRef.current.abuse + countersRef.current.raised + countersRef.current["abuse-raised"]);
      speak(CFG.warningMessages[Math.max(0, next - 1)]);
    }
  }

  async function processText(text: string, analysisMode: AnalysisMode) {
    const clean = text.trim();
    if (!clean) return;

    const raised = analysisMode === "immediate" && Date.now() - audioRef.current.lastRaisedTs < CFG.raisedFlagWindow;
    try {
      const result = await analyzeUtterance(clean, raised, analysisMode, CFG.contextWindowMs);
      applyPolicy(result, clean);
    } catch {
      setError("분석 서버 연결에 실패했습니다. backend 서버가 실행 중인지 확인해주세요.");
    }
  }

  function pushContext(text: string) {
    contextBufferRef.current.push(text);
    contextBufferRef.current = contextBufferRef.current.slice(-8);
  }

  async function runContextSnapshot() {
    if (announcingRef.current) return;
    const snapshot = contextBufferRef.current.join(" ").trim();
    if (!snapshot) {
      setContextStatus("3초 문맥 스냅샷 대기");
      return;
    }
    setContextStatus("3초 문맥 스냅샷 분석 중");
    await processText(snapshot, "context_snapshot");
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
      if (announcingRef.current) return;
      let interim = "";
      let final = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) final += transcript;
        else interim += transcript;
      }
      if (interim) {
        setInterimText(interim);
        pushContext(interim);
      }
      if (final) {
        pushContext(final);
        void processText(final, "immediate");
      }
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
    setContextStatus("3초 문맥 스냅샷 대기");
    countersRef.current = initialCounts();
    contextBufferRef.current = [];
    seenEventRef.current.clear();
    setActive(true);

    try {
      await startAudio();
      startRecognition();
      speak("안녕하세요. 원활한 상담을 위해 통화 내용이 녹음됩니다.");
      audioRef.current.timer = window.setInterval(() => setElapsed((prev) => prev + 1), 1000);
      audioRef.current.contextTimer = window.setInterval(() => {
        void runContextSnapshot();
      }, CFG.contextWindowMs);
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
    if (state.contextTimer) clearInterval(state.contextTimer);
    void state.ctx?.close();
    window.speechSynthesis.cancel();
    audioRef.current = { raisedSustainMs: 0, raisedLatched: false, lastRaisedTs: 0 };
    announcingRef.current = false;
    setActive(false);
    setLevel(0);
    setMuted(false);
    setStatus("대기 중");
    setContextStatus("3초 문맥 스냅샷 대기");
    setInterimText("상담이 종료되었습니다.");
  }

  return (
    <main className="app">
      <header className="topbar">
        <div>
          <strong className="brand"><span>Emotion</span>Guard</strong>
          <p>실시간 오디오 보호 게이트웨이 + 3초 AI 문맥 판단</p>
        </div>
        <button className={active ? "danger" : "primary"} onClick={active ? stopSession : startSession}>
          {active ? "상담 종료" : "상담 시작"}
        </button>
      </header>

      <section className="architecture-strip">
        <span>내담자 음성 입력</span>
        <b>20ms Frame</b>
        <b>Ring Buffer</b>
        <b>Streaming Audio Guard</b>
        <b>Policy Engine</b>
        <span>보호된 상담사 청취 출력</span>
      </section>

      <section className="stage-grid">
        <div>
          <strong>폭언/고성 4단계</strong>
          <div className="stage">
            {[1, 2, 3, 4].map((item) => (
              <span key={item} className={abuseStage >= item ? "on" : ""}>{item}단계</span>
            ))}
          </div>
        </div>
        <div>
          <strong>성희롱 2단계</strong>
          <div className="stage two">
            {[1, 2].map((item) => (
              <span key={item} className={sexualStage >= item ? "on sexual" : ""}>{item}단계</span>
            ))}
          </div>
        </div>
      </section>

      {error && <div className="banner">{error}</div>}

      <section className="grid">
        <div className="panel main">
          <div className="timer">{mm}:{ss}</div>
          <div className="stt">{interimText}</div>
          <div className="meter">
            <label>RMS</label>
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
          <div className="pipeline">
            <div><strong>즉시 감지 경로</strong><span>RMS · STT 인터림 · 로컬 사전 · 즉시 마스크</span></div>
            <div><strong>AI 문맥 경로</strong><span>{contextStatus}</span></div>
            <div><strong>출력 커서</strong><span>{CFG.outputDelay}s 지연 후 보호 마스크 적용</span></div>
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
                <small>{log.time} · {eventLabel[log.eventType]} · {pathLabel[log.detectionPath]} · {log.source}</small>
                <p>{log.maskedText}</p>
              </article>
            ))}
          </div>
        </aside>
      </section>
    </main>
  );
}
