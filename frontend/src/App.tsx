import { useEffect, useMemo, useRef, useState } from "react";
import {
  AnalysisMode,
  analyzeUtterance,
  AnalyzeResponse,
  AudioFeatures,
  EmotionPrediction,
  EventType,
  FeedbackContext,
  PolicyAction,
  predictEmotion,
  transcribeAudioBlob,
  TranscribeResponse,
  TranscriptionWord,
} from "./lib/api";
import { Jungle } from "./lib/audio/jungle";

type LogEntry = AnalyzeResponse & {
  id: string;
  text: string;
  time: string;
  timestamp: string;
  loggedAtMs?: number;
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
  detail?: string;
  tone?: "normal" | "risk" | "system";
  timestamp: string;
};

type DemoAudioKey = "parking-normal" | "abuse-profanity" | "sexual-ambiguous" | "sexual-harassment";

type DemoAudioSpec = {
  src: string;
  transcript: string;
  volume?: number;
};

type ConversationEntry = {
  id: string;
  timestamp: string;
  role: string;
  text: string;
  detail: string;
  tone: "normal" | "risk" | "system";
  eventType?: EventType;
};

type LatestDetectionView = {
  id: string;
  timestamp: string;
  title: string;
  detail: string;
  eventType: EventType;
  original: string;
};

type AutoThresholdBaseline = {
  startedAtMs: number;
  levels: number[];
  voiceLevels: number[];
  lastUpdateMs: number;
};

