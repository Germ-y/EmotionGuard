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
    text(draw, (x + 32, y + 28), "카테고리별 통과율", 28, INK, True)
    text(draw, (x + 32, y + 66), "낮은 통과율 순", 20, MUTED)

    items = sorted(metrics.items(), key=lambda item: item[1]["passRate"])
    top = y + 112
    label_x = x + 32
    bar_x = x + 330
    bar_w = 380
    row_h = 38
    for index, (category, values) in enumerate(items):
        yy = top + index * row_h
        rate = values["passRate"]
        color = RED if rate < 0.65 else ORANGE if rate < 0.8 else BLUE
        text(draw, (label_x, yy - 2), category, 18, INK, True)
        bar(draw, bar_x, yy + 4, bar_w, 16, rate, color)
        text(draw, (bar_x + bar_w + 22, yy - 3), pct(rate), 19, color, True)
        text(draw, (bar_x + bar_w + 112, yy - 3), f"{values['passed']:,}/{values['total']:,}", 17, MUTED)


def draw_failures(draw: ImageDraw.ImageDraw, results: list[dict[str, Any]]) -> None:
    x, y, w, h = 970, 470, 470, 520
    rounded(draw, (x, y, x + w, y + h), 24, CARD, LINE)
    text(draw, (x + 30, y + 28), "주요 실패 패턴", 28, INK, True)

    confusion = collections.Counter(
        (
            result["expected"].get("eventType"),
            (result["actual"] or {}).get("eventType"),
        )
        for result in results
        if not result["passed"]
    )
    sources = collections.Counter((result["actual"] or {}).get("source", "none") for result in results)

    max_failure = max(confusion.values()) if confusion else 1
    yy = y + 86
    for (expected, actual), count in confusion.most_common():
        label = f"{expected or '-'} -> {actual or '-'}"
        text(draw, (x + 30, yy), label, 20, INK, True)
        bar(draw, x + 30, yy + 30, 300, 18, count / max_failure, RED)
        text(draw, (x + 350, yy + 20), f"{count:,}건", 21, RED, True)
        yy += 78

    draw.line((x + 30, y + 376, x + w - 30, y + 376), fill=LINE, width=2)
    text(draw, (x + 30, y + 402), "판단 경로", 24, INK, True)
    max_source = max(sources.values()) if sources else 1
    source_colors = {"openai": BLUE, "local": ORANGE, "fallback": RED}
    yy = y + 445
    for source, count in sources.most_common():
        text(draw, (x + 30, yy), source, 19, MUTED, True)
        bar(draw, x + 130, yy + 3, 220, 15, count / max_source, source_colors.get(source, BLUE))
        text(draw, (x + 365, yy - 3), f"{count:,}", 19, INK, True)
        yy += 34


def generate_visual(data: dict[str, Any], output_path: Path) -> None:
    image = Image.new("RGB", (1510, 1080), BG)
    draw = ImageDraw.Draw(image)
    draw_overview(draw, data["summary"])
    draw_categories(draw, data["summary"]["categoryMetrics"])
    draw_failures(draw, data["results"])
    text(draw, (70, 1030), "요약: 정상 발화 방어는 안정적이며, 문맥형 공격 표현 미탐이 주요 개선 지점", 23, MUTED)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    image.save(output_path)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate a single PNG visualization from EmotionGuard text QA results.")
    parser.add_argument("--input", default=str(DEFAULT_INPUT))
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    data = load_result(Path(args.input))
    output_path = Path(args.output)
    generate_visual(data, output_path)
    print(output_path)


if __name__ == "__main__":
    main()
