import json
import re
from typing import Any

import httpx

from app.config import settings
from app.models import AnalysisResult
from app.services.local_classifier import conservative_fail


ANALYST_SYSTEM = """당신은 콜센터 상담사 보호 시스템의 실시간 발화 분석 엔진입니다.
고객의 한국어 발화를 받아 폭언 여부와 감정 상태를 동시에 판단합니다.
반드시 아래 JSON 형식만 출력하세요. 설명은 출력하지 마세요.
{"abusive": true|false, "severity": "none"|"mild"|"severe", "categories": [], "emotion": "normal"|"frustrated"|"angry"|"threatening", "sexual": true|false}

판정 기준:
- abusive=true: 욕설, 비속어, 인신공격, 위협, 협박, 성희롱, 모욕적 반말, 조롱, 차별, 비하
- abusive=false: 욕설이나 모욕이 없는 정당한 불만 또는 항의
- "존맛", "개이득", "개꿀"처럼 악의 없는 단순 강조이면 abusive=false
- 애매한 경우는 abusive=false

emotion 판정:
- threatening: 협박 또는 위협 뉘앙스가 있음
- angry: 욕설 없이도 분노가 명확함
- frustrated: 불만이 있으나 공격적이지 않음
- normal: 일반적인 대화나 문의

sexual 판정 기준:
- sexual=true 이면 반드시 abusive=true도 함께 설정
- 신체/외모 품평, 성적 발언, 만남 강요, 스토킹, 성차별 발언 포함
- 맥락상 성희롱이 명확한 경우에만 sexual=true

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
상담사 개인을 직접 겨냥하는 것이 명확할 때만 sexual=true로 판단한다."""


def _coerce_result(payload: dict[str, Any]) -> AnalysisResult:
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
        source="claude",
        triggeredWords=[],
    )


async def classify_with_claude(text: str) -> AnalysisResult:
    if not settings.anthropic_api_key:
        return conservative_fail(text)

    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            response = await client.post(
                "https://api.anthropic.com/v1/messages",
                headers={
                    "content-type": "application/json",
                    "x-api-key": settings.anthropic_api_key,
                    "anthropic-version": "2023-06-01",
                },
                json={
                    "model": settings.anthropic_model,
                    "max_tokens": settings.anthropic_max_tokens,
                    "system": ANALYST_SYSTEM,
                    "messages": [{"role": "user", "content": text}],
                },
            )
            response.raise_for_status()

        data = response.json()
        raw = next((part.get("text", "") for part in data.get("content", []) if part.get("type") == "text"), "")
        match = re.search(r"\{[\s\S]*\}", raw)
        if not match:
            return conservative_fail(text)

        return _coerce_result(json.loads(match.group(0)))
    except Exception:
        return conservative_fail(text)

