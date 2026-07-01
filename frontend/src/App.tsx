import { useEffect, useMemo, useRef, useState } from "react";
import { AnalysisMode, analyzeUtterance, AnalyzeResponse, EventType, PolicyAction } from "./lib/api";
import { Jungle } from "./lib/audio/jungle";

type LogEntry = AnalyzeResponse & {
  id: string;
  text: string;
  time: string;
  timestamp: string;
};

type PreviewSource = AnalyzeResponse["source"] | "browser" | "pending";

type ProtectionPreview = {
  mode: AnalysisMode;
  title: string;
  status: string;
  input: string;
  output: string;
  eventType: EventType;
  source: PreviewSource;
  emotion: AnalyzeResponse["emotion"];
  actions: string[];
};

type SpeechTiming = {
  startedAtMs: number;
  resultAtMs: number;
};

type DemoPhase = "idle" | "input" | "detect" | "mask" | "context" | "policy";

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
  outputDelay: 1.5,
  meterGain: 400,
  beepMinMs: 420,
  beepCharMs: 95,
  beepMaxMs: 1100,
  beepFrequency: 880,
  beepVolume: 0.18,
  stageDedupeMs: 5000,
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

const actionLabel: Record<PolicyAction, string> = {
  mute: "삐 처리",
  pitch_shift: "피치 완화",
  volume_reduce: "볼륨 완화",
  warn_tts: "경고 TTS",
  escalate: "단계 상승",
  report: "보고서",
};

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

