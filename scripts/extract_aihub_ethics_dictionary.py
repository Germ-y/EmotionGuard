import argparse
import io
import json
import re
import tarfile
import zipfile
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


TARGETS = {
    "ABUSE": "abuse_words",
    "SEXUAL": "sexual_words",
}

COMMON_STOP_TOKENS = {
    "하다",
    "되다",
    "있다",
    "없다",
    "같다",
    "보다",
    "가다",
    "오다",
    "주다",
    "받다",
    "말다",
    "알다",
    "모르다",
    "좋다",
    "나쁘다",
    "너",
    "니",
    "나",
    "내",
    "그",
    "그거",
    "거",
    "것",
    "뭐",
    "말",
    "사람",
    "여자",
    "남자",
    "애들",
    "돈",
    "때",
    "존맛",
    "개이득",
    "개꿀",
}


def normalize(value: str) -> str:
    return "".join(value.lower().split())


def token_is_usable(token: str) -> bool:
    compact = normalize(token)
    if not 2 <= len(compact) <= 20:
        return False
    if compact in COMMON_STOP_TOKENS:
        return False
    if not re.search(r"[가-힣ㄱ-ㅎㅏ-ㅣa-zA-Z]", compact):
        return False
    return True


def load_json_bytes(raw: bytes) -> Any:
    return json.load(io.TextIOWrapper(io.BytesIO(raw), encoding="utf-8-sig"))


def iter_json_from_zip(raw_zip: bytes, label: str) -> Iterable[tuple[str, Any]]:
    try:
        with zipfile.ZipFile(io.BytesIO(raw_zip)) as archive:
            for name in archive.namelist():
                if name.lower().endswith(".json"):
                    yield f"{label}!{name}", load_json_bytes(archive.read(name))
    except zipfile.BadZipFile:
        return


def iter_json_sources(path: Path) -> Iterable[tuple[str, Any]]:
    if path.is_file() and path.suffix.lower() == ".json":
        yield str(path), json.loads(path.read_text(encoding="utf-8-sig"))
        return

    if path.is_file() and path.suffix.lower() == ".tar":
        with tarfile.open(path) as archive:
            for member in archive.getmembers():
                if not member.isfile():
                    continue
                lower_name = member.name.lower()
                extracted = archive.extractfile(member)
                if extracted is None:
                    continue
                raw = extracted.read()
                if lower_name.endswith(".json"):
                    yield member.name, load_json_bytes(raw)
                elif lower_name.endswith(".zip") or lower_name.endswith(".zip.part0"):
                    yield from iter_json_from_zip(raw, member.name)
        return

    if path.is_file() and (path.suffix.lower() == ".zip" or path.name.lower().endswith(".zip.part0")):
        yield from iter_json_from_zip(path.read_bytes(), str(path))
        return

    if path.is_dir():
        for child in path.rglob("*"):
            lower_name = child.name.lower()
            if child.is_file() and lower_name.endswith(".json"):
                yield str(child), json.loads(child.read_text(encoding="utf-8-sig"))
            elif child.is_file() and (lower_name.endswith(".zip") or lower_name.endswith(".zip.part0")):
                yield from iter_json_from_zip(child.read_bytes(), str(child))
        return

    raise FileNotFoundError(f"Unsupported source path: {path}")


def iter_talksets(root: Any) -> Iterable[dict[str, Any]]:
    if isinstance(root, list):
        for item in root:
            if isinstance(item, dict):
                yield item
    elif isinstance(root, dict):
        for key in ("talksets", "data", "items"):
            value = root.get(key)
            if isinstance(value, list):
                for item in value:
                    if isinstance(item, dict):
                        yield item


def sentence_tokens(sentence: dict[str, Any]) -> set[str]:
    tokens: set[str] = set()
    slots = sentence.get("mapped_slots")
    if isinstance(slots, list):
        for slot in slots:
            if isinstance(slot, dict):
                token = str(slot.get("token", "")).strip()
                if token and token_is_usable(token):
                    tokens.add(token)
    return tokens


