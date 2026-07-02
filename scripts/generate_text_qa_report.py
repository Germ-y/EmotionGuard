import argparse
import collections
import json
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INPUT = ROOT / "qa" / "results" / "text_eval_20260702_175933.json"
DEFAULT_OUTPUT = ROOT / "qa" / "reports" / "text_qa_report_20260702.md"


def percent(value: float) -> str:
    return f"{value * 100:.2f}%"


def load_result(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def make_category_rows(metrics: dict[str, dict[str, Any]]) -> str:
    rows = []
    for category, values in metrics.items():
        rows.append(
            "| {category} | {total:,} | {passed:,} | {failed:,} | {rate} |".format(
                category=category,
                total=values["total"],
                passed=values["passed"],
                failed=values["failed"],
                rate=percent(values["passRate"]),
            )
        )
    return "\n".join(rows)


def make_counter_rows(counter: collections.Counter, key_formatter=str) -> str:
    rows = []
    for key, count in counter.most_common():
        rows.append(f"| {key_formatter(key)} | {count:,} |")
    return "\n".join(rows)


def classify_failure(message: str) -> str:
    if message.startswith("eventType:"):
        return "이벤트 유형 불일치"
    if message.startswith("abusive:"):
        return "폭언 여부 불일치"
    if message.startswith("sexual:"):
        return "성희롱 여부 불일치"
    if message.startswith("severity:"):
        return "심각도 불일치"
    if message.startswith("missing policy action"):
        return "정책 액션 누락"
    if message.startswith("unexpected policy action"):
        return "정책 액션 과다"
    if "maskedText" in message:
        return "마스킹 결과 불일치"
    return "기타"


def build_report(data: dict[str, Any], input_path: Path) -> str:
    summary = data["summary"]
    results = data["results"]
    pass_rate = summary["passed"] / max(1, summary["completed"])

    confusion = collections.Counter(
        (
            result["expected"].get("eventType"),
            (result["actual"] or {}).get("eventType"),
        )
        for result in results
        if not result["passed"]
    )
    sources = collections.Counter((result["actual"] or {}).get("source", "none") for result in results)
    context_metrics = collections.Counter(
        (
            "문맥 판단 필요" if result["expected"].get("contextRequired") else "즉시/비문맥",
            "통과" if result["passed"] else "실패",
        )
        for result in results
    )
    failure_reasons = collections.Counter(
        classify_failure(message)
        for result in results
        if not result["passed"]
        for message in result["failures"]
    )
    worst_categories = sorted(
        summary["categoryMetrics"].items(),
        key=lambda item: item[1]["passRate"],
    )[:5]
    worst_lines = "\n".join(
        "- {category}: {passed:,}/{total:,} 통과, 실패 {failed:,}건, 통과율 {rate}".format(
            category=category,
            passed=values["passed"],
            total=values["total"],
            failed=values["failed"],
            rate=percent(values["passRate"]),
        )
        for category, values in worst_categories
    )

    return f"""# EmotionGuard 텍스트 QA 검증 리포트

## 1. 검증 개요

본 검증은 외부 공개 한국어 유해 발화 데이터셋을 EmotionGuard의 텍스트 QA 케이스로 변환한 뒤, 분석 엔진의 판단 결과를 기대값과 자동 비교하는 방식으로 수행하였다. 검증 대상은 `eventType`, `abusive`, `sexual`, `severity`, `maskedText`, `policyActions`이며, 즉시 감지 경로와 GPT 문맥 판단 경로를 모두 포함하였다.

- 평가 입력: `qa/text/emotionguard_text_qa_5000.jsonl`
- 평가 결과: `{input_path.as_posix()}`
- 전체 케이스: {summary["selected"]:,}건
- 완료 케이스: {summary["completed"]:,}건
- 통과: {summary["passed"]:,}건
- 실패: {summary["failed"]:,}건
- 전체 통과율: {percent(pass_rate)}
- 문맥 판단 포함 여부: 포함

## 2. 데이터셋 구성

QA 데이터는 Korpora 한국어 혐오 데이터셋과 KOLD 한국어 공격 표현 데이터셋을 기반으로 구성하였다. 원천 라벨을 EmotionGuard의 정책 판단 단위에 맞춰 정상, 폭언, 성희롱, 문맥 판단 필요 케이스로 재구성하고, 각 케이스마다 기대 이벤트와 정책 액션을 지정하였다.

| 항목 | 내용 |
|---|---|
| 원천 데이터 | Korpora Korean Hate Speech, KOLD |
| QA 변환 단위 | 발화 텍스트 1건 |
| 기대값 | 이벤트 유형, 폭언 여부, 성희롱 여부, 심각도, 마스킹, 정책 액션 |
| 평가 방식 | Expected vs Actual 자동 비교 |
| 중간 저장 | `.partial.jsonl` 단위로 건별 저장 후 재개 가능 |

## 3. 전체 결과

| 지표 | 값 |
|---|---:|
| 전체 케이스 | {summary["completed"]:,} |
| 통과 | {summary["passed"]:,} |
| 실패 | {summary["failed"]:,} |
| 통과율 | {percent(pass_rate)} |

## 4. 카테고리별 결과

| 카테고리 | 전체 | 통과 | 실패 | 통과율 |
|---|---:|---:|---:|---:|
{make_category_rows(summary["categoryMetrics"])}

## 5. 판단 경로별 처리 현황

| 판단 소스 | 건수 |
|---|---:|
{make_counter_rows(sources)}

| 케이스 유형 | 결과 | 건수 |
|---|---|---:|
{make_counter_rows(context_metrics, lambda key: f"{key[0]} | {key[1]}")}

## 6. 주요 실패 패턴

| 기대값 -> 실제값 | 실패 건수 |
|---|---:|
{make_counter_rows(confusion, lambda key: f"{key[0] or '-'} -> {key[1] or '-'}")}

| 실패 원인 | 발생 횟수 |
|---|---:|
{make_counter_rows(failure_reasons)}

가장 큰 실패 패턴은 폭언으로 라벨링된 케이스가 정상으로 분류된 미탐이다. 특히 외부 데이터셋의 공격 표현 중 직접 욕설이 아닌 조롱, 혐오, 집단 비하 표현은 현재 정책 기준에서 정상으로 내려가는 경우가 많았다. 반대로 정상 케이스를 폭언 또는 성희롱으로 판단한 오탐은 전체 실패 중 상대적으로 적었다.

## 7. 취약 카테고리

{worst_lines}

위 카테고리는 직접 욕설보다 맥락형 공격성, 조롱, 혐오 표현이 많이 포함되어 있어 단순 사전 기반 감지보다 문맥 판단 기준의 영향을 크게 받는다. 따라서 즉시 마스킹 대상과 문맥 경고 대상을 분리하되, 문맥형 공격성에 대한 GPT 판단 프롬프트와 정책 액션 기준을 보강할 필요가 있다.

## 8. 개선 방향

1. 문맥형 공격 표현 기준 강화
   - 직접 욕설이 없어도 특정 집단 또는 개인을 모욕·비하하는 표현은 `abuse`로 분류하도록 프롬프트 기준을 보강한다.

2. 즉시 차단과 문맥 경고의 역할 분리
   - 욕설 단어가 명확한 경우는 즉시 마스킹하고, 조롱·혐오·성적 암시 등은 GPT 문맥 판단 후 경고와 보고서에 반영한다.

3. 성희롱 오탐 점검
   - 일부 폭언 케이스가 성희롱으로 분류되는 사례가 있어 성적 맥락 판단 기준을 더 엄격히 조정한다.

4. 실패 케이스 기반 회귀 테스트 구축
   - 실패 케이스를 별도 regression set으로 분리해 프롬프트 또는 정책 엔진 수정 후 재검증한다.

## 9. 결론

EmotionGuard 텍스트 QA는 5,000건 기준 {percent(pass_rate)}의 전체 통과율을 보였다. 정상 발화 방어와 명시적 위험 표현 감지는 비교적 안정적이지만, 외부 데이터셋의 문맥형 공격 표현에서는 미탐이 집중되었다. 향후 개선은 문맥 판단 프롬프트와 정책 기준을 보강하고, 실패 케이스를 회귀 테스트로 관리하는 방향이 적절하다.
"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate a Korean markdown report from EmotionGuard text QA results.")
    parser.add_argument("--input", default=str(DEFAULT_INPUT))
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    input_path = Path(args.input)
    output_path = Path(args.output)
    data = load_result(input_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(build_report(data, input_path), encoding="utf-8")
    print(output_path)


if __name__ == "__main__":
    main()
