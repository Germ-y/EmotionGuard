import { useEffect, useMemo, useRef, useState } from "react";
import { AnalysisMode, analyzeUtterance, AnalyzeResponse, AudioFeatures, EventType, PolicyAction } from "./lib/api";
import { Jungle } from "./lib/audio/jungle";

type LogEntry = AnalyzeResponse & {
  id: string;
  text: string;
  time: string;
  timestamp: string;
};

type SpeechTiming = {
  startedAtMs: number;
  resultAtMs: number;
};

type DemoPhase = "idle" | "input" | "detect" | "mask" | "context" | "policy";

type DemoDialogueLine = {
  id: string;
  role: "상담사" | "고객" | "시스템";
  text: string;
  tone?: "normal" | "risk" | "system";
  timestamp: string;
};

type ConversationEntry = {
  id: string;
  timestamp: string;
  role: string;
  text: string;
  detail: string;
  tone: "normal" | "risk" | "system";
  eventType?: EventType;
  original?: string;
};

type LatestDetectionView = {
  id: string;
  timestamp: string;
  title: string;
  detail: string;
  eventType: EventType;
  original: string;
};

type EscalationState = {
  abuse: number;
  sexual: number;
};

type IncidentReport = {
  id: string;
  generatedAt: string;
  startedAt: string;
  duration: string;
  reason: string;
  summary: string;
  recommendation: string;
  counts: Record<EventType, number>;
  escalation: EscalationState;
  actions: string[];
  evidence: LogEntry[];
};

const CFG = {
  audioFrameMs: 20,
  contextWindowMs: 3000,
  outputDelay: 1.0,
  meterGain: 400,
  beepMinMs: 420,
  beepCharMs: 95,
  beepMaxMs: 1100,
  beepDedupeMs: 2200,
  beepFrequency: 880,
  beepVolume: 0.18,
  beepPreRollMs: 120,
  beepPostRollMs: 140,
  stageDedupeMs: 5000,
  raisedSustainMs: 250,
  raisedFlagWindow: 3000,
  voiceLevelThreshold: 1.2,
  voicePeakThreshold: 0.006,
  voiceHoldMs: 520,
  interimDebounceMs: 90,
  recognitionRestartMs: 220,
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

const actionLabel: Record<PolicyAction, string> = {
  mute: "삐 처리",
  pitch_shift: "피치 완화",
  volume_reduce: "볼륨 완화",
  warn_tts: "경고 기록",
  escalate: "단계 상승",
  report: "보고서",
};

const sourceLabel: Record<AnalyzeResponse["source"], string> = {
  local: "로컬 사전",
  openai: "GPT API",
  claude: "Claude API",
  fallback: "기본 문맥 엔진",
};

const REPORT_ARCHIVE_KEY = "emotionguard.reports.v1";
const REPORT_ARCHIVE_LIMIT = 80;
const MONITOR_GAIN = 0.72;

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

const demoProcessSteps: Array<{ id: DemoPhase; label: string; detail: string }> = [
  { id: "input", label: "음성 입력", detail: "20ms Frame" },
  { id: "detect", label: "빠른 감지", detail: "RMS/STT/로컬 사전" },
  { id: "mask", label: "보호 마스크", detail: "비프음/피치/볼륨" },
  { id: "context", label: "3초 맥락", detail: "GPT/Claude/로컬 문맥" },
  { id: "policy", label: "정책 엔진", detail: "단계/경고/보고서" },
];

function now() {
  return new Date().toLocaleTimeString("ko-KR", { hour12: false });
}

function formatDateTime(date: Date) {
  return date.toLocaleString("ko-KR", { hour12: false });
}

function formatDuration(totalSeconds: number) {
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function formatSessionTimestamp(startedAt: Date | null, fallbackSeconds: number) {
  if (!startedAt) return formatDuration(fallbackSeconds);
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt.getTime()) / 1000));
  return formatDuration(seconds);
}

