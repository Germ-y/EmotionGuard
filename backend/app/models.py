from typing import Literal

from pydantic import BaseModel, Field


Emotion = Literal["normal", "frustrated", "angry", "threatening"]
Severity = Literal["none", "mild", "severe"]
Source = Literal["local", "claude", "fallback"]
EventType = Literal["normal", "abuse", "sexual", "raised", "abuse-raised"]


class AnalyzeRequest(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    raised: bool = False


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

