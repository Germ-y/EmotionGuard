import argparse
import csv
import json
import random
import re
import urllib.request
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DICTIONARY_PATH = ROOT / "backend" / "app" / "data" / "dictionaries.json"
AIHUB_DICTIONARY_PATH = ROOT / "backend" / "app" / "data" / "dictionaries.aihub.json"
DEFAULT_OUTPUT = ROOT / "qa" / "text" / "emotionguard_text_qa_5000.jsonl"
DEFAULT_META_OUTPUT = ROOT / "qa" / "text" / "emotionguard_text_qa_5000.meta.json"
DEFAULT_EXTERNAL_DIR = ROOT / "qa" / "external"

KORPORA_TRAIN_URL = "https://raw.githubusercontent.com/kocohub/korean-hate-speech/master/labeled/train.tsv"
KORPORA_DEV_URL = "https://raw.githubusercontent.com/kocohub/korean-hate-speech/master/labeled/dev.tsv"
KOLD_URL = "https://media.githubusercontent.com/media/boychaboy/KOLD/main/data/kold_v1.json"

TARGET_COUNTS = {
    "korpora_hate": 900,
    "korpora_offensive": 700,
    "korpora_none": 900,
    "kold_offensive": 1600,
    "kold_none": 900,
}


def download(url: str, output: Path, force: bool = False) -> None:
    if output.exists() and not force:
        return
    output.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(url, timeout=120) as response:
        output.write_bytes(response.read())


def ensure_external_files(root: Path, force: bool = False) -> dict[str, Path]:
    files = {
        "korpora_train": root / "korpora_korean_hate_speech_train.tsv",
        "korpora_dev": root / "korpora_korean_hate_speech_dev.tsv",
        "kold": root / "kold_v1.json",
    }
    download(KORPORA_TRAIN_URL, files["korpora_train"], force)
    download(KORPORA_DEV_URL, files["korpora_dev"], force)
    download(KOLD_URL, files["kold"], force)
    return files


def load_dictionaries() -> dict[str, list[str]]:
    with DICTIONARY_PATH.open(encoding="utf-8-sig") as file:
        data = json.load(file)
    if AIHUB_DICTIONARY_PATH.exists():
        with AIHUB_DICTIONARY_PATH.open(encoding="utf-8-sig") as file:
            generated = json.load(file)
        for key, value in generated.items():
            if not isinstance(value, list):
                continue
            base = data.get(key, [])
            if isinstance(base, list):
                data[key] = list(dict.fromkeys([*base, *value]))
    return {key: value for key, value in data.items() if isinstance(value, list)}


def normalize(text: str) -> str:
    return "".join(text.lower().split())


def mask_text(text: str, dictionaries: dict[str, list[str]]) -> str:
    masked = text
    exceptions = list(dict.fromkeys([*dictionaries["abuse_exceptions"], *dictionaries["sexual_exceptions"]]))
    protected = [(f"\x00{index}\x00", exception) for index, exception in enumerate(exceptions)]
    for token, exception in protected:
        masked = masked.replace(exception, token)

    for word in list(dict.fromkeys([*dictionaries["abuse_words"], *dictionaries["sexual_words"]])):
        masked = re.sub(re.escape(word), lambda match: "*" * len(match.group(0)), masked, flags=re.IGNORECASE)

    for token, exception in protected:
        masked = masked.replace(token, exception)
    return masked


def triggered_words(text: str, dictionaries: dict[str, list[str]]) -> list[str]:
    compact = normalize(text)
    words = [*dictionaries["abuse_words"], *dictionaries["sexual_words"]]
    matches = [word for word in words if normalize(word) and normalize(word) in compact]
    return list(dict.fromkeys(matches))


def triggered_words_for(text: str, words: list[str]) -> list[str]:
    compact = normalize(text)
    matches = [word for word in words if normalize(word) and normalize(word) in compact]
    return list(dict.fromkeys(matches))


