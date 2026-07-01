from app.config import settings
from app.models import AnalysisResult
from app.services.claude import classify_with_claude
from app.services.local_classifier import conservative_fail
from app.services.openai import classify_with_openai


async def classify_context(text: str) -> AnalysisResult:
    if settings.openai_api_key:
        return await classify_with_openai(text)
    if settings.anthropic_api_key:
        return await classify_with_claude(text)
    return conservative_fail(text)
