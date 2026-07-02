import json
import math
from functools import lru_cache
from pathlib import Path
from typing import Any

from app.config import settings
from app.models import AudioFeatures, Emotion, EmotionPrediction


EMOTION_RANK: dict[Emotion, int] = {
    "normal": 0,
    "frustrated": 1,
    "angry": 2,
    "threatening": 3,
}

FEATURE_ALIASES = {
    "audio_rms": ("rms",),
    "rms_percent": ("rmsPercent",),
    "audio_peak": ("peak",),
    "audio_zero_crossing_rate": ("zeroCrossingRate",),
    "spectral_centroid_hz": ("spectralCentroidHz",),
    "pitch_hz": ("pitchHz",),
    "pitch_confidence": ("pitchConfidence",),
    "syllables_per_second": ("syllablesPerSecond",),
}


def _feature_dump(features: AudioFeatures) -> dict[str, float]:
    raw = features.model_dump(exclude_none=True)
    values: dict[str, float] = {}
    for key, aliases in FEATURE_ALIASES.items():
        for alias in aliases:
            value = raw.get(alias)
            if isinstance(value, (int, float)) and math.isfinite(float(value)):
                values[key] = float(value)
                break
    return values


def _sigmoid(value: float) -> float:
    return 1 / (1 + math.exp(-value))


def _softmax(scores: dict[str, float]) -> dict[str, float]:
    if not scores:
        return {}
    max_score = max(scores.values())
    exps = {key: math.exp(value - max_score) for key, value in scores.items()}
    total = sum(exps.values()) or 1
    return {key: round(value / total, 4) for key, value in exps.items()}


@lru_cache(maxsize=1)
def load_emotion_model() -> dict[str, Any]:
    path = Path(settings.emotion_model_path)
    if not path.exists():
        return {"mode": "fallback", "featureKeys": [], "stats": {}}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"mode": "fallback", "featureKeys": [], "stats": {}}


def _z(value: float | None, stats: dict[str, Any], key: str) -> float:
    if value is None:
        return 0
    item = stats.get(key) if isinstance(stats, dict) else None
    if not isinstance(item, dict):
        return 0
    mean = float(item.get("mean", 0) or 0)
    std = max(float(item.get("std", 0) or 0), 1e-9)
    return (value - mean) / std


def _baseline_prediction(features: AudioFeatures, model: dict[str, Any]) -> EmotionPrediction:
    values = _feature_dump(features)
    stats = model.get("stats", {}) if isinstance(model, dict) else {}
    rms_value = values.get("rms_percent", values.get("audio_rms", 0) * 650)
    peak_z = _z(values.get("audio_peak"), stats, "audio_peak")
    rms_z = _z(values.get("audio_rms"), stats, "audio_rms")
    zcr_z = _z(values.get("audio_zero_crossing_rate"), stats, "audio_zero_crossing_rate")
    centroid_z = _z(values.get("spectral_centroid_hz"), stats, "spectral_centroid_hz")
    syllable_z = _z(values.get("syllables_per_second"), stats, "syllables_per_second")

    if not features.voiceActivity or rms_value < 1.2:
        return EmotionPrediction(
            label="normal",
            confidence=0.72,
            source="skt_acoustic_baseline" if model.get("mode") == "acoustic_baseline" else "fallback",
            scores={"normal": 0.72, "frustrated": 0.18, "angry": 0.08, "threatening": 0.02},
            reasons=["무음 또는 낮은 음량"],
        )

    arousal = (
        max(0, rms_z) * 0.3
        + max(0, peak_z) * 0.25
        + max(0, zcr_z) * 0.2
        + max(0, centroid_z) * 0.15
        + max(0, syllable_z) * 0.1
    )
    if not stats:
        arousal = max(rms_value / 42, values.get("audio_peak", 0) / 0.22)

    label: Emotion
    if arousal >= 1.75 and values.get("audio_peak", 0) >= 0.34:
        label = "threatening"
    elif arousal >= 1.05 or rms_value >= 62:
        label = "angry"
    elif arousal >= 0.42 or rms_value >= 34:
        label = "frustrated"
    else:
        label = "normal"

    scores = {
        "normal": -abs(arousal - 0.1),
        "frustrated": -abs(arousal - 0.65),
        "angry": -abs(arousal - 1.25),
        "threatening": -abs(arousal - 1.95),
    }
    normalized_scores = _softmax(scores)
    confidence = max(normalized_scores.get(label, 0.45), _sigmoid(arousal - 0.35) if label != "normal" else 0.58)

    reasons = []
    if rms_z > 0.6 or rms_value >= 42:
        reasons.append("음량 상승")
    if peak_z > 0.6 or values.get("audio_peak", 0) >= 0.28:
        reasons.append("피크 진폭 상승")
    if zcr_z > 0.6:
        reasons.append("ZCR 상승")
    if centroid_z > 0.6:
        reasons.append("고주파 성분 상승")
    if syllable_z > 0.6:
        reasons.append("발화 속도 상승")
    if not reasons:
        reasons.append("SKT 음성 분포 기준 안정 범위")

    return EmotionPrediction(
        label=label,
        confidence=round(min(0.96, max(0.35, confidence)), 4),
        source="skt_acoustic_baseline" if model.get("mode") == "acoustic_baseline" else "fallback",
        scores=normalized_scores,
        reasons=reasons,
    )


def _centroid_prediction(features: AudioFeatures, model: dict[str, Any]) -> EmotionPrediction:
    values = _feature_dump(features)
    stats = model.get("stats", {})
    feature_keys = [key for key in model.get("featureKeys", []) if key in values]
    centroids = model.get("centroids", {})
    if not feature_keys or not isinstance(centroids, dict):
        return _baseline_prediction(features, model)

    distances: dict[str, float] = {}
    for emotion, centroid in centroids.items():
        if emotion not in EMOTION_RANK or not isinstance(centroid, dict):
            continue
        total = 0.0
        used = 0
        for key in feature_keys:
            current = _z(values.get(key), stats, key)
            expected = float(centroid.get(key, 0) or 0)
            total += (current - expected) ** 2
            used += 1
        if used:
            distances[emotion] = math.sqrt(total / used)

    if not distances:
        return _baseline_prediction(features, model)

    raw_scores = {emotion: -distance for emotion, distance in distances.items()}
    scores = _softmax(raw_scores)
    label = max(scores, key=scores.get)
    confidence = scores[label]
    return EmotionPrediction(
        label=label,  # type: ignore[arg-type]
        confidence=round(confidence, 4),
        source="skt_centroid_model",
        scores=scores,
        reasons=["라벨 기반 centroid 모델", "실시간 음향 특징 매칭"],
    )


def predict_emotion(features: AudioFeatures | None) -> EmotionPrediction | None:
    if features is None:
        return None
    model = load_emotion_model()
    if model.get("mode") == "centroid":
        return _centroid_prediction(features, model)
    return _baseline_prediction(features, model)
