from __future__ import annotations

import os
import re
import json
import uuid
import random
import logging
from typing import Any, Optional
from fastapi import HTTPException

from .database import (
    get_db,
    get_generation,
    update_generation,
    now_iso,
)
from .pipeline import (
    build_analytics,
    merge_speech_analysis_into_analytics,
    speech_analysis_from_generation,
    shuffle_quiz_options,
)
from .ml_service import MLServiceClient, MLServiceError

logger = logging.getLogger(__name__)

ML_URL = os.getenv("ML_URL", "https://ml.fastclass.ru")
ML_API_KEY = os.getenv("ML_API_KEY", "")


def default_practice_state() -> dict[str, Any]:
    """Returns the default blank state structure for a student practice session."""
    return {
        "status": "idle",
        "stage": "",
        "weak_subtopics": [],
        "current_weak_subtopics": [],
        "pending_weak_subtopics": [],
        "mastery": {},
        "mastery_order": [],
        "practice_round": 0,
        "round_submitted": False,
        "practice_completed": False,
        "request": {},
        "summary": [],
        "quiz": [],
        "error_message": "",
        "stale_reason": "",
        "updated_at": "",
    }


def normalize_practice_state(raw_state: Any) -> dict[str, Any]:
    """Ensures raw practice dictionary conforms to target schema, fallback defaults if fields missing."""
    state = default_practice_state()
    if isinstance(raw_state, dict):
        try:
            practice_round = int(raw_state.get("practice_round") or state["practice_round"] or 0)
        except (TypeError, ValueError):
            practice_round = state["practice_round"]
        state.update({
            "status": str(raw_state.get("status") or state["status"]),
            "stage": str(raw_state.get("stage") or state["stage"]),
            "error_message": str(raw_state.get("error_message") or state["error_message"]),
            "stale_reason": str(raw_state.get("stale_reason") or state["stale_reason"]),
            "updated_at": str(raw_state.get("updated_at") or state["updated_at"]),
            "practice_round": practice_round,
            "round_submitted": bool(raw_state.get("round_submitted", state["round_submitted"])),
            "practice_completed": bool(raw_state.get("practice_completed", state["practice_completed"])),
        })
        weak_subtopics = raw_state.get("weak_subtopics")
        if isinstance(weak_subtopics, list):
            state["weak_subtopics"] = [str(item).strip() for item in weak_subtopics if str(item).strip()]
        current_weak_subtopics = raw_state.get("current_weak_subtopics")
        if isinstance(current_weak_subtopics, list):
            state["current_weak_subtopics"] = [str(item).strip() for item in current_weak_subtopics if str(item).strip()]
        pending_weak_subtopics = raw_state.get("pending_weak_subtopics")
        if isinstance(pending_weak_subtopics, list):
            state["pending_weak_subtopics"] = [str(item).strip() for item in pending_weak_subtopics if str(item).strip()]
        mastery = raw_state.get("mastery")
        if isinstance(mastery, dict):
            state["mastery"] = normalize_mastery_map(mastery)
        elif isinstance(mastery, list):
            state["mastery"] = normalize_mastery_map(mastery)
        mastery_order = raw_state.get("mastery_order")
        if isinstance(mastery_order, list):
            state["mastery_order"] = [str(item).strip() for item in mastery_order if str(item).strip()]
        request = raw_state.get("request")
        if isinstance(request, dict):
            state["request"] = request
        summary = raw_state.get("summary")
        if isinstance(summary, list):
            state["summary"] = summary
        quiz = raw_state.get("quiz")
        if isinstance(quiz, list):
            state["quiz"] = quiz
    return state


