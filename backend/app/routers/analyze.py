from fastapi import APIRouter

from app.models import AnalysisResult, AnalyzeRequest, AnalyzeResponse, FeedbackContext
from app.services.context_engine import classify_context
from app.services.emotion_model import predict_emotion
from app.services.local_classifier import (
    classify_local,
    mask_sensitive,
    normal_result,
    should_defer_abuse_to_context,
)
from app.services.policy_engine import decide_policy_actions, resolve_event_type


router = APIRouter(prefix="/api/analyze", tags=["analyze"])


FEEDBACK_CONTEXT_CUES = {
    "목소리",
    "퇴근",
    "기다릴",
    "기다릴게",
    "집",
    "주소",
    "연락처",
    "번호",
    "만나",
    "찾아",
    "개인",
    "어디",
    "예쁘",
    "섹시",
    "계속",
    "또 전화",
}


def _compact(text: str) -> str:
    return "".join(text.lower().split())


def _needs_feedback_context(text: str, feedback: FeedbackContext | None, raised: bool) -> bool:
    if not feedback:
        return False

    compact = _compact(text)
    has_context_cue = any(_compact(cue) in compact for cue in FEEDBACK_CONTEXT_CUES)
    has_prior_risk = feedback.repeatedRisk or feedback.sessionRiskScore >= 45
    has_sexual_prior = feedback.sexualCount > 0 or "sexual" in feedback.recentEvents

    if has_context_cue and (has_prior_risk or has_sexual_prior):
        return True
    if raised and feedback.sessionRiskScore >= 65:
        return True
    return False


def _apply_feedback_prior(analysis: AnalysisResult, feedback: FeedbackContext | None) -> AnalysisResult:
    if not feedback:
        return analysis

    next_analysis = analysis.model_copy(deep=True)

    if next_analysis.sexual and feedback.sexualCount > 0:
        next_analysis.severity = "severe"
        next_analysis.emotion = "threatening"

    if next_analysis.abusive and feedback.repeatedRisk and next_analysis.severity == "mild":
        next_analysis.severity = "severe"

    if not next_analysis.abusive and not next_analysis.sexual:
        if next_analysis.emotion == "normal" and feedback.acousticTrend == "escalating" and feedback.sessionRiskScore >= 35:
            next_analysis.emotion = "frustrated"
        elif next_analysis.emotion == "frustrated" and feedback.sessionRiskScore >= 70:
            next_analysis.emotion = "angry"

    if feedback.repeatedRisk and next_analysis.abusive and "반복 위험" not in next_analysis.categories:
        next_analysis.categories.append("반복 위험")

    return next_analysis


@router.post("", response_model=AnalyzeResponse)
async def analyze(payload: AnalyzeRequest) -> AnalyzeResponse:
    local = classify_local(payload.text)
    needs_context = should_defer_abuse_to_context(payload.text)
    needs_feedback_context = _needs_feedback_context(payload.text, payload.feedbackContext, payload.raised)
    emotion_prediction = predict_emotion(payload.audioFeatures)
    if payload.analysisMode == "immediate":
        analysis = local or (
            await classify_context(payload.text, payload.audioFeatures, payload.feedbackContext, emotion_prediction)
            if needs_context or needs_feedback_context
            else normal_result()
        )
    else:
        analysis = local or await classify_context(payload.text, payload.audioFeatures, payload.feedbackContext, emotion_prediction)
    analysis = _apply_feedback_prior(analysis, payload.feedbackContext)

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
        feedbackContext=payload.feedbackContext,
        emotionPrediction=emotion_prediction,
    )
