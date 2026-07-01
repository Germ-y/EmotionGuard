from fastapi import APIRouter

from app.models import AnalyzeRequest, AnalyzeResponse
from app.services.context_engine import classify_context
from app.services.local_classifier import classify_local, mask_abuse, normal_result
from app.services.policy_engine import decide_policy_actions, resolve_event_type


router = APIRouter(prefix="/api/analyze", tags=["analyze"])


@router.post("", response_model=AnalyzeResponse)
async def analyze(payload: AnalyzeRequest) -> AnalyzeResponse:
    local = classify_local(payload.text)
    if payload.analysisMode == "immediate":
        analysis = local or normal_result()
    else:
        analysis = local or await classify_context(payload.text)

    event_type = resolve_event_type(analysis, payload.raised)

    return AnalyzeResponse(
        **analysis.model_dump(),
        raised=payload.raised,
        eventType=event_type,
        maskedText=mask_abuse(payload.text),
        detectionPath=payload.analysisMode,
        contextWindowMs=payload.contextWindowMs,
        policyActions=decide_policy_actions(event_type, analysis, payload.analysisMode),
    )
