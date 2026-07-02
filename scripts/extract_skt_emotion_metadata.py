import argparse
import csv
import io
import json
import math
import re
import tarfile
import wave
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable


AUDIO_EXTENSIONS = {".wav", ".wave"}
LABEL_EXTENSIONS = {".csv", ".json", ".jsonl"}
ARCHIVE_FRAGMENT_PATTERNS = (".tar.irx", ".irx")

BASE_COLUMNS = [
    "audio_id",
    "audio_path",
    "speaker_id",
    "speaker_gender",
    "emotion",
    "emotion_index",
    "emotion_detail",
    "service_emotion",
    "emotion_source",
    "transcript",
    "transcript_source",
    "duration_s",
    "sample_rate",
    "channels",
    "audio_rms",
    "audio_peak",
    "audio_zero_crossing_rate",
    "spectral_centroid_hz",
    "pitch_hz",
    "pitch_confidence",
]

ID_COLUMNS = {
    "id",
    "utt_id",
    "utterance_id",
    "segment_id",
    "audio_id",
    "wav_id",
    "file_id",
    "filename",
    "file_name",
    "wav",
    "audio",
    "path",
    "file",
    "파일명",
    "음성파일",
    "발화id",
    "발화_id",
}

EMOTION_COLUMNS = {
    "emotion",
    "emotion_label",
    "label",
    "sentiment",
    "감정",
    "감정대분류",
    "감정_대분류",
    "감정소분류",
    "감정_소분류",
    "발화감정",
}

TRANSCRIPT_COLUMNS = {
    "text",
    "transcript",
    "sentence",
    "utterance",
    "발화",
    "문장",
    "대화",
    "전사",
    "전사문",
    "스크립트",
}

PATH_EMOTION_HINTS = {
    "neutral": "neutral",
    "normal": "neutral",
    "중립": "neutral",
    "평온": "neutral",
    "happy": "happy",
    "happiness": "happy",
    "기쁨": "happy",
    "행복": "happy",
    "joy": "happy",
    "sad": "sad",
    "sadness": "sad",
    "슬픔": "sad",
    "우울": "sad",
    "angry": "angry",
    "anger": "angry",
    "분노": "angry",
    "화남": "angry",
    "frustrated": "frustrated",
    "짜증": "frustrated",
    "불만": "frustrated",
    "fear": "fear",
    "불안": "fear",
    "공포": "fear",
    "surprise": "surprise",
    "놀람": "surprise",
    "disgust": "disgust",
    "혐오": "disgust",
}

SKT_EMOTION_GUIDE = [
    (1, 1, 20, "neutral", "뉴스, 나레이션 문의 낭독체"),
    (2, 21, 30, "angry", "화난, 큰소리의"),
    (3, 31, 40, "joy", "즐거운, 기쁜, 행복한"),
    (4, 41, 50, "sad", "슬픈"),
    (5, 51, 60, "serious", "단호한, 명령하듯 말하는"),
    (6, 61, 70, "anxious", "걱정, 근심, 염려하는"),
    (7, 71, 80, "kind", "상냥한, 친절한, 공손한"),
    (8, 81, 90, "dry", "사무적인 톤의"),
    (9, 91, 100, "tease", "심술부리듯, 비난하듯, 짜증내듯"),
    (10, 101, 110, "doubt", "의심스러운 듯, 궁금한 듯"),
    (11, 111, 120, "surprise", "깜짝 놀란듯"),
    (12, 121, 130, "shy", "부끄러운듯"),
    (13, 131, 140, "hurry", "몹시 서두르는 듯"),
    (14, 141, 150, "fear", "무서운, 공포, 두려워하듯"),
    (15, 151, 160, "hesitate", "머뭇거리듯, 당황한듯"),
]

SERVICE_EMOTION_MAP = {
    "neutral": "normal",
    "joy": "normal",
    "kind": "normal",
    "dry": "normal",
    "doubt": "normal",
    "shy": "normal",
    "hesitate": "normal",
    "sad": "frustrated",
    "serious": "frustrated",
    "anxious": "frustrated",
    "surprise": "frustrated",
    "hurry": "frustrated",
    "fear": "frustrated",
    "angry": "angry",
    "tease": "angry",
}


