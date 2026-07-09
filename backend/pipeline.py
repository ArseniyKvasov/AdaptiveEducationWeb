from __future__ import annotations

import os
import re
import math
import json
import logging
import asyncio
from pathlib import Path
from typing import Any, Optional

from .database import (
    get_generation,
    update_generation,
    update_generation_progress,
    store_cached_transcript,
    get_cached_transcript,
)
from .audio_processor import (
    convert_to_wav_audio,
    split_audio_into_chunks,
    format_timestamp,
    MediaConversionError,
)
from .ml_service import MLServiceClient, MLServiceError

logger = logging.getLogger(__name__)


def make_user_error_message(exc: Exception) -> str:
    """Formats system exceptions into user-friendly error messages."""
    if isinstance(exc, MediaConversionError):
        return "Не удалось подготовить аудио из файла. Проверьте формат файла или попробуйте другой файл."
    if isinstance(exc, MLServiceError):
        combined = f"{exc.user_message} {exc}".lower()
        if "429" in combined or "rate" in combined:
            return "Rate limit reached"
        return exc.user_message
    text = str(exc).lower()
    if "rate" in text or "429" in text:
        return "Rate limit reached"
    if "timeout" in text:
        return "Превышено время ожидания ответа сервиса. Попробуйте позже."
    return "Не удалось завершить генерацию. Попробуйте позже."


# Config options from environment
ML_URL = os.getenv("ML_URL", "https://ml.fastclass.ru")
ML_API_KEY = os.getenv("ML_API_KEY", "")
TRANSCRIBE_BATCH_SIZE = max(1, int(os.getenv("TRANSCRIBE_BATCH_SIZE", "2")))
SPEECH_ANALYSIS_GROUP_TARGET_SECONDS = int(os.getenv("SPEECH_ANALYSIS_GROUP_TARGET_SECONDS", str(7 * 60)))
SPEECH_ANALYSIS_GROUP_MIN_SECONDS = int(os.getenv("SPEECH_ANALYSIS_GROUP_MIN_SECONDS", str(6 * 60)))
SPEECH_ANALYSIS_GROUP_MAX_SECONDS = int(os.getenv("SPEECH_ANALYSIS_GROUP_MAX_SECONDS", str(8 * 60)))
SPEECH_ANALYSIS_GROUP_OVERLAP_PHRASES = int(os.getenv("SPEECH_ANALYSIS_GROUP_OVERLAP_PHRASES", "3"))

SPEECH_ANALYSIS_TYPE_MAIN = "main"
SPEECH_ANALYSIS_TYPE_AGGREGATED = "aggregated"
SPEECH_ANALYSIS_AGGREGATE_KEYS = (
    "lesson_format",
    "audience_engagement",
    "lesson_structure",
    "material_explanation",
    "teacher_recommendation",
    "flags",
)


def detect_speech_analysis_type(speech_analysis: Any) -> str:
    """Detects whether speech analysis was successful and of aggregate or main type."""
    if not isinstance(speech_analysis, dict) or not speech_analysis:
        return ""
    explicit = str(speech_analysis.get("speech_analysis_type") or "").strip().lower()
    if explicit in {SPEECH_ANALYSIS_TYPE_MAIN, SPEECH_ANALYSIS_TYPE_AGGREGATED}:
        return explicit
    if any(isinstance(speech_analysis.get(key), dict) and speech_analysis.get(key) for key in SPEECH_ANALYSIS_AGGREGATE_KEYS):
        return SPEECH_ANALYSIS_TYPE_MAIN
    if isinstance(speech_analysis.get("chunk_analyses"), list):
        return SPEECH_ANALYSIS_TYPE_AGGREGATED
    return SPEECH_ANALYSIS_TYPE_MAIN


def normalize_analytics_speech_type(analytics: dict[str, Any]) -> bool:
    """Updates the speech analysis type marker in analytics if needed."""
    if not isinstance(analytics, dict):
        return False
    speech_analysis = analytics.get("speech_analysis")
    if not isinstance(speech_analysis, dict) or not speech_analysis:
        return False
    speech_type = detect_speech_analysis_type(speech_analysis)
    if not speech_type:
        return False
    if analytics.get("speech_analysis_type") == speech_type:
        return False
    analytics["speech_analysis_type"] = speech_type
    return True


def build_analytics(
    generation_id: str,
    quiz: list[dict[str, Any]],
    speech_analysis: Optional[dict[str, Any]] = None,
    speech_analysis_error: str = "",
) -> dict[str, Any]:
    """Prepares the base analytics payload for teacher view."""
    analytics = {
        "studentLink": f"/material/{generation_id}/",
        "studentsCompleted": 0,
        "mastery": [],
        "recommendations": [],
    }
    if isinstance(speech_analysis, dict) and speech_analysis:
        analytics["speech_analysis"] = speech_analysis
        speech_type = detect_speech_analysis_type(speech_analysis)
        if speech_type:
            analytics["speech_analysis_type"] = speech_type
    if str(speech_analysis_error or "").strip():
        analytics["speech_analysis_error"] = str(speech_analysis_error).strip()
    return analytics


def merge_speech_analysis_into_analytics(analytics: dict[str, Any], speech_analysis: Optional[dict[str, Any]]) -> dict[str, Any]:
    """Combines speech analysis components inside analytics wrapper."""
    merged = dict(analytics or {})
    if isinstance(speech_analysis, dict) and speech_analysis:
        merged["speech_analysis"] = speech_analysis
        speech_type = detect_speech_analysis_type(speech_analysis)
        if speech_type:
            merged["speech_analysis_type"] = speech_type
    return merged