def load_existing_terms(path: Path) -> dict[str, set[str]]:
    if not path.exists():
        return {key: set() for key in TARGETS.values()}

    data = json.loads(path.read_text(encoding="utf-8-sig"))
    existing: dict[str, set[str]] = {}
    for key in TARGETS.values():
        values = data.get(key, [])
        existing[key] = {normalize(value) for value in values if isinstance(value, str)}
    return existing


def build_dictionary(args: argparse.Namespace) -> dict[str, Any]:
    token_totals: Counter[str] = Counter()
    target_counts: dict[str, Counter[str]] = {label: Counter() for label in TARGETS}
    source_files: list[str] = []
    sentence_count = 0

    for source in args.source:
        for name, root in iter_json_sources(Path(source)):
            source_files.append(name)
            for talkset in iter_talksets(root):
                sentences = talkset.get("sentences")
                if not isinstance(sentences, list):
                    continue
                for sentence in sentences:
                    if not isinstance(sentence, dict):
                        continue
                    tokens = sentence_tokens(sentence)
                    if not tokens:
                        continue
                    raw_types = sentence.get("types", [])
                    if isinstance(raw_types, str):
                        labels = {raw_types.upper()}
                    elif isinstance(raw_types, list):
                        labels = {str(label).upper() for label in raw_types}
                    else:
                        labels = set()
                    sentence_count += 1
                    for token in tokens:
                        token_totals[token] += 1
                    for label in TARGETS:
                        if label in labels:
                            target_counts[label].update(tokens)

    existing_terms = load_existing_terms(Path(args.base_dictionary))
    output: dict[str, Any] = {
        "abuse_words": [],
        "abuse_exceptions": [],
        "sexual_words": [],
        "sexual_exceptions": [],
        "high_risk_words": [],
        "_metadata": {
            "source": "AI-Hub dataset 558 text ethics validation labeling data",
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "sourceFiles": source_files,
            "sentenceCount": sentence_count,
            "minCount": args.min_count,
            "minRatio": args.min_ratio,
            "maxPerCategory": args.max_per_category,
            "note": "Generated as a reviewable local dictionary extension. Do not commit raw AI-Hub data.",
        },
    }

    for label, dictionary_key in TARGETS.items():
        candidates: list[tuple[str, int, float]] = []
        for token, count in target_counts[label].items():
            total = token_totals[token]
            ratio = count / total if total else 0.0
            if count < args.min_count or ratio < args.min_ratio:
                continue
            if normalize(token) in existing_terms[dictionary_key]:
                continue
            candidates.append((token, count, ratio))

        candidates.sort(key=lambda item: (item[2], item[1], len(item[0]), item[0]), reverse=True)
        output[dictionary_key] = [token for token, _, _ in candidates[: args.max_per_category]]
        output["_metadata"][f"{dictionary_key}CandidateCount"] = len(candidates)
        output["_metadata"][f"{dictionary_key}SelectedCount"] = len(output[dictionary_key])

    return output


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build EmotionGuard dictionary extension from AI-Hub text ethics data.")
    parser.add_argument("source", nargs="+", help="download.tar, AI-Hub extracted directory, zip, or json path")
    parser.add_argument(
        "--output",
        default="backend/app/data/dictionaries.aihub.json",
        help="Generated dictionary extension path",
    )
    parser.add_argument(
        "--base-dictionary",
        default="backend/app/data/dictionaries.json",
        help="Existing curated dictionary used to skip duplicates",
    )
    parser.add_argument("--min-count", type=int, default=2)
    parser.add_argument("--min-ratio", type=float, default=0.6)
    parser.add_argument("--max-per-category", type=int, default=500)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    output = build_dictionary(args)
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    metadata = output["_metadata"]
    print(
        json.dumps(
            {
                "output": str(output_path),
                "abuseWords": metadata["abuse_wordsSelectedCount"],
                "sexualWords": metadata["sexual_wordsSelectedCount"],
                "sourceFiles": len(metadata["sourceFiles"]),
                "sentenceCount": metadata["sentenceCount"],
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
