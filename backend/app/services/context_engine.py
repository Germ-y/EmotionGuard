from app.config import settings
from app.models import AnalysisResult, AudioFeatures, EmotionPrediction, FeedbackContext
from app.services.local_classifier import conservative_fail
from app.services.openai import classify_with_openai


async def classify_context(
    text: str,
    audio_features: AudioFeatures | None = None,
    feedback_context: FeedbackContext | None = None,
    emotion_prediction: EmotionPrediction | None = None,
) -> AnalysisResult:
    if settings.openai_api_key:
        return await classify_with_openai(text, audio_features, feedback_context, emotion_prediction)
    return conservative_fail(text)
