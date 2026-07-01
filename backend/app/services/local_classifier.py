import json
import re
from functools import lru_cache
from pathlib import Path

from app.models import AnalysisResult


DATA_DIR = Path(__file__).resolve().parents[1] / "data"
DATA_PATH = DATA_DIR / "dictionaries.json"
AIHUB_DATA_PATH = DATA_DIR / "dictionaries.aihub.json"
DICTIONARY_KEYS = [
    "abuse_words",
    "abuse_exceptions",
    "sexual_words",
    "sexual_exceptions",
    "high_risk_words",
]


@lru_cache(maxsize=1)
def load_dictionaries() -> dict[str, list[str]]:
    with DATA_PATH.open(encoding="utf-8-sig") as file:
        data = json.load(file)

    if AIHUB_DATA_PATH.exists():
        with AIHUB_DATA_PATH.open(encoding="utf-8-sig") as file:
            generated = json.load(file)
        for key in DICTIONARY_KEYS:
            generated_values = generated.get(key, [])
            if not isinstance(generated_values, list):
                generated_values = []
            values = [*data.get(key, []), *generated_values]
            data[key] = list(dict.fromkeys(value for value in values if isinstance(value, str) and value.strip()))

    return data


def normalize(text: str) -> str:
    return "".join(text.lower().split())


def _words_in(text: str, word_key: str, exception_key: str) -> list[str]:
    data = load_dictionaries()
    original = text.lower()
    compact = normalize(text)

    for exception in data[exception_key]:
        original = original.replace(exception, " ")
        compact = compact.replace(normalize(exception), "")

    from_original = [word for word in data[word_key] if word.lower() in original]
    from_compact = [word for word in data[word_key] if normalize(word) in compact]

    return list(dict.fromkeys([*from_original, *from_compact]))


def abuse_words_in(text: str) -> list[str]:
    return _words_in(text, "abuse_words", "abuse_exceptions")


def sexual_words_in(text: str) -> list[str]:
    return _words_in(text, "sexual_words", "sexual_exceptions")


def is_local_sexual(text: str) -> bool:
    return bool(sexual_words_in(text))


def mask_sensitive(text: str) -> str:
    data = load_dictionaries()
    masked = text
    exceptions = list(dict.fromkeys([*data["abuse_exceptions"], *data["sexual_exceptions"]]))
    protected = [(f"\x00{index}\x00", exception) for index, exception in enumerate(exceptions)]

    for key, exception in protected:
        masked = masked.replace(exception, key)
    for word in list(dict.fromkeys([*data["abuse_words"], *data["sexual_words"]])):
        masked = re.sub(re.escape(word), lambda match: "*" * len(match.group(0)), masked, flags=re.IGNORECASE)
    for key, exception in protected:
        masked = masked.replace(key, exception)

    return masked


def mask_abuse(text: str) -> str:
    return mask_sensitive(text)


def _has_any(compact: str, words: list[str]) -> bool:
    return any(normalize(word) in compact for word in words)


def _contextual_fallback(text: str) -> AnalysisResult | None:
    data = load_dictionaries()
    compact = normalize(text)

    if any(normalize(exception) in compact for exception in data["sexual_exceptions"]):
        return None

    sexual_rules = [
        (
            ["퇴근몇시", "퇴근시간", "몇시에끝나"],
            ["기다릴게", "기다릴께", "기다리겠다", "기다리고있", "찾아갈게", "찾아갈께"],
            ["성희롱", "스토킹"],
        ),
        (
            ["집", "주소", "사는곳"],
            ["알아낼", "찾아갈", "기다릴", "따라갈"],
            ["성희롱", "스토킹"],
        ),
        (
            ["목소리"],
            ["또전화", "계속듣고", "듣고싶", "반했", "설레", "섹시"],
            ["성희롱"],
        ),
        (
            ["개인연락처", "개인번호", "카톡아이디", "인스타"],
            ["알려줘", "줄래", "줘", "궁금"],
            ["성희롱"],
        ),
        (
            ["얼굴"],
            ["보여줘", "보고싶", "궁금"],
            ["성희롱"],
        ),
    ]

    for anchors, triggers, categories in sexual_rules:
        if _has_any(compact, anchors) and _has_any(compact, triggers):
            return AnalysisResult(
                abusive=True,
                severity="severe",
                categories=categories,
                emotion="threatening" if "스토킹" in categories else "angry",
                sexual=True,
                source="fallback",
                triggeredWords=[*anchors, *triggers],
            )

    threat_rules = [
        (["찾아갈게", "찾아간다", "가만안둬", "가만두지않"], ["위협"]),
        (["죽여버", "죽인다", "죽여"], ["위협"]),
    ]
    for triggers, categories in threat_rules:
        if _has_any(compact, triggers):
            return AnalysisResult(
                abusive=True,
                severity="severe",
                categories=categories,
                emotion="threatening",
                sexual=False,
                source="fallback",
                triggeredWords=triggers,
            )

    return None


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

    contextual = _contextual_fallback(text)
    if contextual:
        return contextual

    return AnalysisResult(
        abusive=False,
        severity="none",
        categories=[],
        emotion="normal",
        sexual=False,
        source="fallback",
        triggeredWords=[],
    )


def normal_result() -> AnalysisResult:
    return AnalysisResult(
        abusive=False,
        severity="none",
        categories=[],
        emotion="normal",
        sexual=False,
        source="local",
        triggeredWords=[],
    )


def classify_local(text: str) -> AnalysisResult | None:
    sexual_triggered = sexual_words_in(text)
    if sexual_triggered:
        return AnalysisResult(
            abusive=True,
            severity="severe",
            categories=["성희롱"],
            emotion="threatening",
            sexual=True,
            source="local",
            triggeredWords=sexual_triggered,
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
