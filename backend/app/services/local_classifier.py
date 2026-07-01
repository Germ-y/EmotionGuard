import json
from functools import lru_cache
from pathlib import Path

from app.models import AnalysisResult


DATA_PATH = Path(__file__).resolve().parents[1] / "data" / "dictionaries.json"


@lru_cache(maxsize=1)
def load_dictionaries() -> dict[str, list[str]]:
    with DATA_PATH.open(encoding="utf-8-sig") as file:
        return json.load(file)


def normalize(text: str) -> str:
    return "".join(text.lower().split())


def abuse_words_in(text: str) -> list[str]:
    data = load_dictionaries()
    original = text.lower()
    compact = normalize(text)

    for exception in data["abuse_exceptions"]:
        original = original.replace(exception, " ")
        compact = compact.replace(normalize(exception), "")

    from_original = [word for word in data["abuse_words"] if word in original]
    from_compact = [word for word in data["abuse_words"] if normalize(word) in compact]

    return list(dict.fromkeys([*from_original, *from_compact]))


def is_local_sexual(text: str) -> bool:
    data = load_dictionaries()
    compact = normalize(text)

    if any(normalize(exception) in compact for exception in data["sexual_exceptions"]):
        return False

    return any(normalize(word) in compact for word in data["sexual_words"])


def mask_abuse(text: str) -> str:
    data = load_dictionaries()
    masked = text
    placeholders = [(f"\x00{index}\x00", exception) for index, exception in enumerate(data["abuse_exceptions"])]

    for key, exception in placeholders:
        masked = masked.replace(exception, key)
    for word in data["abuse_words"]:
        masked = masked.replace(word, "*" * len(word))
    for key, exception in placeholders:
        masked = masked.replace(key, exception)

    return masked


def conservative_fail(text: str) -> AnalysisResult:
    data = load_dictionaries()
    compact = normalize(text)
    triggered = [word for word in data["high_risk_words"] if normalize(word) in compact]

    if triggered:
        return AnalysisResult(
            abusive=True,
            severity="severe",
            categories=["욕설"],
            emotion="angry",
            sexual=False,
            source="fallback",
            triggeredWords=triggered,
        )

    return AnalysisResult(
        abusive=False,
        severity="none",
        categories=[],
        emotion="normal",
        sexual=False,
        source="fallback",
        triggeredWords=[],
    )


def classify_local(text: str) -> AnalysisResult | None:
    if is_local_sexual(text):
        return AnalysisResult(
            abusive=True,
            severity="severe",
            categories=["성희롱"],
            emotion="threatening",
            sexual=True,
            source="local",
            triggeredWords=[],
        )

    triggered = abuse_words_in(text)
    if triggered:
        return AnalysisResult(
            abusive=True,
            severity="severe",
            categories=["욕설"],
            emotion="angry",
            sexual=False,
            source="local",
            triggeredWords=triggered,
        )

    return None