def audio_features(seed_value: int) -> dict[str, Any]:
    rng = random.Random(seed_value)
    rms_percent = rng.randint(18, 48)
    return {
        "rms": round(rms_percent / 100, 4),
        "rmsPercent": rms_percent,
        "peak": round(rng.uniform(0.08, 0.42), 4),
        "pitchHz": rng.randint(115, 245),
        "pitchConfidence": round(rng.uniform(0.58, 0.93), 4),
        "zeroCrossingRate": round(rng.uniform(0.035, 0.18), 4),
        "spectralCentroidHz": rng.randint(900, 4200),
        "utteranceDurationMs": rng.randint(650, 6200),
        "syllableCount": rng.randint(5, 58),
        "syllablesPerSecond": round(rng.uniform(1.8, 7.2), 2),
        "voiceActivity": True,
    }


def read_korpora_rows(path: Path, split: str) -> list[dict[str, Any]]:
    with path.open(encoding="utf-8", newline="") as file:
        reader = csv.DictReader(file, delimiter="\t")
        rows = []
        for row_index, row in enumerate(reader, start=1):
            text = row.get("comments", "").strip()
            if not text:
                continue
            rows.append({
                "externalId": f"korpora_{split}_{row_index:05d}",
                "sourceDataset": "korpora_korean_hate_speech",
                "sourceRepository": "kocohub/korean-hate-speech",
                "sourceSplit": split,
                "text": text,
                "title": row.get("news_title", "").strip(),
                "rawLabels": {
                    "contain_gender_bias": row.get("contain_gender_bias", "").strip(),
                    "bias": row.get("bias", "").strip(),
                    "hate": row.get("hate", "").strip(),
                },
            })
    return rows


def read_kold_rows(path: Path) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    rows = []
    for row_index, item in enumerate(payload, start=1):
        text = str(item.get("comment", "")).strip()
        if not text:
            continue
        rows.append({
            "externalId": str(item.get("guid") or f"kold_{row_index:05d}"),
            "sourceDataset": "kold",
            "sourceRepository": "boychaboy/KOLD",
            "sourceSplit": "kold_v1",
            "text": text,
            "title": str(item.get("title", "")).strip(),
            "rawLabels": {
                "OFF": bool(item.get("OFF")),
                "TGT": item.get("TGT"),
                "GRP": item.get("GRP"),
                "OFF_span": item.get("OFF_span", ""),
                "TGT_span": item.get("TGT_span", ""),
            },
        })
    return rows


def bucket_korpora(row: dict[str, Any]) -> str:
    hate = str(row["rawLabels"].get("hate", "")).lower()
    if hate == "hate":
        return "korpora_hate"
    if hate == "offensive":
        return "korpora_offensive"
    return "korpora_none"


def bucket_kold(row: dict[str, Any]) -> str:
    return "kold_offensive" if row["rawLabels"].get("OFF") else "kold_none"


def event_for_bucket(bucket: str) -> str:
    return "abuse" if bucket in {"korpora_hate", "korpora_offensive", "kold_offensive"} else "normal"


def category_for_bucket(bucket: str, row: dict[str, Any]) -> str:
    if bucket.startswith("korpora"):
        bias = str(row["rawLabels"].get("bias", "none"))
        if bucket != "korpora_none" and bias == "gender":
            return f"{bucket}_gender_bias"
        if bucket != "korpora_none" and bias not in {"none", ""}:
            return f"{bucket}_bias"
    if bucket == "kold_offensive" and row["rawLabels"].get("GRP"):
        return "kold_offensive_targeted"
    return bucket


def expected_actions(event_type: str, mode: str, local_hit: bool) -> list[str]:
    actions: list[str] = []
    if mode == "immediate" and event_type == "abuse" and local_hit:
        actions.append("mute")
    if mode == "immediate" and event_type == "sexual" and local_hit:
        actions.append("mute")
    if event_type in {"abuse", "sexual"}:
        actions.extend(["warn_tts", "escalate", "report"])
    return actions


