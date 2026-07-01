from app.models import AnalysisMode, AnalysisResult, EventType, PolicyAction


def resolve_event_type(analysis: AnalysisResult, raised: bool) -> EventType:
    if analysis.sexual:
        return "sexual"
    if analysis.abusive and raised:
        return "abuse-raised"
    if analysis.abusive:
        return "abuse"
    if raised:
        return "raised"
    return "normal"


def decide_policy_actions(event_type: EventType, analysis: AnalysisResult, mode: AnalysisMode) -> list[PolicyAction]:
    actions: list[PolicyAction] = []

    if mode == "immediate":
        if event_type in {"abuse", "abuse-raised", "sexual"}:
            actions.append("mute")
        if event_type in {"raised", "abuse-raised"}:
            actions.extend(["pitch_shift", "volume_reduce"])

    if event_type in {"abuse", "abuse-raised", "raised", "sexual"}:
        actions.append("warn_tts")

    if event_type in {"abuse", "abuse-raised", "raised", "sexual"} or analysis.emotion in {"angry", "threatening"}:
        actions.append("escalate")

    if event_type in {"abuse", "abuse-raised", "sexual"} or analysis.emotion == "threatening":
        actions.append("report")

    return list(dict.fromkeys(actions))