function pitchOffsetForLevel(level: number, threshold: number, gender: "male" | "female") {
  if (level < threshold) return 0;
  const over = (level - threshold) / (100 - threshold);
  const curve = gender === "female" ? { base: 0.07, span: 0.1 } : { base: 0.1, span: 0.15 };
  return -(curve.base + curve.span * Math.min(1, over));
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function rounded(value: number | undefined, digits = 2) {
  if (value === undefined || Number.isNaN(value)) return undefined;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function countKoreanSyllables(text: string) {
  return (text.match(/[가-힣]/g) ?? []).length;
}

function zeroCrossingRate(samples: Float32Array) {
  let crossings = 0;
  for (let index = 1; index < samples.length; index += 1) {
    if ((samples[index - 1] >= 0 && samples[index] < 0) || (samples[index - 1] < 0 && samples[index] >= 0)) {
      crossings += 1;
    }
  }
  return crossings / Math.max(1, samples.length - 1);
}

function estimatePitch(samples: Float32Array, sampleRate: number) {
  const minLag = Math.floor(sampleRate / 420);
  const maxLag = Math.floor(sampleRate / 70);
  let bestLag = 0;
  let bestScore = 0;
  let mean = 0;

  for (let index = 0; index < samples.length; index += 1) {
    mean += samples[index];
  }
  mean /= samples.length;

  let centeredEnergy = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const centered = samples[index] - mean;
    centeredEnergy += centered * centered;
  }
  const rms = Math.sqrt(centeredEnergy / samples.length);
  if (rms < 0.006) return { pitchHz: undefined, confidence: 0 };

  for (let lag = minLag; lag <= Math.min(maxLag, samples.length - 1); lag += 1) {
    let score = 0;
    let leftEnergy = 0;
    let rightEnergy = 0;
    for (let index = 0; index < samples.length - lag; index += 1) {
      const left = samples[index] - mean;
      const right = samples[index + lag] - mean;
      score += left * right;
      leftEnergy += left * left;
      rightEnergy += right * right;
    }
    const normalized = score / Math.sqrt(Math.max(0.000001, leftEnergy * rightEnergy));
    if (normalized > bestScore) {
      bestScore = normalized;
      bestLag = lag;
    }
  }

  if (!bestLag || bestScore < 0.18) return { pitchHz: undefined, confidence: rounded(bestScore, 2) ?? 0 };
  return { pitchHz: rounded(sampleRate / bestLag, 1), confidence: rounded(Math.min(1, bestScore), 2) ?? 0 };
}

function spectralCentroid(frequencyData: Uint8Array, sampleRate: number) {
  let weighted = 0;
  let total = 0;
  const binHz = sampleRate / 2 / Math.max(1, frequencyData.length);
  for (let index = 0; index < frequencyData.length; index += 1) {
    const magnitude = frequencyData[index];
    weighted += index * binHz * magnitude;
    total += magnitude;
  }
  return total ? rounded(weighted / total, 0) : undefined;
}

function mergeUtteranceFeatures(base: AudioFeatures, text: string, timing?: SpeechTiming): AudioFeatures {
  if (!timing) return base;
  const durationMs = clamp(timing.resultAtMs - timing.startedAtMs, 200, 15000);
  const syllableCount = countKoreanSyllables(text);
  return {
    ...base,
    utteranceDurationMs: rounded(durationMs, 0),
    syllableCount,
    syllablesPerSecond: rounded(syllableCount / Math.max(0.2, durationMs / 1000), 2),
  };
}

function featureValue(value: number | undefined, suffix = "", voiceActivity = true) {
  if (!voiceActivity) return "대기";
  return value === undefined ? "계산중" : `${value}${suffix}`;
}

function findTriggeredSpan(text: string, words: string[]) {
  const lowerText = text.toLowerCase();
  const matches = words
    .map((word) => {
      const index = lowerText.indexOf(word.toLowerCase());
      return index >= 0 ? { word, index, length: word.length } : null;
    })
    .filter((match): match is { word: string; index: number; length: number } => Boolean(match))
    .sort((a, b) => a.index - b.index || b.length - a.length);

  return matches[0];
}

function beepDurationFor(result: AnalyzeResponse) {
  const longest = result.triggeredWords.reduce((max, word) => Math.max(max, word.length), 0);
  return clamp(CFG.beepMinMs + longest * CFG.beepCharMs, CFG.beepMinMs, CFG.beepMaxMs);
}

function initialCounts() {
  return { normal: 0, abuse: 0, sexual: 0, raised: 0, "abuse-raised": 0 } as Record<EventType, number>;
}

function initialEscalation(): EscalationState {
  return { abuse: 0, sexual: 0 };
}

function loadReportArchive(): IncidentReport[] {
  try {
    const raw = window.localStorage.getItem(REPORT_ARCHIVE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is IncidentReport => Boolean(item?.id && item?.generatedAt && item?.summary));
  } catch {
    return [];
  }
}

function persistReportArchive(reports: IncidentReport[]) {
  try {
    window.localStorage.setItem(REPORT_ARCHIVE_KEY, JSON.stringify(reports));
  } catch {
    // 데모 저장소 접근이 막힌 환경에서는 현재 화면 상태만 유지합니다.
  }
}

function reportToText(report: IncidentReport) {
  const evidence = report.evidence.length
    ? report.evidence
        .map((item, index) => `${index + 1}. [${item.timestamp}] ${eventLabel[item.eventType]} / ${pathLabel[item.detectionPath]} / ${item.text}`)
        .join("\n")
    : "감지된 특이 민원 발화 없음";

  return [
    "[EmotionGuard 특이민원 발생 보고서]",
    `보고서 ID: ${report.id}`,
    `상담 시작: ${report.startedAt}`,
    `보고서 생성: ${report.generatedAt}`,
    `상담 시간: ${report.duration}`,
    `생성 사유: ${report.reason}`,
    "",
    `요약: ${report.summary}`,
    `최고 단계: 폭언/고성 ${report.escalation.abuse}단계, 성희롱 ${report.escalation.sexual}단계`,
    `조치: ${report.actions.join(", ") || "특이 조치 없음"}`,
    `권고: ${report.recommendation}`,
    "",
    "[증빙 발화]",
    evidence,
  ].join("\n");
}

function ReportPage({ reports, onNavigateHome }: { reports: IncidentReport[]; onNavigateHome: () => void }) {
  const [copiedId, setCopiedId] = useState("");

  async function copyOne(report: IncidentReport) {
    try {
      await navigator.clipboard.writeText(reportToText(report));
      setCopiedId(report.id);
      window.setTimeout(() => setCopiedId(""), 1600);
    } catch {
      setCopiedId("");
    }
  }

  return (
    <main className="app report-page">
      <header className="topbar">
        <div>
          <strong className="brand"><span>Emotion</span>Guard</strong>
          <p>특이민원 보고서 보관함</p>
        </div>
        <button className="primary" onClick={onNavigateHome}>상담 화면</button>
      </header>

      <section className="report-hero">
        <div>
          <strong>보고서 목록</strong>
          <span>상담 종료 시 생성된 보고서가 최신순으로 누적됩니다.</span>
        </div>
        <b>{reports.length}건</b>
      </section>

      <section className="report-list-page">
        {reports.length === 0 && (
          <article className="report-empty">
            <strong>아직 생성된 보고서가 없습니다.</strong>
            <p>상담 화면에서 상담을 종료하면 정상/특이 여부와 관계없이 보고서가 자동 저장됩니다.</p>
          </article>
        )}
        {reports.map((item) => (
          <article key={item.id} className="report-item">
            <div className="report-item-head">
              <div>
                <strong>{item.id}</strong>
                <span>{item.generatedAt} · {item.reason}</span>
              </div>
              <button onClick={() => void copyOne(item)}>{copiedId === item.id ? "복사 완료" : "보고서 복사"}</button>
            </div>
            <p>{item.summary}</p>
            <dl className="report-grid">
              <div><dt>상담 시간</dt><dd>{item.duration}</dd></div>
              <div><dt>폭언/고성</dt><dd>{item.escalation.abuse}단계</dd></div>
              <div><dt>성희롱</dt><dd>{item.escalation.sexual}단계</dd></div>
              <div><dt>조치</dt><dd>{item.actions.join(", ") || "특이 조치 없음"}</dd></div>
            </dl>
            <strong className="report-subtitle">후속 권고</strong>
            <p>{item.recommendation}</p>
            <strong className="report-subtitle">증빙 발화</strong>
            <div className="report-evidence expanded">
              {item.evidence.length === 0 && <span>감지된 특이 민원 발화 없음</span>}
              {item.evidence.map((evidence) => (
                <article key={evidence.id} data-original={evidence.text}>
                  <small>[{evidence.timestamp}] · {eventLabel[evidence.eventType]} · {pathLabel[evidence.detectionPath]}</small>
                  <p>원문 문장 비공개 기록됨</p>
                </article>
              ))}
            </div>
          </article>
        ))}
      </section>
    </main>
  );
}

export default function App() {
  const [routePath, setRoutePath] = useState(() => window.location.pathname);
  const [active, setActive] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [threshold, setThreshold] = useState(42);
  const [gender, setGender] = useState<"male" | "female">("male");
  const [monitorEnabled, setMonitorEnabled] = useState(false);
  const [, setInterimText] = useState("상담을 시작하면 실시간 STT 인터림과 보호 상태가 표시됩니다.");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [muted, setMuted] = useState(false);
  const [status, setStatus] = useState("대기 중");
  const [demoStep, setDemoStep] = useState("데모 버튼을 누르면 즉시 보호 경로와 3초 문맥 경로가 순서대로 표시됩니다.");
  const [demoDialogue, setDemoDialogue] = useState<DemoDialogueLine[]>([]);
  const [demoPhase, setDemoPhase] = useState<DemoPhase>("idle");
  const [litPhases, setLitPhases] = useState<DemoPhase[]>([]);
  const [escalation, setEscalation] = useState<EscalationState>(() => initialEscalation());
  const [reportArchive, setReportArchive] = useState<IncidentReport[]>(() => loadReportArchive());
  const [audioFeatures, setAudioFeatures] = useState<AudioFeatures>({ rms: 0, rmsPercent: 0, peak: 0, zeroCrossingRate: 0, voiceActivity: false });
  const [latestDetection, setLatestDetection] = useState<LatestDetectionView | null>(null);
  const [error, setError] = useState("");

  const countersRef = useRef(initialCounts());
  const logsRef = useRef<LogEntry[]>([]);
  const reportLogsRef = useRef<LogEntry[]>([]);
  const contextBufferRef = useRef<string[]>([]);
  const escalationRef = useRef<EscalationState>(initialEscalation());
  const seenEventRef = useRef(new Set<string>());
  const seenStageRef = useRef(new Set<string>());
  const lastBeepRef = useRef<{ key: string; at: number } | null>(null);
  const announcingRef = useRef(false);
  const interimCheckRef = useRef<{ timer?: number; lastText: string }>({ lastText: "" });
  const speechStartAtRef = useRef<number | null>(null);
  const sessionStartedAtRef = useRef<Date | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const audioFeaturesRef = useRef<AudioFeatures>({ rms: 0, rmsPercent: 0, peak: 0, zeroCrossingRate: 0, voiceActivity: false });
  const featureUiTsRef = useRef(0);

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
    maskTimer?: number;
    recognitionRestartTimer?: number;
    lastVoiceActivityTs?: number;
  }>({ raisedSustainMs: 0, raisedLatched: false, lastRaisedTs: 0 });

  const counts = useMemo(() => {
    return logs.reduce((acc, log) => {
      acc[log.eventType] += 1;
      return acc;
    }, initialCounts());
  }, [logs]);
  const timelineEntries = useMemo(() => logs.slice().reverse(), [logs]);
  const conversationEntries = useMemo<ConversationEntry[]>(() => {
    const dialogue = demoDialogue.filter((line) => line.role !== "상담사");
    if (dialogue.length > 0) {
      return dialogue.map((line) => {
        const hidden = line.tone === "risk";
        return {
          id: line.id,
          timestamp: line.timestamp,
          role: line.role,
          text: hidden ? "삐 처리된 고객 발화" : line.text,
          detail: hidden ? "원문 비공개 · 보호 오디오 출력" : line.role === "시스템" ? "시스템 보호 조치" : "고객 발화",
          tone: line.tone ?? "normal",
          eventType: hidden ? "abuse" : undefined,
          original: line.text,
        };
      });
    }

    return timelineEntries.map((log) => ({
      id: log.id,
      timestamp: log.timestamp,
      role: "고객",
      text: "삐 처리된 고객 발화",
      detail: `${eventLabel[log.eventType]} · ${pathLabel[log.detectionPath]} · ${log.policyActions.map((action) => actionLabel[action]).join(" · ") || "기록"} · ${sourceLabel[log.source]}`,
      tone: log.eventType === "normal" ? "normal" : "risk",
      eventType: log.eventType,
      original: log.text,
    }));
  }, [demoDialogue, timelineEntries]);

  const abuseStage = escalation.abuse;
  const sexualStage = escalation.sexual;
  const litPhaseSet = useMemo(() => new Set(litPhases), [litPhases]);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");
  const normalizedRoute = routePath.replace(/\/$/, "") || "/";

  function navigate(path: string) {
    window.history.pushState(null, "", path);
    setRoutePath(path);
  }

  function markDemoPhase(phase: DemoPhase) {
    setDemoPhase(phase);
    if (phase === "idle") {
      setLitPhases([]);
      return;
    }
    setLitPhases((prev) => (prev.includes(phase) ? prev : [...prev, phase]));
  }

  function pushDemoDialogue(
    role: DemoDialogueLine["role"],
    text: string,
    tone: DemoDialogueLine["tone"] = "normal",
    timestamp = formatSessionTimestamp(sessionStartedAtRef.current, elapsed),
  ) {
    setDemoDialogue((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role, text, tone, timestamp },
    ].slice(-8));
  }

  useEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline) return;
    timeline.scrollTo({ top: timeline.scrollHeight, behavior: "smooth" });
  }, [logs, demoDialogue]);

  useEffect(() => {
    if (demoPhase === "idle") return;
    const timer = window.setTimeout(() => {
      setDemoPhase("idle");
      setLitPhases([]);
    }, 2600);
    return () => window.clearTimeout(timer);
  }, [demoPhase]);

  useEffect(() => {
    const syncRoute = () => setRoutePath(window.location.pathname);
    window.addEventListener("popstate", syncRoute);
    return () => window.removeEventListener("popstate", syncRoute);
  }, []);

  useEffect(() => {
    const { ctx, outGain } = audioRef.current;
    if (!ctx || !outGain) return;
    outGain.gain.cancelScheduledValues(ctx.currentTime);
    outGain.gain.setTargetAtTime(monitorEnabled ? MONITOR_GAIN : 0, ctx.currentTime, 0.03);
  }, [monitorEnabled]);

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
    const outputCursorDelay = ctx.createDelay(Math.max(3, CFG.outputDelay + 0.4));
    const outGain = ctx.createGain();
    outputCursorDelay.delayTime.value = CFG.outputDelay;
    outGain.gain.value = monitorEnabled ? MONITOR_GAIN : 0;

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
    const frequencyData = new Uint8Array(state.analyser.frequencyBinCount);
    let lastTs = performance.now();

    const loop = () => {
      const current = audioRef.current;
      if (!current.analyser || !current.jungle) return;

      current.analyser.getFloatTimeDomainData(buffer);
      current.analyser.getByteFrequencyData(frequencyData);
      const rms = Math.sqrt(buffer.reduce((sum, item) => sum + item * item, 0) / buffer.length);
      const nextLevel = Math.min(100, rms * CFG.meterGain);
      const t = performance.now();
      const dt = t - lastTs;
      lastTs = t;

      setLevel((prev) => prev + (nextLevel - prev) * 0.35);
      const peak = buffer.reduce((max, item) => Math.max(max, Math.abs(item)), 0);
      const pitch = current.ctx ? estimatePitch(buffer, current.ctx.sampleRate) : { pitchHz: undefined, confidence: 0 };
      const rawVoiceActivity = nextLevel >= CFG.voiceLevelThreshold || peak >= CFG.voicePeakThreshold;
      if (rawVoiceActivity) current.lastVoiceActivityTs = Date.now();
      const voiceActivity = rawVoiceActivity || Date.now() - (current.lastVoiceActivityTs ?? 0) < CFG.voiceHoldMs;
      const offset = pitchOffsetForLevel(nextLevel, threshold, gender);
      const nextFeatures: AudioFeatures = {
        rms: rounded(rms, 4),
        rmsPercent: rounded(nextLevel, 1),
        peak: rounded(peak, 4),
        pitchHz: pitch.pitchHz,
        pitchConfidence: pitch.confidence,
        zeroCrossingRate: rounded(zeroCrossingRate(buffer), 3),
        spectralCentroidHz: current.ctx ? spectralCentroid(frequencyData, current.ctx.sampleRate) : undefined,
        voiceActivity,
      };
      audioFeaturesRef.current = nextFeatures;

      if (t - featureUiTsRef.current > 220) {
        featureUiTsRef.current = t;
        setAudioFeatures(nextFeatures);
        const nextStatus = offset < 0
          ? "고성 구간 피치/볼륨 완화"
          : muted
            ? "욕설 단어 삐 처리"
            : voiceActivity
              ? "음성 입력 감지"
              : "음성 입력 대기 중";
        setStatus((prev) => {
          const keepProcessingStatus = prev.includes("분석") || prev.includes("판단") || prev.includes("보고서") || prev.includes("삐 처리 중");
          return keepProcessingStatus && voiceActivity ? prev : nextStatus;
        });
      }

      current.jungle.setPitchOffset(offset);

      if (!announcingRef.current && nextLevel >= threshold) {
        current.raisedSustainMs += dt;
        if (current.raisedSustainMs >= CFG.raisedSustainMs && !current.raisedLatched) {
          current.raisedLatched = true;
          current.lastRaisedTs = Date.now();
          markDemoPhase("detect");
          markDemoPhase("mask");
          setInterimText("RMS 고성 분석 감지 - 출력 커서에서 음정을 낮춰 전달합니다.");
          setStatus("고성 구간 피치/볼륨 완화");
        }
      } else if (nextLevel < threshold * 0.8) {
        current.raisedSustainMs = 0;
        current.raisedLatched = false;
      }

      current.raf = requestAnimationFrame(loop);
    };

    state.raf = requestAnimationFrame(loop);
  }

  function playBeep(ctx: AudioContext, startAt: number, durationMs: number) {
    const oscillator = ctx.createOscillator();
    const beepGain = ctx.createGain();
    const endAt = startAt + durationMs / 1000;

    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(CFG.beepFrequency, startAt);
    beepGain.gain.setValueAtTime(0.0001, ctx.currentTime);
    beepGain.gain.setValueAtTime(0.0001, startAt);
    beepGain.gain.linearRampToValueAtTime(CFG.beepVolume, startAt + 0.015);
    beepGain.gain.setValueAtTime(CFG.beepVolume, Math.max(startAt + 0.02, endAt - 0.025));
    beepGain.gain.linearRampToValueAtTime(0.0001, endAt);

    oscillator.connect(beepGain);
    beepGain.connect(ctx.destination);
    oscillator.start(startAt);
    oscillator.stop(endAt + 0.05);
    oscillator.onended = () => {
      oscillator.disconnect();
      beepGain.disconnect();
    };
  }

  function estimateBeepStart(result: AnalyzeResponse, text: string, timing: SpeechTiming | undefined, ctx: AudioContext) {
    const span = findTriggeredSpan(text, result.triggeredWords);
    if (!span || !timing) return ctx.currentTime + 0.08;

    const utteranceMs = clamp(timing.resultAtMs - timing.startedAtMs, 450, 5000);
    const ratio = clamp(span.index / Math.max(1, text.length), 0, 0.92);
    const wordInputAtMs = timing.startedAtMs + utteranceMs * ratio - CFG.beepPreRollMs;
    const wordOutputAtMs = wordInputAtMs + CFG.outputDelay * 1000;
    const delaySeconds = Math.max(0.04, (wordOutputAtMs - performance.now()) / 1000);

    return ctx.currentTime + delaySeconds;
  }

  function beepProfanitySegment(result: AnalyzeResponse, text: string, timing?: SpeechTiming) {
    markDemoPhase("mask");
    const beepKey = `${result.eventType}:${result.triggeredWords.join("|") || result.maskedText || text}`;
    const nowMs = Date.now();
    if (lastBeepRef.current?.key === beepKey && nowMs - lastBeepRef.current.at < CFG.beepDedupeMs) return;
    lastBeepRef.current = { key: beepKey, at: nowMs };

    const { ctx, outGain } = audioRef.current;
    const durationMs = beepDurationFor(result) + CFG.beepPreRollMs + CFG.beepPostRollMs;
    if (!ctx || !outGain) {
      const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      setMuted(true);
      if (AudioContextCtor) {
        const beepCtx = new AudioContextCtor();
        const startAt = beepCtx.currentTime + 0.04;
        void beepCtx.resume().then(() => playBeep(beepCtx, startAt, durationMs));
        window.setTimeout(() => void beepCtx.close(), durationMs + 260);
      }
      window.setTimeout(() => setMuted(false), durationMs);
      return;
    }

    const startAt = estimateBeepStart(result, text, timing, ctx);
    const endAt = startAt + durationMs / 1000;
    const gain = outGain.gain;

    gain.cancelScheduledValues(ctx.currentTime);
    gain.setValueAtTime(gain.value, ctx.currentTime);
    gain.setValueAtTime(gain.value, Math.max(ctx.currentTime, startAt - 0.01));
    gain.linearRampToValueAtTime(0.0001, startAt + 0.025);
    gain.setValueAtTime(0.0001, endAt);
    gain.linearRampToValueAtTime(monitorEnabled ? MONITOR_GAIN : 0, endAt + 0.05);
    playBeep(ctx, startAt, durationMs);

    setMuted(true);
    if (audioRef.current.maskTimer) window.clearTimeout(audioRef.current.maskTimer);
    audioRef.current.maskTimer = window.setTimeout(() => setMuted(false), Math.max(0, (endAt - ctx.currentTime) * 1000 + 80));
  }

  function speak(_text: string) {
    announcingRef.current = false;
  }

  function appendLog(result: AnalyzeResponse, text: string) {
    const fingerprint = `${result.eventType}:${result.maskedText}:${Math.floor(Date.now() / 1200)}`;
    if (seenEventRef.current.has(fingerprint)) return false;
    seenEventRef.current.add(fingerprint);

    const entry: LogEntry = {
      ...result,
      id: crypto.randomUUID(),
      text,
      time: now(),
      timestamp: formatSessionTimestamp(sessionStartedAtRef.current, elapsed),
    };

    countersRef.current[result.eventType] += 1;
    reportLogsRef.current = [entry, ...reportLogsRef.current].slice(0, 200);
    logsRef.current = [entry, ...logsRef.current].slice(0, 200);
    setLogs((prev) => [entry, ...prev].slice(0, 200));
    if (entry.eventType !== "normal") {
      setLatestDetection({
        id: entry.id,
        timestamp: entry.timestamp,
        title: `${eventLabel[entry.eventType]} · ${pathLabel[entry.detectionPath]}`,
        detail: `${entry.policyActions.map((action) => actionLabel[action]).join(" · ") || "기록"} · ${sourceLabel[entry.source]}`,
        eventType: entry.eventType,
        original: entry.text,
      });
    }
    return true;
  }

  function resetEscalation() {
    escalationRef.current = initialEscalation();
    setEscalation(initialEscalation());
    seenStageRef.current.clear();
  }

  function setEscalationStage(kind: keyof EscalationState, stage: number) {
    const next = {
      ...escalationRef.current,
      [kind]: kind === "abuse" ? clamp(stage, 0, 4) : clamp(stage, 0, 2),
    };
    escalationRef.current = next;
    setEscalation(next);
  }

  function advanceEscalation(result: AnalyzeResponse, text: string) {
    if (!result.policyActions.includes("escalate") || result.eventType === "normal") return;

    const kind: keyof EscalationState = result.eventType === "sexual" ? "sexual" : "abuse";
    const maxStage = kind === "abuse" ? 4 : 2;
    const timeBucket = Math.floor(Date.now() / CFG.stageDedupeMs);
    const fingerprint = `${kind}:${result.maskedText || text}:${timeBucket}`;
    if (seenStageRef.current.has(fingerprint)) return;
    seenStageRef.current.add(fingerprint);

    setEscalation((prev) => {
      const next = { ...prev, [kind]: Math.min(maxStage, prev[kind] + 1) };
      escalationRef.current = next;
      return next;
    });
  }

  function applyPolicy(result: AnalyzeResponse, text: string, timing?: SpeechTiming) {
    advanceEscalation(result, text);
    if (result.detectionPath === "context_snapshot") markDemoPhase("context");
    if (
      result.policyActions.includes("mute") ||
      result.policyActions.includes("pitch_shift") ||
      result.policyActions.includes("volume_reduce")
    ) {
      markDemoPhase("mask");
    }
    if (
      result.policyActions.includes("warn_tts") ||
      result.policyActions.includes("escalate") ||
      result.policyActions.includes("report")
    ) {
      markDemoPhase("policy");
    }

    const shouldLog =
      result.eventType !== "normal" ||
      result.emotion === "angry" ||
      result.emotion === "threatening" ||
      result.policyActions.includes("report");
    const logged = shouldLog ? appendLog(result, text) : true;

    if (result.detectionPath === "immediate") {
      if (result.policyActions.includes("mute")) beepProfanitySegment(result, text, timing);
      if (result.eventType !== "normal") setInterimText(`${eventLabel[result.eventType]} 감지 - ${result.maskedText}`);
    } else if (result.eventType !== "normal") {
      const engine = result.source === "openai" ? "GPT" : result.source === "claude" ? "Claude" : "문맥 엔진";
      setStatus(`${engine} 판단: ${eventLabel[result.eventType]}`);
    } else {
      const engine = result.source === "openai" ? "GPT" : result.source === "claude" ? "Claude" : "3초 문맥";
      setStatus(`${engine} 판단 완료`);
    }

    if (!logged || !result.policyActions.includes("warn_tts")) return;

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

  function buildIncidentReport(reason: string, escalationSnapshot: EscalationState, durationSeconds: number): IncidentReport {
    const evidence = reportLogsRef.current
      .filter((log) => log.eventType !== "normal" || log.policyActions.includes("report"))
      .slice()
      .reverse();
    const reportCounts = evidence.reduce((acc, item) => {
      acc[item.eventType] += 1;
      return acc;
    }, initialCounts());
    const actions = Array.from(new Set(evidence.flatMap((item) => item.policyActions.map((action) => actionLabel[action]))));
    const generatedAt = new Date();
    const startedAt = sessionStartedAtRef.current ?? new Date(generatedAt.getTime() - durationSeconds * 1000);
    const categories = [
      reportCounts.abuse ? `욕설 ${reportCounts.abuse}건` : "",
      reportCounts["abuse-raised"] ? `욕설+고성 ${reportCounts["abuse-raised"]}건` : "",
      reportCounts.raised ? `고성 ${reportCounts.raised}건` : "",
      reportCounts.sexual ? `성희롱 ${reportCounts.sexual}건` : "",
    ].filter(Boolean);

    const summary = categories.length
      ? `특이 민원 발화 ${evidence.length}건이 감지되었습니다. ${categories.join(", ")}이 기록되었고, 최고 단계는 폭언/고성 ${escalationSnapshot.abuse}단계, 성희롱 ${escalationSnapshot.sexual}단계입니다.`
      : "특이 민원 발화 없이 상담이 종료되었습니다.";

    const recommendation =
      escalationSnapshot.abuse >= 4
        ? "폭언/고성 4단계 도달. 상담 종료 안내 및 관리자 이관을 권고합니다."
        : escalationSnapshot.sexual >= 2
          ? "성희롱 2단계 도달. 증빙 보존 후 관리자 및 담당 부서 이관을 권고합니다."
          : evidence.some((item) => item.policyActions.includes("report"))
            ? "증빙 로그를 보존하고 필요 시 사후 검토를 진행합니다."
            : "추가 조치 없이 상담 기록만 보존합니다.";

    return {
      id: `EG-${generatedAt.getTime().toString(36).toUpperCase()}`,
      generatedAt: formatDateTime(generatedAt),
      startedAt: formatDateTime(startedAt),
      duration: formatDuration(durationSeconds),
      reason,
      summary,
      recommendation,
      counts: reportCounts,
      escalation: escalationSnapshot,
      actions,
      evidence,
    };
  }

  function generateReport(reason: string, escalationSnapshot = escalationRef.current, durationSeconds = elapsed) {
    const nextReport = buildIncidentReport(reason, escalationSnapshot, durationSeconds);
    setReportArchive((prev) => {
      const next = [nextReport, ...prev.filter((item) => item.id !== nextReport.id)].slice(0, REPORT_ARCHIVE_LIMIT);
      persistReportArchive(next);
      return next;
    });
    return nextReport;
  }

  async function processText(text: string, analysisMode: AnalysisMode, timing?: SpeechTiming) {
    const clean = text.trim();
    if (!clean) return;
    markDemoPhase(analysisMode === "immediate" ? "detect" : "context");

    const raised = analysisMode === "immediate" && Date.now() - audioRef.current.lastRaisedTs < CFG.raisedFlagWindow;
    const features = mergeUtteranceFeatures(audioFeaturesRef.current, clean, timing);
    try {
      const result = await analyzeUtterance(clean, raised, analysisMode, CFG.contextWindowMs, features);
      applyPolicy(result, clean, timing);
    } catch {
      setError("분석 서버 연결에 실패했습니다. backend 서버가 실행 중인지 확인해주세요.");
    }
  }

  function queueInterimImmediate(text: string, timing: SpeechTiming) {
    const clean = text.trim();
    if (!clean || announcingRef.current) return;
    if (clean === interimCheckRef.current.lastText) return;

    markDemoPhase("detect");
    if (interimCheckRef.current.timer) window.clearTimeout(interimCheckRef.current.timer);
    setStatus("STT 인터림 분석 중");

    interimCheckRef.current.timer = window.setTimeout(() => {
      interimCheckRef.current.lastText = clean;
      void processText(clean, "immediate", timing);
    }, CFG.interimDebounceMs);
  }

  async function analyzeDemo(text: string, raised: boolean, analysisMode: AnalysisMode) {
    const demoFeatures = mergeUtteranceFeatures(
      {
        rms: raised ? 0.18 : 0.08,
        rmsPercent: raised ? 76 : 34,
        peak: raised ? 0.51 : 0.22,
        pitchHz: raised ? 238 : 174,
        pitchConfidence: 0.72,
        zeroCrossingRate: raised ? 0.14 : 0.08,
        spectralCentroidHz: raised ? 2800 : 1900,
        voiceActivity: true,
      },
      text,
      { startedAtMs: performance.now() - 900, resultAtMs: performance.now() },
    );
    audioFeaturesRef.current = demoFeatures;
    setAudioFeatures(demoFeatures);
    const result = await analyzeUtterance(text, raised, analysisMode, CFG.contextWindowMs, demoFeatures);
    applyPolicy(result, text, { startedAtMs: performance.now() - 900, resultAtMs: performance.now() });
    return result;
  }

  async function runDemo(type: "abuse" | "sexual" | "raised" | "escalation") {
    if (active) stopSession();
    const setDemoClock = (seconds: number) => {
      setElapsed(seconds);
      sessionStartedAtRef.current = new Date(Date.now() - seconds * 1000);
    };
    const say = async (
      role: DemoDialogueLine["role"],
      text: string,
      seconds: number,
      tone: DemoDialogueLine["tone"] = "normal",
    ) => {
      setDemoClock(seconds);
      markDemoPhase("input");
      setLevel(tone === "risk" ? 48 : 18);
      setStatus(role === "상담사" ? "상담사 발화 지연 없이 전달" : "고객 음성 입력");
      pushDemoDialogue(role, text, tone, formatDuration(seconds));
      await sleep(620);
    };
    const riskTurn = async (options: {
      text: string;
      seconds: number;
      level: number;
      raised: boolean;
      stageKind: keyof EscalationState;
      stage: number;
      maskStatus: string;
      systemText: string;
    }) => {
      setDemoClock(options.seconds);
      markDemoPhase("input");
      setLevel(options.level);
      setStatus("고객 음성 입력");
      pushDemoDialogue("고객", options.text, "risk", formatDuration(options.seconds));
      setDemoStep("고객 발화가 보호 게이트웨이로 들어왔습니다.");
      await sleep(520);

      markDemoPhase("detect");
      setStatus(options.raised ? "RMS 고성 분석 감지" : "로컬 사전 즉시 확인");
      setDemoStep(options.raised ? "RMS 기준 초과: 고성 완화 마스크 준비" : "로컬 사전 감지: 위험 단어 구간 확인");
      await analyzeDemo(options.text, options.raised, "immediate");
      setEscalationStage(options.stageKind, options.stage);
      await sleep(620);

      markDemoPhase("mask");
      setStatus(options.maskStatus);
      pushDemoDialogue("시스템", options.systemText, "system", formatDuration(options.seconds + 1));
      await sleep(620);

      setDemoClock(options.seconds + 3);
      markDemoPhase("context");
      setStatus("GPT 문맥 판단 요청 중");
      setDemoStep("3초 문맥 스냅샷을 정책 엔진에 반영합니다.");
      await analyzeDemo(options.text, false, "context_snapshot");
      await sleep(520);
    };

    setError("");
    setLogs([]);
    logsRef.current = [];
    reportLogsRef.current = [];
    setLatestDetection(null);
    countersRef.current = initialCounts();
    seenEventRef.current.clear();
    contextBufferRef.current = [];
    resetEscalation();
    setElapsed(0);
    setActive(false);
    setMuted(false);
    setDemoDialogue([]);
    setDemoClock(0);
    markDemoPhase("idle");
    interimCheckRef.current.lastText = "";
    speechStartAtRef.current = null;
    if (interimCheckRef.current.timer) window.clearTimeout(interimCheckRef.current.timer);

    if (type === "escalation") {
      const lines: Array<{ text: string; level: number }> = [
        { text: "시발 뭐하는 거야. 담당자 바꿔.", level: 44 },
        { text: "개새끼야 당장 해결하라고.", level: 52 },
        { text: "병신같이 처리하네. 찾아가면 되냐?", level: 64 },
        { text: "좆같네, 더 못 기다려. 끊기 전에 해결해.", level: 78 },
      ];

      try {
        setDemoStep("폭언/고성 4단계 상승 데모: 실제 상담 흐름 시작");
        await say("상담사", "서울시 120다산콜센터입니다. 어떤 민원으로 전화주셨을까요?", 1);
        await say("고객", "민원 접수했는데 며칠째 답이 없어서 전화했습니다.", 3);
        await say("상담사", "접수번호 확인 후 처리 부서 진행 상황을 안내드리겠습니다.", 5);
        for (let index = 0; index < lines.length; index += 1) {
          const stage = index + 1;
          const item = lines[index];
          await riskTurn({
            text: item.text,
            seconds: 7 + index * 4,
            level: item.level,
            raised: stage >= 3,
            stageKind: "abuse",
            stage,
            maskStatus: stage >= 3 ? "욕설 삐 처리 및 고성 완화" : "욕설 구간 삐 처리",
            systemText: `${stage}단계 경고가 기록되었습니다. 욕설 구간은 상담사 청취 전에 삐 처리됩니다.`,
          });
        }

        markDemoPhase("policy");
        setDemoClock(25);
        setDemoStep("Policy Engine: 4단계 도달, 상담 종료 및 보고서 생성");
        setStatus("4단계 도달: 상담 종료 안내 및 보고서 생성");
        pushDemoDialogue("시스템", "4단계 도달로 상담 종료 안내와 특이민원 보고서가 자동 생성됩니다.", "system", formatDuration(25));
        generateReport("4단계 상승 데모 종료", { abuse: 4, sexual: 0 }, 25);
      } catch {
        setError("데모 실행 중 분석 서버 연결에 실패했습니다. 백엔드 8000 포트를 확인해주세요.");
      }
      return;
    }

    const script = {
      abuse: {
        text: "시발 뭐하는 거야",
        level: 34,
        raised: false,
        title: "욕설 구간 삐 처리 데모",
        setup: [
          ["상담사", "서울시 120다산콜센터입니다. 어떤 내용을 도와드릴까요?"],
          ["고객", "주차 단속 문자 받고 전화했어요. 이거 잘못된 것 같습니다."],
          ["상담사", "차량번호와 단속 위치를 확인한 뒤 안내드리겠습니다."],
        ] as Array<[DemoDialogueLine["role"], string]>,
        systemText: "욕설 단어 구간만 삐 처리하고 1단계 경고를 기록했습니다.",
        maskStatus: "욕설 구간 삐 처리",
        stageKind: "abuse" as const,
      },
      sexual: {
        text: "목소리 섹시해요. 퇴근하면 기다릴게요",
        level: 36,
        raised: false,
        title: "성희롱 경고·보고서 데모",
        setup: [
          ["상담사", "복지 서비스 신청 절차 안내드리겠습니다."],
          ["고객", "상담사님이 계속 설명해 주세요. 목소리가 마음에 드네요."],
          ["상담사", "민원 내용 중심으로 안내드리겠습니다."],
        ] as Array<[DemoDialogueLine["role"], string]>,
        systemText: "성희롱 가능 발언으로 경고 기록과 증빙 로그를 준비했습니다.",
        maskStatus: "성희롱 경고 기록 및 증빙 로그",
        stageKind: "sexual" as const,
      },
      raised: {
        text: "왜 이렇게 처리가 늦습니까. 당장 해결하세요",
        level: 76,
        raised: true,
        title: "고성 피치/볼륨 완화 데모",
        setup: [
          ["상담사", "상수도 요금 문의 접수 도와드리겠습니다."],
          ["고객", "지난달보다 요금이 많이 나왔습니다. 확인해주세요."],
          ["상담사", "검침 내역과 감면 적용 여부를 차례로 확인하겠습니다."],
        ] as Array<[DemoDialogueLine["role"], string]>,
        systemText: "고성 구간의 피치와 볼륨을 낮춰 상담사에게 전달했습니다.",
        maskStatus: "고성 구간 피치/볼륨 완화",
        stageKind: "abuse" as const,
      },
    }[type];

    try {
      setDemoStep(`${script.title}: 실제 상담 예시 시작`);
      await say(script.setup[0][0], script.setup[0][1], 1);
      await say(script.setup[1][0], script.setup[1][1], 3);
      await say(script.setup[2][0], script.setup[2][1], 5);
      await riskTurn({
        text: script.text,
        seconds: 8,
        level: script.level,
        raised: script.raised,
        stageKind: script.stageKind,
        stage: 1,
        maskStatus: script.maskStatus,
        systemText: script.systemText,
      });
      if (type === "sexual") setEscalationStage("sexual", 2);

      markDemoPhase("policy");
      setDemoClock(14);
      setDemoStep("Policy Engine: 경고, 타임스탬프, 보고서 반영 완료");
      setStatus("특이민원 보고서 생성 완료");
      pushDemoDialogue("시스템", "상담 종료 시 특이민원 보고서에 증빙 발화가 자동 반영됩니다.", "system", formatDuration(14));
      generateReport("데모 종료", escalationRef.current, 14);
    } catch {
      setError("데모 실행 중 분석 서버 연결에 실패했습니다. 백엔드 8000 포트를 확인해주세요.");
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
      setStatus("3초 문맥 스냅샷 대기");
      return;
    }
    setStatus("3초 문맥 스냅샷 분석 중");
    markDemoPhase("context");
    await processText(snapshot, "context_snapshot");
  }

  function startRecognition() {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
      setError("이 브라우저는 Web Speech API를 지원하지 않습니다. Chrome 또는 Edge를 권장합니다.");
      return;
    }

    const recognition = new Recognition();
    let recognitionRunning = false;

    const startSafely = (delay = 0) => {
      if (audioRef.current.recognition !== recognition) return;
      if (audioRef.current.recognitionRestartTimer) {
        window.clearTimeout(audioRef.current.recognitionRestartTimer);
      }
      audioRef.current.recognitionRestartTimer = window.setTimeout(() => {
        if (audioRef.current.recognition !== recognition || recognitionRunning) return;
        try {
          recognition.start();
          recognitionRunning = true;
          setStatus("음성 입력 대기 중");
        } catch {
          recognitionRunning = false;
          startSafely(CFG.recognitionRestartMs * 2);
        }
      }, delay);
    };

    recognition.lang = "ko-KR";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 3;
    recognition.onresult = (event) => {
      if (announcingRef.current) return;
      const resultAtMs = performance.now();
      if (!speechStartAtRef.current) speechStartAtRef.current = resultAtMs - 650;
      const timing = { startedAtMs: speechStartAtRef.current, resultAtMs };
      markDemoPhase("input");
      setStatus("음성 입력 감지");
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
        queueInterimImmediate(interim, timing);
      }
      if (final) {
        pushContext(final);
        void processText(final, "immediate", timing);
        speechStartAtRef.current = null;
      }
    };
    recognition.onspeechstart = () => {
      speechStartAtRef.current = performance.now();
      setStatus("음성 입력 감지");
    };
    recognition.onspeechend = () => {
      speechStartAtRef.current = null;
    };
    recognition.onend = () => {
      recognitionRunning = false;
      startSafely(CFG.recognitionRestartMs);
    };
    recognition.onerror = (event) => {
      recognitionRunning = false;
      if (event.error === "no-speech") {
        setStatus("음성 입력 대기 중");
        startSafely(CFG.recognitionRestartMs);
        return;
      }
      if (event.error === "aborted") return;
      setError(`음성 인식 오류: ${event.error}`);
      startSafely(CFG.recognitionRestartMs * 2);
    };
    audioRef.current.recognition = recognition;
    startSafely();
  }

  async function startSession() {
    setError("");
    setLogs([]);
    logsRef.current = [];
    reportLogsRef.current = [];
    setLatestDetection(null);
    setElapsed(0);
    setInterimText("상담을 듣고 있습니다.");
    setStatus("보호된 상담사 청취 출력");
    countersRef.current = initialCounts();
    contextBufferRef.current = [];
    seenEventRef.current.clear();
    resetEscalation();
    interimCheckRef.current.lastText = "";
    speechStartAtRef.current = null;
    sessionStartedAtRef.current = new Date();
    markDemoPhase("idle");
    if (interimCheckRef.current.timer) window.clearTimeout(interimCheckRef.current.timer);
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
    if (interimCheckRef.current.timer) window.clearTimeout(interimCheckRef.current.timer);
    if (state.maskTimer) clearTimeout(state.maskTimer);
    if (state.recognitionRestartTimer) clearTimeout(state.recognitionRestartTimer);
    void state.ctx?.close();
    window.speechSynthesis.cancel();
    audioRef.current = { raisedSustainMs: 0, raisedLatched: false, lastRaisedTs: 0 };
    interimCheckRef.current.lastText = "";
    speechStartAtRef.current = null;
    announcingRef.current = false;
    setActive(false);
    setLevel(0);
    setMuted(false);
    setStatus("대기 중");
    generateReport("상담 종료", escalationRef.current, elapsed);
    setInterimText("상담이 종료되었습니다. 특이민원 보고서가 생성되었습니다.");
    setStatus("특이민원 보고서 생성 완료");
    markDemoPhase("policy");
  }

  if (normalizedRoute === "/report") {
    return <ReportPage reports={reportArchive} onNavigateHome={() => navigate("/")} />;
  }

  return (
    <main className="app">
      <header className="topbar">
        <div>
          <strong className="brand"><span>Emotion</span>Guard</strong>
          <p>실시간 오디오 보호 게이트웨이 + 3초 AI 문맥 판단</p>
        </div>
        <div className="top-actions">
          <button className="secondary" onClick={() => navigate("/report")}>보고서</button>
          <button className={active ? "danger" : "primary"} onClick={active ? stopSession : startSession}>
            {active ? "상담 종료" : "상담 시작"}
          </button>
        </div>
      </header>

      <section className="architecture-strip">
        <span>내담자 음성 입력</span>
        <b>20ms Frame</b>
        <b>Ring Buffer</b>
        <b>Streaming Audio Guard</b>
        <b>Policy Engine</b>
        <span>보호된 상담사 청취 출력</span>
      </section>

      <section className="process-strip">
        {demoProcessSteps.map((step) => (
          <div
            key={step.id}
            className={[
              "process-step",
              demoPhase === step.id ? "active" : "",
              litPhaseSet.has(step.id) ? "done" : "",
            ].join(" ")}
          >
            <strong>{step.label}</strong>
            <span>{step.detail}</span>
          </div>
        ))}
      </section>

      <section className="stage-grid">
        <div>
          <strong>폭언/고성 4단계 <em>{abuseStage ? `${abuseStage}단계 진입` : "대기"}</em></strong>
          <div className="stage">
            {[1, 2, 3, 4].map((item) => (
              <span key={item} className={`${abuseStage >= item ? "on" : ""} ${abuseStage === item ? "current" : ""}`}>
                {item}단계
              </span>
            ))}
          </div>
        </div>
        <div>
          <strong>성희롱 2단계 <em>{sexualStage ? `${sexualStage}단계 진입` : "대기"}</em></strong>
          <div className="stage two">
            {[1, 2].map((item) => (
              <span key={item} className={`${sexualStage >= item ? "on sexual" : ""} ${sexualStage === item ? "current" : ""}`}>
                {item}단계
              </span>
            ))}
          </div>
        </div>
      </section>

      {error && <div className="banner">{error}</div>}

      <section className="grid">
        <div className="panel main">
          <div className="timer">{mm}:{ss}</div>
          <section className="guard-panel">
            <div className="guard-state">
              <strong>현재 보호 상태</strong>
              <span>{muted ? "욕설 구간 삐 처리 중" : status}</span>
            </div>
            <label className="threshold-control">
              <span>고성 기준</span>
              <input type="range" min={20} max={80} value={threshold} onChange={(event) => setThreshold(Number(event.target.value))} />
              <b>{threshold}%</b>
            </label>
            <div className="voice-control">
              <span>음성 보정</span>
              <div className="segmented">
                <button className={gender === "male" ? "selected" : ""} onClick={() => setGender("male")}>남성</button>
                <button className={gender === "female" ? "selected" : ""} onClick={() => setGender("female")}>여성</button>
              </div>
            </div>
            <div className="monitor-control">
              <span>청취 모니터</span>
              <button className={monitorEnabled ? "selected" : ""} onClick={() => setMonitorEnabled((prev) => !prev)}>
                {monitorEnabled ? "켜짐" : "꺼짐"}
              </button>
            </div>
          </section>
          <div className="meter">
            <label>RMS</label>
            <div className="track">
              <div className="fill" style={{ width: `${level}%` }} />
              <i style={{ left: `${threshold}%` }} />
            </div>
            <strong>{Math.round(level)}</strong>
          </div>
          <section className={`acoustic-panel ${audioFeatures.voiceActivity ? "active" : ""}`}>
            <div><span>입력 상태</span><strong>{audioFeatures.voiceActivity ? "발화 감지" : active ? "무음 대기" : "마이크 대기"}</strong></div>
            <div><span>Pitch</span><strong>{featureValue(audioFeatures.pitchHz, "Hz", audioFeatures.voiceActivity)}</strong></div>
            <div><span>Peak</span><strong>{featureValue(audioFeatures.peak, "", audioFeatures.voiceActivity)}</strong></div>
            <div><span>ZCR</span><strong>{featureValue(audioFeatures.zeroCrossingRate, "", audioFeatures.voiceActivity)}</strong></div>
            <div><span>Centroid</span><strong>{featureValue(audioFeatures.spectralCentroidHz, "Hz", audioFeatures.voiceActivity)}</strong></div>
          </section>
          <section className="timeline-panel">
            <div className="timestamp-head">
              <strong>상담 타임라인</strong>
              <span>{latestDetection ? `최근 감지 [${latestDetection.timestamp}] · ${eventLabel[latestDetection.eventType]}` : "고객 발화와 보호 조치 누적"}</span>
            </div>
            <div className="conversation-list" ref={timelineRef}>
              {conversationEntries.length === 0 && <p className="empty">고객 발화가 들어오면 [00:00] 형식으로 바로 기록됩니다.</p>}
              {conversationEntries.map((entry) => (
                <article key={entry.id} className={`conversation-row ${entry.tone} ${entry.eventType ?? ""}`} data-original={entry.original}>
                  <time>[{entry.timestamp}]</time>
                  <b>{entry.role === "시스템" ? "보호 조치" : entry.role}</b>
                  <div>
                    <strong>{entry.text}</strong>
                    <small>{entry.detail}</small>
                  </div>
                </article>
              ))}
            </div>
          </section>
        </div>

        <aside className="panel">
          <h2>감지 현황</h2>
          <dl className="stats">
            <div><dt>욕설</dt><dd>{counts.abuse}</dd></div>
            <div><dt>욕설+고성</dt><dd>{counts["abuse-raised"]}</dd></div>
            <div><dt>고성</dt><dd>{counts.raised}</dd></div>
            <div><dt>성희롱</dt><dd>{counts.sexual}</dd></div>
          </dl>
          <section className="report-link-card">
            <h2>보고서</h2>
            <p>상담 종료 시 보고서가 자동 저장됩니다.</p>
            <button onClick={() => navigate("/report")}>보고서 {reportArchive.length}건 보기</button>
          </section>
        </aside>
      </section>
      <aside className="demo-remote" aria-label="데모 리모콘">
        <strong>DEMO</strong>
        <span>{demoStep}</span>
        <button onClick={() => void runDemo("abuse")}>욕설 삐 처리</button>
        <button onClick={() => void runDemo("raised")}>고성 완화</button>
        <button onClick={() => void runDemo("sexual")}>성희롱 경고</button>
        <button onClick={() => void runDemo("escalation")}>4단계 상승</button>
      </aside>
    </main>
  );
}
