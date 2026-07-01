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
