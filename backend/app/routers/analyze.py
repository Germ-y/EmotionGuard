from fastapi import APIRouter

from app.models import AnalyzeRequest, AnalyzeResponse
from app.services.context_engine import classify_context
from app.services.local_classifier import (
    classify_local,
    mask_sensitive,
    normal_result,
    should_defer_abuse_to_context,
)
from app.services.policy_engine import decide_policy_actions, resolve_event_type


router = APIRouter(prefix="/api/analyze", tags=["analyze"])


@router.post("", response_model=AnalyzeResponse)
async def analyze(payload: AnalyzeRequest) -> AnalyzeResponse:
    local = classify_local(payload.text)
    needs_context = should_defer_abuse_to_context(payload.text)
    if payload.analysisMode == "immediate":
        analysis = local or (
            await classify_context(payload.text, payload.audioFeatures) if needs_context else normal_result()
        )
    else:
        analysis = local or await classify_context(payload.text, payload.audioFeatures)

    event_type = resolve_event_type(analysis, payload.raised)
    policy_actions = decide_policy_actions(event_type, analysis, payload.analysisMode)

    return AnalyzeResponse(
        **analysis.model_dump(),
        raised=payload.raised,
        eventType=event_type,
        maskedText=(
            mask_sensitive(payload.text) if event_type in {"abuse", "abuse-raised", "sexual"} else payload.text
        ),
        detectionPath=payload.analysisMode,
        contextWindowMs=payload.contextWindowMs,
        policyActions=policy_actions,
        audioFeatures=payload.audioFeatures,
    )