def normalize_mastery_map(raw_mastery: Any) -> dict[str, int]:
    """Extracts raw mastery fields into a normalized dictionary of subtopic -> percentage mapping."""
    mastery: dict[str, int] = {}
    items: list[tuple[str, Any]] = []
    if isinstance(raw_mastery, dict):
        items = [(str(key), value) for key, value in raw_mastery.items()]
    elif isinstance(raw_mastery, list):
        for item in raw_mastery:
            if not isinstance(item, dict):
                continue
            subtopic = str(item.get("subtopic") or "").strip()
            if not subtopic:
                continue
            items.append((subtopic, item.get("percent", 0)))
    for subtopic_raw, percent_raw in items:
        subtopic = str(subtopic_raw or "").strip()
        if not subtopic:
            continue
        try:
            percent = int(percent_raw or 0)
        except (TypeError, ValueError):
            percent = 0
        mastery[subtopic] = max(0, min(100, percent))
    return mastery


def practice_mastery_order(practice: dict[str, Any], fallback_order: list[str] | None = None) -> list[str]:
    """Determines sorted sequence of subtopics, aligning legacy orders and fallback lists."""
    order: list[str] = []
    seen: set[str] = set()
    raw_order = practice.get("mastery_order")
    if isinstance(raw_order, list):
        for item in raw_order:
            subtopic = str(item or "").strip()
            if not subtopic or subtopic in seen:
                continue
            order.append(subtopic)
            seen.add(subtopic)
    if fallback_order:
        for item in fallback_order:
            subtopic = str(item or "").strip()
            if not subtopic or subtopic in seen:
                continue
            order.append(subtopic)
            seen.add(subtopic)
    mastery = normalize_mastery_map(practice.get("mastery", {}))
    for subtopic in mastery.keys():
        if subtopic not in seen:
            order.append(subtopic)
            seen.add(subtopic)
    return order


def practice_low_topics(mastery: dict[str, int], order: list[str]) -> list[dict[str, Any]]:
    """Filters and returns subtopics with score < 80% sorted by weakest score."""
    order_map = {subtopic: idx for idx, subtopic in enumerate(order)}
    low_topics = [
        {"subtopic": subtopic, "percent": int(percent or 0)}
        for subtopic, percent in mastery.items()
        if int(percent or 0) < 80
    ]
    low_topics.sort(
        key=lambda item: (
            int(item.get("percent", 0) or 0),
            order_map.get(str(item.get("subtopic") or ""), len(order_map)),
            str(item.get("subtopic") or "").casefold(),
        )
    )
    return low_topics


def practice_round_topics(mastery: dict[str, int], order: list[str], limit: int = 2) -> tuple[list[str], list[str]]:
    """Splits weak subtopics into the current batch and pending queues."""
    low_topics = practice_low_topics(mastery, order)
    selected = [str(item.get("subtopic") or "").strip() for item in low_topics[:limit] if str(item.get("subtopic") or "").strip()]
    pending = [str(item.get("subtopic") or "").strip() for item in low_topics[limit:] if str(item.get("subtopic") or "").strip()]
    return selected, pending


def merge_practice_mastery(practice: dict[str, Any], round_mastery: list[dict[str, Any]], fallback_order: list[str] | None = None) -> dict[str, Any]:
    """Combines new round evaluations into existing session mastery maps."""
    mastery = normalize_mastery_map(practice.get("mastery", {}))
    for item in round_mastery:
        if not isinstance(item, dict):
            continue
        subtopic = str(item.get("subtopic") or "").strip()
        if not subtopic:
            continue
        try:
            percent = int(item.get("percent", 0) or 0)
        except (TypeError, ValueError):
            percent = 0
        mastery[subtopic] = max(0, min(100, percent))

    order = practice_mastery_order(practice, fallback_order)
    for subtopic in mastery.keys():
        if subtopic not in order:
            order.append(subtopic)

    updated = {**practice, "mastery": mastery, "mastery_order": order}
    return updated


def practice_is_active(practice: dict[str, Any]) -> bool:
    """Verifies if the practice flow is currently active."""
    return str(practice.get("status") or "").strip().casefold() in {
        "processing_summary",
        "summary_ready",
        "processing_quiz",
        "completed",
        "failed",
    }