def speech_analysis_from_generation(generation: dict[str, Any]) -> dict[str, Any]:
    """Safely extracts teacher speech analysis from a generation dictionary."""
    analytics = generation.get("analytics") if isinstance(generation.get("analytics"), dict) else {}
    speech_analysis = analytics.get("speech_analysis") if isinstance(analytics, dict) else {}
    return speech_analysis if isinstance(speech_analysis, dict) else {}


def transcript_line_by_start_ms(transcript: list[dict[str, Any]], start_ms: Any) -> Optional[dict[str, Any]]:
    """Finds exact match segment inside transcript array by start time."""
    try:
        target = int(start_ms)
    except (TypeError, ValueError):
        return None
    for line in transcript:
        if not isinstance(line, dict):
            continue
        try:
            line_start = int(line.get("start_ms", 0) or 0)
        except (TypeError, ValueError):
            continue
        if line_start == target:
            return line
    return None


def transcript_lines_by_ms_range(
    transcript: list[dict[str, Any]],
    start_ms: Any,
    end_ms: Any = None,
) -> list[dict[str, Any]]:
    """Extracts subset of transcript phrases within bounded millisecond range."""
    try:
        start_value = int(start_ms)
    except (TypeError, ValueError):
        return []
    try:
        end_value = int(end_ms if end_ms is not None else start_value)
    except (TypeError, ValueError):
        end_value = start_value
    if end_value < start_value:
        start_value, end_value = end_value, start_value
    matches: list[dict[str, Any]] = []
    for line in transcript:
        if not isinstance(line, dict):
            continue
        try:
            line_start = int(line.get("start_ms", 0) or 0)
        except (TypeError, ValueError):
            continue
        if start_value <= line_start <= end_value:
            matches.append(line)
    return matches


def expand_transcript_segment(
    *,
    chunk_id: int,
    chunk_start_ms: int,
    chunk_end_ms: int,
    start_ms: int,
    text: str,
) -> list[dict[str, Any]]:
    """Heuristically splits long speech-to-text text segments into structured sentences with relative starts."""
    clean_text = " ".join((text or "").split()).strip()
    if not clean_text:
        return []

    chunk_duration_ms = max(0, chunk_end_ms - chunk_start_ms)
    if chunk_duration_ms <= 0:
        return [
            {
                "chunk_id": chunk_id,
                "start_ms": max(chunk_start_ms, start_ms),
                "start_time": format_timestamp(max(chunk_start_ms, start_ms) / 1000),
                "text": clean_text,
                "is_final": True,
            }
        ]

    sentence_parts = [
        part.strip()
        for part in re.split(r"(?<=[.!?…])\s+(?=[A-ZА-ЯЁ0-9(«\"'])", clean_text)
        if part.strip()
    ]
    if len(sentence_parts) < 2:
        sentence_parts = [
            part.strip()
            for part in re.split(r"[\n\r]+", clean_text)
            if part.strip()
        ]
    if len(sentence_parts) < 2:
        return [
            {
                "chunk_id": chunk_id,
                "start_ms": max(chunk_start_ms, start_ms),
                "start_time": format_timestamp(max(chunk_start_ms, start_ms) / 1000),
                "text": clean_text,
                "is_final": True,
            }
        ]

    total_weight = sum(max(1, len(part)) for part in sentence_parts)
    expanded: list[dict[str, Any]] = []
    consumed_weight = 0
    for index, part in enumerate(sentence_parts):
        part_weight = max(1, len(part))
        part_start_ms = chunk_start_ms + round(chunk_duration_ms * consumed_weight / total_weight)
        if index > 0 and expanded:
            prev_start_ms = int(expanded[-1].get("start_ms", chunk_start_ms) or chunk_start_ms)
            if part_start_ms <= prev_start_ms:
                part_start_ms = prev_start_ms + 1
        if part_start_ms < chunk_start_ms:
            part_start_ms = chunk_start_ms
        expanded.append(
            {
                "chunk_id": chunk_id,
                "start_ms": part_start_ms,
                "start_time": format_timestamp(part_start_ms / 1000),
                "text": part,
                "is_final": True,
            }
        )
        consumed_weight += part_weight
    return expanded


