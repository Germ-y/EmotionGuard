export type EventType = "normal" | "abuse" | "sexual" | "raised" | "abuse-raised";
export type Emotion = "normal" | "frustrated" | "angry" | "threatening";

export interface AnalyzeResponse {
  abusive: boolean;
  severity: "none" | "mild" | "severe";
  categories: string[];
  emotion: Emotion;
  sexual: boolean;
  source: "local" | "claude" | "fallback";
  triggeredWords: string[];
  raised: boolean;
  eventType: EventType;
  maskedText: string;
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000";

export async function analyzeUtterance(text: string, raised: boolean): Promise<AnalyzeResponse> {
  const response = await fetch(`${API_BASE_URL}/api/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, raised }),
  });

  if (!response.ok) {
    throw new Error(`Analyze failed: ${response.status}`);
  }

  return response.json() as Promise<AnalyzeResponse>;
}