def build_case(
    number: int,
    bucket: str,
    row: dict[str, Any],
    dictionaries: dict[str, list[str]],
) -> dict[str, Any]:
    source_event_type = event_for_bucket(bucket)
    abuse_words = triggered_words_for(row["text"], dictionaries["abuse_words"])
    sexual_words = triggered_words_for(row["text"], dictionaries["sexual_words"])
    words = list(dict.fromkeys([*abuse_words, *sexual_words]))
    event_type = "sexual" if source_event_type == "abuse" and sexual_words else source_event_type
    masked = mask_text(row["text"], dictionaries) if event_type in {"abuse", "sexual"} else row["text"]
    local_hit = bool(words)
    context_required = source_event_type == "abuse" and not local_hit
    mode = "context_snapshot" if context_required else "immediate"

    severity = "none"
    emotion = "normal"
    if event_type in {"abuse", "sexual"}:
        severity = "any"
        emotion = "threatening" if event_type == "sexual" else "angry"

    raw_labels = row["rawLabels"]
    offensive_span = raw_labels.get("OFF_span") if row["sourceDataset"] == "kold" else ""

    return {
        "id": f"eg_ext_textqa_{number:05d}",
        "version": 2,
        "split": "test",
        "sourceDataset": row["sourceDataset"],
        "sourceRepository": row["sourceRepository"],
        "sourceSplit": row["sourceSplit"],
        "sourceExternalId": row["externalId"],
        "category": category_for_bucket(bucket, row),
        "text": row["text"],
        "sourceContext": {
            "title": row.get("title", ""),
        },
        "sourceLabels": raw_labels,
        "request": {
            "text": row["text"],
            "raised": False,
            "analysisMode": mode,
            "contextWindowMs": 3000,
            "audioFeatures": audio_features(number),
        },
        "expected": {
            "eventType": event_type,
            "abusive": event_type in {"abuse", "sexual"},
            "sexual": event_type == "sexual",
            "raised": False,
            "severity": severity,
            "emotion": emotion,
            "sourceHint": "local" if local_hit else ("openai" if context_required else "fallback"),
            "contextRequired": context_required,
            "requiresReportRedaction": event_type in {"abuse", "sexual"},
            "mustMask": masked != row["text"] and "*" in masked,
            "maskedText": masked,
            "triggeredWordsHint": words,
            "offensiveSpanHint": offensive_span,
            "policyActionsAny": expected_actions(event_type, mode, local_hit),
            "policyActionsNot": ["mute"] if event_type == "normal" or context_required else [],
        },
        "tags": tags_for(bucket, row, local_hit, context_required),
        "rationale": rationale_for(bucket, row, local_hit, context_required),
    }


def tags_for(bucket: str, row: dict[str, Any], local_hit: bool, context_required: bool) -> list[str]:
    tags = [row["sourceDataset"], bucket]
    if event_for_bucket(bucket) == "abuse":
        tags.append("abuse")
    else:
        tags.extend(["normal", "false-positive-check"])
    if local_hit:
        tags.append("dictionary-hit")
    if context_required:
        tags.append("context-required")
    if row["sourceDataset"] == "kold" and row["rawLabels"].get("GRP"):
        tags.append("targeted-offensive")
    if row["sourceDataset"] == "korpora_korean_hate_speech" and str(row["rawLabels"].get("contain_gender_bias")).lower() == "true":
        tags.append("gender-bias")
    return tags


def rationale_for(bucket: str, row: dict[str, Any], local_hit: bool, context_required: bool) -> str:
    if event_for_bucket(bucket) == "normal":
        return "외부 데이터셋에서 비혐오/비공격으로 라벨링된 문장이므로 오탐 없이 정상으로 남아야 한다."
    if local_hit:
        return "외부 데이터셋에서 공격/혐오로 라벨링되었고 내부 비윤리 표현 사전에도 걸리는 문장이므로 즉시 감지와 마스킹을 기대한다."
    if context_required:
        return "외부 데이터셋에서 공격/혐오로 라벨링되었지만 직접 사전 단어가 약하므로 GPT 문맥 판단으로 감지되어야 한다."
    return "외부 데이터셋 공격/혐오 라벨을 EmotionGuard 폭언 이벤트로 매핑한다."


def sample_bucket(rows: list[dict[str, Any]], count: int, rng: random.Random, label: str) -> list[dict[str, Any]]:
    if len(rows) < count:
        raise ValueError(f"Not enough rows for {label}: need {count}, got {len(rows)}")
    return rng.sample(rows, count)


