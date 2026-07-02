import argparse
import asyncio
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_QA_PATH = ROOT / "qa" / "text" / "emotionguard_text_qa_5000.jsonl"
DEFAULT_OUTPUT_DIR = ROOT / "qa" / "results"
BACKEND_DIR = ROOT / "backend"


def make_progress(items: list[dict[str, Any]], enabled: bool):
    if not enabled:
        return items
    try:
        from tqdm import tqdm

        return tqdm(items, total=len(items), desc="EmotionGuard QA", unit="case")
    except Exception:
        print("tqdm is not installed. Falling back to periodic progress logs.")
        return items


def read_cases(path: Path) -> list[dict[str, Any]]:
    cases = []
    with path.open(encoding="utf-8") as file:
        for line in file:
            line = line.strip()
            if line:
                cases.append(json.loads(line))
    return cases


def post_json(url: str, payload: dict[str, Any], timeout: float) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


async def analyze_direct(payload: dict[str, Any]) -> dict[str, Any]:
    if str(BACKEND_DIR) not in sys.path:
        sys.path.insert(0, str(BACKEND_DIR))
    from app.models import AnalyzeRequest
    from app.routers.analyze import analyze

    response = await analyze(AnalyzeRequest(**payload))
    return response.model_dump()


async def evaluate_case_direct(case: dict[str, Any]) -> dict[str, Any]:
    try:
        actual = await analyze_direct(case["request"])
        failures = compare(case, actual)
        return {
            "id": case["id"],
            "category": case["category"],
            "passed": not failures,
            "failures": failures,
            "expected": case["expected"],
            "actual": actual,
        }
    except Exception as exc:
        return {
            "id": case["id"],
            "category": case["category"],
            "passed": False,
            "failures": [f"request failed: {exc}"],
            "expected": case["expected"],
            "actual": None,
        }


async def evaluate_direct_concurrent(cases: list[dict[str, Any]], concurrency: int, progress: bool) -> list[dict[str, Any]]:
    semaphore = asyncio.Semaphore(max(1, concurrency))
    results: list[dict[str, Any] | None] = [None] * len(cases)
    completed = 0
    progress_bar = None
    if progress:
        try:
            from tqdm import tqdm

            progress_bar = tqdm(total=len(cases), desc="EmotionGuard QA", unit="case")
        except Exception:
            print("tqdm is not installed. Falling back to periodic progress logs.")

    async def run_one(index: int, case: dict[str, Any]) -> None:
        nonlocal completed
        async with semaphore:
            results[index] = await evaluate_case_direct(case)
            completed += 1
            if progress_bar:
                progress_bar.update(1)
            elif completed % 100 == 0:
                print(f"evaluated {completed}/{len(cases)}")

    await asyncio.gather(*(run_one(index, case) for index, case in enumerate(cases)))
    if progress_bar:
        progress_bar.close()
    return [result for result in results if result is not None]


def compare(case: dict[str, Any], actual: dict[str, Any]) -> list[str]:
    expected = case["expected"]
    failures = []

    for key in ("eventType", "abusive", "sexual", "raised"):
        if actual.get(key) != expected.get(key):
            failures.append(f"{key}: expected {expected.get(key)!r}, got {actual.get(key)!r}")

    if expected.get("severity") != "any" and actual.get("severity") != expected.get("severity"):
        failures.append(f"severity: expected {expected.get('severity')!r}, got {actual.get('severity')!r}")

    if expected.get("mustMask") and actual.get("maskedText") != expected.get("maskedText"):
        failures.append("maskedText mismatch")

    actions = set(actual.get("policyActions", []))
    for action in expected.get("policyActionsAny", []):
        if action not in actions:
            failures.append(f"missing policy action: {action}")
    for action in expected.get("policyActionsNot", []):
        if action in actions:
            failures.append(f"unexpected policy action: {action}")

    return failures


def category_metrics(results: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    metrics: dict[str, dict[str, Any]] = {}
    for result in results:
        category = result["category"]
        bucket = metrics.setdefault(category, {"total": 0, "passed": 0, "failed": 0})
        bucket["total"] += 1
        if result["passed"]:
            bucket["passed"] += 1
        else:
            bucket["failed"] += 1
    for bucket in metrics.values():
        bucket["passRate"] = round(bucket["passed"] / max(1, bucket["total"]), 4)
    return dict(sorted(metrics.items()))


def select_cases(cases: list[dict[str, Any]], limit: int | None, include_context: bool) -> list[dict[str, Any]]:
    selected = [
        case
        for case in cases
        if include_context or not case["expected"].get("contextRequired")
    ]
    return selected[:limit] if limit else selected


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate EmotionGuard text QA cases against /api/analyze.")
    parser.add_argument("--qa", default=str(DEFAULT_QA_PATH))
    parser.add_argument("--url", default="http://127.0.0.1:8000/api/analyze")
    parser.add_argument("--limit", type=int, default=200, help="Default protects API cost. Use 0 for all selected cases.")
    parser.add_argument("--include-context", action="store_true", help="Include context/LLM-required cases.")
    parser.add_argument("--timeout", type=float, default=20.0)
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    parser.add_argument("--direct", action="store_true", help="Call backend analysis code in-process instead of HTTP.")
    parser.add_argument("--concurrency", type=int, default=1, help="Concurrent workers for --direct evaluation.")
    parser.add_argument("--progress", action="store_true", help="Show a tqdm progress bar when tqdm is installed.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    cases = read_cases(Path(args.qa))
    limit = args.limit if args.limit > 0 else None
    selected = select_cases(cases, limit, args.include_context)
    results = []

    started = time.strftime("%Y%m%d_%H%M%S")
    if args.direct and args.concurrency > 1:
        results = asyncio.run(evaluate_direct_concurrent(selected, args.concurrency, args.progress))
    else:
        for index, case in enumerate(make_progress(selected, args.progress), start=1):
            try:
                actual = asyncio.run(analyze_direct(case["request"])) if args.direct else post_json(args.url, case["request"], args.timeout)
                failures = compare(case, actual)
                results.append({
                    "id": case["id"],
                    "category": case["category"],
                    "passed": not failures,
                    "failures": failures,
                    "expected": case["expected"],
                    "actual": actual,
                })
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
                results.append({
                    "id": case["id"],
                    "category": case["category"],
                    "passed": False,
                    "failures": [f"request failed: {exc}"],
                    "expected": case["expected"],
                    "actual": None,
                })
            if not args.progress and index % 100 == 0:
                print(f"evaluated {index}/{len(selected)}")

    summary = {
        "qa": str(args.qa),
        "url": args.url,
        "selected": len(selected),
        "includeContext": args.include_context,
        "passed": sum(1 for result in results if result["passed"]),
        "failed": sum(1 for result in results if not result["passed"]),
        "categoryMetrics": category_metrics(results),
        "failures": [
            {
                "id": result["id"],
                "category": result["category"],
                "failures": result["failures"],
                "expectedEventType": result["expected"].get("eventType"),
                "actualEventType": result["actual"].get("eventType") if result["actual"] else None,
            }
            for result in results
            if not result["passed"]
        ][:100],
    }

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"text_eval_{started}.json"
    output_path.write_text(json.dumps({"summary": summary, "results": results}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({**summary, "output": str(output_path)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