def transcript_from_transcription_results(transcription_results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Combines batch transcription blocks into single sorted timeline."""
    transcript: list[dict[str, Any]] = []
    for chunk in transcription_results:
        transcript.extend(chunk.get("phrases", []))
    transcript.sort(key=lambda item: (int(item.get("start_ms", 0) or 0), int(item.get("chunk_id", 0) or 0)))
    return transcript


def transcript_chunk_payloads(transcript_chunks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Exposes normalized chunk payloads from raw collection."""
    payloads: list[dict[str, Any]] = []
    for chunk in transcript_chunks:
        if not isinstance(chunk, dict):
            continue
        if isinstance(chunk.get("transcript_chunk"), dict):
            payloads.append(chunk["transcript_chunk"])
        elif isinstance(chunk.get("transcript"), list):
            payloads.append(chunk)
    return payloads


def _flatten_transcript_phrases(transcript_chunks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Helper to convert structured transcript chunks to flat phrases list."""
    phrases: list[dict[str, Any]] = []
    sorted_chunks = sorted(transcript_chunks, key=lambda item: int(item.get("start_ms", 0) or 0))
    for chunk in sorted_chunks:
        if not isinstance(chunk, dict):
            continue
        chunk_start_ms = int(chunk.get("start_ms", 0) or 0)
        transcript = chunk.get("transcript")
        if not isinstance(transcript, list):
            continue
        for item in transcript:
            if not isinstance(item, dict):
                continue
            text = str(item.get("text") or "").strip()
            if not text:
                continue
            try:
                start_ms = int(item.get("start_ms", 0) or 0)
            except (TypeError, ValueError):
                start_ms = chunk_start_ms
            phrases.append({"start_ms": start_ms, "text": text})
    phrases.sort(key=lambda item: int(item.get("start_ms", 0) or 0))
    return phrases


def _build_overlapped_time_groups(
    transcript_chunks: list[dict[str, Any]],
    *,
    target_seconds: int,
    min_seconds: int,
    max_seconds: int,
    overlap_phrases: int = 3,
) -> list[dict[str, Any]]:
    """Groups flat phrases into target durations (like 7-8 min blocks) for speech analysis, adding overlaps."""
    flat_phrases = _flatten_transcript_phrases(transcript_chunks)
    if not flat_phrases:
        return []

    target_ms = max(1, target_seconds) * 1000
    min_ms = max(1, min_seconds) * 1000
    max_ms = max(min_ms, max_seconds * 1000)
    overlap = max(0, int(overlap_phrases))

    def make_group(
        phrases: list[dict[str, Any]],
        chunk_id: int,
        *,
        start_ms: int | None = None,
        end_ms: int | None = None,
    ) -> dict[str, Any]:
        selected_start_ms = int(phrases[0].get("start_ms", 0) or 0)
        selected_end_ms = int(phrases[-1].get("start_ms", selected_start_ms) or selected_start_ms)
        start_value = selected_start_ms if start_ms is None else int(start_ms)
        end_value = selected_end_ms if end_ms is None else int(end_ms)
        if end_value < start_value:
            end_value = start_value
        return {
            "chunk_id": chunk_id,
            "start_time": format_timestamp(start_value / 1000),
            "end_time": format_timestamp(end_value / 1000),
            "start_ms": start_value,
            "end_ms": end_value,
            "transcript": [
                {
                    "start_ms": int(item.get("start_ms", start_value) or start_value),
                    "text": item.get("text", ""),
                }
                for item in phrases
            ],
        }

    def duration_ms(start_idx: int, end_idx: int) -> int:
        if end_idx <= start_idx:
            return 0
        s_ms = int(flat_phrases[start_idx].get("start_ms", 0) or 0)
        e_ms = int(flat_phrases[end_idx - 1].get("start_ms", s_ms) or s_ms)
        return max(0, e_ms - s_ms)

    def choose_cut_index(start_idx: int, end_idx: int, target_duration_ms: int) -> int:
        if end_idx - start_idx <= 1:
            return end_idx
        s_ms = int(flat_phrases[start_idx].get("start_ms", 0) or 0)
        e_ms = int(flat_phrases[end_idx - 1].get("start_ms", s_ms) or s_ms)
        span_ms = max(0, e_ms - s_ms)
        if span_ms <= 0:
            return start_idx + max(1, (end_idx - start_idx) // 2)
        target_cut_ms = s_ms + min(target_duration_ms, span_ms)
        best_idx = start_idx + 1
        best_distance = float("inf")
        for cut_idx in range(start_idx + 1, end_idx):
            cut_ms = int(flat_phrases[cut_idx].get("start_ms", s_ms) or s_ms)
            distance = abs(cut_ms - target_cut_ms)
            if distance < best_distance:
                best_distance = distance
                best_idx = cut_idx
        return best_idx

    core_ranges: list[tuple[int, int]] = []
    start_idx = 0
    while start_idx < len(flat_phrases):
        best_end = -1
        best_score = float("inf")
        end_idx = start_idx + 1

        while end_idx <= len(flat_phrases):
            current_duration_ms = duration_ms(start_idx, end_idx)
            if current_duration_ms > max_ms and end_idx > start_idx + 1:
                break
            if current_duration_ms >= min_ms:
                score = abs(current_duration_ms - target_ms)
                if score < best_score:
                    best_score = score
                    best_end = end_idx
            end_idx += 1

        if best_end < 0:
            remaining_duration_ms = duration_ms(start_idx, len(flat_phrases))
            if remaining_duration_ms <= max_ms and remaining_duration_ms > 0:
                best_end = len(flat_phrases)
            else:
                best_end = choose_cut_index(start_idx, len(flat_phrases), target_ms)

        if best_end <= start_idx:
            best_end = min(len(flat_phrases), start_idx + 1)

        core_ranges.append((start_idx, best_end))
        start_idx = best_end

    if len(core_ranges) > 1:
        last_start, last_end = core_ranges[-1]
        last_duration_ms = duration_ms(last_start, last_end)
        if last_duration_ms > 0 and last_duration_ms < min_ms:
            prev_start, prev_end = core_ranges[-2]
            combined_start = prev_start
            combined_end = last_end
            if duration_ms(combined_start, combined_end) <= max_ms:
                core_ranges[-2] = (combined_start, combined_end)
                core_ranges.pop()

    groups: list[dict[str, Any]] = []
    for idx, (core_start, core_end) in enumerate(core_ranges, start=1):
        payload_start = max(0, core_start - overlap)
        payload_end = min(len(flat_phrases), core_end + overlap)
        core_start_ms = int(flat_phrases[core_start].get("start_ms", 0) or 0)
        core_end_ms = int(flat_phrases[core_end - 1].get("start_ms", core_start_ms) or core_start_ms)
        groups.append(
            make_group(
                flat_phrases[payload_start:payload_end],
                idx,
                start_ms=core_start_ms,
                end_ms=core_end_ms,
            )
        )

    return groups


def transcript_to_summary_groups(
    transcript_chunks: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Converts transcript chunks into time-bounded evaluation analysis groups."""
    return _build_overlapped_time_groups(
        transcript_chunks,
        target_seconds=SPEECH_ANALYSIS_GROUP_TARGET_SECONDS,
        min_seconds=SPEECH_ANALYSIS_GROUP_MIN_SECONDS,
        max_seconds=SPEECH_ANALYSIS_GROUP_MAX_SECONDS,
        overlap_phrases=SPEECH_ANALYSIS_GROUP_OVERLAP_PHRASES,
    )


def log_summary_payload(summary_groups: list[dict[str, Any]], label: str) -> None:
    """Logs structured summaries of processing segments."""
    logger.info(f"[summary] {label}: groups={len(summary_groups)}")
    for idx, group in enumerate(summary_groups, start=1):
        subtopic = str(group.get("subtopic") or f"Раздел {idx}").strip()
        transcript = group.get("transcript", [])
        if isinstance(transcript, list):
            preview_parts = []
            for item in transcript[:2]:
                if not isinstance(item, dict):
                    continue
                text = " ".join(str(item.get("text", "") or "").split())
                if text:
                    preview_parts.append(text[:140])
            preview = " | ".join(preview_parts)
        else:
            preview = ""
        logger.info(
            f"[summary] {label} #{idx}: subtopic={subtopic!r}, "
            f"start_ms={group.get('start_ms', 0)}, end_ms={group.get('end_ms', 0)}, preview={preview!r}"
        )


def _chunk_analysis_debug_view(chunk: dict[str, Any], idx: int) -> str:
    """Builds a compact diagnostic string for a chunk analysis payload."""
    if not isinstance(chunk, dict):
        return f"#{idx}: <non-dict>"
    key_points = chunk.get("key_points")
    key_points_count = len(key_points) if isinstance(key_points, list) else 0
    preview_parts: list[str] = []
    transcript = chunk.get("transcript")
    if isinstance(transcript, list):
        for item in transcript[:2]:
            if not isinstance(item, dict):
                continue
            text = " ".join(str(item.get("text", "") or "").split())
            if text:
                preview_parts.append(text[:120])
    preview = " | ".join(preview_parts)
    return (
        f"#{idx}: chunk_id={chunk.get('chunk_id')!r}, "
        f"start_ms={chunk.get('start_ms')!r}, end_ms={chunk.get('end_ms')!r}, "
        f"key_points={key_points_count}, preview={preview!r}"
    )


def log_final_summary(summary: list[dict[str, Any]], label: str) -> None:
    """Logs summaries of the finalized generated summaries."""
    logger.info(f"[summary] {label}: sections={len(summary) if isinstance(summary, list) else 0}")
    if not isinstance(summary, list):
        return
    for idx, section in enumerate(summary, start=1):
        if not isinstance(section, dict):
            continue
        subtopic = str(section.get("subtopic") or f"Раздел {idx}").strip()
        content = " ".join(str(section.get("content", "") or "").split())
        logger.info(f"[summary] {label} #{idx}: subtopic={subtopic!r}, content_preview={content[:220]!r}")


def shuffle_quiz_options(quiz: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Shuffles the multiple choice quiz options while keeping the correct answer index aligned."""
    import random
    special_option_patterns = (
        "all of the above",
        "none of the above",
        "all of above",
        "все вышеперечисленное",
        "все выше перечисленное",
        "все перечисленное выше",
        "ни одно из вышеперечисленного",
        "ничего из вышеперечисленного",
        "ни один из вышеперечисленных",
        "ни один из перечисленных",
        "ни один из вышеперечисленных вариантов",
    )

    def is_special_option(option: Any) -> bool:
        text = str(option or "").strip().casefold()
        if not text:
            return False
        return any(pattern in text for pattern in special_option_patterns)

    shuffled_quiz = []
    for question in quiz:
        q = dict(question) if isinstance(question, dict) else {}
        options = q.get("options")
        if q.get("question_type") != "multiple_choice" or not isinstance(options, list) or len(options) < 2:
            shuffled_quiz.append(q)
            continue

        try:
            correct_idx = int(q.get("correct_answer"))
        except (TypeError, ValueError):
            shuffled_quiz.append(q)
            continue
        if correct_idx < 0 or correct_idx >= len(options):
            shuffled_quiz.append(q)
            continue

        normal_options = [(idx, option) for idx, option in enumerate(options) if not is_special_option(option)]
        special_options = [(idx, option) for idx, option in enumerate(options) if is_special_option(option)]

        random.shuffle(normal_options)
        ordered_options = normal_options + special_options
        q["options"] = [option for _, option in ordered_options]
        q["correct_answer"] = next(new_idx for new_idx, (old_idx, _) in enumerate(ordered_options) if old_idx == correct_idx)
        shuffled_quiz.append(q)
    return shuffled_quiz


def transcript_to_chunks(transcript: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Groups flat transcript lines back into chunk files."""
    grouped: dict[int, list[dict[str, Any]]] = {}
    for phrase in transcript:
        try:
            chunk_id = int(phrase.get("chunk_id") or 1)
        except (TypeError, ValueError):
            chunk_id = 1
        grouped.setdefault(chunk_id, []).append(phrase)

    chunks = []
    for chunk_id, phrases in sorted(grouped.items()):
        phrases = sorted(phrases, key=lambda item: int(item.get("start_ms", 0) or 0))
        if not phrases:
            continue
        start_ms = int(phrases[0].get("start_ms", 0) or 0)
        end_ms = int(phrases[-1].get("start_ms", start_ms) or start_ms)
        chunks.append(
            {
                "chunk_id": chunk_id,
                "start_time": format_timestamp(start_ms / 1000),
                "end_time": format_timestamp(end_ms / 1000),
                "start_ms": start_ms,
                "end_ms": end_ms,
                "transcript": [
                    {
                        "start_ms": int(item.get("start_ms", 0) or 0),
                        "start_time": item.get("start_time") or format_timestamp(int(item.get("start_ms", 0) or 0) / 1000),
                        "text": item.get("text", ""),
                    }
                    for item in phrases
                ],
            }
        )
    return chunks


async def transcribe_audio_chunks(
    ml_client: MLServiceClient,
    audio_chunks: list[dict[str, Any]],
    audio_content_type: str,
    generation_id: Optional[str] = None,
) -> list[dict[str, Any]]:
    """Transcribes batches of audio in parallel and reports step percentage progress."""
    async def animate_batch_progress(target_percent: int, stop_event: asyncio.Event) -> None:
        if not generation_id:
            return
        current_generation = get_generation(generation_id)
        current_percent = int(round(float(current_generation.get("progress_percent", 0) or 0))) if current_generation else 0
        current_percent = max(0, min(current_percent, target_percent))
        while current_percent < target_percent:
            if stop_event.is_set():
                return
            await asyncio.sleep(1)
            if stop_event.is_set():
                return
            current_percent += 1
            update_generation_progress(generation_id, current_percent)

    async def transcribe_one(chunk: dict[str, Any]) -> dict[str, Any]:
        chunk_start_ms = int(chunk["start_seconds"] * 1000)
        chunk_end_ms = int(chunk["end_seconds"] * 1000)
        chunk_duration_ms = max(0, chunk_end_ms - chunk_start_ms)
        chunk_segments = await ml_client.transcribe_chunk(
            file_name=chunk["filename"],
            mime_type=chunk.get("mime_type") or audio_content_type,
            audio_bytes=chunk["bytes"],
            chunk_id=chunk["chunk_id"],
            start_ms=chunk_start_ms,
            end_ms=chunk_end_ms,
        )
        chunk_phrases = []
        for segment in chunk_segments:
            phrase = str(segment.get("text", "")).strip()
            if not phrase:
                continue
            raw_start_ms = int(segment.get("start_ms", 0) or 0)
            if 0 <= raw_start_ms <= chunk_duration_ms + 5000:
                absolute_start_ms = chunk_start_ms + raw_start_ms
                if absolute_start_ms > chunk_end_ms + 2000:
                    absolute_start_ms = chunk_end_ms
            else:
                absolute_start_ms = raw_start_ms
            if absolute_start_ms < chunk_start_ms:
                absolute_start_ms = chunk_start_ms
            chunk_phrases.extend(
                expand_transcript_segment(
                    chunk_id=chunk["chunk_id"],
                    chunk_start_ms=chunk_start_ms,
                    chunk_end_ms=chunk_end_ms,
                    start_ms=absolute_start_ms,
                    text=phrase,
                )
            )
        transcript_chunk = {
            "chunk_id": chunk["chunk_id"],
            "start_time": chunk["start_time"],
            "end_time": chunk["end_time"],
            "start_ms": int(chunk["start_seconds"] * 1000),
            "end_ms": int(chunk["end_seconds"] * 1000),
            "transcript": [{"start_ms": phrase["start_ms"], "text": phrase["text"]} for phrase in chunk_phrases],
        }
        return {
            "chunk_id": chunk["chunk_id"],
            "transcript_chunk": transcript_chunk,
            "phrases": chunk_phrases,
        }

    results: list[dict[str, Any]] = []
    animated_progress = 0
    for batch_start in range(0, len(audio_chunks), TRANSCRIBE_BATCH_SIZE):
        batch = audio_chunks[batch_start:batch_start + TRANSCRIBE_BATCH_SIZE]
        batch_target = math.ceil(((batch_start + len(batch)) / len(audio_chunks)) * 100) if audio_chunks else 100
        batch_target = max(animated_progress, min(100, batch_target))
        stop_event = asyncio.Event()
        progress_task: Optional[asyncio.Task[None]] = None
        if generation_id:
            progress_task = asyncio.create_task(animate_batch_progress(batch_target, stop_event))
        try:
            batch_results = await asyncio.gather(*(transcribe_one(chunk) for chunk in batch))
        finally:
            if progress_task:
                stop_event.set()
                await progress_task
        results.extend(batch_results)
        if generation_id:
            animated_progress = batch_target
            update_generation(
                generation_id,
                {
                    "transcript": transcript_from_transcription_results(results),
                    "progress_percent": animated_progress,
                },
            )
    return sorted(results, key=lambda item: int(item.get("chunk_id", 0) or 0))


async def build_summary_and_quiz(
    ml_client: MLServiceClient,
    transcript_chunks: list[dict[str, Any]],
    generation_id: Optional[str] = None,
    *,
    chunk_analyses: list[dict[str, Any]] | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    """Builds mini summaries, aggregate summary, and MCQs using the ML service client."""
    summary_source = transcript_chunk_payloads(transcript_chunks)
    summary_groups = transcript_to_summary_groups(summary_source)
    log_summary_payload(summary_groups, "build_summary_and_quiz")
    if chunk_analyses is None:
        analysis_tasks = [asyncio.create_task(ml_client.make_chunk_analyze(chunk)) for chunk in summary_groups]
        raw_results = await asyncio.gather(*analysis_tasks, return_exceptions=True)
        chunk_analyses = []
        failed_chunks = 0
        rejected_chunks = 0
        for result in raw_results:
            if isinstance(result, Exception):
                failed_chunks += 1
                logger.error(f"Chunk analysis failed: {result}")
                continue
            if isinstance(result, dict) and result:
                chunk_analyses.append(result)
                continue
            rejected_chunks += 1
        if failed_chunks:
            logger.warning(f"Chunk analysis completed with failures: failed_chunks={failed_chunks}, total={len(summary_groups)}")
        if rejected_chunks:
            logger.warning(
                "Chunk analysis returned unusable payloads: rejected_chunks=%s total=%s",
                rejected_chunks,
                len(summary_groups),
            )
    else:
        chunk_analyses = [chunk for chunk in chunk_analyses if isinstance(chunk, dict) and chunk]

    mini_summaries = []
    discarded_chunks = 0
    for idx, chunk in enumerate(chunk_analyses, start=1):
        key_points_raw = chunk.get("key_points")
        if not isinstance(key_points_raw, list):
            discarded_chunks += 1
            logger.warning(
                "[summary] %s: discarded chunk without key_points list: %s",
                "build_summary_and_quiz",
                _chunk_analysis_debug_view(chunk, idx),
            )
            continue
        key_points = [str(point).strip() for point in key_points_raw if str(point).strip()]
        if not key_points:
            discarded_chunks += 1
            logger.warning(
                "[summary] %s: discarded chunk with empty key_points: %s",
                "build_summary_and_quiz",
                _chunk_analysis_debug_view(chunk, idx),
            )
            continue
        mini_summaries.append(
            {
                "chunk_id": chunk.get("chunk_id"),
                "start_time": chunk.get("start_time"),
                "end_time": chunk.get("end_time"),
                "key_points": key_points,
                "terms": [],
                "examples": [],
            }
        )
    if discarded_chunks:
        logger.warning(
            "[summary] build_summary_and_quiz: discarded %s/%s chunk analyses before mini summaries",
            discarded_chunks,
            len(chunk_analyses),
        )
    if not mini_summaries:
        logger.error(
            "[summary] build_summary_and_quiz: no usable mini summaries after chunk analyses: %s",
            [
                _chunk_analysis_debug_view(chunk, idx)
                for idx, chunk in enumerate(chunk_analyses[:5], start=1)
            ],
        )
        raise MLServiceError(
            "Chunk analysis produced no usable mini summaries",
            "Не удалось составить конспект. Попробуйте повторить генерацию.",
        )
    # Batch lesson-summary generation to handle long recordings
    LESSON_SUMMARY_BATCH_SIZE = 8
    summary_batches = [mini_summaries[i:i + LESSON_SUMMARY_BATCH_SIZE] for i in range(0, len(mini_summaries), LESSON_SUMMARY_BATCH_SIZE)]
    
    logger.info(f"[summary] build_summary_and_quiz: parallelizing {len(summary_batches)} summary batches")
    summary_tasks = [ml_client.make_lesson_summary(list(batch)) for batch in summary_batches]
    summary_results = await asyncio.gather(*summary_tasks, return_exceptions=True)
    
    summary = []
    for idx, res in enumerate(summary_results, start=1):
        if isinstance(res, Exception):
            logger.error(f"[summary] build_summary_and_quiz: batch #{idx} failed: {res}")
            continue
        if isinstance(res, list):
            summary.extend(res)
            
    if not summary:
        raise MLServiceError(
            "All lesson summary batches failed",
            "Не удалось составить конспект. Попробуйте повторить генерацию.",
        )

    log_final_summary(summary, "build_summary_and_quiz")
    if generation_id:
        update_generation(
            generation_id,
            {
                "status": "processing",
                "progress_percent": 100,
                "mini_summary": list(mini_summaries),
                "summary": summary,
                "quiz": [],
                "analytics": {},
                "error_message": "",
            },
        )
    quiz = shuffle_quiz_options(await ml_client.make_quiz(summary))
    if generation_id:
        update_generation(
            generation_id,
            {
                "status": "processing",
                "progress_percent": 100,
                "mini_summary": list(mini_summaries),
                "summary": summary,
                "quiz": quiz,
                "analytics": {},
                "error_message": "",
            },
        )
    transcript: list[dict[str, Any]] = []
    for chunk in transcript_chunks:
        if not isinstance(chunk, dict):
            continue
        phrases = chunk.get("phrases") if isinstance(chunk.get("phrases"), list) else chunk.get("transcript")
        if isinstance(phrases, list):
            transcript.extend(phrases)
    transcript.sort(key=lambda item: (int(item.get("start_ms", 0) or 0), int(item.get("chunk_id", 0) or 0)))
    return transcript, list(mini_summaries), summary, quiz


async def build_teacher_analysis(
    ml_client: MLServiceClient,
    transcript_chunks: list[dict[str, Any]],
    *,
    chunk_analyses: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Assembles analytical reviews on speech tone, events, and flags for teacher visualization."""
    analysis_source = transcript_to_summary_groups(transcript_chunk_payloads(transcript_chunks))
    if not analysis_source:
        logger.warning("Teacher analysis skipped: no usable transcript chunks")
        return {}
    log_summary_payload(analysis_source, "build_teacher_analysis")
    if chunk_analyses is None:
        analysis_tasks = [asyncio.create_task(ml_client.make_chunk_analyze(chunk)) for chunk in analysis_source]
        analysis_results = await asyncio.gather(*analysis_tasks, return_exceptions=True)

        chunk_analyses = []
        failed_chunks = 0
        rejected_chunks = 0
        for result in analysis_results:
            if isinstance(result, Exception):
                failed_chunks += 1
                logger.error(f"Teacher analysis chunk failed: {result}")
                continue
            if isinstance(result, dict) and result:
                chunk_analyses.append(result)
                continue
            rejected_chunks += 1
    else:
        chunk_analyses = [chunk for chunk in chunk_analyses if isinstance(chunk, dict) and chunk]
        failed_chunks = 0
        rejected_chunks = 0
        analysis_results = list(chunk_analyses)

    if not chunk_analyses:
        logger.error(
            "Teacher analysis produced no usable chunk analyses: %s",
            [_chunk_analysis_debug_view(chunk, idx) for idx, chunk in enumerate(analysis_results[:5], start=1)],
        )
        return {}

    speech_analysis_type = SPEECH_ANALYSIS_TYPE_MAIN
    try:
        aggregate = await ml_client.make_teacher_analysis_aggregate(list(chunk_analyses))
    except Exception as exc:
        logger.error(f"Teacher analysis aggregate failed, falling back: {exc}")
        aggregate = {}
        speech_analysis_type = SPEECH_ANALYSIS_TYPE_AGGREGATED

    if not isinstance(aggregate, dict):
        aggregate = {}
    aggregate["chunk_analyses"] = list(chunk_analyses)
    aggregate["speech_analysis_type"] = speech_analysis_type
    if failed_chunks:
        aggregate["chunk_failures"] = failed_chunks
    return aggregate


async def build_summary_quiz_and_speech_analysis(
    ml_client: MLServiceClient,
    transcript_chunks: list[dict[str, Any]],
    generation_id: Optional[str] = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]], dict[str, Any], str]:
    """Runs concurrent summary, quiz, and speech analysis generation routines."""
    summary_source = transcript_chunk_payloads(transcript_chunks)
    summary_groups = transcript_to_summary_groups(summary_source)
    chunk_analysis_tasks = [asyncio.create_task(ml_client.make_chunk_analyze(chunk)) for chunk in summary_groups]
    chunk_analysis_results = await asyncio.gather(*chunk_analysis_tasks, return_exceptions=True)

    chunk_analyses: list[dict[str, Any]] = []
    failed_chunks = 0
    for result in chunk_analysis_results:
        if isinstance(result, Exception):
            failed_chunks += 1
            logger.error(f"Chunk analysis failed: {result}")
            continue
        if isinstance(result, dict) and result:
            chunk_analyses.append(result)
    if failed_chunks:
        logger.warning(f"Chunk analysis completed with failures: failed_chunks={failed_chunks}, total={len(summary_groups)}")

    summary_task = asyncio.create_task(
        build_summary_and_quiz(
            ml_client,
            transcript_chunks,
            generation_id=generation_id,
            chunk_analyses=list(chunk_analyses),
        )
    )
    speech_task = asyncio.create_task(
        build_teacher_analysis(
            ml_client,
            transcript_chunks,
            chunk_analyses=list(chunk_analyses),
        )
    )
    logger.info("[speech] build_summary_quiz_and_speech_analysis: started")
    try:
        transcript, mini_summaries, summary, quiz = await summary_task
    except Exception:
        speech_task.cancel()
        await asyncio.gather(speech_task, return_exceptions=True)
        raise

    speech_analysis: dict[str, Any] = {}
    speech_error = ""
    try:
        speech_analysis = await speech_task
        logger.info(f"[speech] build_summary_quiz_and_speech_analysis: finished, has_analysis={bool(speech_analysis)}")
    except Exception as exc:
        logger.error(f"Teacher analysis failed: {exc}")
        speech_analysis = {}
        speech_error = make_user_error_message(exc)

    return transcript, mini_summaries, summary, quiz, speech_analysis, speech_error


async def run_speech_analysis_retry_pipeline(generation_id: str) -> None:
    """Retries speech analysis generation using an already saved transcript."""
    current = get_generation(generation_id)
    if not current:
        return
    if not ML_API_KEY:
        raise RuntimeError("ML_API_KEY is empty")
    transcript = current.get("transcript", [])
    transcript_chunks = transcript_to_chunks(transcript if isinstance(transcript, list) else [])
    analysis_source = transcript_to_summary_groups(transcript_chunks)
    if not analysis_source:
        raise MLServiceError(
            "Retry requested without saved transcript",
            "Не найден сохраненный транскрипт для анализа речи преподавателя. Загрузите файл заново.",
        )

    ml_client = MLServiceClient(api_key=ML_API_KEY, base_url=ML_URL)
    existing_analytics = current.get("analytics") if isinstance(current.get("analytics"), dict) else {}
    if existing_analytics:
        analytics = dict(existing_analytics)
    else:
        analytics = build_analytics(generation_id, current.get("quiz", []))

    
    try:
        speech_analysis = await build_teacher_analysis(ml_client, transcript_chunks)
        if not speech_analysis:
            raise MLServiceError(
                "Teacher analysis retry returned empty result",
                "Не удалось заново собрать анализ речи преподавателя. Попробуйте еще раз.",
            )
        analytics["speech_analysis"] = speech_analysis
        analytics.pop("speech_analysis_error", None)
    except Exception as exc:
        analytics["speech_analysis_error"] = make_user_error_message(exc)

    update_generation(
        generation_id,
        {
            "status": "completed",
            "progress_percent": 100,
            "analytics": analytics,
            "error_message": "",
        },
    )


async def run_ml_retry_pipeline(generation_id: str) -> None:
    """Re-executes content summary and quiz generation using an existing transcript."""
    try:
        current = get_generation(generation_id)
        if not current:
            return
        if not ML_API_KEY:
            raise RuntimeError("ML_API_KEY is empty")

        ml_client = MLServiceClient(api_key=ML_API_KEY, base_url=ML_URL)
        summary = current.get("summary", [])
        quiz = current.get("quiz", [])
        transcript = current.get("transcript", [])
        transcript_chunks = transcript_to_chunks(transcript if isinstance(transcript, list) else [])
        summary_groups = transcript_to_summary_groups(transcript_chunks)
        if not summary_groups:
            raise MLServiceError(
                "Retry requested without saved transcript",
                "Не найден сохраненный транскрипт для повторной генерации. Загрузите файл заново.",
            )

        if isinstance(summary, list) and summary and isinstance(quiz, list) and quiz:
            await run_speech_analysis_retry_pipeline(generation_id)
            return

        update_generation(generation_id, {"status": "processing", "progress_percent": 100, "error_message": ""})
        log_summary_payload(summary_groups, "run_ml_retry_pipeline")
        transcript, mini_summaries, summary, quiz, speech_analysis, speech_error = await build_summary_quiz_and_speech_analysis(
            ml_client,
            transcript_chunks,
            generation_id=generation_id,
        )
        log_final_summary(summary, "run_ml_retry_pipeline")
        analytics = build_analytics(generation_id, quiz, speech_analysis, speech_error)
        update_generation(
            generation_id,
            {
                "status": "completed",
                "progress_percent": 100,
                "mini_summary": list(mini_summaries),
                "summary": summary,
                "quiz": quiz,
                "transcript": transcript,
                "analytics": analytics,
                "error_message": "",
            },
        )
    except Exception as e:
        update_generation(generation_id, {"status": "failed", "error_message": make_user_error_message(e)})
        logger.error(f"Generation retry failed for {generation_id}: {e}", exc_info=True)


async def finalize_generation_from_transcript(generation_id: str, transcript: list[dict[str, Any]]) -> None:
    """Completes the summaries/quiz flow if transcript is loaded from cache."""
    try:
        update_generation(
            generation_id,
            {
                "status": "processing",
                "progress_percent": 100,
                "mini_summary": [],
                "transcript": transcript,
                "summary": [],
                "quiz": [],
                "analytics": {},
                "error_message": "",
            },
        )
        if not ML_API_KEY:
            raise RuntimeError("ML_API_KEY is empty")
        ml_client = MLServiceClient(api_key=ML_API_KEY, base_url=ML_URL)
        transcript_chunks = transcript_to_chunks(transcript if isinstance(transcript, list) else [])
        summary_groups = transcript_to_summary_groups(transcript_chunks)
        if not summary_groups:
            raise MLServiceError("Cached transcript is empty", "Не удалось получить транскрипт из файла. Попробуйте другой файл.")

        log_summary_payload(summary_groups, "finalize_generation_from_transcript")
        transcript, mini_summaries, summary, quiz, speech_analysis, speech_error = await build_summary_quiz_and_speech_analysis(
            ml_client,
            transcript_chunks,
            generation_id=generation_id,
        )
        log_final_summary(summary, "finalize_generation_from_transcript")
        analytics = build_analytics(generation_id, quiz, speech_analysis, speech_error)

        update_generation(
            generation_id,
            {
                "status": "completed",
                "progress_percent": 100,
                "transcript": transcript,
                "mini_summary": mini_summaries,
                "summary": summary,
                "quiz": quiz,
                "analytics": analytics,
                "error_message": "",
            },
        )
    except Exception as e:
        update_generation(generation_id, {"status": "failed", "error_message": make_user_error_message(e)})
        logger.error(f"Generation from transcript failed for {generation_id}: {e}", exc_info=True)


async def run_generation_pipeline(generation_id: str, file_bytes: bytes, file_name: str, content_type: Optional[str], content_hash: Optional[str] = None) -> None:
    """Main transcription and content generation entrypoint for uploaded video/audio files."""
    try:
        update_generation(
            generation_id,
            {
                "status": "processing",
                "progress_percent": 0,
                "transcript": [],
                "mini_summary": [],
                "summary": [],
                "quiz": [],
                "analytics": {},
                "error_message": "",
            },
        )
        if not ML_API_KEY:
            raise RuntimeError("ML_API_KEY is empty")
        ml_client = MLServiceClient(api_key=ML_API_KEY, base_url=ML_URL)
        audio_bytes, audio_name, audio_content_type = await asyncio.to_thread(convert_to_wav_audio, file_bytes, file_name)
        audio_chunks = await asyncio.to_thread(split_audio_into_chunks, audio_bytes, audio_name)
        transcription_results = await transcribe_audio_chunks(ml_client, audio_chunks, audio_content_type, generation_id)
        if content_hash:
            store_cached_transcript(content_hash, transcript_from_transcription_results(transcription_results))

        transcript, mini_summaries, summary, quiz, speech_analysis, speech_error = await build_summary_quiz_and_speech_analysis(
            ml_client,
            transcription_results,
            generation_id=generation_id,
        )
        analytics = build_analytics(generation_id, quiz, speech_analysis, speech_error)

        update_generation(
            generation_id,
            {
                "status": "completed",
                "progress_percent": 100,
                "transcript": transcript,
                "mini_summary": mini_summaries,
                "summary": summary,
                "quiz": quiz,
                "analytics": analytics,
                "error_message": "",
            },
        )
    except Exception as e:
        update_generation(generation_id, {"status": "failed", "error_message": make_user_error_message(e)})
        logger.error(f"Generation failed for {generation_id}: {e}", exc_info=True)