def decode_text(raw: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-8", "cp949", "euc-kr"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def normalize_key(value: str) -> str:
    cleaned = re.sub(r"[\s\-]+", "_", value.strip().lower())
    return cleaned.replace(".", "_")


def audio_id_from_path(path: Path) -> str:
    return path.stem.strip().lower()


def speaker_from_audio_path(path: str | Path) -> tuple[str, str]:
    normalized = str(path).replace("\\", "/")
    match = re.search(r"(?:^|/)([FM]\d{4})(?:[_/]|$)", normalized, flags=re.IGNORECASE)
    if not match:
        return "", ""
    speaker_id = match.group(1).upper()
    return speaker_id, "female" if speaker_id.startswith("F") else "male"


def infer_skt_emotion_from_audio_id(audio_id: str) -> tuple[str, str, str, str]:
    match = re.search(r"_(\d{6})$", audio_id.lower())
    if not match:
        return "", "", "", ""
    utterance_index = int(match.group(1))
    sentence_index = ((utterance_index - 1) % 160) + 1
    for emotion_index, start, end, emotion, detail in SKT_EMOTION_GUIDE:
        if start <= sentence_index <= end:
            return emotion, str(emotion_index), detail, SERVICE_EMOTION_MAP.get(emotion, "")
    return "", "", "", ""


def candidate_ids(value: str) -> set[str]:
    cleaned = value.strip()
    if not cleaned:
        return set()
    path = Path(cleaned.replace("\\", "/"))
    stem = path.stem or cleaned
    name = path.name or cleaned
    return {
        cleaned.lower(),
        name.lower(),
        stem.lower(),
        normalize_key(cleaned),
        normalize_key(name),
        normalize_key(stem),
    }


def is_archive_fragment(path: Path) -> bool:
    lower = path.name.lower()
    return any(pattern in lower for pattern in ARCHIVE_FRAGMENT_PATTERNS) or lower.endswith(".tar")


def inspect_tar(path: Path, max_members: int = 8) -> dict[str, Any]:
    members = []
    truncated = False
    error = ""
    try:
        with tarfile.open(path) as archive:
            for index, member in enumerate(archive):
                if index >= max_members:
                    break
                members.append({"name": member.name, "size": member.size, "type": "dir" if member.isdir() else "file"})
    except (tarfile.TarError, EOFError, OSError) as exc:
        truncated = True
        error = str(exc)

    return {
        "path": str(path),
        "size": path.stat().st_size,
        "members": members,
        "truncated_or_incomplete": truncated,
        "error": error,
    }


def read_csv_dicts(path: Path) -> Iterable[dict[str, str]]:
    raw = path.read_bytes()
    text = decode_text(raw)
    sample = text[:4096]
    try:
        dialect = csv.Sniffer().sniff(sample)
    except csv.Error:
        dialect = csv.excel
    reader = csv.DictReader(io.StringIO(text), dialect=dialect)
    for row in reader:
        yield {str(key): str(value) for key, value in row.items() if key is not None and value is not None}


def flatten_json_items(value: Any) -> Iterable[dict[str, Any]]:
    if isinstance(value, list):
        for item in value:
            yield from flatten_json_items(item)
    elif isinstance(value, dict):
        if any(not isinstance(child, (list, dict)) for child in value.values()):
            yield value
        for child in value.values():
            if isinstance(child, (list, dict)):
                yield from flatten_json_items(child)


def read_json_dicts(path: Path) -> Iterable[dict[str, str]]:
    text = decode_text(path.read_bytes())
    if path.suffix.lower() == ".jsonl":
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(item, dict):
                yield {str(key): str(value) for key, value in item.items() if value is not None}
        return

    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        return
    for item in flatten_json_items(payload):
        yield {str(key): str(value) for key, value in item.items() if value is not None}


def pick_column(row: dict[str, str], candidates: set[str]) -> str:
    normalized = {normalize_key(key): value for key, value in row.items()}
    for candidate in candidates:
        normalized_candidate = normalize_key(candidate)
        if normalized_candidate in normalized and normalized[normalized_candidate].strip():
            return normalized[normalized_candidate].strip()
    return ""


def build_label_index(source: Path) -> dict[str, dict[str, str]]:
    index: dict[str, dict[str, str]] = {}
    for path in source.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in LABEL_EXTENSIONS:
            continue

        rows = read_csv_dicts(path) if path.suffix.lower() == ".csv" else read_json_dicts(path)
        for row in rows:
            emotion = pick_column(row, EMOTION_COLUMNS)
            transcript = pick_column(row, TRANSCRIPT_COLUMNS)
            id_value = pick_column(row, ID_COLUMNS)
            if not id_value or not (emotion or transcript):
                continue

            record = {
                "emotion": emotion,
                "emotion_source": str(path.relative_to(source)) if emotion else "",
                "transcript": transcript,
                "transcript_source": str(path.relative_to(source)) if transcript else "",
            }
            for key in candidate_ids(id_value):
                existing = index.get(key, {})
                index[key] = {**existing, **{k: v for k, v in record.items() if v}}
    return index


def pcm_samples(raw: bytes, sample_width: int) -> list[float]:
    if sample_width == 1:
        return [(byte - 128) / 128 for byte in raw]
    if sample_width == 2:
        count = len(raw) // 2
        return [int.from_bytes(raw[index * 2 : index * 2 + 2], "little", signed=True) / 32768 for index in range(count)]
    if sample_width == 3:
        count = len(raw) // 3
        values = []
        for index in range(count):
            chunk = raw[index * 3 : index * 3 + 3]
            sign = b"\xff" if chunk[2] & 0x80 else b"\x00"
            values.append(int.from_bytes(chunk + sign, "little", signed=True) / 8388608)
        return values
    if sample_width == 4:
        count = len(raw) // 4
        return [int.from_bytes(raw[index * 4 : index * 4 + 4], "little", signed=True) / 2147483648 for index in range(count)]
    return []


def mono_samples(samples: list[float], channels: int) -> list[float]:
    if channels <= 1:
        return samples
    return [
        sum(samples[index + channel] for channel in range(channels) if index + channel < len(samples)) / channels
        for index in range(0, len(samples), channels)
    ]


def optional_numpy():
    try:
        import numpy as np  # type: ignore

        return np
    except Exception:
        return None


def spectral_centroid(samples: list[float], sample_rate: int) -> str:
    np = optional_numpy()
    if np is None or not samples or sample_rate <= 0:
        return ""

    window = np.array(samples[: min(len(samples), sample_rate * 3)], dtype=float)
    if window.size == 0:
        return ""
    spectrum = np.abs(np.fft.rfft(window))
    freqs = np.fft.rfftfreq(window.size, d=1 / sample_rate)
    total = float(spectrum.sum())
    if total <= 0:
        return ""
    return f"{float((freqs * spectrum).sum() / total):.4f}"


def estimate_pitch(samples: list[float], sample_rate: int) -> tuple[str, str]:
    np = optional_numpy()
    if np is None or not samples or sample_rate <= 0:
        return "", ""

    stride = max(1, round(sample_rate / 16000))
    effective_rate = sample_rate / stride
    signal = np.array(samples[: min(len(samples), int(sample_rate * 3.0)) : stride], dtype=float)
    if signal.size == 0:
        return "", ""

    frame_size = max(1, int(effective_rate * 0.04))
    hop_size = max(1, frame_size // 2)
    if signal.size > frame_size:
        frame_starts = range(0, signal.size - frame_size + 1, hop_size)
        best_start = max(frame_starts, key=lambda start: float((signal[start : start + frame_size] ** 2).mean()))
        center = best_start + frame_size // 2
        window_size = max(frame_size * 2, int(effective_rate * 0.36))
        start = max(0, center - window_size // 2)
        end = min(signal.size, start + window_size)
        start = max(0, end - window_size)
        window = signal[start:end]
    else:
        window = signal

    if window.size < int(effective_rate * 0.08):
        return "", ""
    window = window - window.mean()
    rms = math.sqrt(float((window * window).mean()))
    if rms < 0.006:
        return "", ""

    min_lag = max(1, int(effective_rate / 420))
    max_lag = min(window.size - 1, int(effective_rate / 70))
    if max_lag <= min_lag:
        return "", ""

    fft_size = 1 << (2 * window.size - 1).bit_length()
    spectrum = np.fft.rfft(window, fft_size)
    correlations = np.fft.irfft(spectrum * np.conjugate(spectrum), fft_size)[: window.size]
    search = correlations[min_lag:max_lag]
    if search.size == 0:
        return "", ""

    best_offset = int(search.argmax())
    best_lag = min_lag + best_offset
    confidence = float(search[best_offset] / max(correlations[0], 1e-9))
    if confidence < 0.08:
        return "", f"{confidence:.4f}"
    return f"{effective_rate / best_lag:.4f}", f"{min(1.0, confidence):.4f}"


def audio_features_from_wav(path: Path) -> dict[str, str]:
    with wave.open(str(path), "rb") as wav:
        channels = wav.getnchannels()
        sample_rate = wav.getframerate()
        sample_width = wav.getsampwidth()
        frame_count = wav.getnframes()
        raw = wav.readframes(frame_count)

    samples = mono_samples(pcm_samples(raw, sample_width), channels)
    if not samples:
        return {}

    rms = math.sqrt(sum(sample * sample for sample in samples) / len(samples))
    peak = max(abs(sample) for sample in samples)
    crossings = sum(
        1
        for index in range(1, len(samples))
        if (samples[index - 1] >= 0 > samples[index]) or (samples[index - 1] < 0 <= samples[index])
    )
    pitch_hz, pitch_confidence = estimate_pitch(samples, sample_rate)

    return {
        "duration_s": f"{frame_count / sample_rate:.4f}" if sample_rate else "",
        "sample_rate": str(sample_rate),
        "channels": str(channels),
        "audio_rms": f"{rms:.6g}",
        "audio_peak": f"{peak:.6g}",
        "audio_zero_crossing_rate": f"{crossings / max(1, len(samples) - 1):.6g}",
        "spectral_centroid_hz": spectral_centroid(samples, sample_rate),
        "pitch_hz": pitch_hz,
        "pitch_confidence": pitch_confidence,
    }


def audio_features_from_wav_bytes(raw_wav: bytes) -> dict[str, str]:
    with wave.open(io.BytesIO(raw_wav), "rb") as wav:
        channels = wav.getnchannels()
        sample_rate = wav.getframerate()
        sample_width = wav.getsampwidth()
        frame_count = wav.getnframes()
        raw = wav.readframes(frame_count)

    samples = mono_samples(pcm_samples(raw, sample_width), channels)
    if not samples:
        return {}

    rms = math.sqrt(sum(sample * sample for sample in samples) / len(samples))
    peak = max(abs(sample) for sample in samples)
    crossings = sum(
        1
        for index in range(1, len(samples))
        if (samples[index - 1] >= 0 > samples[index]) or (samples[index - 1] < 0 <= samples[index])
    )
    pitch_hz, pitch_confidence = estimate_pitch(samples, sample_rate)

    return {
        "duration_s": f"{frame_count / sample_rate:.4f}" if sample_rate else "",
        "sample_rate": str(sample_rate),
        "channels": str(channels),
        "audio_rms": f"{rms:.6g}",
        "audio_peak": f"{peak:.6g}",
        "audio_zero_crossing_rate": f"{crossings / max(1, len(samples) - 1):.6g}",
        "spectral_centroid_hz": spectral_centroid(samples, sample_rate),
        "pitch_hz": pitch_hz,
        "pitch_confidence": pitch_confidence,
    }


def infer_emotion_from_path(path: Path) -> tuple[str, str]:
    parts = [part.lower() for part in path.parts]
    for part in reversed(parts):
        for hint, label in PATH_EMOTION_HINTS.items():
            if hint.lower() in part:
                return label, "path"
    return "", ""


def label_for_audio(label_index: dict[str, dict[str, str]], audio_path: str | Path) -> dict[str, str]:
    path = Path(str(audio_path).replace("\\", "/"))
    for key in candidate_ids(path.name) | candidate_ids(path.stem) | candidate_ids(str(path)):
        if key in label_index:
            return label_index[key]
    return {}


def iter_nested_tar_wavs(source: Path, limit: int | None = None) -> Iterable[tuple[str, bytes]]:
    yielded = 0
    with tarfile.open(source, "r") as outer:
        for outer_member in outer:
            if not outer_member.isfile():
                continue
            outer_name = outer_member.name
            lower_outer_name = outer_name.lower()

            if Path(lower_outer_name).suffix in AUDIO_EXTENSIONS:
                outer_file = outer.extractfile(outer_member)
                if outer_file is None:
                    continue
                yield outer_name, outer_file.read()
                yielded += 1
                if limit is not None and yielded >= limit:
                    return
                continue

            if not lower_outer_name.endswith(".tar"):
                continue

            outer_file = outer.extractfile(outer_member)
            if outer_file is None:
                continue

            with tarfile.open(fileobj=outer_file, mode="r|") as inner:
                for inner_member in inner:
                    if not inner_member.isfile() or Path(inner_member.name).suffix.lower() not in AUDIO_EXTENSIONS:
                        continue
                    inner_file = inner.extractfile(inner_member)
                    if inner_file is None:
                        continue
                    yield f"{outer_name}!{inner_member.name}", inner_file.read()
                    yielded += 1
                    if limit is not None and yielded >= limit:
                        return


def build_metadata_from_tar(
    source: Path,
    label_index: dict[str, dict[str, str]],
    limit: int | None = None,
) -> tuple[list[dict[str, str]], dict[str, Any]]:
    rows = []
    errors = []

    with tarfile.open(source, "r") as outer:
        outer_files = [member for member in outer.getmembers() if member.isfile()]

    for audio_path, raw_wav in iter_nested_tar_wavs(source, limit):
        audio_id = audio_id_from_path(Path(audio_path.split("!")[-1]))
        label = label_for_audio(label_index, audio_path)
        path_emotion, path_emotion_source = infer_emotion_from_path(Path(audio_path.replace("!", "/")))
        skt_emotion, emotion_index, emotion_detail, service_emotion = infer_skt_emotion_from_audio_id(audio_id)
        speaker_id, speaker_gender = speaker_from_audio_path(audio_path)
        row = {
            "audio_id": audio_id,
            "audio_path": audio_path,
            "speaker_id": speaker_id,
            "speaker_gender": speaker_gender,
            "emotion": label.get("emotion", skt_emotion or path_emotion),
            "emotion_index": emotion_index,
            "emotion_detail": emotion_detail,
            "service_emotion": service_emotion,
            "emotion_source": label.get("emotion_source", "skt_index" if skt_emotion else path_emotion_source),
            "transcript": label.get("transcript", ""),
            "transcript_source": label.get("transcript_source", ""),
        }
        try:
            row.update(audio_features_from_wav_bytes(raw_wav))
        except (wave.Error, EOFError, OSError) as exc:
            row["error"] = str(exc)
            errors.append({"audio_path": audio_path, "error": str(exc)})
        rows.append(row)

    summary = {
        "source": str(source),
        "source_type": "tar",
        "outer_files": len(outer_files),
        "outer_tar_files": sum(1 for member in outer_files if member.name.lower().endswith(".tar")),
        "label_keys": len(label_index),
        "rows": len(rows),
        "rows_with_emotion": sum(1 for row in rows if row.get("emotion")),
        "rows_with_transcript": sum(1 for row in rows if row.get("transcript")),
        "rows_with_pitch": sum(1 for row in rows if row.get("pitch_hz")),
        "rows_with_speaker_gender": sum(1 for row in rows if row.get("speaker_gender")),
        "limited": limit is not None,
        "errors": errors[:20],
    }
    if not rows:
        summary["status"] = "empty"
        summary["message"] = "No wav files found in tar or nested tar files."
    if rows and not summary["rows_with_emotion"]:
        summary["label_note"] = "No emotion labels matched. This tar appears to contain wav audio only; pass --labels if labels are stored separately."
    return rows, summary


def build_metadata(
    source: Path,
    limit: int | None = None,
    extra_label_index: dict[str, dict[str, str]] | None = None,
) -> tuple[list[dict[str, str]], dict[str, Any]]:
    label_index = {**build_label_index(source), **(extra_label_index or {})}
    audio_paths = sorted(path for path in source.rglob("*") if path.is_file() and path.suffix.lower() in AUDIO_EXTENSIONS)
    rows = []

    for path in audio_paths[:limit]:
        audio_id = audio_id_from_path(path)
        relative = path.relative_to(source)
        label = {}
        for key in candidate_ids(path.name) | candidate_ids(path.stem) | candidate_ids(str(relative)):
            if key in label_index:
                label = label_index[key]
                break

        path_emotion, path_emotion_source = infer_emotion_from_path(relative)
        speaker_id, speaker_gender = speaker_from_audio_path(relative)
        skt_emotion, emotion_index, emotion_detail, service_emotion = infer_skt_emotion_from_audio_id(audio_id)
        row = {
            "audio_id": audio_id,
            "audio_path": str(relative),
            "speaker_id": speaker_id,
            "speaker_gender": speaker_gender,
            "emotion": label.get("emotion", skt_emotion or path_emotion),
            "emotion_index": emotion_index,
            "emotion_detail": emotion_detail,
            "service_emotion": service_emotion,
            "emotion_source": label.get("emotion_source", "skt_index" if skt_emotion else path_emotion_source),
            "transcript": label.get("transcript", ""),
            "transcript_source": label.get("transcript_source", ""),
        }
        try:
            row.update(audio_features_from_wav(path))
        except (wave.Error, EOFError, OSError) as exc:
            row["error"] = str(exc)
        rows.append(row)

    archives = [inspect_tar(path) for path in sorted(source.rglob("*")) if path.is_file() and is_archive_fragment(path)]
    summary = {
        "source": str(source),
        "audio_files": len(audio_paths),
        "label_keys": len(label_index),
        "rows": len(rows),
        "rows_with_emotion": sum(1 for row in rows if row.get("emotion")),
        "rows_with_transcript": sum(1 for row in rows if row.get("transcript")),
        "archive_fragments": archives,
    }
    if not audio_paths and archives:
        summary["status"] = "archive_only"
        summary["message"] = "No extracted wav files found. Extract completed tar files first, then rerun this script."
    return rows, summary


def build_metadata_for_source(source: Path, limit: int | None = None, label_sources: list[Path] | None = None) -> tuple[list[dict[str, str]], dict[str, Any]]:
    label_sources = label_sources or []
    label_index: dict[str, dict[str, str]] = {}
    for label_source in label_sources:
        if label_source.is_dir():
            label_index.update(build_label_index(label_source))

    if source.is_file() and source.suffix.lower() == ".tar":
        return build_metadata_from_tar(source, label_index, limit)

    return build_metadata(source, limit, label_index)


def write_csv(rows: list[dict[str, str]], output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    extra_columns = sorted({key for row in rows for key in row if key not in BASE_COLUMNS})
    fieldnames = [*BASE_COLUMNS, *extra_columns]
    with output.open("w", encoding="utf-8-sig", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Extract SKT speech emotion metadata from an extracted dataset folder or small.tar.")
    parser.add_argument("source", help="Extracted SKT dataset folder or completed nested tar such as small.tar")
    parser.add_argument("--output", default="data/skt/skt_emotion_metadata.csv")
    parser.add_argument("--limit", type=int, default=None, help="Limit audio files for a quick smoke test")
    parser.add_argument("--labels", action="append", default=[], help="Optional extracted label folder. Repeatable.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    source = Path(args.source)
    rows, summary = build_metadata_for_source(source, args.limit, [Path(item) for item in args.labels])
    write_csv(rows, Path(args.output))
    summary["output"] = args.output
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
