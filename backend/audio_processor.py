from __future__ import annotations

import os
import tempfile
import subprocess
import logging
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

# Resolve dependencies
BACKEND_DIR = Path(__file__).resolve().parent
BASE_DIR = BACKEND_DIR.parent
DATA_DIR = BASE_DIR / "data"

AUDIO_SAMPLE_RATE = int(os.getenv("AUDIO_SAMPLE_RATE", "16000"))
AUDIO_CHUNK_SECONDS = int(os.getenv("AUDIO_CHUNK_SECONDS", "480"))
AUDIO_CHUNK_MIN_SECONDS = int(os.getenv("AUDIO_CHUNK_MIN_SECONDS", "300"))
AUDIO_CHUNK_MAX_SECONDS = int(os.getenv("AUDIO_CHUNK_MAX_SECONDS", "600"))
AUDIO_CHUNK_OVERLAP_SECONDS = int(os.getenv("AUDIO_CHUNK_OVERLAP_SECONDS", "0"))
AUDIO_SILENCE_NOISE_DB = os.getenv("AUDIO_SILENCE_NOISE_DB", "-35dB")
AUDIO_SILENCE_MIN_SECONDS = float(os.getenv("AUDIO_SILENCE_MIN_SECONDS", "0.7"))


class MediaConversionError(Exception):
    pass


def sanitize_uploaded_filename(file_name: str) -> str:
    import re
    if not file_name:
        return "unnamed_file"
    cleaned = re.sub(r'[\\/*?:"<>|]', "", file_name)
    cleaned = cleaned.replace(" ", "_")
    return cleaned if cleaned else "unnamed_file"


def media_suffix(file_name: str) -> str:
    if not file_name:
        return ".media"
    suffix = Path(file_name).suffix.lower()
    if not suffix or len(suffix) > 12:
        return ".media"
    return suffix


def convert_to_wav_audio(file_bytes: bytes, file_name: str) -> tuple[bytes, str, str]:
    safe_name = sanitize_uploaded_filename(file_name)
    with tempfile.TemporaryDirectory(prefix="upload_audio_", dir=DATA_DIR) as tmp_dir:
        input_path = Path(tmp_dir) / f"input{media_suffix(safe_name)}"
        output_path = Path(tmp_dir) / "audio.wav"
        input_path.write_bytes(file_bytes)

        cmd = [
            "ffmpeg",
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(input_path),
            "-vn",
            "-ac",
            "1",
            "-ar",
            str(AUDIO_SAMPLE_RATE),
            "-c:a",
            "pcm_s16le",
            str(output_path),
        ]
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=300, check=False)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise MediaConversionError(f"ffmpeg conversion failed: {exc}") from exc

        if result.returncode != 0 or not output_path.exists() or output_path.stat().st_size == 0:
            stderr = result.stderr.strip() if result else "unknown ffmpeg error"
            raise MediaConversionError(f"ffmpeg conversion failed: {stderr}")

        return output_path.read_bytes(), f"{Path(safe_name or 'media').stem or 'media'}.wav", "audio/wav"


def format_timestamp(seconds: float) -> str:
    total_seconds = max(0, int(round(seconds)))
    minutes, secs = divmod(total_seconds, 60)
    hours, minutes = divmod(minutes, 60)
    if hours:
        return f"{hours:02d}:{minutes:02d}:{secs:02d}"
    return f"{minutes:02d}:{secs:02d}"


def media_duration_seconds(media_path: Path) -> float:
    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(media_path),
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise MediaConversionError(f"ffprobe failed: {exc}") from exc

    if result.returncode != 0:
        raise MediaConversionError(f"ffprobe failed: {result.stderr.strip()}")

    try:
        duration = float(result.stdout.strip())
    except ValueError as exc:
        raise MediaConversionError(f"ffprobe returned invalid duration: {result.stdout.strip()}") from exc
    if duration <= 0:
        raise MediaConversionError("Audio duration is empty")
    return duration


def detect_silence_ranges(media_path: Path) -> list[tuple[float, float]]:
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "info",
        "-i",
        str(media_path),
        "-af",
        f"silencedetect=noise={AUDIO_SILENCE_NOISE_DB}:d={AUDIO_SILENCE_MIN_SECONDS}",
        "-f",
        "null",
        "-",
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=300, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise MediaConversionError(f"ffmpeg silence detection failed: {exc}") from exc

    if result.returncode not in (0, 1) and result.stderr.strip():
        raise MediaConversionError(f"ffmpeg silence detection failed: {result.stderr.strip()}")

    silence_ranges: list[tuple[float, float]] = []
    silence_start: Optional[float] = None
    for line in result.stderr.splitlines():
        if "silence_start:" in line:
            try:
                silence_start = float(line.rsplit("silence_start:", 1)[1].strip().split()[0])
            except (IndexError, ValueError):
                silence_start = None
        elif "silence_end:" in line and silence_start is not None:
            try:
                silence_end = float(line.rsplit("silence_end:", 1)[1].strip().split()[0])
            except (IndexError, ValueError):
                continue
            if silence_end > silence_start:
                silence_ranges.append((silence_start, silence_end))
            silence_start = None
    return silence_ranges