def practice_state_from_patch(current_practice: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    """Merges edits into the practice block and stamps update timestamp."""
    practice = normalize_practice_state(current_practice)
    practice.update(patch)
    practice["updated_at"] = now_iso()
    return practice


def invalidate_practice_state(reason: str) -> dict[str, Any]:
    """Marks practice session as stale due to course content/quiz changes."""
    state = default_practice_state()
    state["status"] = "stale"
    state["stale_reason"] = reason
    state["updated_at"] = now_iso()
    return state


def normalize_text_for_match(text: str) -> str:
    """Standardizes string characters and spacing to evaluate substring matches."""
    return re.sub(r"[^0-9a-zA-Zа-яА-ЯёЁ]+", " ", str(text or "").casefold()).strip()


def split_text_tokens(text: str) -> set[str]:
    """Segments string into keywords longer than 3 characters."""
    tokens = {
        token
        for token in re.split(r"[^0-9a-zA-Zа-яА-ЯёЁ]+", normalize_text_for_match(text))
        if len(token) >= 4
    }
    return tokens


def select_practice_mini_summaries(generation: dict[str, Any], weak_subtopics: list[str]) -> list[dict[str, Any]]:
    """Selects mini-summary blocks covering key points matching weak subtopics."""
    mini_summaries = generation.get("mini_summary", [])
    summary_sections = generation.get("summary", [])
    if not isinstance(mini_summaries, list):
        mini_summaries = []
    if not isinstance(summary_sections, list):
        summary_sections = []

    summary_map: dict[str, dict[str, Any]] = {}
    for idx, section in enumerate(summary_sections):
        if not isinstance(section, dict):
            continue
        subtopic = str(section.get("subtopic") or f"Раздел {idx + 1}").strip()
        if subtopic:
            summary_map[normalize_text_for_match(subtopic)] = section

    selected: list[dict[str, Any]] = []
    seen_chunks: set[int] = set()

    def add_chunk(item: dict[str, Any]) -> None:
        try:
            chunk_id = int(item.get("chunk_id", 0) or 0)
        except (TypeError, ValueError):
            chunk_id = 0
        if chunk_id in seen_chunks:
            return
        seen_chunks.add(chunk_id)
        selected.append(item)

    for weak_subtopic in weak_subtopics:
        normalized_weak = normalize_text_for_match(weak_subtopic)
        if not normalized_weak:
            continue
        matched_section = summary_map.get(normalized_weak)
        matched_tokens = split_text_tokens(matched_section.get("content", "")) if isinstance(matched_section, dict) else set()
        if not matched_tokens:
            matched_tokens = split_text_tokens(weak_subtopic)

        for item in mini_summaries:
            if not isinstance(item, dict):
                continue
            blob_parts: list[str] = []
            for field in ("key_points", "terms", "examples"):
                value = item.get(field)
                if isinstance(value, list):
                    blob_parts.extend(str(part) for part in value if str(part).strip())
            blob = normalize_text_for_match(" ".join(blob_parts))
            if normalized_weak in blob or any(token in blob for token in matched_tokens):
                add_chunk(item)

    if not selected and isinstance(mini_summaries, list):
        for item in mini_summaries[:4]:
            if isinstance(item, dict):
                add_chunk(item)

    return selected


def build_practice_questions(generation: dict[str, Any], questions: list[dict[str, Any]], weak_subtopics: list[str]) -> list[dict[str, Any]]:
    """Builds and filters list of practice questions covering targeted topics."""
    quiz = generation.get("quiz", [])
    if not isinstance(quiz, list):
        quiz = []
    allowed = {normalize_text_for_match(item) for item in weak_subtopics if normalize_text_for_match(item)}
    normalized_questions: list[dict[str, Any]] = []

    quiz_by_id: dict[str, dict[str, Any]] = {}
    for idx, q in enumerate(quiz):
        if not isinstance(q, dict):
            continue
        qid = str(q.get("question_id", idx + 1))
        quiz_by_id[qid] = q

    for item in questions:
        if not isinstance(item, dict):
            continue
        subtopic = str(item.get("subtopic") or "").strip()
        if allowed and normalize_text_for_match(subtopic) not in allowed:
            continue
        qid = str(item.get("question_id") or "").strip()
        source_q = quiz_by_id.get(qid)
        source_question_type = str(source_q.get("question_type") if isinstance(source_q, dict) else "multiple_choice")
        source_question_text = str(source_q.get("question_text") if isinstance(source_q, dict) else "")
        source_explanation = str(source_q.get("explanation") if isinstance(source_q, dict) else "")
        normalized_questions.append(
            {
                "question_id": qid,
                "question_type": str(item.get("question_type") or source_question_type or "multiple_choice"),
                "subtopic": subtopic,
                "question_text": str(item.get("question_text") or source_question_text).strip(),
                "student_answer": str(item.get("student_answer") or "").strip(),
                "correct_answer": str(item.get("correct_answer") or "").strip(),
                "is_correct": bool(item.get("is_correct")),
                "explanation": str(item.get("explanation") or source_explanation).strip(),
            }
        )

    if not normalized_questions and questions:
        for item in questions:
            if not isinstance(item, dict):
                continue
            subtopic = str(item.get("subtopic") or "").strip()
            qid = str(item.get("question_id") or "").strip()
            source_q = quiz_by_id.get(qid)
            source_question_type = str(source_q.get("question_type") if isinstance(source_q, dict) else "multiple_choice")
            source_question_text = str(source_q.get("question_text") if isinstance(source_q, dict) else "")
            source_explanation = str(source_q.get("explanation") if isinstance(source_q, dict) else "")
            normalized_questions.append(
                {
                    "question_id": qid,
                    "question_type": str(item.get("question_type") or source_question_type or "multiple_choice"),
                    "subtopic": subtopic,
                    "question_text": str(item.get("question_text") or source_question_text).strip(),
                    "student_answer": str(item.get("student_answer") or "").strip(),
                    "correct_answer": str(item.get("correct_answer") or "").strip(),
                    "is_correct": bool(item.get("is_correct")),
                    "explanation": str(item.get("explanation") or source_explanation).strip(),
                }
            )

    return normalized_questions


def fallback_practice_questions_from_quiz(generation: dict[str, Any], weak_subtopics: list[str]) -> list[dict[str, Any]]:
    """Selects quiz questions directly from main test if practice question generators return empty."""
    quiz = generation.get("quiz", [])
    if not isinstance(quiz, list):
        quiz = []
    allowed = {normalize_text_for_match(item) for item in weak_subtopics if normalize_text_for_match(item)}
    questions: list[dict[str, Any]] = []
    for idx, q in enumerate(quiz):
        if not isinstance(q, dict):
            continue
        subtopic = str(q.get("subtopic") or f"Подтема {idx + 1}").strip()
        normalized_subtopic = normalize_text_for_match(subtopic)
        if allowed and normalized_subtopic not in allowed:
            continue
        questions.append(
            {
                "question_id": str(q.get("question_id") or idx + 1),
                "question_type": str(q.get("question_type") or "multiple_choice"),
                "subtopic": subtopic,
                "question_text": str(q.get("question_text") or "").strip(),
                "student_answer": "",
                "correct_answer": str(q.get("correct_answer") or "").strip(),
                "is_correct": False,
                "explanation": str(q.get("explanation") or "").strip(),
            }
        )
    if not questions:
        for idx, q in enumerate(quiz):
            if not isinstance(q, dict):
                continue
            questions.append(
                {
                    "question_id": str(q.get("question_id") or idx + 1),
                    "question_type": str(q.get("question_type") or "multiple_choice"),
                    "subtopic": str(q.get("subtopic") or f"Подтема {idx + 1}").strip(),
                    "question_text": str(q.get("question_text") or "").strip(),
                    "student_answer": "",
                    "correct_answer": str(q.get("correct_answer") or "").strip(),
                    "is_correct": False,
                    "explanation": str(q.get("explanation") or "").strip(),
                }
            )
    return questions


def build_practice_payload(generation: dict[str, Any], weak_subtopics: list[str], questions: list[dict[str, Any]]) -> dict[str, Any]:
    """Prepares structured context summary and matching questions for LLM review."""
    topics = []
    selected_mini_summaries = select_practice_mini_summaries(generation, weak_subtopics)
    summary_sections = generation.get("summary", [])
    summary_lookup: dict[str, dict[str, Any]] = {}
    if isinstance(summary_sections, list):
        for idx, section in enumerate(summary_sections):
            if not isinstance(section, dict):
                continue
            subtopic = str(section.get("subtopic") or f"Раздел {idx + 1}").strip()
            if subtopic:
                summary_lookup[normalize_text_for_match(subtopic)] = section

    for weak_subtopic in weak_subtopics:
        normalized_weak = normalize_text_for_match(weak_subtopic)
        section = summary_lookup.get(normalized_weak)
        topic_mini_summaries = select_practice_mini_summaries(
            generation,
            [weak_subtopic],
        )
        topics.append(
            {
                "subtopic": weak_subtopic,
                "summary_section": section if isinstance(section, dict) else None,
                "mini_summaries": topic_mini_summaries,
            }
        )

    if not topics and selected_mini_summaries:
        topics.append(
            {
                "subtopic": "Повторение ключевых моментов",
                "summary_section": None,
                "mini_summaries": selected_mini_summaries,
            }
        )

    return {
        "weak_subtopics": weak_subtopics,
        "topics": topics,
        "questions": questions,
    }


async def grade_quiz_attempt(generation: dict[str, Any], quiz: list[dict[str, Any]], answers: list[dict[str, Any]]) -> dict[str, Any]:
    """Validates student quiz inputs, requesting open-ended question checks from ML if needed."""
    quiz_subtopics_list = quiz_subtopics(quiz)
    answers_by_id: dict[str, dict[str, Any]] = {}
    for item in answers:
        if not isinstance(item, dict):
            continue
        qid = str(item.get("question_id", "")).strip()
        if qid:
            answers_by_id[qid] = item

    results: list[dict[str, Any]] = []
    open_payload: list[dict[str, Any]] = []
    open_subtopics_by_id: dict[str, str] = {}
    for idx, q in enumerate(quiz):
        if not isinstance(q, dict):
            continue
        qid = str(q.get("question_id", idx + 1))
        qtype = q.get("question_type", "multiple_choice")
        subtopic = (q.get("subtopic") or f"Подтема {idx + 1}").strip()
        user_answer = answers_by_id.get(qid, {})
        if not isinstance(user_answer, dict):
            user_answer = {"answer": user_answer}
        if qtype in ("open_ended", "open_question"):
            open_subtopics_by_id[qid] = subtopic
            open_payload.append(
                {
                    "question_id": qid,
                    "question_text": q.get("question_text", ""),
                    "correct_answer": q.get("correct_answer", ""),
                    "student_answer": user_answer.get("student_answer") if isinstance(user_answer.get("student_answer"), str) else str(user_answer.get("answer") or ""),
                }
            )
            continue

        if "is_correct" in user_answer:
            score = 1 if user_answer.get("is_correct") is True else 0
        else:
            try:
                ua = int(user_answer.get("answer"))
            except (TypeError, ValueError):
                ua = -1
            try:
                correct_answer = int(q.get("correct_answer", -999))
            except (TypeError, ValueError):
                correct_answer = -999
            score = 1 if ua == correct_answer else 0
        results.append({"question_id": qid, "subtopic": subtopic, "score": score})

    if open_payload:
        if not ML_API_KEY:
            raise HTTPException(status_code=500, detail="Сервис проверки не настроен.")
        ml_client = MLServiceClient(api_key=ML_API_KEY, base_url=ML_URL)
        try:
            graded = await ml_client.grade_open_answers(open_payload)
            for row in graded.get("scores", []):
                qid = str(row.get("question_id", ""))
                results.append(
                    {
                        "question_id": qid,
                        "subtopic": open_subtopics_by_id.get(qid, ""),
                        "score": int(row.get("score", 0)),
                    }
                )
        except MLServiceError as exc:
            raise HTTPException(status_code=500, detail=exc.user_message)

    mastery = build_mastery_from_results(results, quiz_subtopics_list)
    recommendations = build_recommendations_from_mastery(mastery)
    recommendation = summarize_recommendations(recommendations)
    subtopic_to_revise = choose_subtopic_to_revise(recommendations)
    return {
        "results": results,
        "mastery": mastery,
        "recommendations": recommendations,
        "recommendation": recommendation,
        "subtopic_to_revise": subtopic_to_revise,
    }


def update_practice_state(generation_id: str, patch: dict[str, Any]) -> None:
    """Modifies practice dictionary inside DB for target generation."""
    current = get_generation(generation_id)
    if not current:
        return
    practice = normalize_practice_state(current.get("practice", {}))
    practice.update(patch)
    practice["updated_at"] = now_iso()
    update_generation(generation_id, {"practice": practice})


def seed_practice_mastery(practice: dict[str, Any], payload_mastery: Any, generation: dict[str, Any]) -> dict[str, Any]:
    """Combines explicit client mastery levels and global results into active session state."""
    current = normalize_practice_state(practice)
    mastery = normalize_mastery_map(current.get("mastery", {}))
    payload_mastery_map = normalize_mastery_map(payload_mastery)
    if payload_mastery_map:
        for subtopic, percent in payload_mastery_map.items():
            mastery.setdefault(subtopic, percent)
    if not mastery:
        analytics = generation.get("analytics", {})
        if isinstance(analytics, dict):
            mastery = normalize_mastery_map(analytics.get("mastery", []))
    if mastery:
        order = practice_mastery_order(current, [str(item) for item in quiz_subtopics(generation.get("quiz", []))])
        for subtopic in mastery.keys():
            if subtopic not in order:
                order.append(subtopic)
        current["mastery"] = mastery
        current["mastery_order"] = order
    return current


def practice_completion_view(practice: dict[str, Any]) -> dict[str, Any]:
    """Stamps the next student action (start, continue, done) based on pending subtopics."""
    return {
        "practice": normalize_practice_state(practice),
        "next_action": "done"
        if bool(practice.get("practice_completed"))
        else ("continue" if practice.get("round_submitted") and practice.get("pending_weak_subtopics") else "start"),
    }


def practice_round_context(practice: dict[str, Any], generation: dict[str, Any], payload_mastery: Any = None) -> tuple[dict[str, Any], list[str], list[str], bool]:
    """Identifies the next 1-2 weakest subtopics to include in the next practice round."""
    current = seed_practice_mastery(practice, payload_mastery, generation)
    mastery = normalize_mastery_map(current.get("mastery", {}))
    order = practice_mastery_order(current, [str(item) for item in quiz_subtopics(generation.get("quiz", []))])
    low_topics = practice_low_topics(mastery, order)
    selected = [str(item.get("subtopic") or "").strip() for item in low_topics[:2] if str(item.get("subtopic") or "").strip()]
    pending = [str(item.get("subtopic") or "").strip() for item in low_topics[2:] if str(item.get("subtopic") or "").strip()]
    all_done = not selected
    if selected:
        current["practice_round"] = int(current.get("practice_round") or 0) + 1
        current["current_weak_subtopics"] = selected
        current["pending_weak_subtopics"] = pending
        current["weak_subtopics"] = selected
        current["round_submitted"] = False
        current["practice_completed"] = False
    else:
        current["current_weak_subtopics"] = []
        current["pending_weak_subtopics"] = []
        current["weak_subtopics"] = []
        current["round_submitted"] = True
        current["practice_completed"] = True
        current["status"] = "completed"
        current["stage"] = "quiz"
        current["summary"] = []
        current["quiz"] = []
    current["mastery"] = mastery
    current["mastery_order"] = order
    current["updated_at"] = now_iso()
    return current, selected, pending, all_done


def quiz_subtopics(quiz: list[dict[str, Any]]) -> list[str]:
    """Returns list of unique subtopics covered by the quiz."""
    subtopics: list[str] = []
    for idx, q in enumerate(quiz):
        if not isinstance(q, dict):
            continue
        subtopic = str(q.get("subtopic") or f"Подтема {idx + 1}").strip()
        if subtopic and subtopic not in subtopics:
            subtopics.append(subtopic)
    return subtopics


def build_mastery_from_results(results: list[dict[str, Any]], subtopics: Optional[list[str]] = None) -> list[dict[str, Any]]:
    """Aggregates scores to compute topic mastery percentage lists."""
    stats: dict[str, dict[str, int]] = {subtopic: {"correct": 0, "total": 0} for subtopic in (subtopics or [])}
    for item in results:
        subtopic = str(item.get("subtopic") or "Без темы").strip() or "Без темы"
        if subtopics and subtopic not in stats:
            continue
        current = stats.setdefault(subtopic, {"correct": 0, "total": 0})
        current["correct"] += 1 if item.get("score") else 0
        current["total"] += 1
    ordered_subtopics = subtopics or list(stats.keys())
    return [
        {
            "subtopic": subtopic,
            "percent": round((stat["correct"] / stat["total"]) * 100) if stat["total"] else 0,
            "correct": stat["correct"],
            "total": stat["total"],
        }
        for subtopic in ordered_subtopics
        for stat in [stats.get(subtopic, {"correct": 0, "total": 0})]
    ]


def build_recommendations_from_mastery(mastery: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Calculates prioritized revision list for subjects below 80% mastery."""
    recommendations: list[dict[str, Any]] = []
    for item in mastery:
        try:
            percent = int(item.get("percent", 0) or 0)
        except (TypeError, ValueError):
            percent = 0
        subtopic = str(item.get("subtopic") or "Без темы").strip() or "Без темы"
        if percent < 50:
            recommendations.append(
                {
                    "subtopic": subtopic,
                    "action": "Важно разобрать тему",
                    "priority": "high",
                    "percent": percent,
                }
            )
        elif percent < 80:
            recommendations.append(
                {
                    "subtopic": subtopic,
                    "action": "Стоит повторить тему",
                    "priority": "medium",
                    "percent": percent,
                }
            )

    recommendations.sort(
        key=lambda item: (
            0 if item.get("priority") == "high" else 1,
            int(item.get("percent", 0) or 0),
            str(item.get("subtopic") or "").strip().casefold(),
        )
    )
    return recommendations[:2]


def summarize_recommendations(recommendations: list[dict[str, Any]]) -> str:
    """Returns human readable summary string of topics to revise."""
    if not recommendations:
        return "Отлично: все подтемы теста освоены."
    return " ".join(
        str(item.get("action") or "").strip()
        for item in recommendations
        if str(item.get("action") or "").strip()
    )


def choose_subtopic_to_revise(recommendations: list[dict[str, Any]]) -> str:
    """Returns the title of the subtopic requiring the most urgent revision."""
    for item in recommendations:
        if item.get("priority") == "high":
            return str(item.get("subtopic") or "").strip()
    return str(recommendations[0].get("subtopic") or "").strip() if recommendations else ""


def analytics_from_attempts(generation_id: str, quiz: list[dict[str, Any]], attempts: list[Any]) -> dict[str, Any]:
    """Calculates average mastery levels and recommendations from all attempts of students."""
    subtopics = quiz_subtopics(quiz)
    stats = {subtopic: {"correct": 0, "total": 0} for subtopic in subtopics}
    
    # We import this to fix latex characters once when loading attempts
    from .text_repair import repair_latex_value
    
    for attempt in attempts:
        try:
            results = repair_latex_value(json.loads(attempt["results_json"]))
        except (TypeError, json.JSONDecodeError):
            results = []
        for item in results if isinstance(results, list) else []:
            subtopic = str(item.get("subtopic") or "Без темы").strip() or "Без темы"
            if subtopics and subtopic not in stats:
                continue
            current = stats.setdefault(subtopic, {"correct": 0, "total": 0})
            current["correct"] += 1 if item.get("score") else 0
            current["total"] += 1

    mastery = [
        {
            "subtopic": subtopic,
            "percent": round((stat["correct"] / stat["total"]) * 100) if stat["total"] else 0,
            "correct": stat["correct"],
            "total": stat["total"],
        }
        for subtopic in subtopics
        for stat in [stats.get(subtopic, {"correct": 0, "total": 0})]
        if stat["total"] > 0
    ]
    recommendations = build_recommendations_from_mastery(mastery)

    return {
        "studentLink": f"/material/{generation_id}/",
        "studentsCompleted": len(attempts),
        "mastery": mastery,
        "recommendations": recommendations,
    }


def refresh_generation_analytics(generation_id: str) -> dict[str, Any]:
    """Recomputes aggregate analytics and broadcasts changes to WebSocket listeners."""
    generation = get_generation(generation_id)
    if not generation:
        return {}
    with get_db() as conn:
        attempts = conn.execute(
            "SELECT * FROM student_attempts WHERE generation_id = ? ORDER BY created_at DESC",
            (generation_id,),
        ).fetchall()
    
    analytics = analytics_from_attempts(generation_id, generation.get("quiz", []), attempts)
    if not attempts and not analytics.get("mastery"):
        analytics = build_analytics(generation_id, generation.get("quiz", []), speech_analysis_from_generation(generation))
        analytics["studentsCompleted"] = 0
        analytics["mastery"] = []
        analytics["recommendations"] = []
    else:
        analytics = merge_speech_analysis_into_analytics(analytics, speech_analysis_from_generation(generation))
        
    update_generation(generation_id, {"analytics": analytics}, broadcast_event_type="generation_analytics_updated")
    return analytics


def save_student_attempt(
    generation_id: str,
    user_id: str,
    answers: list[dict[str, Any]],
    results: list[dict[str, Any]],
    recommendation: str,
    subtopic_to_revise: str,
    quiz: Optional[list[dict[str, Any]]] = None,
) -> dict[str, Any]:
    """Saves student quiz attempt results and recalculates aggregate classroom analytics."""
    generation = get_generation(generation_id)
    quiz_source = quiz if isinstance(quiz, list) else (generation.get("quiz", []) if generation else [])
    mastery = build_mastery_from_results(results, quiz_subtopics(quiz_source))
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO student_attempts
            (id, generation_id, user_id, created_at, answers_json, results_json, mastery_json, recommendation, subtopic_to_revise)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(generation_id, user_id) DO UPDATE SET
              created_at = excluded.created_at,
              answers_json = excluded.answers_json,
              results_json = excluded.results_json,
              mastery_json = excluded.mastery_json,
              recommendation = excluded.recommendation,
              subtopic_to_revise = excluded.subtopic_to_revise
            """,
            (
                f"attempt_{uuid.uuid4().hex[:14]}",
                generation_id,
                user_id,
                now_iso(),
                json.dumps(answers, ensure_ascii=False),
                json.dumps(results, ensure_ascii=False),
                json.dumps(mastery, ensure_ascii=False),
                recommendation,
                subtopic_to_revise,
            ),
        )
    refresh_generation_analytics(generation_id)
    return {"mastery": mastery}


def load_student_attempt(generation_id: str, user_id: str) -> Optional[dict[str, Any]]:
    """Loads matching student quiz attempt if it exists."""
    from .text_repair import repair_latex_value
    with get_db() as conn:
        attempt_row = conn.execute(
            "SELECT * FROM student_attempts WHERE generation_id = ? AND user_id = ?",
            (generation_id, user_id),
        ).fetchone()
    if not attempt_row:
        return None
    return {
        "answers": repair_latex_value(json.loads(attempt_row["answers_json"])) if attempt_row["answers_json"] else [],
        "results": repair_latex_value(json.loads(attempt_row["results_json"])) if attempt_row["results_json"] else [],
        "mastery": repair_latex_value(json.loads(attempt_row["mastery_json"])) if attempt_row["mastery_json"] else [],
        "recommendation": attempt_row["recommendation"] or "",
        "subtopic_to_revise": attempt_row["subtopic_to_revise"] or "",
        "created_at": attempt_row["created_at"],
    }
