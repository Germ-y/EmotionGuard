export type EventType = "normal" | "abuse" | "sexual" | "raised" | "abuse-raised";
export type Emotion = "normal" | "frustrated" | "angry" | "threatening";
export type AnalysisMode = "immediate" | "context_snapshot";
export type PolicyAction = "mute" | "pitch_shift" | "volume_reduce" | "warn_tts" | "escalate" | "report";

export interface AudioFeatures {
  rms?: number;
  rmsPercent?: number;
  peak?: number;
  pitchHz?: number;
  pitchConfidence?: number;
  zeroCrossingRate?: number;
  spectralCentroidHz?: number;
  utteranceDurationMs?: number;
  syllableCount?: number;
  syllablesPerSecond?: number;
  voiceActivity?: boolean;
}

export interface AnalyzeResponse {
  abusive: boolean;
  severity: "none" | "mild" | "severe";
  categories: string[];
  emotion: Emotion;
  sexual: boolean;
  source: "local" | "openai" | "claude" | "fallback";
  triggeredWords: string[];
  raised: boolean;
  eventType: EventType;
  maskedText: string;
  detectionPath: AnalysisMode;
  contextWindowMs: number;
  policyActions: PolicyAction[];
  audioFeatures?: AudioFeatures | null;
}

export interface TranscriptionWord {
  word: string;
  start: number;
  end: number;
}

export interface TranscribeResponse {
  text: string;
  words: TranscriptionWord[];
  source: "openai" | "fallback";
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";

export async function analyzeUtterance(
  text: string,
  raised: boolean,
  analysisMode: AnalysisMode,
  contextWindowMs = 3000,
  audioFeatures?: AudioFeatures,
): Promise<AnalyzeResponse> {
  const response = await fetch(`${API_BASE_URL}/api/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, raised, analysisMode, contextWindowMs, audioFeatures }),
  });

  if (!response.ok) {
    throw new Error(`Analyze failed: ${response.status}`);
  }

  return response.json() as Promise<AnalyzeResponse>;
}

export async function transcribeAudioBlob(file: Blob, filename = "demo-audio.mp3", prompt = ""): Promise<TranscribeResponse> {
  const formData = new FormData();
  formData.append("file", file, filename);
  if (prompt.trim()) formData.append("prompt", prompt.trim());

  const response = await fetch(`${API_BASE_URL}/api/transcribe`, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`Transcribe failed: ${response.status}`);
  }

  return response.json() as Promise<TranscribeResponse>;
}