const demoProcessSteps: Array<{ id: DemoPhase; label: string; detail: string }> = [
  { id: "input", label: "음성 입력", detail: "20ms Frame" },
  { id: "detect", label: "빠른 감지", detail: "RMS/STT/로컬 사전" },
  { id: "mask", label: "보호 마스크", detail: "비프음/피치/볼륨" },
  { id: "context", label: "3초 맥락", detail: "Claude 판단" },
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

function initialPreview(mode: AnalysisMode): ProtectionPreview {
  return {
    mode,
    title: mode === "immediate" ? "즉시 마스킹 처리" : "3초 맥락 처리",
    status: mode === "immediate" ? "STT 인터림과 로컬 사전 감지 대기" : "3초 스냅샷과 Claude 문맥 판단 대기",
    input: "-",
    output: "-",
    eventType: "normal",
    source: "pending",
    emotion: "normal",
    actions: [],
  };
}

function summarizePolicy(result: AnalyzeResponse) {
  if (result.detectionPath === "immediate") {
    if (result.policyActions.includes("mute")) return "로컬 사전 감지: 욕설 단어 구간에 비프음 마스크 적용";
    if (result.policyActions.includes("pitch_shift") || result.policyActions.includes("volume_reduce")) {
      return "RMS 고성 감지: 피치/볼륨 완화 마스크 적용";
    }
    return "즉시 위험 없음: 원문 전달";
  }

  if (result.policyActions.includes("report")) return "Claude 문맥 판단: 경고·에스컬레이션·보고서 액션 반영";
  if (result.eventType !== "normal") return "Claude 문맥 판단: 단계 상승과 경고 액션 반영";
  return "Claude 문맥 판단: 특이 위험 없음";
}

function previewFromResult(result: AnalyzeResponse, input: string): ProtectionPreview {
  return {
    mode: result.detectionPath,
    title: result.detectionPath === "immediate" ? "즉시 마스킹 처리" : "3초 맥락 처리",
    status: summarizePolicy(result),
    input,
    output: result.maskedText || input,
    eventType: result.eventType,
    source: result.source,
    emotion: result.emotion,
    actions: result.policyActions.map((action) => actionLabel[action]),
  };
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

export default function App() {
  const [active, setActive] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [threshold, setThreshold] = useState(38);
  const [gender, setGender] = useState<"male" | "female">("male");
  const [, setInterimText] = useState("상담을 시작하면 실시간 STT 인터림과 보호 상태가 표시됩니다.");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [muted, setMuted] = useState(false);
  const [status, setStatus] = useState("대기 중");
  const [contextStatus, setContextStatus] = useState("3초 문맥 스냅샷 대기");
  const [demoStep, setDemoStep] = useState("데모 버튼을 누르면 즉시 보호 경로와 3초 문맥 경로가 순서대로 표시됩니다.");
  const [demoPhase, setDemoPhase] = useState<DemoPhase>("idle");
  const [litPhases, setLitPhases] = useState<DemoPhase[]>([]);
  const [escalation, setEscalation] = useState<EscalationState>(() => initialEscalation());
  const [immediatePreview, setImmediatePreview] = useState<ProtectionPreview>(() => initialPreview("immediate"));
  const [contextPreview, setContextPreview] = useState<ProtectionPreview>(() => initialPreview("context_snapshot"));
  const [report, setReport] = useState<IncidentReport | null>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const [error, setError] = useState("");

  const countersRef = useRef(initialCounts());
  const logsRef = useRef<LogEntry[]>([]);
  const reportLogsRef = useRef<LogEntry[]>([]);
  const contextBufferRef = useRef<string[]>([]);
  const escalationRef = useRef<EscalationState>(initialEscalation());
  const seenEventRef = useRef(new Set<string>());
  const seenStageRef = useRef(new Set<string>());
  const announcingRef = useRef(false);
  const interimCheckRef = useRef<{ timer?: number; lastText: string }>({ lastText: "" });
  const speechStartAtRef = useRef<number | null>(null);
  const sessionStartedAtRef = useRef<Date | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);

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
  }>({ raisedSustainMs: 0, raisedLatched: false, lastRaisedTs: 0 });

  const counts = useMemo(() => {
    return logs.reduce((acc, log) => {
      acc[log.eventType] += 1;
      return acc;
    }, initialCounts());
  }, [logs]);
  const timelineEntries = useMemo(() => logs.slice().reverse(), [logs]);

  const abuseStage = escalation.abuse;
  const sexualStage = escalation.sexual;
  const litPhaseSet = useMemo(() => new Set(litPhases), [litPhases]);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");

  function markDemoPhase(phase: DemoPhase) {
    setDemoPhase(phase);
    if (phase === "idle") {
      setLitPhases([]);
      return;
    }
    setLitPhases((prev) => (prev.includes(phase) ? prev : [...prev, phase]));
  }

  useEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline) return;
    timeline.scrollTo({ top: timeline.scrollHeight, behavior: "smooth" });
  }, [logs]);

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
      setStatus(offset < 0 ? "고성 구간 피치/볼륨 완화" : muted ? "욕설 단어 삐 처리" : "보호된 상담사 청취 출력");

      if (!announcingRef.current && nextLevel >= threshold) {
        current.raisedSustainMs += dt;
        if (current.raisedSustainMs >= CFG.raisedSustainMs && !current.raisedLatched) {
          current.raisedLatched = true;
          current.lastRaisedTs = Date.now();
          markDemoPhase("detect");
          markDemoPhase("mask");
          setInterimText("RMS 고성 분석 감지 - 출력 커서에서 음정을 낮춰 전달합니다.");
          setImmediatePreview({
            mode: "immediate",
            title: "즉시 마스킹 처리",
            status: "RMS 고성 분석: 출력 커서에서 피치/볼륨 완화 마스크 적용",
            input: "기준 음량을 초과한 고객 음성",
            output: "낮아진 음정과 완화된 볼륨으로 상담사에게 전달",
            eventType: "raised",
            source: "browser",
            emotion: "angry",
            actions: ["피치 완화", "볼륨 완화", "단계 상승"],
          });
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
    const wordInputAtMs = timing.startedAtMs + utteranceMs * ratio;
    const wordOutputAtMs = wordInputAtMs + CFG.outputDelay * 1000;
    const delaySeconds = Math.max(0.04, (wordOutputAtMs - performance.now()) / 1000);

    return ctx.currentTime + delaySeconds;
  }

  function beepProfanitySegment(result: AnalyzeResponse, text: string, timing?: SpeechTiming) {
    markDemoPhase("mask");
    const { ctx, outGain } = audioRef.current;
    const durationMs = beepDurationFor(result);
    if (!ctx || !outGain) {
      setMuted(true);
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
    gain.linearRampToValueAtTime(1, endAt + 0.05);
    playBeep(ctx, startAt, durationMs);

    setMuted(true);
    if (audioRef.current.maskTimer) window.clearTimeout(audioRef.current.maskTimer);
    audioRef.current.maskTimer = window.setTimeout(() => setMuted(false), Math.max(0, (endAt - ctx.currentTime) * 1000 + 80));
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

  function updatePreview(result: AnalyzeResponse, text: string) {
    const preview = previewFromResult(result, text);
    if (result.detectionPath === "immediate") setImmediatePreview(preview);
    else setContextPreview(preview);
  }

  function applyPolicy(result: AnalyzeResponse, text: string, timing?: SpeechTiming) {
    updatePreview(result, text);
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
      setContextStatus(`Claude 문맥 판단: ${eventLabel[result.eventType]} / ${result.emotion}`);
    } else {
      setContextStatus("Claude 문맥 판단: 특이 위험 없음");
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
    setReport(nextReport);
    setCopyStatus("");
    return nextReport;
  }

  async function copyReport() {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(reportToText(report));
      setCopyStatus("복사 완료");
    } catch {
      setCopyStatus("복사 실패");
    }
    window.setTimeout(() => setCopyStatus(""), 1600);
  }

  async function processText(text: string, analysisMode: AnalysisMode, timing?: SpeechTiming) {
    const clean = text.trim();
    if (!clean) return;
    markDemoPhase(analysisMode === "immediate" ? "detect" : "context");

    const raised = analysisMode === "immediate" && Date.now() - audioRef.current.lastRaisedTs < CFG.raisedFlagWindow;
    try {
      const result = await analyzeUtterance(clean, raised, analysisMode, CFG.contextWindowMs);
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
    setImmediatePreview((prev) => ({
      ...prev,
      status: "STT 인터림 분석 대기: 로컬 사전 즉시 확인 준비",
      input: clean,
      output: "분석 중",
      source: "pending",
      actions: [],
    }));

    interimCheckRef.current.timer = window.setTimeout(() => {
      interimCheckRef.current.lastText = clean;
      void processText(clean, "immediate", timing);
    }, 360);
  }

  async function analyzeDemo(text: string, raised: boolean, analysisMode: AnalysisMode) {
    const result = await analyzeUtterance(text, raised, analysisMode, CFG.contextWindowMs);
    applyPolicy(result, text, { startedAtMs: performance.now() - 900, resultAtMs: performance.now() });
    return result;
  }

  async function runDemo(type: "abuse" | "sexual" | "raised" | "escalation") {
    if (active) stopSession();
    setError("");
    setLogs([]);
    logsRef.current = [];
    reportLogsRef.current = [];
    countersRef.current = initialCounts();
    seenEventRef.current.clear();
    contextBufferRef.current = [];
    resetEscalation();
    setElapsed(0);
    setActive(false);
    setMuted(false);
    setReport(null);
    setCopyStatus("");
    sessionStartedAtRef.current = new Date();
    markDemoPhase("idle");
    setImmediatePreview(initialPreview("immediate"));
    setContextPreview(initialPreview("context_snapshot"));
    interimCheckRef.current.lastText = "";
    speechStartAtRef.current = null;
    if (interimCheckRef.current.timer) window.clearTimeout(interimCheckRef.current.timer);

    if (type === "escalation") {
      const lines = [
        "시발 뭐하는 거야",
        "개새끼 당장 바꿔",
        "병신같이 처리하네",
        "좆같네 꺼져",
      ];

      try {
        setDemoStep("폭언/고성 4단계 상승 데모: 반복 위험 이벤트 입력");
        setContextPreview(initialPreview("context_snapshot"));
        for (let index = 0; index < lines.length; index += 1) {
          const stage = index + 1;
          const text = lines[index];
          markDemoPhase("input");
          setInterimText(text);
          setLevel(42 + stage * 9);
          setDemoStep(`${stage}단계 진입: 고객 발화 입력`);
          setStatus("20ms 오디오 프레임 → Ring Buffer 적재");
          await sleep(420);

          markDemoPhase("detect");
          setDemoStep(`${stage}단계 진입: 로컬 욕설 사전 감지`);
          await analyzeDemo(text, stage >= 3, "immediate");
          setEscalationStage("abuse", stage);
          await sleep(620);

          markDemoPhase("mask");
          setDemoStep(`${stage}단계 진입: 욕설 단어 구간 비프음 마스크 적용`);
          await sleep(520);
        }

        markDemoPhase("policy");
        setDemoStep("Policy Engine: 폭언/고성 4단계 점등 완료, 상담 종료 안내 단계");
        generateReport("4단계 상승 데모 종료", { abuse: 4, sexual: 0 }, 16);
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
      },
      sexual: {
        text: "목소리 섹시해요. 퇴근하면 기다릴게요",
        level: 36,
        raised: false,
        title: "성희롱 경고·보고서 데모",
      },
      raised: {
        text: "왜 이렇게 처리가 늦습니까. 당장 해결하세요",
        level: 76,
        raised: true,
        title: "고성 피치/볼륨 완화 데모",
      },
    }[type];

    try {
      markDemoPhase("input");
      setDemoStep(`${script.title}: 고객 음성 입력`);
      setInterimText(script.text);
      setLevel(script.level);
      setStatus("20ms 오디오 프레임 → Ring Buffer 적재");
      setImmediatePreview({
        ...initialPreview("immediate"),
        status: "고객 음성이 Ring Buffer에 들어오고 STT 인터림이 생성됨",
        input: script.text,
        output: "즉시 분석 전",
      });
      setContextPreview({
        ...initialPreview("context_snapshot"),
        status: "3초 문맥 스냅샷 대기",
        input: script.text,
        output: "문맥 분석 전",
      });
      await sleep(650);

      markDemoPhase("detect");
      setDemoStep("즉시 감지 경로: RMS/STT 인터림/로컬 사전 확인");
      setStatus(script.raised ? "RMS 고성 분석 감지" : "로컬 사전 즉시 확인");
      await analyzeDemo(script.text, script.raised, "immediate");
      setEscalationStage(type === "sexual" ? "sexual" : "abuse", 1);
      await sleep(900);

      markDemoPhase("mask");
      setDemoStep(
        type === "abuse"
          ? "출력 커서: 욕설 단어 구간에만 비프음 마스크 적용"
          : type === "raised"
            ? "출력 커서: 고성 구간 피치/볼륨 완화 마스크 적용"
            : "정책 엔진: 성희롱 경고 TTS와 증빙 로그 액션 준비",
      );
      setStatus(
        type === "raised"
          ? "고성 구간 피치/볼륨 완화"
          : type === "sexual"
            ? "성희롱 경고 TTS 및 증빙 로그"
            : "욕설 단어 삐 처리",
      );
      await sleep(900);

      markDemoPhase("context");
      setDemoStep("3초 문맥 판단 경로: Claude 스냅샷 분석 결과를 정책 엔진에 반영");
      setContextStatus("3초 문맥 스냅샷 분석 중");
      await analyzeDemo(script.text, false, "context_snapshot");
      if (type === "sexual") setEscalationStage("sexual", 2);
      await sleep(600);

      markDemoPhase("policy");
      setDemoStep("Policy Engine: 단계 상승, 경고, 로그, 보고서 액션 결정 완료");
      generateReport("데모 종료", escalationRef.current, 8);
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
      setContextStatus("3초 문맥 스냅샷 대기");
      return;
    }
    setContextStatus("3초 문맥 스냅샷 분석 중");
    markDemoPhase("context");
    setContextPreview((prev) => ({
      ...prev,
      status: "3초 문맥 스냅샷 분석 중: Claude 판단 대기",
      input: snapshot,
      output: "문맥 판단 중",
      source: "pending",
      actions: [],
    }));
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
      const resultAtMs = performance.now();
      if (!speechStartAtRef.current) speechStartAtRef.current = resultAtMs - 650;
      const timing = { startedAtMs: speechStartAtRef.current, resultAtMs };
      markDemoPhase("input");
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
    };
    recognition.onspeechend = () => {
      speechStartAtRef.current = null;
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
    logsRef.current = [];
    reportLogsRef.current = [];
    setElapsed(0);
    setInterimText("상담을 듣고 있습니다.");
    setContextStatus("3초 문맥 스냅샷 대기");
    countersRef.current = initialCounts();
    contextBufferRef.current = [];
    seenEventRef.current.clear();
    resetEscalation();
    interimCheckRef.current.lastText = "";
    speechStartAtRef.current = null;
    sessionStartedAtRef.current = new Date();
    setReport(null);
    setCopyStatus("");
    markDemoPhase("idle");
    if (interimCheckRef.current.timer) window.clearTimeout(interimCheckRef.current.timer);
    setImmediatePreview(initialPreview("immediate"));
    setContextPreview(initialPreview("context_snapshot"));
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
    setContextStatus("3초 문맥 스냅샷 대기");
    generateReport("상담 종료", escalationRef.current, elapsed);
    setInterimText("상담이 종료되었습니다. 특이민원 보고서가 생성되었습니다.");
    setStatus("특이민원 보고서 생성 완료");
    markDemoPhase("policy");
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
          <section className="timestamp-panel">
            <div className="timestamp-head">
              <strong>문장 타임스탬프</strong>
              <span>상담 시간 기준 누적</span>
            </div>
            <div className="timestamp-list" ref={timelineRef}>
              {timelineEntries.length === 0 && <p className="empty">문장이 들어오면 [00:00] 형식으로 바로 기록됩니다.</p>}
              {timelineEntries.map((log) => (
                <article key={log.id} className={`timestamp-row ${log.eventType}`} data-original={log.text}>
                  <time>[{log.timestamp}]</time>
                  <div>
                    <strong>원문 문장 비공개 기록됨 · {pathLabel[log.detectionPath]}</strong>
                    <small>{log.policyActions.map((action) => actionLabel[action]).join(" · ") || "기록"} · {log.source}</small>
                  </div>
                </article>
              ))}
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
          <div className="controls">
            <label>
              고성 기준
              <input type="range" min={20} max={80} value={threshold} onChange={(event) => setThreshold(Number(event.target.value))} />
            </label>
            <div className="segmented">
              <button className={gender === "male" ? "selected" : ""} onClick={() => setGender("male")}>남성</button>
              <button className={gender === "female" ? "selected" : ""} onClick={() => setGender("female")}>여성</button>
            </div>
            <span className={muted ? "pill mute" : "pill"}>{muted ? "삐 처리 중" : status}</span>
          </div>
          <div className="pipeline">
            <div><strong>즉시 감지 경로</strong><span>RMS · STT 인터림 · 로컬 사전 · 즉시 마스크</span></div>
            <div><strong>AI 문맥 경로</strong><span>{contextStatus}</span></div>
            <div><strong>출력 커서</strong><span>{CFG.outputDelay}s 지연 후 보호 마스크 적용</span></div>
          </div>
          <div className="live-compare">
            {[immediatePreview, contextPreview].map((preview) => (
              <article key={preview.mode} className={`preview ${preview.eventType}`}>
                <div className="preview-head">
                  <strong>{preview.title}</strong>
                  <span>{pathLabel[preview.mode]} · {eventLabel[preview.eventType]} · {preview.source}</span>
                </div>
                <p>{preview.status}</p>
                <dl>
                  <div>
                    <dt>입력</dt>
                    <dd>{preview.input}</dd>
                  </div>
                  <div>
                    <dt>처리 결과</dt>
                    <dd>{preview.output}</dd>
                  </div>
                </dl>
                <div className="action-tags">
                  {preview.actions.length === 0 && <span>대기</span>}
                  {preview.actions.map((action) => <span key={action}>{action}</span>)}
                </div>
              </article>
            ))}
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
          <section className={report ? "report-card ready" : "report-card"}>
            <div className="report-head">
              <h2>특이민원 보고서</h2>
              {report && <button onClick={() => void copyReport()}>{copyStatus || "보고서 복사"}</button>}
            </div>
            {!report && <p className="empty">상담 종료 시 자동 생성됩니다.</p>}
            {report && (
              <>
                <small>{report.id} · {report.generatedAt}</small>
                <p>{report.summary}</p>
                <dl className="report-meta">
                  <div><dt>상담 시간</dt><dd>{report.duration}</dd></div>
                  <div><dt>최고 단계</dt><dd>폭언 {report.escalation.abuse} / 성희롱 {report.escalation.sexual}</dd></div>
                  <div><dt>조치</dt><dd>{report.actions.join(", ") || "특이 조치 없음"}</dd></div>
                </dl>
                <strong className="report-subtitle">후속 권고</strong>
                <p>{report.recommendation}</p>
                <strong className="report-subtitle">증빙 발화</strong>
                <div className="report-evidence">
                  {report.evidence.length === 0 && <span>감지된 특이 민원 발화 없음</span>}
                  {report.evidence.map((item) => (
                    <article key={item.id} data-original={item.text}>
                      <small>[{item.timestamp}] · {eventLabel[item.eventType]} · {pathLabel[item.detectionPath]}</small>
                      <p>원문 문장 비공개 기록됨</p>
                    </article>
                  ))}
                </div>
              </>
            )}
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
