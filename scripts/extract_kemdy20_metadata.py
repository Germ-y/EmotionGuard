import argparse
import csv
import io
import json
import math
import statistics
import wave
import zipfile
from collections import defaultdict
from pathlib import Path
from typing import BinaryIO, Iterable


TAG_MAP = {
    "c": "continuous_speech",
    "n": "single_noise",
    "N": "heavy_noise",
    "u": "unintelligible",
    "l": "filler_hum",
    "b": "breath_or_cough",
    "*": "partial_word",
    "+": "stutter",
    "/": "interjection",
}

BASE_COLUMNS = [
    "segment_id",
    "emotion",
    "arousal",
    "valence",
    "annotation_source",
    "sound_tags",
    *TAG_MAP.values(),
    "duration_s",
    "sample_rate",
    "channels",
    "audio_rms",
    "audio_peak",
    "audio_zero_crossing_rate",
    "eda_count",
    "eda_mean",
    "eda_min",
    "eda_max",
    "ibi_count",
    "ibi_mean",
    "ibi_min",
    "ibi_max",
    "temp_count",
    "temp_mean",
    "temp_min",
    "temp_max",
]


def normalize_name(value: str) -> str:
    return value.strip().lower().replace(" ", "_").replace("-", "_")


def decode_text(raw: bytes) -> str:
    for encoding in ("utf-8-sig", "cp949", "euc-kr"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def read_csv_rows(raw: bytes) -> list[list[str]]:
    text = decode_text(raw)
    sample = text[:2048]
    try:
        dialect = csv.Sniffer().sniff(sample)
    except csv.Error:
        dialect = csv.excel
    return [row for row in csv.reader(io.StringIO(text), dialect) if any(cell.strip() for cell in row)]


def as_float(value: str | None) -> float | None:
    if value is None:
        return None
    cleaned = value.strip()
    if not cleaned:
        return None
    try:
        return float(cleaned)
    except ValueError:
        return None


def segment_from_path(path: str) -> str:
    return Path(path).stem


def find_column(headers: list[str], candidates: Iterable[str], fallback: int = 0) -> int:
    normalized = [normalize_name(header) for header in headers]
    for candidate in candidates:
        for index, header in enumerate(normalized):
            if candidate in header:
                return index
    return fallback


def parse_annotation(path: str, raw: bytes, rows_by_segment: dict[str, dict[str, str]]) -> None:
    rows = read_csv_rows(raw)
    if not rows:
        return

    headers = rows[0]
    data_rows = rows[1:]
    segment_index = find_column(headers, ("segment", "seg_id", "segment_id", "id"), 0)
    emotion_index = find_column(headers, ("emotion", "label", "감정"), -1)
    arousal_index = find_column(headers, ("arousal", "각성"), -1)
    valence_index = find_column(headers, ("valence", "긍부정", "긍정", "부정"), -1)

    for row in data_rows:
        if segment_index >= len(row):
            continue
        segment_id = row[segment_index].strip()
        if not segment_id:
            continue
        record = rows_by_segment[segment_id]
        record["segment_id"] = segment_id
        record["annotation_source"] = path
        if 0 <= emotion_index < len(row):
            record["emotion"] = row[emotion_index].strip()
        if 0 <= arousal_index < len(row):
            record["arousal"] = row[arousal_index].strip()
        if 0 <= valence_index < len(row):
            record["valence"] = row[valence_index].strip()

        extra = {
            normalize_name(header): row[index].strip()
            for index, header in enumerate(headers)
            if index < len(row) and index not in {segment_index, emotion_index, arousal_index, valence_index}
        }
        if extra:
            record["annotation_extra"] = json.dumps(extra, ensure_ascii=False)


def add_series_value(series: dict[str, list[float]], segment_id: str, value: float | None) -> None:
    if segment_id and value is not None:
        series[segment_id].append(value)


def parse_signal_csv(path: str, raw: bytes, signal: str, values_by_segment: dict[str, dict[str, list[float]]]) -> None:
    rows = read_csv_rows(raw)
    for row in rows:
        if signal == "ibi":
            value_index = 1
            segment_index = 3
        else:
            value_index = 0
            segment_index = 2
        if len(row) <= max(value_index, segment_index):
            continue
        segment_id = row[segment_index].strip()
        add_series_value(values_by_segment[signal], segment_id, as_float(row[value_index]))


def summarize(values: list[float]) -> dict[str, str]:
    if not values:
        return {"count": "", "mean": "", "min": "", "max": ""}
    return {
        "count": str(len(values)),
        "mean": f"{statistics.fmean(values):.6g}",
        "min": f"{min(values):.6g}",
        "max": f"{max(values):.6g}",
    }


def parse_tag_text(path: str, raw: bytes, rows_by_segment: dict[str, dict[str, str]]) -> None:
    segment_id = segment_from_path(path)
    text = decode_text(raw)
    text_tokens = {token.strip() for token in text.replace("\n", " ").split() if token.strip()}
    path_tokens = set(Path(path).parts)
    tags = [tag for tag in TAG_MAP if tag in text_tokens or tag in path_tokens]
    if not tags:
        return
    record = rows_by_segment[segment_id]
    record["segment_id"] = segment_id
    record["sound_tags"] = ";".join(tags)
    for tag in tags:
        record[TAG_MAP[tag]] = "1"


def pcm_samples(raw: bytes, sample_width: int) -> list[float]:
    if sample_width == 1:
        return [(byte - 128) / 128 for byte in raw]
    if sample_width == 2:
        count = len(raw) // 2
        return [int.from_bytes(raw[index * 2 : index * 2 + 2], "little", signed=True) / 32768 for index in range(count)]
    if sample_width == 4:
        count = len(raw) // 4
        return [int.from_bytes(raw[index * 4 : index * 4 + 4], "little", signed=True) / 2147483648 for index in range(count)]
    return []


def audio_features_from_wav(file_obj: BinaryIO) -> dict[str, str]:
    with wave.open(file_obj, "rb") as wav:
        channels = wav.getnchannels()
        sample_rate = wav.getframerate()
        sample_width = wav.getsampwidth()
        frames = wav.getnframes()
        raw = wav.readframes(frames)

    samples = pcm_samples(raw, sample_width)
    if channels > 1 and samples:
        samples = samples[::channels]
    if not samples:
        return {}

    rms = math.sqrt(sum(sample * sample for sample in samples) / len(samples))
    peak = max(abs(sample) for sample in samples)
    crossings = sum(
        1
        for index in range(1, len(samples))
        if (samples[index - 1] >= 0 > samples[index]) or (samples[index - 1] < 0 <= samples[index])
    )
    return {
        "duration_s": f"{frames / sample_rate:.4f}" if sample_rate else "",
        "sample_rate": str(sample_rate),
        "channels": str(channels),
        "audio_rms": f"{rms:.6g}",
        "audio_peak": f"{peak:.6g}",
        "audio_zero_crossing_rate": f"{crossings / max(1, len(samples) - 1):.6g}",
    }


def iter_archive_files(source: Path) -> Iterable[tuple[str, bytes]]:
    if source.is_file() and source.suffix.lower() == ".zip":
        with zipfile.ZipFile(source) as archive:
            for name in archive.namelist():
                if not name.endswith("/"):
                    yield name, archive.read(name)
        return

    if source.is_dir():
        for child in source.rglob("*"):
            if child.is_file():
                yield str(child.relative_to(source)), child.read_bytes()
        return

    raise FileNotFoundError(f"Unsupported KEMDy20 source: {source}")


def build_metadata(source: Path) -> list[dict[str, str]]:
    rows_by_segment: dict[str, dict[str, str]] = defaultdict(dict)
    values_by_segment: dict[str, dict[str, list[float]]] = {
        "eda": defaultdict(list),
        "ibi": defaultdict(list),
        "temp": defaultdict(list),
    }

    for path, raw in iter_archive_files(source):
        lower = path.lower().replace("\\", "/")
        if "/annotation/" in lower and lower.endswith(".csv"):
            parse_annotation(path, raw, rows_by_segment)
        elif "/eda/" in lower and lower.endswith(".csv"):
            parse_signal_csv(path, raw, "eda", values_by_segment)
        elif "/ibi/" in lower and lower.endswith(".csv"):
            parse_signal_csv(path, raw, "ibi", values_by_segment)
        elif "/temp/" in lower and lower.endswith(".csv"):
            parse_signal_csv(path, raw, "temp", values_by_segment)
        elif "/wav/" in lower and lower.endswith(".txt"):
            parse_tag_text(path, raw, rows_by_segment)
        elif "/wav/" in lower and lower.endswith(".wav"):
            segment_id = segment_from_path(path)
            rows_by_segment[segment_id]["segment_id"] = segment_id
            rows_by_segment[segment_id].update(audio_features_from_wav(io.BytesIO(raw)))

    for signal, grouped in values_by_segment.items():
        for segment_id, values in grouped.items():
            record = rows_by_segment[segment_id]
            record["segment_id"] = segment_id
            summary = summarize(values)
            record[f"{signal}_count"] = summary["count"]
            record[f"{signal}_mean"] = summary["mean"]
            record[f"{signal}_min"] = summary["min"]
            record[f"{signal}_max"] = summary["max"]

    return [rows_by_segment[key] for key in sorted(rows_by_segment)]


def write_csv(rows: list[dict[str, str]], output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    extra_columns = sorted({key for row in rows for key in row if key not in BASE_COLUMNS})
    fieldnames = [*BASE_COLUMNS, *extra_columns]
    with output.open("w", encoding="utf-8-sig", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Extract segment-level metadata from KEMDy20 zip or folder.")
    parser.add_argument("source", help="KEMDy20_v*.zip or extracted KEMDy20 folder")
    parser.add_argument("--output", default="data/kemdy20/kemdy20_metadata.csv")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    rows = build_metadata(Path(args.source))
    write_csv(rows, Path(args.output))
    print(json.dumps({"output": args.output, "segments": len(rows)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
