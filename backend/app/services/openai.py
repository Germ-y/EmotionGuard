import json
import re
from typing import Any

import httpx

from app.config import settings
from app.models import AnalysisResult, AudioFeatures, TranscribeResponse, TranscriptionWord
from app.services.claude import ANALYST_SYSTEM, build_analysis_payload
from app.services.local_classifier import conservative_fail


def _coerce_openai_result(payload: dict[str, Any]) -> AnalysisResult:
    emotion = payload.get("emotion")
    severity = payload.get("severity")

    return AnalysisResult(
        abusive=bool(payload.get("abusive")),
        severity=severity if severity in {"none", "mild", "severe"} else "none",
        categories=[item for item in payload.get("categories", []) if isinstance(item, str)]
        if isinstance(payload.get("categories"), list)
        else [],
        emotion=emotion if emotion in {"normal", "frustrated", "angry", "threatening"} else "normal",
        sexual=bool(payload.get("sexual")),
        source="openai",
        triggeredWords=[],
    )


async def classify_with_openai(text: str, audio_features: AudioFeatures | None = None) -> AnalysisResult:
    if not settings.openai_api_key:
        return conservative_fail(text)

    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            response = await client.post(
                "https://api.openai.com/v1/chat/completions",
                headers={
                    "content-type": "application/json",
                    "authorization": f"Bearer {settings.openai_api_key}",
                },
                json={
                    "model": settings.openai_model,
                    "max_tokens": settings.openai_max_tokens,
                    "response_format": {"type": "json_object"},
                    "messages": [
                        {"role": "system", "content": ANALYST_SYSTEM},
                        {"role": "user", "content": build_analysis_payload(text, audio_features)},
                    ],
                },
            )
            response.raise_for_status()

        data = response.json()
        raw = data.get("choices", [{}])[0].get("message", {}).get("content", "")
        match = re.search(r"\{[\s\S]*\}", raw)
        if not match:
            return conservative_fail(text)

        return _coerce_openai_result(json.loads(match.group(0)))
    except Exception:
        return conservative_fail(text)


async def transcribe_audio_with_openai(filename: str, content: bytes, content_type: str | None = None) -> TranscribeResponse:
    if not settings.openai_api_key:
        raise RuntimeError("OPENAI_API_KEY is not configured")

    async with httpx.AsyncClient(timeout=45.0) as client:
        response = await client.post(
            "https://api.openai.com/v1/audio/transcriptions",
            headers={"authorization": f"Bearer {settings.openai_api_key}"},
            data=[
                ("model", settings.openai_transcription_model),
                ("language", "ko"),
                ("response_format", "verbose_json"),
                ("timestamp_granularities[]", "word"),
            ],
            files={
                "file": (
                    filename,
                    content,
                    content_type or "application/octet-stream",
                )
            },
        )
        response.raise_for_status()

    data = response.json()
    words = []
    for item in data.get("words", []):
        if not isinstance(item, dict):
            continue
        word = str(item.get("word", "")).strip()
        if not word:
            continue
        try:
            start = float(item.get("start", 0))
            end = float(item.get("end", start))
        except (TypeError, ValueError):
            continue
        words.append(TranscriptionWord(word=word, start=max(0, start), end=max(start, end)))

    return TranscribeResponse(text=str(data.get("text", "")).strip(), words=words, source="openai")