def choose_chunk_end(
    start_seconds: float,
    duration_seconds: float,
    silence_ranges: list[tuple[float, float]],
    *,
    target_seconds: int,
    min_seconds: int,
    max_seconds: int,
) -> float:
    min_end = min(start_seconds + min_seconds, duration_seconds)
    max_end = min(start_seconds + max_seconds, duration_seconds)
    if max_end <= min_end:
        return duration_seconds

    target_end = min(start_seconds + target_seconds, max_end)
    best_boundary: Optional[float] = None
    best_score: Optional[float] = None

    for silence_start, silence_end in silence_ranges:
        if silence_end < min_end or silence_start > max_end:
            continue
        boundary = max(min_end, min(target_end, silence_end))
        boundary = max(boundary, silence_start)
        boundary = min(boundary, silence_end, max_end)
        if boundary < min_end or boundary > max_end:
            continue
        score = abs(boundary - target_end)
        if best_score is None or score < best_score:
            best_score = score
            best_boundary = boundary

    if best_boundary is not None:
        return best_boundary
    return target_end


def split_audio_into_chunks(audio_bytes: bytes, audio_name: str) -> list[dict[str, Any]]:
    chunk_seconds = max(AUDIO_CHUNK_MIN_SECONDS, min(AUDIO_CHUNK_SECONDS, AUDIO_CHUNK_MAX_SECONDS))
    min_seconds = max(10, min(AUDIO_CHUNK_MIN_SECONDS, chunk_seconds))
    max_seconds = max(min_seconds, min(AUDIO_CHUNK_MAX_SECONDS, 10 * 60))
    target_seconds = max(min_seconds, min(AUDIO_CHUNK_SECONDS, max_seconds))
    overlap_seconds = max(0, min(AUDIO_CHUNK_OVERLAP_SECONDS, 5, chunk_seconds - 1))

    with tempfile.TemporaryDirectory(prefix="audio_chunks_", dir=DATA_DIR) as tmp_dir:
        tmp_path = Path(tmp_dir)
        source_path = tmp_path / "source.wav"
        source_path.write_bytes(audio_bytes)
        duration = media_duration_seconds(source_path)
        silence_ranges = detect_silence_ranges(source_path)

        chunks = []
        start = 0.0
        chunk_id = 1
        while start < duration:
            remaining = duration - start
            if remaining <= max_seconds:
                end = duration
            else:
                end = choose_chunk_end(
                    start,
                    duration,
                    silence_ranges,
                    target_seconds=target_seconds,
                    min_seconds=min_seconds,
                    max_seconds=max_seconds,
                )
                if end < start + min_seconds:
                    end = min(start + target_seconds, start + max_seconds, duration)
                end = min(max(end, start + min_seconds), start + max_seconds, duration)
            chunk_path = tmp_path / f"chunk_{chunk_id:03d}.wav"
            cmd = [
                "ffmpeg",
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-ss",
                f"{start:.3f}",
                "-i",
                str(source_path),
                "-t",
                f"{end - start:.3f}",
                "-vn",
                "-ac",
                "1",
                "-ar",
                str(AUDIO_SAMPLE_RATE),
                "-c:a",
                "pcm_s16le",
                str(chunk_path),
            ]
            try:
                result = subprocess.run(cmd, capture_output=True, text=True, timeout=300, check=False)
            except (OSError, subprocess.TimeoutExpired) as exc:
                raise MediaConversionError(f"ffmpeg chunking failed: {exc}") from exc

            if result.returncode != 0 or not chunk_path.exists() or chunk_path.stat().st_size == 0:
                raise MediaConversionError(f"ffmpeg chunking failed: {result.stderr.strip()}")

            chunks.append(
                {
                    "chunk_id": chunk_id,
                    "start_seconds": start,
                    "end_seconds": end,
                    "start_time": format_timestamp(start),
                    "end_time": format_timestamp(end),
                    "filename": f"{Path(audio_name).stem}_chunk_{chunk_id:03d}.wav",
                    "mime_type": "audio/wav",
                    "bytes": chunk_path.read_bytes(),
                }
            )

            if end >= duration:
                break
            start = max(0.0, end - overlap_seconds)
            chunk_id += 1

        return chunks
