from fastapi import APIRouter

from app.models import AnalyzeRequest, AnalyzeResponse
from app.services.claude import classify_with_claude
from app.services.local_classifier import classify_local, mask_abuse


router = APIRouter(prefix="/api/analyze", tags=["analyze"])


@router.post("", response_model=AnalyzeResponse)
async def analyze(payload: AnalyzeRequest) -> AnalyzeResponse:
    local = classify_local(payload.text)
    analysis = local or await classify_with_claude(payload.text)

    if analysis.sexual:
        event_type = "sexual"
    elif analysis.abusive and payload.raised:
        event_type = "abuse-raised"
    elif analysis.abusive:
        event_type = "abuse"
    elif payload.raised:
        event_type = "raised"
    else:
        event_type = "normal"

    return AnalyzeResponse(
        **analysis.model_dump(),
        raised=payload.raised,
        eventType=event_type,
        maskedText=mask_abuse(payload.text),
    )

