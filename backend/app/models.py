from typing import Literal

from pydantic import BaseModel, Field


Emotion = Literal["normal", "frustrated", "angry", "threatening"]
Severity = Literal["none", "mild", "severe"]
Source = Literal["local", "openai", "claude", "fallback"]
EventType = Literal["normal", "abuse", "sexual", "raised", "abuse-raised"]
AnalysisMode = Literal["immediate", "context_snapshot"]
PolicyAction = Literal["mute", "pitch_shift", "volume_reduce", "warn_tts", "escalate", "report"]


class AudioFeatures(BaseModel):
    rms: float | None = Field(default=None, ge=0)
    rmsPercent: float | None = Field(default=None, ge=0, le=100)
    peak: float | None = Field(default=None, ge=0)
    pitchHz: float | None = Field(default=None, ge=0)
    pitchConfidence: float | None = Field(default=None, ge=0, le=1)
    zeroCrossingRate: float | None = Field(default=None, ge=0)
    spectralCentroidHz: float | None = Field(default=None, ge=0)
    utteranceDurationMs: float | None = Field(default=None, ge=0)
    syllableCount: int | None = Field(default=None, ge=0)
    syllablesPerSecond: float | None = Field(default=None, ge=0)
    voiceActivity: bool | None = None


class AnalyzeRequest(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    raised: bool = False
    analysisMode: AnalysisMode = "immediate"
    contextWindowMs: int = Field(default=3000, ge=1000, le=10000)
    audioFeatures: AudioFeatures | None = None


class AnalysisResult(BaseModel):
    abusive: bool
    severity: Severity
    categories: list[str]
    emotion: Emotion
    sexual: bool
    source: Source
    triggeredWords: list[str]


class AnalyzeResponse(AnalysisResult):
    raised: bool
    eventType: EventType
    maskedText: str
    detectionPath: AnalysisMode
    contextWindowMs: int
    policyActions: list[PolicyAction]
    audioFeatures: AudioFeatures | None = None


class TranscriptionWord(BaseModel):
    word: str
    start: float = Field(ge=0)
    end: float = Field(ge=0)


class TranscribeResponse(BaseModel):
    text: str
    words: list[TranscriptionWord] = Field(default_factory=list)
    source: Literal["openai", "fallback"] = "openai"