def build_cases(files: dict[str, Path], total: int, seed: int, dictionaries: dict[str, list[str]]) -> list[dict[str, Any]]:
    rng = random.Random(seed)
    korpora_rows = [
        *read_korpora_rows(files["korpora_train"], "train"),
        *read_korpora_rows(files["korpora_dev"], "dev"),
    ]
    kold_rows = read_kold_rows(files["kold"])

    buckets = {
        "korpora_hate": [row for row in korpora_rows if bucket_korpora(row) == "korpora_hate"],
        "korpora_offensive": [row for row in korpora_rows if bucket_korpora(row) == "korpora_offensive"],
        "korpora_none": [row for row in korpora_rows if bucket_korpora(row) == "korpora_none"],
        "kold_offensive": [row for row in kold_rows if bucket_kold(row) == "kold_offensive"],
        "kold_none": [row for row in kold_rows if bucket_kold(row) == "kold_none"],
    }

    if sum(TARGET_COUNTS.values()) != total:
        raise ValueError(f"Target counts produce {sum(TARGET_COUNTS.values())}, not {total}")

    selected: list[tuple[str, dict[str, Any]]] = []
    for bucket, count in TARGET_COUNTS.items():
        selected.extend((bucket, row) for row in sample_bucket(buckets[bucket], count, rng, bucket))
    rng.shuffle(selected)
    return [build_case(index, bucket, row, dictionaries) for index, (bucket, row) in enumerate(selected, start=1)]


def write_jsonl(cases: list[dict[str, Any]], output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", encoding="utf-8", newline="\n") as file:
        for case in cases:
            file.write(json.dumps(case, ensure_ascii=False, sort_keys=True))
            file.write("\n")


def write_meta(cases: list[dict[str, Any]], output: Path, seed: int, files: dict[str, Path]) -> None:
    def count_by(key: str) -> dict[str, int]:
        counts: dict[str, int] = {}
        for case in cases:
            value = str(case[key])
            counts[value] = counts.get(value, 0) + 1
        return dict(sorted(counts.items()))

    event_counts: dict[str, int] = {}
    for case in cases:
        event = case["expected"]["eventType"]
        event_counts[event] = event_counts.get(event, 0) + 1

    payload = {
        "version": 2,
        "seed": seed,
        "rows": len(cases),
        "sourceRepositories": [
            {
                "name": "kocohub/korean-hate-speech",
                "files": ["labeled/train.tsv", "labeled/dev.tsv"],
                "localCache": str(files["korpora_train"].parent),
            },
            {
                "name": "boychaboy/KOLD",
                "files": ["data/kold_v1.json"],
                "localCache": str(files["kold"].parent),
            },
        ],
        "targetCounts": TARGET_COUNTS,
        "sourceDatasetCounts": count_by("sourceDataset"),
        "categoryCounts": count_by("category"),
        "eventTypeCounts": dict(sorted(event_counts.items())),
        "maskableRows": sum(1 for case in cases if case["expected"]["mustMask"]),
        "contextRequiredRows": sum(1 for case in cases if case["expected"]["contextRequired"]),
        "notes": [
            "Rows are sampled from external Korpora/kocohub Korean HateSpeech and KOLD datasets.",
            "External offensive/hate labels are mapped to EmotionGuard abuse events for QA.",
            "Normal rows are used to measure false positives.",
            "KOLD OFF_span is preserved as expected.offensiveSpanHint when available.",
            "Local raw caches under qa/external are reproducible and should not be committed.",
        ],
    }
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate a 5,000-row external text QA set from KOLD and Korpora/kocohub.")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--meta-output", default=str(DEFAULT_META_OUTPUT))
    parser.add_argument("--external-dir", default=str(DEFAULT_EXTERNAL_DIR))
    parser.add_argument("--total", type=int, default=5000)
    parser.add_argument("--seed", type=int, default=20260702)
    parser.add_argument("--force-download", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    files = ensure_external_files(Path(args.external_dir), args.force_download)
    dictionaries = load_dictionaries()
    cases = build_cases(files, args.total, args.seed, dictionaries)
    output = Path(args.output)
    meta_output = Path(args.meta_output)
    write_jsonl(cases, output)
    write_meta(cases, meta_output, args.seed, files)
    print(json.dumps({"output": str(output), "metaOutput": str(meta_output), "rows": len(cases)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