type PitchProtection = {
  active: boolean;
  levelTriggered: boolean;
  pitchTriggered: boolean;
  modulationTriggered: boolean;
  offset: number;
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
  outputDelay: 1.8,
  meterGain: 650,
  beepMinMs: 420,
  beepCharMs: 95,
  beepMaxMs: 1100,
  beepDedupeMs: 2200,
  beepFrequency: 880,
  beepVolume: 0.18,
  beepPreRollMs: 45,
  beepPostRollMs: 90,
  stageDedupeMs: 5000,
  raisedSustainMs: 250,
  raisedFlagWindow: 3000,
  voiceLevelThreshold: 0.35,
  voicePeakThreshold: 0.002,
  voiceHoldMs: 1200,
  interimDebounceMs: 90,
  recognitionRestartMs: 220,
  liveChunkMs: 900,
  liveChunkMaxInflight: 4,
  liveChunkMinBytes: 450,
  liveChunkVoiceWindowMs: 5200,
  liveChunkMinLevel: 0.35,
  liveChunkMinPeak: 0.002,
  liveChunkProbeEveryMs: 2800,
  normalRepeatDedupeMs: 10000,
  autoThresholdWarmupMs: 5000,
  autoThresholdMin: 32,
  autoThresholdMax: 72,
  autoThresholdSampleLimit: 360,
  autoThresholdUpdateMs: 450,
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

const emotionLabel: Record<EmotionPrediction["label"], string> = {
  normal: "안정",
  frustrated: "긴장",
  angry: "분노",
  threatening: "위협",
};

const sourceLabel: Record<AnalyzeResponse["source"], string> = {
  local: "비윤리 표현 사전",
  openai: "GPT API",
  fallback: "기본 문맥 엔진",
};

function timelineDetailFor(log: LogEntry) {
  if (log.eventType === "normal") return "정상 · STT 기록";
  return `${eventLabel[log.eventType]} · ${pathLabel[log.detectionPath]} · ${log.policyActions.map((action) => actionLabel[action]).join(" · ") || "기록"} · ${sourceLabel[log.source]}`;
}

const REPORT_ARCHIVE_KEY = "emotionguard.reports.v1";
const REPORT_ARCHIVE_LIMIT = 80;
const MONITOR_GAIN = 0.5;
const SHOW_DEMO_REMOTE = false;

const demoAudioSpecs: Record<DemoAudioKey, DemoAudioSpec> = {
  "parking-normal": {
    src: "/demo-audio/parking-normal.mp3",
    transcript: "주차 단속 문자 받고 전화했어요. 이거 잘못된 것 같습니다.",
    volume: 0.92,
  },
  "sexual-harassment": {
    src: "/demo-audio/sexual-harassment.mp3",
    transcript: "목소리 섹시해요. 퇴근하면 기다릴게요.",
    volume: 0.92,
  },
  "sexual-ambiguous": {
    src: "/demo-audio/sexual-ambiguous.mp3",
    transcript: "상담사님이 계속 설명해 주세요. 목소리가 마음에 드네요.",
    volume: 0.92,
  },
  "abuse-profanity": {
    src: "/demo-audio/abuse-profanity.mp3",
    transcript: "시발 뭐라는 거야",
    volume: 0.92,
  },
};

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

const demoProcessSteps: Array<{ id: DemoPhase; label: string; detail: string }> = [
  { id: "input", label: "음성 입력", detail: "20ms Frame" },
  { id: "detect", label: "빠른 감지", detail: "RMS/STT/비윤리 표현" },
  { id: "mask", label: "보호 마스크", detail: "비프음/피치/볼륨" },
  { id: "context", label: "3초 맥락", detail: "GPT/기본 문맥" },
  { id: "policy", label: "정책 엔진", detail: "단계/경고/보고서" },
];

const visibleMaskWords = [
  "씨발", "시발", "씨바", "시바", "씨불", "시불", "씨팔", "시팔", "씨펄", "시펄", "씨벌", "시벌",
  "씨발아", "시발아", "씨발놈", "시발놈", "씨발년", "시발년",
  "개새끼", "개색기", "개색끼", "개세끼", "새끼", "새끼야", "쌔끼", "색히",
  "병신", "빙신", "븅신", "등신", "머저리", "또라이", "지랄", "존나", "좆", "좃", "좇",
  "닥쳐", "아가리", "주둥이", "꺼져", "죽어", "죽여",
  "ㅅㅂ", "ㅆㅂ", "ㅂㅅ", "ㅄ", "ㅈㄹ", "ㅈㄴ",
  "섹시", "야한", "자자", "몸매", "가슴", "엉덩이",
];

const visibleMaskExceptions = ["시발점", "시발역", "시발지"];

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

function pitchProtectionForShout(
  level: number,
  threshold: number,
  pitchHz: number | undefined,
  pitchConfidence: number,
  pitchThreshold: number,
  strength: number,
): PitchProtection {
  const levelTriggered = level >= threshold;
  const pitchTriggered = Boolean(pitchHz && pitchConfidence >= 0.28 && pitchHz >= pitchThreshold);
  const modulationTriggered = levelTriggered || pitchTriggered;
  if (!modulationTriggered) {
    return { active: false, levelTriggered, pitchTriggered, modulationTriggered, offset: 0 };
  }

  const levelOver = clamp((level - threshold) / Math.max(1, 100 - threshold), 0, 1);
  const pitchOver = pitchHz ? clamp((pitchHz - pitchThreshold) / 120, 0, 1) : 0;
  const triggerStrength = Math.max(0.35, levelOver, pitchOver);
  const ratio = clamp(strength / 100, 0, 1);
  const baseDrop = 0.58;
  const spanDrop = 0.28;
  const offset = -(baseDrop + spanDrop * triggerStrength) * (0.9 + ratio * 0.25);

  return {
    active: true,
    levelTriggered,
    pitchTriggered,
    modulationTriggered,
    offset: clamp(offset, -0.95, -0.45),
  };
}

function loudnessGainForLevel(level: number, threshold: number, strength: number) {
  if (level < threshold) return 1;
  const over = clamp((level - threshold) / Math.max(1, 100 - threshold), 0, 1);
  const ratio = clamp(strength / 100, 0, 1);
  const startReduction = 0.05 + ratio * 0.14;
  const maxReduction = 0.18 + ratio * 0.38;
  const reduction = startReduction + (maxReduction - startReduction) * over;
  return clamp(1 - reduction, 1 - maxReduction, 1 - startReduction);
}

function createAutoThresholdBaseline(startedAtMs = 0): AutoThresholdBaseline {
  return { startedAtMs, levels: [], voiceLevels: [], lastUpdateMs: 0 };
}

function pushRollingSample(samples: number[], value: number) {
  samples.push(value);
  if (samples.length > CFG.autoThresholdSampleLimit) samples.shift();
}

function percentile(sortedValues: number[], ratio: number) {
  if (sortedValues.length === 0) return 0;
  const index = clamp(Math.floor((sortedValues.length - 1) * ratio), 0, sortedValues.length - 1);
  return sortedValues[index] ?? 0;
}

function computeAutoThreshold(baseline: AutoThresholdBaseline, fallback: number) {
  if (baseline.voiceLevels.length < 8) return fallback;
  const samples = baseline.voiceLevels;

  const sorted = [...samples].sort((a, b) => a - b);
  const average = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const p75 = percentile(sorted, 0.75);
  const ambientSorted = [...baseline.levels].sort((a, b) => a - b);
  const ambientP95 = percentile(ambientSorted, 0.95);
  const target = Math.max(ambientP95 + 18, average * 1.45 + 14, p75 + 10, CFG.autoThresholdMin);
  return Math.round(clamp(target, CFG.autoThresholdMin, CFG.autoThresholdMax));
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

function emotionPredictionValue(prediction: EmotionPrediction | null, voiceActivity = true) {
  if (!voiceActivity) return "대기";
  if (!prediction) return "계산중";
  return `${emotionLabel[prediction.label]} ${Math.round(prediction.confidence * 100)}%`;
}

function normalizeSpeechWord(value: string) {
  return value.toLowerCase().replace(/[^0-9a-z가-힣ㄱ-ㅎㅏ-ㅣ]/g, "");
}

const liveSttHallucinationPatterns = [
  /mbc\s*뉴스/i,
  /mbc뉴스/i,
  /이덕영입니다/,
  /뉴스\s*[가-힣]{2,5}입니다/,
  /자막\s*제공/i,
  /시청해\s*주셔서\s*감사합니다/,
  /구독.*좋아요/,
  /광고.*후/i,
  /연합뉴스/i,
  /한국경제\s*tv/i,
  /영상\s*편집/i,
  /자막.*사용/i,
  /사용하였습니다/,
  /잘\s*들리시나요/,
];

function compactTranscriptText(value: string) {
  return value
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[.,!?~…'"“”‘’]/g, "");
}

function commonPrefixLength(left: string, right: string) {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

function transcriptsLookRelated(left: string, right: string, minLength = 8) {
  const compactLeft = compactTranscriptText(left);
  const compactRight = compactTranscriptText(right);
  if (!compactLeft || !compactRight) return false;
  if (compactLeft === compactRight) return true;

  const [shorter, longer] = compactLeft.length <= compactRight.length
    ? [compactLeft, compactRight]
    : [compactRight, compactLeft];

  if (shorter.length >= minLength && longer.includes(shorter)) return true;

  const prefixLength = commonPrefixLength(compactLeft, compactRight);
  if (prefixLength >= Math.min(18, shorter.length) && prefixLength / Math.max(1, shorter.length) >= 0.7) {
    return true;
  }

  return false;
}

function collapseConsecutiveDuplicatePhrases(text: string) {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 6) return text;

  let changed = true;
  while (changed) {
    changed = false;
    for (let size = Math.floor(words.length / 2); size >= 3; size -= 1) {
      for (let index = 0; index + size * 2 <= words.length; index += 1) {
        const left = words.slice(index, index + size).map(normalizeSpeechWord).join("");
        const right = words.slice(index + size, index + size * 2).map(normalizeSpeechWord).join("");
        if (left && left === right) {
          words.splice(index + size, size);
          changed = true;
          break;
        }
      }
      if (changed) break;
    }
  }

  return words.join(" ");
}

function sanitizeTranscriptText(value: string) {
  const cleaned = value
    .replace(/이전 상담 문맥\s*:\s*/g, "")
    .replace(/이어지는 발화를 한국어로 그대로 받아쓰기\.?/g, "")
    .replace(/문맥에 없는 내용을 새로 만들지 말 것\.?/g, "")
    .replace(/한국어 음성을 들리는 대로 그대로 받아쓰기\.?/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return collapseConsecutiveDuplicatePhrases(cleaned);
}

function isLikelyLiveSttHallucination(text: string) {
  const compact = compactTranscriptText(text);
  if (!compact) return true;
  return liveSttHallucinationPatterns.some((pattern) => pattern.test(text) || pattern.test(compact));
}

function isTimestampWordMatch(word: string, trigger: string) {
  if (!word || !trigger) return false;
  if (word === trigger) return true;
  if (word.length >= 3 && word.includes(trigger)) return true;
  if (trigger.length >= 3 && word.includes(trigger.slice(0, Math.max(2, trigger.length - 1)))) return true;
  return false;
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

function wordTimestampSegments(words: TranscriptionWord[], triggeredWords: string[]) {
  const normalizedTriggers = triggeredWords.map(normalizeSpeechWord).filter(Boolean);
  if (normalizedTriggers.length === 0) return [];

  const segments = words
    .map((item) => {
      const normalizedWord = normalizeSpeechWord(item.word);
      const matchedTrigger = normalizedTriggers.find((trigger) => isTimestampWordMatch(normalizedWord, trigger));
      if (!matchedTrigger) return null;
      const duration = Math.max(0.08, item.end - item.start);
      const triggerIndex = Math.max(0, normalizedWord.indexOf(matchedTrigger));
      const triggerLength = Math.max(1, matchedTrigger.length);
      const wordLength = Math.max(triggerLength, normalizedWord.length);
      const isCompoundWord = normalizedWord !== matchedTrigger && normalizedWord.includes(matchedTrigger) && wordLength > triggerLength;
      const startRatio = isCompoundWord ? triggerIndex / wordLength : 0;
      const endRatio = isCompoundWord ? (triggerIndex + triggerLength) / wordLength : 1;
      const triggerStart = item.start + duration * startRatio;
      const triggerEnd = item.start + duration * endRatio;
      return {
        start: Math.max(0, triggerStart - CFG.beepPreRollMs / 1000),
        end: Math.max(triggerStart + 0.12, triggerEnd + CFG.beepPostRollMs / 1000),
      };
    })
    .filter((item): item is { start: number; end: number } => Boolean(item))
    .sort((a, b) => a.start - b.start);

  return segments.reduce<Array<{ start: number; end: number }>>((merged, segment) => {
    const last = merged.at(-1);
    if (!last || segment.start > last.end + 0.05) {
      merged.push(segment);
    } else {
      last.end = Math.max(last.end, segment.end);
    }
    return merged;
  }, []);
}

function maskTextByWords(text: string, words: string[]) {
  return words
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .reduce((masked, word) => {
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const compact = normalizeSpeechWord(word);
      const flexible = compact
        ? Array.from(compact).map((character) => character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s*")
        : "";
      return [escaped, flexible]
        .filter(Boolean)
        .reduce((nextMasked, pattern) => {
          return nextMasked.replace(new RegExp(pattern, "gi"), (match) => "*".repeat(Array.from(match).length));
        }, masked);
    }, text);
}

function maskVisibleText(text: string) {
  const preserved: Array<[string, string]> = [];
  let visible = sanitizeTranscriptText(text);
  visibleMaskExceptions.forEach((exception, index) => {
    const token = `__EG_SAFE_${index}__`;
    preserved.push([token, exception]);
    visible = visible.replace(new RegExp(exception.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), token);
  });
  let masked = maskTextByWords(visible, visibleMaskWords);
  preserved.forEach(([token, exception]) => {
    masked = masked.replace(new RegExp(token, "g"), exception);
  });
  return masked;
}

const genericContextTriggers = new Set([
  "목소리",
  "퇴근",
  "퇴근몇시",
  "퇴근시간",
  "몇시에끝나",
  "집",
  "주소",
  "사는곳",
  "얼굴",
  "개인연락처",
  "개인번호",
  "카톡아이디",
  "인스타",
].map(normalizeSpeechWord));

function isGenericContextTrigger(word: string) {
  const normalized = normalizeSpeechWord(word);
  return Array.from(genericContextTriggers).some((trigger) => normalized === trigger || normalized.includes(trigger));
}

function presentContextWords(text: string, candidates: string[]) {
  const compact = normalizeSpeechWord(text);
  return candidates.filter((candidate) => compact.includes(normalizeSpeechWord(candidate)));
}

function contextualSensitiveWords(text: string) {
  const compact = normalizeSpeechWord(text);
  const words: string[] = [];

  if (compact.includes("목소리") && compact.includes("섹시")) {
    words.push(...presentContextWords(text, ["섹시해요", "섹시합니다", "섹시하네요", "섹시해", "섹시"]));
  }

  if (compact.includes("퇴근") && (compact.includes("기다릴") || compact.includes("기다리"))) {
    words.push(...presentContextWords(text, [
      "기다릴게요",
      "기다릴께요",
      "기다릴게",
      "기다릴께",
      "기다리고있을게요",
      "기다리고있을게",
      "기다리겠습니다",
    ]));
  }

  if ((compact.includes("집") || compact.includes("주소") || compact.includes("사는곳")) && compact.includes("찾아")) {
    words.push(...presentContextWords(text, ["찾아갈게요", "찾아갈게", "찾아간다", "찾아가겠습니다"]));
  }

  return Array.from(new Set(words));
}

function sensitiveWordsForResult(text: string, result: AnalyzeResponse) {
  const directWords = result.triggeredWords.filter((word) => !isGenericContextTrigger(word));
  const contextualWords = result.eventType === "sexual" ? contextualSensitiveWords(text) : [];
  return Array.from(new Set([...directWords, ...contextualWords]));
}

function withDisplayMask(result: AnalyzeResponse, text: string) {
  const displaySource = result.detectionPath === "context_snapshot" && text.trim()
    ? text
    : result.maskedText || text;
  if (result.eventType === "normal") return { ...result, maskedText: displaySource };
  const maskedText = maskTextByWords(displaySource, sensitiveWordsForResult(displaySource, result));
  return maskedText === result.maskedText ? result : { ...result, maskedText };
}

function uniqueValues<T extends string>(items: T[]) {
  return Array.from(new Set(items));
}

function logTextScore(log: LogEntry) {
  const text = sanitizeTranscriptText(log.maskedText || log.text);
  const length = compactTranscriptText(text).length;
  const runawayPenalty = Math.max(0, length - 220) * 2;
  return (
    (log.detectionPath === "immediate" ? 1000 : 0) +
    (log.eventType !== "normal" ? 150 : 0) +
    Math.min(length, 180) -
    runawayPenalty
  );
}

function bestLogText(logs: LogEntry[]) {
  const best = logs
    .slice()
    .sort((left, right) => logTextScore(right) - logTextScore(left))[0];
  return sanitizeTranscriptText(best?.maskedText || best?.text || "");
}

function eventRank(eventType: EventType) {
  return {
    normal: 0,
    raised: 1,
    abuse: 2,
    "abuse-raised": 3,
    sexual: 4,
  }[eventType];
}

function severityRank(severity: AnalyzeResponse["severity"]) {
  return { none: 0, mild: 1, severe: 2 }[severity];
}

function bestLogJudgement(logs: LogEntry[]) {
  return logs
    .slice()
    .sort((left, right) => {
      const eventDiff = eventRank(right.eventType) - eventRank(left.eventType);
      if (eventDiff) return eventDiff;
      const severityDiff = severityRank(right.severity) - severityRank(left.severity);
      if (severityDiff) return severityDiff;
      const pathDiff = (right.detectionPath === "immediate" ? 1 : 0) - (left.detectionPath === "immediate" ? 1 : 0);
      if (pathDiff) return pathDiff;
      return logTextScore(right) - logTextScore(left);
    })[0];
}

function shouldMergeLogCandidate(candidate: LogEntry, entry: LogEntry) {
  const compatibleEvent =
    candidate.eventType === entry.eventType ||
    candidate.eventType === "normal" ||
    entry.eventType === "normal";
  if (!compatibleEvent) return false;

  if (transcriptsLookRelated(candidate.maskedText || candidate.text, entry.maskedText || entry.text, 5)) {
    return true;
  }

  const candidateLoggedAt = candidate.loggedAtMs ?? 0;
  const entryLoggedAt = entry.loggedAtMs ?? Date.now();
  const sameShortWindow = candidateLoggedAt > 0 && Math.abs(entryLoggedAt - candidateLoggedAt) <= 3200;
  const sameRiskTurn =
    sameShortWindow &&
    candidate.eventType !== "normal" &&
    entry.eventType !== "normal" &&
    candidate.detectionPath !== entry.detectionPath;

  return sameRiskTurn;
}

function fallbackWordTimings(text: string): TranscriptionWord[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const duration = Math.max(0.9, words.join("").length * 0.12);
  let cursor = 0;

  return words.map((word) => {
    const share = Math.max(0.18, duration * (Array.from(word).length / Math.max(1, text.replace(/\s/g, "").length)));
    const timing = { word, start: cursor, end: cursor + share };
    cursor += share + 0.06;
    return timing;
  });
}

function streamingTranscriptFrames(transcription: TranscribeResponse, fallbackText: string) {
  const words = transcription.words.length > 0
    ? transcription.words
    : fallbackWordTimings(transcription.text || fallbackText);
  const frames: Array<{ at: number; text: string; syllables: number }> = [];
  let visible = "";
  let syllables = 0;

  words.forEach((wordTiming) => {
    const characters = Array.from(wordTiming.word);
    const wordDuration = Math.max(0.12, wordTiming.end - wordTiming.start);

    characters.forEach((character, index) => {
      const nextVisible = `${visible}${character}`;
      syllables += /[가-힣]/.test(character) ? 1 : 0;
      frames.push({
        at: wordTiming.start + (wordDuration * (index + 1)) / Math.max(1, characters.length),
        text: nextVisible.trim(),
        syllables,
      });
      visible = nextVisible;
    });

    visible = `${visible} `;
  });

  return frames;
}

function beepDurationFor(result: AnalyzeResponse, words = result.triggeredWords) {
  const longest = words.reduce((max, word) => Math.max(max, word.length), 0);
  return clamp(CFG.beepMinMs + longest * CFG.beepCharMs, CFG.beepMinMs, CFG.beepMaxMs);
}

function initialCounts() {
  return { normal: 0, abuse: 0, sexual: 0, raised: 0, "abuse-raised": 0 } as Record<EventType, number>;
}

function initialEscalation(): EscalationState {
  return { abuse: 0, sexual: 0 };
}

function initialFeedbackContext(): FeedbackContext {
  return {
    sessionRiskScore: 0,
    repeatedRisk: false,
    abuseCount: 0,
    sexualCount: 0,
    raisedCount: 0,
    normalCount: 0,
    recentEvents: [],
    recentEmotions: [],
    recentCategories: [],
    recentTriggeredWords: [],
    lastEventType: null,
    lastEmotion: null,
    acousticTrend: "stable",
    notes: [],
  };
}

function appendTail<T>(items: T[], item: T, limit: number) {
  return [...items, item].slice(-limit);
}

function appendUniqueTail(items: string[], incoming: string[], limit: number) {
  return uniqueValues([...items, ...incoming].filter(Boolean)).slice(-limit);
}

function acousticTrendFrom(features?: AudioFeatures | null): FeedbackContext["acousticTrend"] {
  if (!features?.voiceActivity) return "quiet";
  const rms = features.rmsPercent ?? 0;
  const zcr = features.zeroCrossingRate ?? 0;
  const speed = features.syllablesPerSecond ?? 0;
  const pitchConfidence = features.pitchConfidence ?? 0;
  const pitch = features.pitchHz ?? 0;
  if (rms >= 70 || zcr >= 0.18 || speed >= 7.2 || (pitchConfidence >= 0.45 && pitch >= 260)) {
    return "escalating";
  }
  return "stable";
}

function feedbackRiskDelta(result: AnalyzeResponse, features?: AudioFeatures | null) {
  const eventWeight: Record<EventType, number> = {
    normal: 0,
    raised: 10,
    abuse: 24,
    "abuse-raised": 34,
    sexual: 38,
  };
  const emotionWeight = result.emotion === "threatening" ? 18 : result.emotion === "angry" ? 12 : result.emotion === "frustrated" ? 5 : 0;
  const severityWeight = result.severity === "severe" ? 14 : result.severity === "mild" ? 6 : 0;
  const acousticWeight = acousticTrendFrom(features) === "escalating" ? 8 : 0;
  return eventWeight[result.eventType] + emotionWeight + severityWeight + acousticWeight;
}

function feedbackNotesFor(context: FeedbackContext) {
  const notes: string[] = [];
  if (context.repeatedRisk) notes.push("repeated-risk");
  if (context.sexualCount > 0) notes.push("prior-sexual-cue");
  if (context.abuseCount + context.raisedCount >= 2) notes.push("abuse-raised-pattern");
  if (context.acousticTrend === "escalating") notes.push("acoustic-escalation");
  if (context.sessionRiskScore >= 70) notes.push("high-session-risk");
  return notes.slice(-20);
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
        .map((item, index) => `${index + 1}. [${item.timestamp}] ${eventLabel[item.eventType]} / ${pathLabel[item.detectionPath]} / ${maskVisibleText(item.maskedText || item.text)}`)
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
                <article key={evidence.id} className={`report-evidence-card ${evidence.eventType}`}>
                  <div className="report-evidence-meta">
                    <small>[{evidence.timestamp}] · {eventLabel[evidence.eventType]} · {pathLabel[evidence.detectionPath]}</small>
                    <b>{evidence.source === "openai" ? "GPT" : evidence.source === "local" ? "비윤리 표현" : "보조 판단"}</b>
                  </div>
                  <p><span>보호 표시</span>{maskVisibleText(evidence.maskedText || evidence.text)}</p>
                  <div className="report-evidence-actions">
                    {evidence.policyActions.map((action) => (
                      <i key={action}>{actionLabel[action]}</i>
                    ))}
                  </div>
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
  const [autoThreshold, setAutoThreshold] = useState(42);
  const [autoThresholdEnabled, setAutoThresholdEnabled] = useState(true);
  const [attenuationStrength, setAttenuationStrength] = useState(65);
  const [pitchThreshold, setPitchThreshold] = useState(240);
  const [monitorEnabled, setMonitorEnabled] = useState(true);
  const [, setInterimText] = useState("상담을 시작하면 실시간 STT 인터림과 보호 상태가 표시됩니다.");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [muted, setMuted] = useState(false);
  const [status, setStatus] = useState("대기 중");
  const [demoStep, setDemoStep] = useState("데모 버튼을 누르면 즉시 보호 경로와 3초 문맥 경로가 순서대로 표시됩니다.");
  const [demoDialogue, setDemoDialogue] = useState<DemoDialogueLine[]>([]);
  const [liveTranscript, setLiveTranscript] = useState("");
  const [demoPhase, setDemoPhase] = useState<DemoPhase>("idle");
  const [litPhases, setLitPhases] = useState<DemoPhase[]>([]);
  const [escalation, setEscalation] = useState<EscalationState>(() => initialEscalation());
  const [reportArchive, setReportArchive] = useState<IncidentReport[]>(() => loadReportArchive());
  const [audioFeatures, setAudioFeatures] = useState<AudioFeatures>({ rms: 0, rmsPercent: 0, peak: 0, zeroCrossingRate: 0, voiceActivity: false });
  const [emotionPrediction, setEmotionPrediction] = useState<EmotionPrediction | null>(null);
  const [feedbackContext, setFeedbackContext] = useState<FeedbackContext>(() => initialFeedbackContext());
  const [latestDetection, setLatestDetection] = useState<LatestDetectionView | null>(null);
  const [error, setError] = useState("");

  const countersRef = useRef(initialCounts());
  const logsRef = useRef<LogEntry[]>([]);
  const reportLogsRef = useRef<LogEntry[]>([]);
  const contextBufferRef = useRef<string[]>([]);
  const feedbackContextRef = useRef<FeedbackContext>(initialFeedbackContext());
  const escalationRef = useRef<EscalationState>(initialEscalation());
  const seenEventRef = useRef(new Set<string>());
  const seenStageRef = useRef(new Set<string>());
  const lastBeepRef = useRef<{ key: string; at: number } | null>(null);
  const lastFeedbackRef = useRef<{ key: string; at: number } | null>(null);
  const announcingRef = useRef(false);
  const interimCheckRef = useRef<{ timer?: number; lastText: string }>({ lastText: "" });
  const speechStartAtRef = useRef<number | null>(null);
  const sessionStartedAtRef = useRef<Date | null>(null);
  const sessionStartedAtMsRef = useRef<number | null>(null);
  const sessionRunIdRef = useRef(0);
  const activeRef = useRef(false);
  const elapsedRef = useRef(0);
  const timelineRef = useRef<HTMLDivElement>(null);
  const audioFeaturesRef = useRef<AudioFeatures>({ rms: 0, rmsPercent: 0, peak: 0, zeroCrossingRate: 0, voiceActivity: false });
  const featureUiTsRef = useRef(0);
  const thresholdRef = useRef(42);
  const autoThresholdRef = useRef(42);
  const autoThresholdEnabledRef = useRef(true);
  const autoBaselineRef = useRef<AutoThresholdBaseline>(createAutoThresholdBaseline());
  const attenuationStrengthRef = useRef(65);
  const pitchThresholdRef = useRef(240);
  const browserDictationRef = useRef(false);
  const lastBrowserDictationRef = useRef<{ text: string; at: number } | null>(null);
  const demoAudioRef = useRef<{
    ctx?: AudioContext;
    sources: AudioBufferSourceNode[];
    timers: number[];
  }>({ sources: [], timers: [] });
  const demoTranscriptionCacheRef = useRef<Partial<Record<DemoAudioKey, TranscribeResponse>>>({});
  const liveChunkRef = useRef<{ enabled: boolean; inFlight: number; timer?: number; lastProbeTs: number }>({
    enabled: false,
    inFlight: 0,
    lastProbeTs: 0,
  });
  const lastNormalTranscriptRef = useRef<{ text: string; at: number } | null>(null);
  const lastContextSnapshotRef = useRef("");
  const emotionPredictRef = useRef<{ inFlight: boolean; lastAt: number }>({ inFlight: false, lastAt: 0 });

  const audioRef = useRef<{
    stream?: MediaStream;
    ctx?: AudioContext;
    analyser?: AnalyserNode;
    jungle?: Jungle;
    outGain?: GainNode;
    dryGain?: GainNode;
    processedGain?: GainNode;
    loudnessGain?: GainNode;
    modulationGain?: GainNode;
    modulationCarrierGain?: GainNode;
    raf?: number;
    raisedSustainMs: number;
    raisedLatched: boolean;
    lastRaisedTs: number;
    mediaRecorder?: MediaRecorder;
    recognition?: SpeechRecognition;
    timer?: number;
    contextTimer?: number;
    maskTimer?: number;
    maskUntilAt?: number;
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
    const liveEntry: ConversationEntry[] = active && liveTranscript.trim()
      ? [{
          id: "live-transcript",
          timestamp: formatDuration(elapsed),
          role: "고객",
          text: maskVisibleText(liveTranscript.trim()),
          detail: "받아쓰기 중",
          tone: "normal",
        }]
      : [];
    const dialogue = demoDialogue.filter((line) => line.role !== "상담사");
    if (dialogue.length > 0) {
      const dialogueEntries: ConversationEntry[] = dialogue.map((line) => {
        const risk = line.tone === "risk";
        return {
          id: line.id,
          timestamp: line.timestamp,
          role: line.role,
          text: line.role === "고객" ? maskVisibleText(line.text) : line.text,
          detail: line.detail ?? (risk ? "위험 구간만 * 마스킹 · 보호 오디오 출력" : line.role === "시스템" ? "시스템 보호 조치" : "고객 발화"),
          tone: line.tone ?? "normal",
          eventType: risk ? ("abuse" as EventType) : undefined,
        };
      });
      return [...dialogueEntries, ...liveEntry];
    }

    const logEntries: ConversationEntry[] = timelineEntries.map((log) => ({
      id: log.id,
      timestamp: log.timestamp,
      role: "고객",
      text: maskVisibleText(log.maskedText),
      detail: timelineDetailFor(log),
      tone: log.eventType === "normal" ? "normal" : "risk",
      eventType: log.eventType,
    }));
    return [...logEntries, ...liveEntry];
  }, [active, demoDialogue, elapsed, liveTranscript, timelineEntries]);

  const abuseStage = escalation.abuse;
  const sexualStage = escalation.sexual;
  const litPhaseSet = useMemo(() => new Set(litPhases), [litPhases]);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");
  const effectiveThreshold = autoThresholdEnabled ? autoThreshold : threshold;
  const normalizedRoute = routePath.replace(/\/$/, "") || "/";

  function navigate(path: string) {
    window.history.pushState(null, "", path);
    setRoutePath(path);
  }

  function currentSessionSeconds() {
    if (!activeRef.current || sessionStartedAtMsRef.current === null) return elapsedRef.current;
    const seconds = Math.max(0, Math.floor((performance.now() - sessionStartedAtMsRef.current) / 1000));
    elapsedRef.current = seconds;
    return seconds;
  }

  function currentSessionTimestamp() {
    return formatDuration(currentSessionSeconds());
  }

  async function predictLiveEmotion(features: AudioFeatures) {
    if (!activeRef.current || !features.voiceActivity) return;
    const nowMs = Date.now();
    if (emotionPredictRef.current.inFlight || nowMs - emotionPredictRef.current.lastAt < 900) return;
    emotionPredictRef.current = { inFlight: true, lastAt: nowMs };
    try {
      const prediction = await predictEmotion(features);
      if (activeRef.current) setEmotionPrediction(prediction);
    } catch {
      // Emotion prediction is advisory only; live protection continues without it.
    } finally {
      emotionPredictRef.current.inFlight = false;
    }
  }

  function dictationPrompt() {
    return "";
  }

  function recentBrowserDictation(maxAgeMs = 3000) {
    const recent = lastBrowserDictationRef.current;
    if (!recent || Date.now() - recent.at > maxAgeMs) return "";
    return recent.text;
  }

  function markDemoPhase(phase: DemoPhase) {
    setDemoPhase(phase);
    if (phase === "idle") return;
    setLitPhases((prev) => (prev.includes(phase) ? prev : [...prev, phase]));
  }

  function resetAutoThresholdLearning(seed = thresholdRef.current) {
    autoBaselineRef.current = createAutoThresholdBaseline(performance.now());
    autoThresholdRef.current = seed;
    setAutoThreshold(seed);
  }

  function toggleAutoThresholdMode() {
    if (autoThresholdEnabledRef.current) {
      thresholdRef.current = autoThresholdRef.current;
      autoThresholdEnabledRef.current = false;
      setThreshold(autoThresholdRef.current);
      setAutoThresholdEnabled(false);
      return;
    }

    autoThresholdEnabledRef.current = true;
    resetAutoThresholdLearning(thresholdRef.current);
    setAutoThresholdEnabled(true);
  }

  function pushDemoDialogue(
    role: DemoDialogueLine["role"],
    text: string,
    tone: DemoDialogueLine["tone"] = "normal",
    timestamp = currentSessionTimestamp(),
    detail?: string,
  ) {
    const id = crypto.randomUUID();
    setDemoDialogue((prev) => [
      ...prev,
      { id, role, text, tone, timestamp, detail },
    ].slice(-80));
    return id;
  }

  function updateDemoDialogue(id: string, patch: Partial<Omit<DemoDialogueLine, "id">>) {
    setDemoDialogue((prev) => prev.map((line) => (line.id === id ? { ...line, ...patch } : line)));
  }

  function scheduleStreamingSttLine(
    lineId: string,
    transcription: TranscribeResponse,
    fallbackText: string,
    sensitive: boolean,
    finalSensitiveText?: string,
  ) {
    const frames = streamingTranscriptFrames(transcription, fallbackText).slice(0, 120);
    const finalText = transcription.text || fallbackText;
    const timers = frames.map((frame) => window.setTimeout(() => {
      if (sensitive) return;

      updateDemoDialogue(lineId, {
        text: frame.text,
        detail: "고객 발화",
      });
    }, Math.max(0, frame.at * 1000)));

    const finalAt = frames.at(-1)?.at ?? 0.8;
    timers.push(window.setTimeout(() => {
      updateDemoDialogue(lineId, {
        text: sensitive ? finalSensitiveText ?? finalText : finalText,
        detail: sensitive ? "위험 구간만 * 마스킹" : "고객 발화",
      });
    }, Math.max(650, finalAt * 1000 + 160)));

    demoAudioRef.current.timers.push(...timers);
  }

  useEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline) return;
    timeline.scrollTo({ top: timeline.scrollHeight, behavior: "smooth" });
  }, [logs, demoDialogue, liveTranscript]);

  useEffect(() => {
    if (demoPhase === "idle") return;
    const timer = window.setTimeout(() => {
      setDemoPhase("idle");
    }, 2600);
    return () => window.clearTimeout(timer);
  }, [demoPhase]);

  useEffect(() => {
    const syncRoute = () => setRoutePath(window.location.pathname);
    window.addEventListener("popstate", syncRoute);
    return () => window.removeEventListener("popstate", syncRoute);
  }, []);

  useEffect(() => {
    thresholdRef.current = threshold;
  }, [threshold]);

  useEffect(() => {
    autoThresholdRef.current = autoThreshold;
  }, [autoThreshold]);

  useEffect(() => {
    autoThresholdEnabledRef.current = autoThresholdEnabled;
  }, [autoThresholdEnabled]);

  useEffect(() => {
    attenuationStrengthRef.current = attenuationStrength;
  }, [attenuationStrength]);

  useEffect(() => {
    pitchThresholdRef.current = pitchThreshold;
  }, [pitchThreshold]);

  useEffect(() => {
    const { ctx, outGain } = audioRef.current;
    if (!ctx || !outGain) return;
    outGain.gain.cancelScheduledValues(ctx.currentTime);
    outGain.gain.setTargetAtTime(monitorEnabled ? MONITOR_GAIN : 0, ctx.currentTime, 0.03);
  }, [monitorEnabled]);

  async function startAudio(monitorOn = monitorEnabled) {
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
    const ctx = new AudioContextCtor();
    if (ctx.state === "suspended") await ctx.resume();

    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);

    const jungle = new Jungle(ctx);
    const dryDelay = ctx.createDelay(Math.max(3, CFG.outputDelay + 0.4));
    const processedDelay = ctx.createDelay(Math.max(3, CFG.outputDelay + 0.4));
    const dryGain = ctx.createGain();
    const processedGain = ctx.createGain();
    const loudnessGain = ctx.createGain();
    const modulationGain = ctx.createGain();
    const modulationCarrier = ctx.createOscillator();
    const modulationCarrierGain = ctx.createGain();
    const outGain = ctx.createGain();
    dryDelay.delayTime.value = CFG.outputDelay;
    processedDelay.delayTime.value = CFG.outputDelay;
    dryGain.gain.value = 1;
    processedGain.gain.value = 0;
    loudnessGain.gain.value = 1;
    modulationGain.gain.value = 1;
    modulationCarrier.type = "square";
    modulationCarrier.frequency.value = 54;
    modulationCarrierGain.gain.value = 0;
    outGain.gain.value = monitorOn ? MONITOR_GAIN : 0;

    source.connect(dryDelay);
    dryDelay.connect(dryGain);
    dryGain.connect(loudnessGain);
    source.connect(jungle.input);
    jungle.output.connect(processedDelay);
    modulationCarrier.connect(modulationCarrierGain);
    modulationCarrierGain.connect(modulationGain.gain);
    processedDelay.connect(modulationGain);
    modulationGain.connect(processedGain);
    processedGain.connect(loudnessGain);
    loudnessGain.connect(outGain);
    outGain.connect(ctx.destination);
    modulationCarrier.start();

    audioRef.current = {
      ...audioRef.current,
      stream,
      ctx,
      analyser,
      jungle,
      outGain,
      dryGain,
      processedGain,
      loudnessGain,
      modulationGain,
      modulationCarrierGain,
    };
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
      if (autoThresholdEnabledRef.current) {
        const baseline = autoBaselineRef.current;
        if (!baseline.startedAtMs) baseline.startedAtMs = t;
        if (nextLevel <= CFG.autoThresholdMax + 8) {
          pushRollingSample(baseline.levels, nextLevel);
          if (rawVoiceActivity && nextLevel >= 1) pushRollingSample(baseline.voiceLevels, nextLevel);
        }

        if (t - baseline.lastUpdateMs >= CFG.autoThresholdUpdateMs) {
          const nextAutoThreshold = computeAutoThreshold(baseline, autoThresholdRef.current);
          const warmup = t - baseline.startedAtMs < CFG.autoThresholdWarmupMs;
          const smoothed = warmup
            ? nextAutoThreshold
            : Math.round(autoThresholdRef.current * 0.85 + nextAutoThreshold * 0.15);
          if (Math.abs(smoothed - autoThresholdRef.current) >= 1) {
            autoThresholdRef.current = smoothed;
            setAutoThreshold(smoothed);
          }
          baseline.lastUpdateMs = t;
        }
      }

      const activeThreshold = autoThresholdEnabledRef.current ? autoThresholdRef.current : thresholdRef.current;
      const pitchProtection = pitchProtectionForShout(
        nextLevel,
        activeThreshold,
        pitch.pitchHz,
        pitch.confidence,
        pitchThresholdRef.current,
        attenuationStrengthRef.current,
      );
      const offset = pitchProtection.offset;
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
      if (voiceActivity) {
        void predictLiveEmotion(nextFeatures);
      }

      if (t - featureUiTsRef.current > 220) {
        featureUiTsRef.current = t;
        setAudioFeatures(nextFeatures);
        if (!voiceActivity) setEmotionPrediction(null);
        const nextStatus = pitchProtection.modulationTriggered
          ? pitchProtection.pitchTriggered
            ? "피치 기준 초과 음성 변조"
            : "고성 기준 초과 음성 변조"
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
      if (current.dryGain && current.processedGain && current.ctx) {
        const processedMix = pitchProtection.modulationTriggered ? 1 : offset < 0 ? 0.85 : 0;
        current.dryGain.gain.setTargetAtTime(1 - processedMix, current.ctx.currentTime, 0.04);
        current.processedGain.gain.setTargetAtTime(processedMix, current.ctx.currentTime, 0.04);
      }
      if (current.modulationGain && current.modulationCarrierGain && current.ctx) {
        current.modulationGain.gain.setTargetAtTime(pitchProtection.modulationTriggered ? 0.58 : 1, current.ctx.currentTime, 0.025);
        current.modulationCarrierGain.gain.setTargetAtTime(pitchProtection.modulationTriggered ? 0.48 : 0, current.ctx.currentTime, 0.025);
      }
      if (current.loudnessGain && current.ctx) {
        current.loudnessGain.gain.setTargetAtTime(loudnessGainForLevel(nextLevel, activeThreshold, attenuationStrengthRef.current), current.ctx.currentTime, 0.05);
      }

      if (!announcingRef.current && pitchProtection.active) {
        current.raisedSustainMs += dt;
        if (current.raisedSustainMs >= CFG.raisedSustainMs && !current.raisedLatched) {
          current.raisedLatched = true;
          current.lastRaisedTs = Date.now();
          markDemoPhase("detect");
          markDemoPhase("mask");
          setInterimText(pitchProtection.pitchTriggered
            ? "피치 기준 초과 감지 - 출력 커서에서 음성을 변조합니다."
            : "RMS 고성 감지 - 출력 커서에서 음성을 변조합니다.");
          setStatus(pitchProtection.pitchTriggered ? "피치 기준 초과 음성 변조" : "고성 기준 초과 음성 변조");
        }
      } else if (nextLevel < activeThreshold * 0.8) {
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

  function stopDemoAudio() {
    demoAudioRef.current.sources.forEach((source) => {
      try {
        source.stop();
      } catch {
        // 이미 종료된 데모 소스는 무시합니다.
      }
    });
    demoAudioRef.current.timers.forEach((timer) => window.clearTimeout(timer));
    void demoAudioRef.current.ctx?.close();
    demoAudioRef.current = { sources: [], timers: [] };
  }

  async function transcribeDemoAudio(key: DemoAudioKey) {
    const cached = demoTranscriptionCacheRef.current[key];
    if (cached) return cached;

    const spec = demoAudioSpecs[key];
    const response = await fetch(spec.src);
    if (!response.ok) throw new Error(`Demo audio fetch failed: ${response.status}`);
    const blob = await response.blob();
    const transcription = await transcribeAudioBlob(blob, `${key}.mp3`);
    demoTranscriptionCacheRef.current[key] = transcription;
    return transcription;
  }

  async function playDemoAudio(key: DemoAudioKey, beepSegments: Array<{ start: number; end: number }> = []) {
    stopDemoAudio();
    const spec = demoAudioSpecs[key];
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioContextCtor();
    if (ctx.state === "suspended") await ctx.resume();

    const response = await fetch(spec.src);
    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    const startAt = ctx.currentTime + 0.06;
    const volume = spec.volume ?? 0.9;

    source.buffer = audioBuffer;
    source.connect(gain);
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(volume, startAt);

    beepSegments.forEach((segment) => {
      const segmentStart = startAt + Math.max(0, segment.start);
      const segmentEnd = startAt + Math.max(segment.start + 0.08, segment.end);
      const pre = Math.max(startAt, segmentStart - 0.025);
      const post = segmentEnd + 0.035;

      gain.gain.setValueAtTime(volume, pre);
      gain.gain.linearRampToValueAtTime(0.0001, segmentStart);
      gain.gain.setValueAtTime(0.0001, segmentEnd);
      gain.gain.linearRampToValueAtTime(volume, post);
      playBeep(ctx, segmentStart, Math.max(180, (segmentEnd - segmentStart) * 1000));
    });

    source.start(startAt);
    source.onended = () => {
      source.disconnect();
      gain.disconnect();
    };

    const closeTimer = window.setTimeout(() => {
      void ctx.close();
      if (demoAudioRef.current.ctx === ctx) demoAudioRef.current = { sources: [], timers: [] };
    }, audioBuffer.duration * 1000 + 700);

    demoAudioRef.current = { ctx, sources: [source], timers: [closeTimer] };
    return audioBuffer.duration * 1000;
  }

  function estimateBeepStart(result: AnalyzeResponse, text: string, timing: SpeechTiming | undefined, ctx: AudioContext) {
    const span = findTriggeredSpan(text, sensitiveWordsForResult(text, result));
    if (!span || !timing) return ctx.currentTime + 0.08;

    const utteranceMs = clamp(timing.resultAtMs - timing.startedAtMs, 450, 5000);
    const ratio = clamp((span.index + span.length * 0.08) / Math.max(1, text.length), 0, 0.96);
    const wordInputAtMs = timing.startedAtMs + utteranceMs * ratio - CFG.beepPreRollMs;
    const wordOutputAtMs = wordInputAtMs + CFG.outputDelay * 1000;
    const delaySeconds = Math.max(0.04, (wordOutputAtMs - performance.now()) / 1000);

    return ctx.currentTime + delaySeconds;
  }

  function applyOutputMaskSegments(segments: Array<{ startAt: number; endAt: number }>) {
    const { ctx, outGain } = audioRef.current;
    if (!ctx || !outGain || segments.length === 0) return false;

    const baseGain = monitorEnabled ? MONITOR_GAIN : 0;
    const nowTime = ctx.currentTime;
    const gain = outGain.gain;
    gain.cancelScheduledValues(nowTime);
    const carriedMask = audioRef.current.maskUntilAt && audioRef.current.maskUntilAt > nowTime
      ? [{ startAt: nowTime, endAt: audioRef.current.maskUntilAt }]
      : [];
    const mergedSegments = [...carriedMask, ...segments]
      .map((segment) => ({
        startAt: Math.max(nowTime, segment.startAt),
        endAt: Math.max(segment.startAt + 0.18, segment.endAt),
      }))
      .sort((a, b) => a.startAt - b.startAt)
      .reduce<Array<{ startAt: number; endAt: number }>>((merged, segment) => {
        const last = merged.at(-1);
        if (!last || segment.startAt > last.endAt + 0.08) {
          merged.push(segment);
        } else {
          last.endAt = Math.max(last.endAt, segment.endAt);
        }
        return merged;
      }, []);

    const currentlyMuted = Boolean(audioRef.current.maskUntilAt && audioRef.current.maskUntilAt > nowTime);
    gain.setValueAtTime(currentlyMuted ? 0.0001 : baseGain, nowTime);

    let latestEndAt = nowTime;
    mergedSegments.forEach((segment) => {
      const startsNow = segment.startAt <= nowTime + 0.08;
      const startAt = startsNow ? nowTime + 0.005 : Math.max(nowTime + 0.02, segment.startAt);
      const endAt = Math.max(startAt + 0.2, segment.endAt);
      latestEndAt = Math.max(latestEndAt, endAt);

      if (startsNow) {
        gain.setValueAtTime(0.0001, nowTime + 0.005);
      } else {
        gain.setValueAtTime(baseGain, Math.max(nowTime, startAt - 0.025));
        gain.linearRampToValueAtTime(0.0001, startAt);
      }
      gain.setValueAtTime(0.0001, endAt);
      gain.linearRampToValueAtTime(baseGain, endAt + 0.06);
    });

    segments.forEach((segment) => {
      const startAt = Math.max(nowTime + 0.005, segment.startAt);
      const endAt = Math.max(startAt + 0.2, segment.endAt);
      playBeep(ctx, startAt, Math.max(180, (endAt - startAt) * 1000));
    });

    setMuted(true);
    audioRef.current.maskUntilAt = latestEndAt + 0.06;
    if (audioRef.current.maskTimer) window.clearTimeout(audioRef.current.maskTimer);
    audioRef.current.maskTimer = window.setTimeout(() => {
      setMuted(false);
      if (audioRef.current.ctx === ctx && (!audioRef.current.maskUntilAt || audioRef.current.maskUntilAt <= ctx.currentTime)) {
        audioRef.current.maskUntilAt = undefined;
      }
    }, Math.max(0, (latestEndAt - nowTime) * 1000 + 80));
    return true;
  }

  function scheduleChunkWordMasks(result: AnalyzeResponse, text: string, words: TranscriptionWord[], chunkStartedAtMs: number) {
    if (!result.policyActions.includes("mute")) return false;
    const { ctx } = audioRef.current;
    if (!ctx) return false;

    const segments = wordTimestampSegments(words, sensitiveWordsForResult(text, result));
    if (segments.length === 0) return false;

    const nowMs = performance.now();
    const scheduled = segments.map((segment) => {
      const outputStartMs = chunkStartedAtMs + segment.start * 1000 + CFG.outputDelay * 1000;
      const outputEndMs = chunkStartedAtMs + segment.end * 1000 + CFG.outputDelay * 1000;
      const startAt = ctx.currentTime + Math.max(0.02, (outputStartMs - nowMs) / 1000);
      const endAt = ctx.currentTime + Math.max(0.2, (outputEndMs - nowMs) / 1000);
      return { startAt, endAt };
    });

    return applyOutputMaskSegments(scheduled);
  }

  function beepProfanitySegment(result: AnalyzeResponse, text: string, timing?: SpeechTiming) {
    markDemoPhase("mask");
    const beepKey = `${result.eventType}:${result.triggeredWords.join("|") || result.maskedText || text}`;
    const nowMs = Date.now();
    if (lastBeepRef.current?.key === beepKey && nowMs - lastBeepRef.current.at < CFG.beepDedupeMs) return;
    lastBeepRef.current = { key: beepKey, at: nowMs };

    const { ctx, outGain } = audioRef.current;
    const sensitiveWords = sensitiveWordsForResult(text, result);
    const durationMs = beepDurationFor(result, sensitiveWords) + CFG.beepPreRollMs + CFG.beepPostRollMs;
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
    applyOutputMaskSegments([{ startAt, endAt: startAt + durationMs / 1000 }]);
  }

  function speak(_text: string) {
    announcingRef.current = false;
  }

  function feedbackSnapshot(features?: AudioFeatures | null) {
    const base = feedbackContextRef.current;
    const acousticTrend = acousticTrendFrom(features ?? audioFeaturesRef.current);
    const snapshot = {
      ...base,
      acousticTrend,
      notes: feedbackNotesFor({ ...base, acousticTrend }),
    };
    feedbackContextRef.current = snapshot;
    setFeedbackContext(snapshot);
    return snapshot;
  }

  function updateFeedbackLoop(result: AnalyzeResponse, features?: AudioFeatures | null) {
    const feedbackKey = `${result.eventType}:${compactTranscriptText(result.maskedText)}`;
    const feedbackNow = Date.now();
    if (lastFeedbackRef.current?.key === feedbackKey && feedbackNow - lastFeedbackRef.current.at < 2600) {
      return;
    }
    lastFeedbackRef.current = { key: feedbackKey, at: feedbackNow };

    const prev = feedbackContextRef.current;
    const acousticTrend = acousticTrendFrom(features ?? result.audioFeatures ?? audioFeaturesRef.current);
    const riskDelta = feedbackRiskDelta(result, features ?? result.audioFeatures);
    const decayedRisk = result.eventType === "normal"
      ? Math.max(0, Math.round(prev.sessionRiskScore * 0.72) - 2)
      : Math.round(prev.sessionRiskScore * 0.86);
    const recentEvents = appendTail(prev.recentEvents, result.eventType, 20);
    const recentRiskCount = recentEvents.slice(-5).filter((eventType) => eventType !== "normal").length;
    const repeatedRisk = recentRiskCount >= 2 || decayedRisk + riskDelta >= 70;
    const next: FeedbackContext = {
      ...prev,
      sessionRiskScore: clamp(decayedRisk + riskDelta, 0, 100),
      repeatedRisk,
      abuseCount: prev.abuseCount + (result.eventType === "abuse" ? 1 : 0),
      sexualCount: prev.sexualCount + (result.eventType === "sexual" ? 1 : 0),
      raisedCount: prev.raisedCount + (result.eventType === "raised" || result.eventType === "abuse-raised" ? 1 : 0),
      normalCount: prev.normalCount + (result.eventType === "normal" ? 1 : 0),
      recentEvents,
      recentEmotions: appendTail(prev.recentEmotions, result.emotion, 20),
      recentCategories: appendUniqueTail(prev.recentCategories, result.categories, 40),
      recentTriggeredWords: appendUniqueTail(prev.recentTriggeredWords, result.triggeredWords, 40),
      lastEventType: result.eventType,
      lastEmotion: result.emotion,
      acousticTrend,
      notes: [],
    };
    next.notes = feedbackNotesFor(next);
    feedbackContextRef.current = next;
    setFeedbackContext(next);
  }

  function appendLog(result: AnalyzeResponse, text: string) {
    if (!activeRef.current) return false;
    const fingerprint = `${result.eventType}:${result.maskedText}:${Math.floor(Date.now() / 1200)}`;
    if (seenEventRef.current.has(fingerprint)) return false;
    seenEventRef.current.add(fingerprint);

    const safeMaskedText = maskVisibleText(result.maskedText || text);
    const entry: LogEntry = {
      ...result,
      maskedText: safeMaskedText,
      id: crypto.randomUUID(),
      text: safeMaskedText,
      time: now(),
      timestamp: currentSessionTimestamp(),
      loggedAtMs: Date.now(),
    };

    const mergeTargets = logsRef.current.slice(0, 20).filter((candidate) => shouldMergeLogCandidate(candidate, entry));

    if (mergeTargets.length > 0) {
      const targetIds = new Set(mergeTargets.map((item) => item.id));
      const anchor = mergeTargets.at(-1) ?? mergeTargets[0];
      const candidates = [entry, ...mergeTargets];
      const mergedBase = bestLogJudgement(candidates) ?? entry;
      const mergedText = maskVisibleText(bestLogText(candidates) || entry.maskedText || entry.text);
      const merged = {
        ...mergedBase,
        id: anchor.id,
        time: anchor.time,
        timestamp: anchor.timestamp,
        loggedAtMs: Math.min(...candidates.map((item) => item.loggedAtMs ?? entry.loggedAtMs ?? Date.now())),
        categories: uniqueValues(candidates.flatMap((item) => item.categories)),
        triggeredWords: uniqueValues(candidates.flatMap((item) => item.triggeredWords)),
        policyActions: uniqueValues(candidates.flatMap((item) => item.policyActions)),
        maskedText: mergedText,
        text: mergedText,
      };
      const nextLogs = [merged, ...logsRef.current.filter((item) => !targetIds.has(item.id))].slice(0, 200);
      const nextReportLogs = [merged, ...reportLogsRef.current.filter((item) => !targetIds.has(item.id))].slice(0, 200);
      reportLogsRef.current = nextReportLogs;
      logsRef.current = nextLogs;
      countersRef.current = nextLogs.reduce((acc, item) => {
        acc[item.eventType] += 1;
        return acc;
      }, initialCounts());
      setLogs(nextLogs);
      if (merged.eventType !== "normal") {
        setLatestDetection({
          id: merged.id,
          timestamp: merged.timestamp,
          title: `${eventLabel[merged.eventType]} · ${pathLabel[merged.detectionPath]}`,
          detail: `${merged.policyActions.map((action) => actionLabel[action]).join(" · ") || "기록"} · ${sourceLabel[merged.source]}`,
          eventType: merged.eventType,
          original: merged.text,
        });
      }
      return false;
    }

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
    const capped = kind === "abuse" ? clamp(stage, 0, 4) : clamp(stage, 0, 2);
    const next = {
      ...escalationRef.current,
      [kind]: Math.max(escalationRef.current[kind], capped),
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

  function applyPolicy(
    result: AnalyzeResponse,
    text: string,
    timing?: SpeechTiming,
    options: { suppressImmediateMask?: boolean; logNormal?: boolean; deferLog?: boolean; skipEscalation?: boolean } = {},
  ) {
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

    const displayResult = withDisplayMask(result, text);
    if (displayResult.emotionPrediction) setEmotionPrediction(displayResult.emotionPrediction);
    const shouldLog =
      !options.deferLog &&
      (
        options.logNormal ||
        displayResult.eventType !== "normal" ||
        displayResult.emotion === "angry" ||
        displayResult.emotion === "threatening" ||
        displayResult.policyActions.includes("report")
    );
    const logged = shouldLog ? appendLog(displayResult, text) : true;
    if (!options.deferLog) updateFeedbackLoop(displayResult, displayResult.audioFeatures);
    if (logged && !options.skipEscalation) advanceEscalation(displayResult, text);

    if (displayResult.detectionPath === "immediate") {
      if (displayResult.policyActions.includes("mute") && !options.suppressImmediateMask) beepProfanitySegment(displayResult, text, timing);
      if (displayResult.eventType !== "normal") setInterimText(`${eventLabel[displayResult.eventType]} 감지 - ${maskVisibleText(displayResult.maskedText)}`);
    } else if (displayResult.eventType !== "normal") {
      const engine = displayResult.source === "openai" ? "GPT" : "문맥 엔진";
      setStatus(`${engine} 판단: ${eventLabel[displayResult.eventType]}`);
    } else {
      const engine = displayResult.source === "openai" ? "GPT" : "3초 문맥";
      setStatus(`${engine} 판단 완료`);
    }

    if (!logged || !displayResult.policyActions.includes("warn_tts")) return;

    if (displayResult.eventType === "sexual") {
      const next = Math.min(2, countersRef.current.sexual);
      speak(CFG.sexualMessages[Math.max(0, next - 1)]);
      return;
    }

    if (displayResult.eventType !== "normal") {
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

  function generateReport(reason: string, escalationSnapshot = escalationRef.current, durationSeconds = currentSessionSeconds()) {
    const nextReport = buildIncidentReport(reason, escalationSnapshot, durationSeconds);
    setReportArchive((prev) => {
      const next = [nextReport, ...prev.filter((item) => item.id !== nextReport.id)].slice(0, REPORT_ARCHIVE_LIMIT);
      persistReportArchive(next);
      return next;
    });
    return nextReport;
  }

  async function processText(
    text: string,
    analysisMode: AnalysisMode,
    timing?: SpeechTiming,
    options: { logNormal?: boolean; runId?: number; interim?: boolean } = {},
  ) {
    const clean = sanitizeTranscriptText(text);
    if (!clean) return;
    const runId = options.runId ?? sessionRunIdRef.current;
    if (!activeRef.current || runId !== sessionRunIdRef.current) return;
    markDemoPhase(analysisMode === "immediate" ? "detect" : "context");

    const raised = analysisMode === "immediate" && Date.now() - audioRef.current.lastRaisedTs < CFG.raisedFlagWindow;
    const features = mergeUtteranceFeatures(audioFeaturesRef.current, clean, timing);
    try {
      const result = await analyzeUtterance(clean, raised, analysisMode, CFG.contextWindowMs, features, feedbackSnapshot(features));
      if (!activeRef.current || runId !== sessionRunIdRef.current) return;
      const displayText = analysisMode === "context_snapshot"
        ? contextBufferRef.current.at(-1) ?? clean
        : clean;
      applyPolicy(result, displayText, timing, {
        logNormal: Boolean(options.logNormal),
        deferLog: Boolean(options.interim),
        skipEscalation: Boolean(options.interim),
      });
    } catch {
      setError("분석 서버 연결에 실패했습니다. backend 서버가 실행 중인지 확인해주세요.");
    }
  }

  async function processLiveAudioChunk(blob: Blob, chunkStartedAtMs: number, runId: number) {
    if (!activeRef.current || runId !== sessionRunIdRef.current) return;
    if (liveChunkRef.current.inFlight >= CFG.liveChunkMaxInflight) return;
    liveChunkRef.current.inFlight += 1;

    try {
      const transcription = await transcribeAudioBlob(blob, `live-${Math.floor(chunkStartedAtMs)}.webm`, dictationPrompt());
      if (!activeRef.current || runId !== sessionRunIdRef.current) return;
      const clean = sanitizeTranscriptText(transcription.text || "");
      if (!clean) {
        setLiveTranscript("");
        setStatus("음성 입력 대기 중");
        return;
      }
      const displayText = recentBrowserDictation() || clean;
      const openAiVisibleDictation = !browserDictationRef.current;
      if (openAiVisibleDictation) setLiveTranscript(maskVisibleText(clean));
      if (isLikelyLiveSttHallucination(clean)) {
        if (openAiVisibleDictation) setLiveTranscript("");
        setStatus("OpenAI 청크 STT 대기 중");
        return;
      }

      const timing = { startedAtMs: chunkStartedAtMs, resultAtMs: performance.now() };
      const raised = Date.now() - audioRef.current.lastRaisedTs < CFG.raisedFlagWindow;
      const features = mergeUtteranceFeatures(audioFeaturesRef.current, clean, timing);
      markDemoPhase("detect");
      setStatus("OpenAI 받아쓰기 청크 분석 중");
      const result = await analyzeUtterance(clean, raised, "immediate", CFG.contextWindowMs, features, feedbackSnapshot(features));
      if (!activeRef.current || runId !== sessionRunIdRef.current) return;
      const exactMasked = scheduleChunkWordMasks(result, clean, transcription.words, chunkStartedAtMs);
      const normalizedClean = compactTranscriptText(clean);
      const repeatedNormal =
        result.eventType === "normal" &&
        lastNormalTranscriptRef.current?.text === normalizedClean &&
        Date.now() - lastNormalTranscriptRef.current.at < CFG.normalRepeatDedupeMs;
      if (result.eventType === "normal") {
        lastNormalTranscriptRef.current = { text: normalizedClean, at: Date.now() };
      }
      if (repeatedNormal) {
        setStatus("음성 입력 대기 중");
        return;
      }
      pushContext(clean);
      if (result.eventType === "normal") {
        if (openAiVisibleDictation) {
          applyPolicy(result, clean, timing, { suppressImmediateMask: exactMasked, logNormal: true });
          setInterimText(maskVisibleText(clean));
          setLiveTranscript("");
          setStatus("받아쓰기 기록");
        } else {
          setStatus("OpenAI 보호 분석 완료");
        }
        return;
      }
      applyPolicy(result, displayText, timing, { suppressImmediateMask: exactMasked });
      if (openAiVisibleDictation) setLiveTranscript("");
      if (exactMasked) {
        setStatus("OpenAI 단어 타임스탬프 기반 삐 처리");
        setDemoStep("OpenAI 청크 STT가 단어 시작/끝 시간을 받아 출력 버퍼에 마스크를 적용했습니다.");
      }
    } catch {
      setStatus("OpenAI 청크 STT 대기 중");
    } finally {
      liveChunkRef.current.inFlight = Math.max(0, liveChunkRef.current.inFlight - 1);
    }
  }

  function startOpenAIChunkStt() {
    const stream = audioRef.current.stream;
    if (!stream || typeof MediaRecorder === "undefined") return false;

    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : "";

    const scheduleNext = (delayMs = 120) => {
      if (!liveChunkRef.current.enabled) return;
      liveChunkRef.current.timer = window.setTimeout(recordOnce, delayMs);
    };

    const recordOnce = () => {
      if (!liveChunkRef.current.enabled) return;
      const currentFeatures = audioFeaturesRef.current;
      const now = Date.now();
      const hasRecentVoice = now - (audioRef.current.lastVoiceActivityTs ?? 0) <= CFG.liveChunkVoiceWindowMs;
      const hasEnoughLevel =
        (currentFeatures.rmsPercent ?? 0) >= CFG.liveChunkMinLevel || (currentFeatures.peak ?? 0) >= CFG.liveChunkMinPeak;
      const hasInputHint = hasRecentVoice || hasEnoughLevel;
      const shouldProbe = !hasInputHint && now - liveChunkRef.current.lastProbeTs >= CFG.liveChunkProbeEveryMs;
      if (!hasInputHint && !shouldProbe) {
        scheduleNext(180);
        return;
      }
      if (liveChunkRef.current.inFlight >= CFG.liveChunkMaxInflight) {
        scheduleNext(240);
        return;
      }
      if (shouldProbe) liveChunkRef.current.lastProbeTs = now;

      const chunks: Blob[] = [];
      const chunkStartedAtMs = performance.now();
      const runId = sessionRunIdRef.current;
      let recorder: MediaRecorder;
      try {
        recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      } catch {
        setStatus("OpenAI 청크 STT 시작 실패 - 브라우저 STT로 전환");
        liveChunkRef.current.enabled = false;
        startRecognition();
        return;
      }

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onstop = () => {
        const blobType = mimeType || chunks[0]?.type || "audio/webm";
        const blob = new Blob(chunks, { type: blobType });
        if (
          runId === sessionRunIdRef.current &&
          blob.size >= CFG.liveChunkMinBytes &&
          (hasInputHint || shouldProbe)
        ) {
          void processLiveAudioChunk(blob, chunkStartedAtMs, runId);
        }
        scheduleNext();
      };
      recorder.onerror = () => {
        setStatus("OpenAI 청크 STT 조각 오류 - 다음 조각 대기");
        scheduleNext(350);
      };

      audioRef.current.mediaRecorder = recorder;
      recorder.start();
      window.setTimeout(() => {
        if (recorder.state === "recording") recorder.stop();
      }, CFG.liveChunkMs);
    };

    liveChunkRef.current = { enabled: true, inFlight: 0, lastProbeTs: Date.now() };
    scheduleNext(0);
    setStatus("OpenAI 받아쓰기 청크 대기 중");
    setDemoStep("라이브 음성을 짧은 청크로 STT하고 단어 타임스탬프로 삐 처리합니다.");
    return true;
  }

  function queueInterimImmediate(text: string, timing: SpeechTiming) {
    const clean = sanitizeTranscriptText(text);
    if (!clean || announcingRef.current) return;
    if (clean === interimCheckRef.current.lastText) return;

    markDemoPhase("detect");
    if (interimCheckRef.current.timer) window.clearTimeout(interimCheckRef.current.timer);
    setStatus("STT 인터림 분석 중");

    interimCheckRef.current.timer = window.setTimeout(() => {
      interimCheckRef.current.lastText = clean;
      void processText(clean, "immediate", timing, { interim: true, runId: sessionRunIdRef.current });
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
    const result = await analyzeUtterance(text, raised, analysisMode, CFG.contextWindowMs, demoFeatures, feedbackSnapshot(demoFeatures));
    applyPolicy(result, text, { startedAtMs: performance.now() - 900, resultAtMs: performance.now() });
    return result;
  }

  async function runDemo(type: "abuse" | "sexual" | "raised" | "escalation") {
    if (!active) {
      setError("상담 시작 후 데모를 실행해주세요.");
      return;
    }
    const demoBaseSeconds = elapsed;
    const stamp = (seconds: number) => formatDuration(demoBaseSeconds + seconds);
    const say = async (
      role: DemoDialogueLine["role"],
      text: string,
      seconds: number,
      tone: DemoDialogueLine["tone"] = "normal",
      audioKey?: DemoAudioKey,
    ) => {
      markDemoPhase("input");
      setLevel(tone === "risk" ? 48 : 18);
      setStatus(role === "상담사" ? "상담사 발화 지연 없이 전달" : "고객 음성 입력");
      let spokenText = text;
      if (audioKey) {
        setDemoStep("고객 음성 파일을 STT로 변환한 뒤 재생 시간에 맞춰 인터림을 표시합니다.");
        const transcription = await transcribeDemoAudio(audioKey);
        spokenText = transcription.text || text;
        const lineId = pushDemoDialogue(role, spokenText, tone, stamp(seconds), "고객 발화");
        const playbackMs = await playDemoAudio(audioKey);
        scheduleStreamingSttLine(lineId, transcription, spokenText, tone === "risk");
        await sleep(clamp(playbackMs + 240, 900, 3600));
        return;
      }
      pushDemoDialogue(role, spokenText, tone, stamp(seconds));
      await sleep(audioKey ? 1300 : 620);
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
      audioKey?: DemoAudioKey;
    }) => {
      markDemoPhase("input");
      setLevel(options.level);
      setStatus("고객 음성 입력");
      let spokenText = options.text;
      let transcription: TranscribeResponse | null = null;
      let lineId: string | null = null;
      if (options.audioKey) {
        setDemoStep("고객 음성 파일을 STT로 변환하고 단어 타임스탬프를 추출합니다.");
        transcription = await transcribeDemoAudio(options.audioKey);
        spokenText = transcription.text || options.text;
        lineId = pushDemoDialogue(
          "고객",
          spokenText,
          "risk",
          stamp(options.seconds),
          "고객 발화",
        );
      } else {
        lineId = pushDemoDialogue("고객", spokenText, "risk", stamp(options.seconds), "고객 발화");
      }
      setDemoStep("고객 발화가 보호 게이트웨이로 들어왔습니다.");
      await sleep(options.audioKey ? 260 : 520);

      markDemoPhase("detect");
      setStatus(options.raised ? "RMS 고성 분석 감지" : "비윤리 표현 즉시 확인");
      setDemoStep(options.raised ? "RMS 기준 초과: 고성 완화 마스크 준비" : "비윤리 표현 감지: 위험 단어 구간 확인");
      const immediateResult = await analyzeDemo(spokenText, options.raised, "immediate");
      const sensitiveWords = sensitiveWordsForResult(spokenText, immediateResult);
      const displayMaskedText = maskTextByWords(immediateResult.maskedText, sensitiveWords);
      setEscalationStage(options.stageKind, options.stage);
      if (lineId) {
        updateDemoDialogue(lineId, {
          text: displayMaskedText,
          detail: `${eventLabel[immediateResult.eventType]} · 위험 구간만 * 마스킹`,
        });
      }
      const beepSegments = transcription
        ? wordTimestampSegments(transcription.words, sensitiveWords)
        : [];
      if (options.audioKey && immediateResult.policyActions.includes("mute") && beepSegments.length === 0) {
        setError("STT 단어 타임스탬프에서 욕설 구간을 찾지 못했습니다. 원본 음성은 재생하지 않습니다.");
        return;
      }
      if (options.audioKey) {
        const playbackMs = await playDemoAudio(options.audioKey, beepSegments);
        if (lineId) scheduleStreamingSttLine(lineId, transcription!, spokenText, true, displayMaskedText);
        await sleep(clamp(playbackMs + 260, 900, 3600));
      } else {
        await sleep(620);
      }

      markDemoPhase("mask");
      setStatus(options.maskStatus);
      pushDemoDialogue("시스템", options.systemText, "system", stamp(options.seconds + 1));
      await sleep(620);

      markDemoPhase("context");
      setStatus("GPT 문맥 판단 요청 중");
      setDemoStep("3초 문맥 스냅샷을 정책 엔진에 반영합니다.");
      await analyzeDemo(spokenText, false, "context_snapshot");
      await sleep(520);
    };

    setError("");
    setMuted(false);
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
        setDemoStep("Policy Engine: 4단계 도달 기록 완료 · 라이브 입력 계속 수신 중");
        setStatus("4단계 도달 기록 · 라이브 입력 계속 수신 중");
        pushDemoDialogue("시스템", "4단계 도달 권고가 현재 상담 세션에 기록되었습니다. 마이크 입력은 계속 수신 중입니다.", "system", stamp(25));
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
        audioKey: "abuse-profanity" as const,
        title: "욕설 구간 삐 처리 데모",
        setup: [
          ["상담사", "서울시 120다산콜센터입니다. 어떤 내용을 도와드릴까요?"],
          ["고객", "주차 단속 문자 받고 전화했어요. 이거 잘못된 것 같습니다.", "parking-normal"],
          ["상담사", "차량번호와 단속 위치를 확인한 뒤 안내드리겠습니다."],
        ] as Array<[DemoDialogueLine["role"], string, DemoAudioKey?]>,
        systemText: "욕설 단어 구간만 삐 처리하고 1단계 경고를 기록했습니다.",
        maskStatus: "욕설 구간 삐 처리",
        stageKind: "abuse" as const,
      },
      sexual: {
        audioKey: "sexual-harassment" as const,
        text: "목소리 섹시해요. 퇴근하면 기다릴게요",
        level: 36,
        raised: false,
        title: "성희롱 경고·보고서 데모",
        setup: [
          ["상담사", "복지 서비스 신청 절차 안내드리겠습니다."],
          ["고객", "상담사님이 계속 설명해 주세요. 목소리가 마음에 드네요.", "sexual-ambiguous"],
          ["상담사", "민원 내용 중심으로 안내드리겠습니다."],
        ] as Array<[DemoDialogueLine["role"], string, DemoAudioKey?]>,
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
        ] as Array<[DemoDialogueLine["role"], string, DemoAudioKey?]>,
        systemText: "고성 구간의 피치와 볼륨을 낮춰 상담사에게 전달했습니다.",
        maskStatus: "고성 구간 피치/볼륨 완화",
        stageKind: "abuse" as const,
      },
    }[type];

    try {
      setDemoStep(`${script.title}: 실제 상담 예시 시작`);
      await say(script.setup[0][0], script.setup[0][1], 1, "normal", script.setup[0][2]);
      await say(script.setup[1][0], script.setup[1][1], 3, "normal", script.setup[1][2]);
      await say(script.setup[2][0], script.setup[2][1], 5, "normal", script.setup[2][2]);
      await riskTurn({
        text: script.text,
        seconds: 8,
        level: script.level,
        raised: script.raised,
        stageKind: script.stageKind,
        stage: 1,
        maskStatus: script.maskStatus,
        systemText: script.systemText,
        audioKey: "audioKey" in script ? script.audioKey : undefined,
      });
      if (type === "sexual") setEscalationStage("sexual", 2);

      markDemoPhase("policy");
      setDemoStep("Policy Engine: 경고, 타임스탬프, 보고서 후보 반영 완료 · 라이브 입력 계속 수신 중");
      setStatus("라이브 상담 입력 계속 수신 중");
      pushDemoDialogue("시스템", "데모 이벤트가 현재 상담 타임라인에 기록되었습니다. 마이크 입력은 계속 수신 중입니다.", "system", stamp(14));
    } catch {
      setError("데모 실행 중 분석 서버 연결에 실패했습니다. 백엔드 8000 포트를 확인해주세요.");
    }
  }

  function pushContext(text: string) {
    const clean = sanitizeTranscriptText(text);
    if (!clean || isLikelyLiveSttHallucination(clean)) return;
    const last = contextBufferRef.current.at(-1);
    const compactClean = compactTranscriptText(clean);
    const compactLast = compactTranscriptText(last ?? "");
    if (compactClean && compactClean === compactLast) return;
    if (last && compactClean.includes(compactLast) && compactLast.length > 8) {
      contextBufferRef.current = [...contextBufferRef.current.slice(0, -1), clean].slice(-8);
      return;
    }
    if (last && compactLast.includes(compactClean) && compactClean.length > 8) return;
    const relatedIndex = contextBufferRef.current.findIndex((item) => transcriptsLookRelated(item, clean));
    if (relatedIndex >= 0) {
      const existing = contextBufferRef.current[relatedIndex];
      const replacement = compactTranscriptText(clean).length >= compactTranscriptText(existing).length ? clean : existing;
      contextBufferRef.current = [
        ...contextBufferRef.current.slice(0, relatedIndex),
        replacement,
        ...contextBufferRef.current.slice(relatedIndex + 1),
      ].slice(-8);
      return;
    }
    contextBufferRef.current.push(clean);
    contextBufferRef.current = contextBufferRef.current.slice(-8);
  }

  async function runContextSnapshot() {
    if (announcingRef.current) return;
    const snapshot = sanitizeTranscriptText(contextBufferRef.current.join(" ")).slice(-260);
    if (!snapshot) {
      setStatus("3초 문맥 스냅샷 대기");
      return;
    }
    setStatus("3초 문맥 스냅샷 분석 중");
    const compactSnapshot = compactTranscriptText(snapshot);
    if (compactSnapshot === lastContextSnapshotRef.current) {
      setStatus("3초 문맥 엔진 대기");
      return;
    }
    lastContextSnapshotRef.current = compactSnapshot;
    markDemoPhase("context");
    await processText(snapshot, "context_snapshot", undefined, { runId: sessionRunIdRef.current });
  }

  function startRecognition() {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
      browserDictationRef.current = false;
      setError("이 브라우저는 Web Speech API를 지원하지 않습니다. Chrome 또는 Edge를 권장합니다.");
      return;
    }
    browserDictationRef.current = true;

    const recognition = new Recognition();
    let recognitionRunning = false;
    let processedFinalResultCount = 0;
    const runId = sessionRunIdRef.current;

    const startSafely = (delay = 0) => {
      if (!activeRef.current || runId !== sessionRunIdRef.current) return;
      if (audioRef.current.recognition !== recognition) return;
      if (audioRef.current.recognitionRestartTimer) {
        window.clearTimeout(audioRef.current.recognitionRestartTimer);
      }
      audioRef.current.recognitionRestartTimer = window.setTimeout(() => {
        if (!activeRef.current || runId !== sessionRunIdRef.current) return;
        if (audioRef.current.recognition !== recognition || recognitionRunning) return;
        try {
          recognition.start();
          recognitionRunning = true;
          processedFinalResultCount = 0;
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
      if (!activeRef.current || runId !== sessionRunIdRef.current) return;
      if (announcingRef.current) return;
      const resultAtMs = performance.now();
      if (!speechStartAtRef.current) speechStartAtRef.current = resultAtMs - 650;
      const timing = { startedAtMs: speechStartAtRef.current, resultAtMs };
      markDemoPhase("input");
      setStatus("음성 입력 감지");
      let interim = "";
      let final = "";
      let nextFinalResultCount = processedFinalResultCount;
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          if (i < processedFinalResultCount) continue;
          final += transcript;
          nextFinalResultCount = Math.max(nextFinalResultCount, i + 1);
        } else {
          interim += transcript;
        }
      }
      if (nextFinalResultCount !== processedFinalResultCount) {
        processedFinalResultCount = nextFinalResultCount;
      }
      if (interim) {
        const cleanInterim = sanitizeTranscriptText(interim);
        setInterimText(maskVisibleText(cleanInterim));
        setLiveTranscript(maskVisibleText(cleanInterim));
        lastBrowserDictationRef.current = { text: cleanInterim, at: Date.now() };
        queueInterimImmediate(cleanInterim, timing);
      }
      if (final) {
        const cleanFinal = sanitizeTranscriptText(final);
        lastBrowserDictationRef.current = { text: cleanFinal, at: Date.now() };
        pushContext(cleanFinal);
        void processText(cleanFinal, "immediate", timing, { logNormal: true, runId: sessionRunIdRef.current });
        setLiveTranscript("");
        speechStartAtRef.current = null;
      }
    };
    recognition.onspeechstart = () => {
      if (!activeRef.current || runId !== sessionRunIdRef.current) return;
      speechStartAtRef.current = performance.now();
      setStatus("음성 입력 감지");
    };
    recognition.onspeechend = () => {
      speechStartAtRef.current = null;
    };
    recognition.onend = () => {
      recognitionRunning = false;
      if (!activeRef.current || runId !== sessionRunIdRef.current) return;
      startSafely(CFG.recognitionRestartMs);
    };
    recognition.onerror = (event) => {
      recognitionRunning = false;
      if (!activeRef.current || runId !== sessionRunIdRef.current) return;
      if (event.error === "no-speech") {
        setStatus("음성 입력 대기 중");
        startSafely(CFG.recognitionRestartMs);
        return;
      }
      if (event.error === "aborted") {
        setStatus("받아쓰기 재연결 중");
        startSafely(CFG.recognitionRestartMs);
        return;
      }
      if (event.error === "network") {
        browserDictationRef.current = false;
        setError("");
        setStatus("브라우저 받아쓰기 연결 실패 - OpenAI 청크 STT로 계속 수신");
        return;
      }
      setError(`음성 인식 오류: ${event.error}`);
      startSafely(CFG.recognitionRestartMs * 2);
    };
    audioRef.current.recognition = recognition;
    startSafely();
  }

  async function startSession() {
    if (activeRef.current) return;
    sessionRunIdRef.current += 1;
    activeRef.current = true;
    elapsedRef.current = 0;
    sessionStartedAtMsRef.current = performance.now();
    setError("");
    setLogs([]);
    logsRef.current = [];
    reportLogsRef.current = [];
    setLatestDetection(null);
    setEmotionPrediction(null);
    setDemoDialogue([]);
    setLiveTranscript("");
    lastBrowserDictationRef.current = null;
    setDemoStep("데모 버튼을 누르면 현재 상담 세션에 보호 이벤트가 기록됩니다.");
    setElapsed(0);
    setInterimText("상담을 듣고 있습니다.");
    setStatus("보호된 상담사 청취 출력");
    countersRef.current = initialCounts();
    contextBufferRef.current = [];
    feedbackContextRef.current = initialFeedbackContext();
    setFeedbackContext(feedbackContextRef.current);
    lastContextSnapshotRef.current = "";
    emotionPredictRef.current = { inFlight: false, lastAt: 0 };
    resetAutoThresholdLearning(thresholdRef.current);
    seenEventRef.current.clear();
    lastBeepRef.current = null;
    lastFeedbackRef.current = null;
    lastNormalTranscriptRef.current = null;
    resetEscalation();
    interimCheckRef.current.lastText = "";
    speechStartAtRef.current = null;
    sessionStartedAtRef.current = new Date();
    setLitPhases([]);
    markDemoPhase("idle");
    if (interimCheckRef.current.timer) window.clearTimeout(interimCheckRef.current.timer);
    setMonitorEnabled(true);
    setActive(true);

    try {
      await startAudio(true);
      startOpenAIChunkStt();
      startRecognition();
      speak("안녕하세요. 원활한 상담을 위해 통화 내용이 녹음됩니다.");
      const runId = sessionRunIdRef.current;
      audioRef.current.timer = window.setInterval(() => {
        if (!activeRef.current || runId !== sessionRunIdRef.current) return;
        setElapsed(currentSessionSeconds());
      }, 500);
      audioRef.current.contextTimer = window.setInterval(() => {
        if (!activeRef.current || runId !== sessionRunIdRef.current) return;
        void runContextSnapshot();
      }, CFG.contextWindowMs);
    } catch {
      activeRef.current = false;
      sessionRunIdRef.current += 1;
      sessionStartedAtMsRef.current = null;
      setActive(false);
      setError("마이크 권한이 필요합니다.");
    }
  }

  function stopSession() {
    const finalElapsed = currentSessionSeconds();
    activeRef.current = false;
    sessionRunIdRef.current += 1;
    elapsedRef.current = finalElapsed;
    const state = audioRef.current;
    liveChunkRef.current.enabled = false;
    if (liveChunkRef.current.timer) window.clearTimeout(liveChunkRef.current.timer);
    if (state.mediaRecorder?.state === "recording") state.mediaRecorder.stop();
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
    liveChunkRef.current = { enabled: false, inFlight: 0, lastProbeTs: 0 };
    lastNormalTranscriptRef.current = null;
    lastBrowserDictationRef.current = null;
    lastContextSnapshotRef.current = "";
    interimCheckRef.current.lastText = "";
    speechStartAtRef.current = null;
    announcingRef.current = false;
    setActive(false);
    setElapsed(finalElapsed);
    setLiveTranscript("");
    setEmotionPrediction(null);
    setLevel(0);
    setMuted(false);
    setStatus("대기 중");
    generateReport("상담 종료", escalationRef.current, finalElapsed);
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
            <div className={`threshold-control ${autoThresholdEnabled ? "auto" : ""}`}>
              <div className="threshold-heading">
                <span>고성 기준</span>
                <button
                  type="button"
                  className={`mode-chip ${autoThresholdEnabled ? "selected" : ""}`}
                  onClick={toggleAutoThresholdMode}
                >
                  {autoThresholdEnabled ? "자동" : "수동"}
                </button>
              </div>
              <input
                type="range"
                min={20}
                max={80}
                value={effectiveThreshold}
                disabled={autoThresholdEnabled}
                onChange={(event) => setThreshold(Number(event.target.value))}
              />
              <b>{effectiveThreshold}%</b>
            </div>
            <label className="threshold-control attenuation-control">
              <span>완화 강도</span>
              <input type="range" min={0} max={100} value={attenuationStrength} onChange={(event) => setAttenuationStrength(Number(event.target.value))} />
              <b>{attenuationStrength}%</b>
            </label>
            <label className="threshold-control pitch-control">
              <span>피치 기준</span>
              <input type="range" min={160} max={340} step={5} value={pitchThreshold} onChange={(event) => setPitchThreshold(Number(event.target.value))} />
              <b>{pitchThreshold}Hz</b>
            </label>
            <div className="monitor-control">
              <span>청취</span>
              <button className={monitorEnabled ? "selected" : ""} onClick={() => setMonitorEnabled((prev) => !prev)}>
                {monitorEnabled ? "켜짐" : "꺼짐"}
              </button>
            </div>
          </section>
          <div className="meter">
            <label>RMS</label>
            <div className="track">
              <div className="fill" style={{ width: `${level}%` }} />
              <i style={{ left: `${effectiveThreshold}%` }} />
            </div>
            <strong>{Math.round(level)}</strong>
          </div>
          <section className={`acoustic-panel ${audioFeatures.voiceActivity ? "active" : ""}`}>
            <div><span>입력 상태</span><strong>{audioFeatures.voiceActivity ? "발화 감지" : active ? "무음 대기" : "마이크 대기"}</strong></div>
            <div><span>감정</span><strong>{emotionPredictionValue(emotionPrediction, audioFeatures.voiceActivity)}</strong></div>
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
              {conversationEntries.length === 0 && <p className="empty">보호 이벤트가 감지되면 [00:00] 형식으로 바로 기록됩니다.</p>}
              {conversationEntries.map((entry) => (
                <article key={entry.id} className={`conversation-row ${entry.tone} ${entry.eventType ?? ""}`}>
                  <time>[{entry.timestamp}]</time>
                  <b>{entry.role === "시스템" ? "보호 조치" : entry.role}</b>
                  <div>
                    <strong>{maskVisibleText(entry.text)}</strong>
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
          <section className="feedback-card">
            <h2>피드백 루프</h2>
            <div>
              <span>위험 점수</span>
              <strong>{feedbackContext.sessionRiskScore}</strong>
            </div>
            <div>
              <span>반복 신호</span>
              <strong>{feedbackContext.repeatedRisk ? "반영" : "대기"}</strong>
            </div>
            <div>
              <span>음향 추세</span>
              <strong>{feedbackContext.acousticTrend === "escalating" ? "상승" : feedbackContext.acousticTrend === "quiet" ? "무음" : "안정"}</strong>
            </div>
            <div>
              <span>감정</span>
              <strong>{emotionPrediction ? emotionLabel[emotionPrediction.label] : "대기"}</strong>
            </div>
          </section>
          <section className="report-link-card">
            <h2>보고서</h2>
            <p>상담 종료 시 보고서가 자동 저장됩니다.</p>
            <button onClick={() => navigate("/report")}>보고서 {reportArchive.length}건 보기</button>
          </section>
        </aside>
      </section>
      {SHOW_DEMO_REMOTE && (
        <aside className="demo-remote" aria-label="데모 리모콘">
          <strong>DEMO</strong>
          <span>{active ? demoStep : "상담 시작 후 데모를 실행합니다."}</span>
          <button disabled={!active} onClick={() => void runDemo("abuse")}>욕설 삐 처리</button>
          <button disabled={!active} onClick={() => void runDemo("sexual")}>성희롱 경고</button>
        </aside>
      )}
    </main>
  );
}
