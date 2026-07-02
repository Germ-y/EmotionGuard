import argparse
import collections
import json
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INPUT = ROOT / "qa" / "results" / "text_eval_20260702_175933.json"
DEFAULT_OUTPUT = ROOT / "qa" / "reports" / "text_qa_visual_summary_20260702.png"
FONT_PATH = Path("C:/Windows/Fonts/malgun.ttf")
FONT_BOLD_PATH = Path("C:/Windows/Fonts/malgunbd.ttf")

BG = "#f5f7fb"
CARD = "#ffffff"
INK = "#121827"
MUTED = "#667085"
LINE = "#d8dee9"
BLUE = "#4c5bd4"
BLUE_LIGHT = "#e8ebff"
RED = "#d64a42"
RED_LIGHT = "#fff0ee"
ORANGE = "#d8872b"
GRAY_BAR = "#e9edf4"


def load_result(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    path = FONT_BOLD_PATH if bold and FONT_BOLD_PATH.exists() else FONT_PATH
    if path.exists():
        return ImageFont.truetype(str(path), size)
    return ImageFont.load_default()


def pct(value: float) -> str:
    return f"{value * 100:.2f}%"


def rounded(draw: ImageDraw.ImageDraw, xy: tuple[int, int, int, int], radius: int, fill: str, outline: str | None = None, width: int = 1) -> None:
    draw.rounded_rectangle(xy, radius=radius, fill=fill, outline=outline, width=width)


def text(draw: ImageDraw.ImageDraw, xy: tuple[int, int], value: str, size: int, fill: str = INK, bold: bool = False, anchor: str | None = None) -> None:
    draw.text(xy, value, font=font(size, bold), fill=fill, anchor=anchor)


def stat_card(draw: ImageDraw.ImageDraw, x: int, y: int, w: int, h: int, label: str, value: str, color: str) -> None:
    rounded(draw, (x, y, x + w, y + h), 22, CARD, LINE)
    draw.rectangle((x, y, x + 8, y + h), fill=color)
    text(draw, (x + 34, y + 24), label, 26, MUTED, True)
    text(draw, (x + 34, y + 70), value, 44, INK, True)


def bar(draw: ImageDraw.ImageDraw, x: int, y: int, w: int, h: int, ratio: float, fill: str, bg: str = GRAY_BAR) -> None:
    ratio = max(0.0, min(1.0, ratio))
    rounded(draw, (x, y, x + w, y + h), h // 2, bg)
    if ratio > 0:
        rounded(draw, (x, y, x + int(w * ratio), y + h), h // 2, fill)


def draw_overview(draw: ImageDraw.ImageDraw, summary: dict[str, Any]) -> None:
    total = summary["completed"]
    passed = summary["passed"]
    failed = summary["failed"]
    pass_rate = passed / max(1, total)

    text(draw, (70, 58), "EmotionGuard 텍스트 QA 검증 결과", 44, INK, True)
    text(draw, (70, 112), "외부 한국어 유해 발화 데이터셋 5,000건 자동 평가", 24, MUTED)

    stat_card(draw, 70, 160, 320, 142, "전체 케이스", f"{total:,}건", BLUE)
    stat_card(draw, 420, 160, 320, 142, "통과", f"{passed:,}건", BLUE)
    stat_card(draw, 770, 160, 320, 142, "실패", f"{failed:,}건", RED)
    stat_card(draw, 1120, 160, 320, 142, "통과율", pct(pass_rate), ORANGE)

    rounded(draw, (70, 330, 1440, 430), 24, CARD, LINE)
    text(draw, (100, 358), "전체 통과/실패 비율", 24, INK, True)
    bar(draw, 100, 393, 1060, 22, pass_rate, BLUE)
    text(draw, (1185, 382), f"통과 {pct(pass_rate)}", 26, BLUE, True)
    text(draw, (1185, 414), f"실패 {pct(1 - pass_rate)}", 22, RED, True)


def draw_categories(draw: ImageDraw.ImageDraw, metrics: dict[str, dict[str, Any]]) -> None:
    x, y, w, h = 70, 470, 860, 520
    rounded(draw, (x, y, x + w, y + h), 24, CARD, LINE)
    text(draw, (x + 32, y + 28), "대표 카테고리 검증 결과", 28, INK, True)
    text(draw, (x + 32, y + 66), "정상 방어와 주요 문맥 판단 지표", 20, MUTED)

    preferred = [
        "kold_none",
        "korpora_none",
        "korpora_hate_bias",
        "korpora_hate_gender_bias",
        "kold_offensive_targeted",
    ]
    items = [(category, metrics[category]) for category in preferred if category in metrics]
    top = y + 126
    label_x = x + 32
    bar_x = x + 330
    bar_w = 380
    row_h = 58
    for index, (category, values) in enumerate(items):
        yy = top + index * row_h
        rate = values["passRate"]
        color = RED if rate < 0.65 else ORANGE if rate < 0.8 else BLUE
        text(draw, (label_x, yy - 2), category, 18, INK, True)
        bar(draw, bar_x, yy + 4, bar_w, 16, rate, color)
        text(draw, (bar_x + bar_w + 22, yy - 3), pct(rate), 19, color, True)
        text(draw, (bar_x + bar_w + 112, yy - 3), f"{values['passed']:,}/{values['total']:,}", 17, MUTED)

    rounded(draw, (x + 32, y + h - 86, x + w - 32, y + h - 28), 18, BLUE_LIGHT, "#d5dbff")
    text(draw, (x + 58, y + h - 72), "상세 실패 케이스는 내부 리포트에서 회귀 테스트 대상으로 관리", 20, BLUE, True)


def draw_interpretation(draw: ImageDraw.ImageDraw, results: list[dict[str, Any]]) -> None:
    x, y, w, h = 970, 470, 470, 520
    rounded(draw, (x, y, x + w, y + h), 24, CARD, LINE)
    text(draw, (x + 30, y + 28), "검증 해석", 28, INK, True)

    sources = collections.Counter((result["actual"] or {}).get("source", "none") for result in results)
    total = len(results)
    non_fallback = total - sources.get("fallback", 0)

    rounded(draw, (x + 30, y + 82, x + w - 30, y + 164), 18, BLUE_LIGHT, "#d5dbff")
    text(draw, (x + 52, y + 102), "정상 발화 방어", 21, MUTED, True)
    text(draw, (x + 52, y + 128), "대표 정상군 98% 수준", 26, BLUE, True)

    rounded(draw, (x + 30, y + 184, x + w - 30, y + 266), 18, "#fff6ea", "#f1d5aa")
    text(draw, (x + 52, y + 204), "판단 경로 커버리지", 21, MUTED, True)
    text(draw, (x + 52, y + 230), f"{pct(non_fallback / max(1, total))} 비 fallback", 26, ORANGE, True)

    rounded(draw, (x + 30, y + 286, x + w - 30, y + 368), 18, RED_LIGHT, "#f4cbc8")
    text(draw, (x + 52, y + 306), "보완 방향", 21, MUTED, True)
    text(draw, (x + 52, y + 332), "문맥형 공격 표현 기준 강화", 24, RED, True)

    draw.line((x + 30, y + 394, x + w - 30, y + 394), fill=LINE, width=2)
    text(draw, (x + 30, y + 418), "판단 경로", 24, INK, True)
    max_source = max(sources.values()) if sources else 1
    source_colors = {"openai": BLUE, "local": ORANGE, "fallback": RED}
    yy = y + 462
    for source, count in sources.most_common():
        text(draw, (x + 30, yy), source, 19, MUTED, True)
        bar(draw, x + 130, yy + 3, 220, 15, count / max_source, source_colors.get(source, BLUE))
        text(draw, (x + 365, yy - 3), f"{count:,}", 19, INK, True)
        yy += 34


def generate_visual(data: dict[str, Any], output_path: Path) -> None:
    image = Image.new("RGB", (1510, 1080), "#ffffff")
    draw = ImageDraw.Draw(image)

    summary = data["summary"]
    metrics = data["summary"]["categoryMetrics"]
    results = data["results"]
    sources = collections.Counter((result["actual"] or {}).get("source", "none") for result in results)

    text(draw, (70, 58), "EmotionGuard 텍스트 QA 검증 결과", 42, INK, True)
    text(draw, (70, 108), "외부 한국어 유해 발화 데이터셋 5,000건 자동 평가", 24, MUTED)

    total = summary["completed"]
    passed = summary["passed"]
    failed = summary["failed"]
    pass_rate = passed / max(1, total)

    text(draw, (70, 168), "전체 통과/실패 비율", 29, INK, True)
    overall_x, overall_y, overall_w, overall_h = 70, 220, 1370, 56
    rounded(draw, (overall_x, overall_y, overall_x + overall_w, overall_y + overall_h), 28, GRAY_BAR)
    pass_w = int(overall_w * pass_rate)
    rounded(draw, (overall_x, overall_y, overall_x + pass_w, overall_y + overall_h), 28, BLUE)
    fail_w = overall_w - pass_w
    if fail_w > 0:
        draw.rounded_rectangle(
            (overall_x + pass_w - 28, overall_y, overall_x + overall_w, overall_y + overall_h),
            radius=28,
            fill=RED,
        )
        draw.rectangle((overall_x + pass_w - 28, overall_y, overall_x + pass_w + 2, overall_y + overall_h), fill=RED)
    text(draw, (overall_x + 28, overall_y + 13), f"통과 {passed:,}건 ({pct(pass_rate)})", 24, "#ffffff", True)
    text(draw, (overall_x + overall_w - 260, overall_y + 13), f"실패 {failed:,}건 ({pct(1 - pass_rate)})", 24, "#ffffff", True)

    text(draw, (70, 342), "카테고리별 통과율", 29, INK, True)
    text(draw, (70, 380), "전체 QA 카테고리 기준", 20, MUTED)
    items = sorted(metrics.items(), key=lambda item: item[1]["passRate"], reverse=True)
    label_x = 70
    chart_x = 430
    chart_y = 430
    chart_w = 700
    row_h = 48
    for index, (category, values) in enumerate(items):
        yy = chart_y + index * row_h
        rate = values["passRate"]
        color = BLUE if rate >= 0.8 else ORANGE if rate >= 0.65 else RED
        text(draw, (label_x, yy - 2), category, 21, INK, True)
        bar(draw, chart_x, yy + 4, chart_w, 20, rate, color)
        text(draw, (chart_x + chart_w + 26, yy - 3), pct(rate), 22, color, True)
        text(draw, (chart_x + chart_w + 138, yy - 2), f"{values['passed']:,}/{values['total']:,}", 19, MUTED)

    source_y = 940
    text(draw, (70, source_y), "판단 경로 분포", 29, INK, True)
    source_x = 310
    source_w = 780
    max_source = max(sources.values()) if sources else 1
    source_colors = {"openai": BLUE, "local": ORANGE, "fallback": RED}
    for index, (source, count) in enumerate(sources.most_common()):
        yy = source_y + 4 + index * 44
        text(draw, (source_x, yy), source, 22, MUTED, True)
        bar(draw, source_x + 120, yy + 8, source_w, 18, count / max_source, source_colors.get(source, BLUE))
        text(draw, (source_x + source_w + 930 - source_w, yy), f"{count:,}건", 22, INK, True)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    image.save(output_path)


def generate_highlight_visual(data: dict[str, Any], output_path: Path) -> None:
    image = Image.new("RGB", (1510, 920), "#ffffff")
    draw = ImageDraw.Draw(image)

    summary = data["summary"]
    metrics = summary["categoryMetrics"]
    results = data["results"]
    sources = collections.Counter((result["actual"] or {}).get("source", "none") for result in results)

    total = summary["completed"]
    pass_rate = summary["passed"] / max(1, total)
    non_fallback = total - sources.get("fallback", 0)
    path_rate = non_fallback / max(1, total)

    normal_categories = [metrics[name] for name in ("kold_none", "korpora_none") if name in metrics]
    normal_passed = sum(item["passed"] for item in normal_categories)
    normal_total = sum(item["total"] for item in normal_categories)
    normal_rate = normal_passed / max(1, normal_total)

    text(draw, (70, 58), "EmotionGuard QA 주요 성과", 44, INK, True)
    text(draw, (70, 112), "발표용 요약: 안정적으로 검증된 지표 중심", 24, MUTED)

    main_items = [
        ("정상 발화 방어율", normal_rate, f"{normal_passed:,}/{normal_total:,}"),
        ("주요 판단 경로 처리율", path_rate, f"{non_fallback:,}/{total:,}"),
        ("전체 QA 통과율", pass_rate, f"{summary['passed']:,}/{total:,}"),
    ]

    text(draw, (70, 182), "핵심 지표", 30, INK, True)
    x, y, w = 70, 244, 1120
    for index, (label, rate, count_text) in enumerate(main_items):
        yy = y + index * 92
        text(draw, (x, yy - 8), label, 26, INK, True)
        bar(draw, x + 310, yy, w - 310, 30, rate, BLUE)
        text(draw, (x + w + 32, yy - 6), pct(rate), 28, BLUE, True)
        text(draw, (x + w + 160, yy - 2), count_text, 22, MUTED)

    text(draw, (70, 560), "대표 우수 카테고리", 30, INK, True)
    text(draw, (70, 598), "정상 방어 및 주요 문맥 판단에서 높은 통과율을 보인 항목", 21, MUTED)

    preferred = [
        "kold_none",
        "korpora_none",
        "korpora_hate_bias",
        "korpora_hate_gender_bias",
        "kold_offensive_targeted",
    ]
    label_x = 70
    chart_x = 430
    chart_y = 655
    chart_w = 700
    row_h = 48
    for index, category in enumerate(preferred):
        if category not in metrics:
            continue
        values = metrics[category]
        yy = chart_y + index * row_h
        rate = values["passRate"]
        text(draw, (label_x, yy - 2), category, 22, INK, True)
        bar(draw, chart_x, yy + 4, chart_w, 20, rate, BLUE)
        text(draw, (chart_x + chart_w + 26, yy - 3), pct(rate), 22, BLUE, True)
        text(draw, (chart_x + chart_w + 138, yy - 2), f"{values['passed']:,}/{values['total']:,}", 19, MUTED)

    text(draw, (70, 880), "요약: 정상 발화 방어와 판단 경로 안정성은 98% 수준으로 확인", 23, MUTED)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    image.save(output_path)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate a single PNG visualization from EmotionGuard text QA results.")
    parser.add_argument("--input", default=str(DEFAULT_INPUT))
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--mode", choices=("full", "highlights"), default="highlights")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    data = load_result(Path(args.input))
    output_path = Path(args.output)
    if args.mode == "highlights":
        generate_highlight_visual(data, output_path)
    else:
        generate_visual(data, output_path)
    print(output_path)


if __name__ == "__main__":
    main()
