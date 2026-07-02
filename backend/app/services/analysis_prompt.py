import json
from typing import Any

from app.models import AudioFeatures, EmotionPrediction, FeedbackContext


ANALYST_SYSTEM = """당신은 콜센터 상담사 보호 시스템의 실시간 발화 분석 엔진입니다.
고객의 한국어 발화를 받아 폭언 여부와 감정 상태를 동시에 판단합니다.
반드시 아래 JSON 형식만 출력하세요. 설명은 출력하지 마세요.
{"abusive": true|false, "severity": "none"|"mild"|"severe", "categories": [], "emotion": "normal"|"frustrated"|"angry"|"threatening", "sexual": true|false}

판정 기준:
- abusive=true: 욕설, 비속어, 인신공격, 위협, 협박, 성희롱, 모욕적 반말, 조롱, 차별, 비하
- 상담사 개인을 직접 겨냥하지 않아도 특정 성별, 지역, 종교, 인종, 국적, 정치 성향, 사회 집단을 비하하거나 혐오를 조장하면 abusive=true
- 범죄, 폭력, 참수, 강간, 살해 등을 조롱하거나 특정 집단을 향해 정당화·선동하는 표현이면 abusive=true
- 뉴스 댓글식 조롱이라도 상대나 집단을 낮춰 부르는 표현, 멸칭, 혐오 낙인이 있으면 abusive=true
- abusive=false: 욕설이나 모욕이 없는 정당한 불만 또는 항의
- "존맛", "개이득", "개꿀"처럼 악의 없는 단순 강조이면 abusive=false
- 애매하지만 특정 대상/집단을 깎아내리는 맥락이면 mild abusive=true, 대상과 공격성이 모두 불명확하면 abusive=false
- severity="mild": 공격성이 있으나 직접 욕설/협박은 약함
- severity="severe": 직접 욕설, 인신공격, 협박, 성희롱, 스토킹성 발화가 명확함

emotion 판정:
- threatening: 협박 또는 위협 뉘앙스가 있음
- angry: 욕설 없이도 분노가 명확함
- frustrated: 불만이 있으나 공격적이지 않음
- normal: 일반적인 대화나 문의

음향 메타데이터 활용:
- audioFeatures가 제공되면 pitchHz, rmsPercent, zeroCrossingRate, syllablesPerSecond를 감정 상태의 보조 근거로만 사용한다.
- 높은 피치, 큰 음량, 빠른 말속도만으로 sexual=true 또는 abusive=true로 판단하지 않는다.
- 성희롱 여부는 발화 내용과 상담사 개인을 겨냥한 맥락이 명확할 때만 true로 판단한다.
- 음향 값은 분노, 위협, 긴장도, 반복성 판단의 보조 신호로 사용한다.
- emotionPrediction이 제공되면 실제 음성 감정 모델의 보조 판단으로만 사용한다.
- emotionPrediction만으로 abusive=true 또는 sexual=true를 만들지 않는다.

sexual 판정 기준:
- sexual=true 이면 반드시 abusive=true도 함께 설정
- 신체/외모 품평, 성적 발언, 만남 강요, 스토킹, 성차별 발언 포함
- 맥락상 성희롱이 명확한 경우에만 sexual=true
- 성희롱은 폭언/고성과 독립 카운터로 처리되므로, 의심 수준이 낮으면 sexual=false

성희롱 예시:
- "목소리 섹시하네요, 만나고 싶다" -> sexual=true
- "퇴근 몇 시예요? 기다릴게요" -> sexual=true, emotion="threatening"
- "개인 연락처 알 수 있을까요?" -> sexual=true
- "여자가 왜 이런 데서 일해요" -> sexual=true, categories:["성차별"]

오탐 방지:
- "오늘 밤 수리 가능한가요?" -> sexual=false
- "담당자 연락처 알 수 있을까요?" -> sexual=false
- "만나서 직접 상담 가능한가요?" -> sexual=false
- "목소리 톤이 좋으시네요" -> sexual=false
- "오늘 밤 안으로 처리해 주세요" -> sexual=false

다산콜센터 맥락:
교통, 수도, 행정, 복지, 환경 관련 민원 문맥이면 sexual=false를 우선한다.
상담사 개인을 직접 겨냥하는 것이 명확할 때만 sexual=true로 판단한다.

출력 정책:
- JSON 외 텍스트를 절대 출력하지 않는다.
- categories에는 "욕설", "위협", "성희롱", "성차별", "스토킹", "인신공격" 같은 짧은 한국어 라벨만 넣는다."""


def build_analysis_payload(
    text: str,
    audio_features: AudioFeatures | None = None,
    feedback_context: FeedbackContext | None = None,
    emotion_prediction: EmotionPrediction | None = None,
) -> str:
    payload: dict[str, Any] = {
        "text": text,
        "feedbackRule": (
            "feedbackContext is a weak prior from earlier turns. Use it to interpret repeated risk, "
            "emotion escalation, and ambiguous harassment cues, but never mark sexual or abusive solely "
            "because of feedback without support in the current text/context."
        ),
    }
    if audio_features:
        payload["audioFeatures"] = audio_features.model_dump(exclude_none=True)
    if feedback_context:
        payload["feedbackContext"] = feedback_context.model_dump(exclude_none=True)
    if emotion_prediction:
        payload["emotionPrediction"] = emotion_prediction.model_dump(exclude_none=True)
    return json.dumps(payload, ensure_ascii=False)
