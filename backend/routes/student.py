from __future__ import annotations

import os
import json
import logging
from typing import Any
from fastapi import APIRouter, Request, HTTPException

from ..database import get_generation, ensure_guest_user, update_generation
from ..practice_helpers import (
    default_practice_state,
    normalize_practice_state,
    seed_practice_mastery,
    practice_completion_view,
    practice_round_context,
    build_practice_questions,
    fallback_practice_questions_from_quiz,
    build_practice_payload,
    update_practice_state,
    grade_quiz_attempt,
    normalize_mastery_map,
    quiz_subtopics,
    build_mastery_from_results,
    practice_mastery_order,
    practice_low_topics,
    load_student_attempt,
    save_student_attempt,
    build_recommendations_from_mastery,
    summarize_recommendations,
    choose_subtopic_to_revise,
)
from ..pipeline import shuffle_quiz_options
from ..ml_service import MLServiceClient, MLServiceError

logger = logging.getLogger(__name__)

router = APIRouter()

ML_URL = os.getenv("ML_URL", "https://ml.fastclass.ru")

def get_ml_api_key() -> str:
    """Dynamically resolves the ML service API key, supporting test suite overrides."""
    import sys
    for mod_name in ("AdaptiveEducationWeb.backend.main", "Web.backend.main", "backend.main", "main"):
        main_mod = sys.modules.get(mod_name)
        if main_mod and hasattr(main_mod, "ML_API_KEY"):
            return main_mod.ML_API_KEY
    return os.getenv("ML_API_KEY", "")


def generation_has_student_material(generation: Optional[dict[str, Any]]) -> bool:
    if not generation or generation.get("status") == "failed":
        return False
    summary = generation.get("summary")
    quiz = generation.get("quiz")
    return isinstance(summary, list) and bool(summary) and isinstance(quiz, list) and bool(quiz)


def generation_has_practice_quiz(generation: Optional[dict[str, Any]]) -> bool:
    if not generation or generation.get("status") == "failed":
        return False
    practice = normalize_practice_state(generation.get("practice", {}))
    return isinstance(practice.get("quiz"), list) and bool(practice.get("quiz"))


@router.get("/api/student/{generation_id}")
async def api_student(request: Request, generation_id: str):
    """Returns the generated lesson summary, quiz, and any active practice attempt for the student."""
    user_id = ensure_guest_user(request)
    generation = get_generation(generation_id)
    if not generation_has_student_material(generation):
        raise HTTPException(status_code=404, detail="Not found")
    attempt = load_student_attempt(generation_id, user_id)
    return {
        "summary": generation.get("summary", []),
        "quiz": generation.get("quiz", []),
        "practice": generation.get("practice", default_practice_state()),
        "generation_id": generation_id,
        "attempt": attempt,
    }


@router.post("/api/student/{generation_id}/practice")
async def api_student_practice(request: Request, generation_id: str, payload: dict[str, Any]):
    """Initiates a personalized student practice round for weakest subtopics."""
    ensure_guest_user(request)
    generation = get_generation(generation_id)
    if not generation_has_student_material(generation):
        raise HTTPException(status_code=404, detail="Материал недоступен.")
    payload = payload if isinstance(payload, dict) else {}
    questions = payload.get("questions", [])
    if questions is not None and not isinstance(questions, list):
        raise HTTPException(status_code=400, detail="Некорректный формат вопросов.")

    current_practice = normalize_practice_state(generation.get("practice", {}))
    current_practice = seed_practice_mastery(current_practice, payload.get("mastery"), generation)
    if current_practice.get("practice_completed") and not current_practice.get("pending_weak_subtopics"):
        return practice_completion_view(current_practice)

    has_active_round = bool(current_practice.get("summary")) and not bool(current_practice.get("round_submitted"))
    if has_active_round and current_practice.get("status") in {"summary_ready", "processing_quiz", "completed"}:
        return practice_completion_view(current_practice)

    weak_subtopics = payload.get("weak_subtopics", [])
    if weak_subtopics is not None and not isinstance(weak_subtopics, list):
        raise HTTPException(status_code=400, detail="Нет слабых подтем для практики.")

    current_practice, selected_weak_subtopics, pending_weak_subtopics, all_done = practice_round_context(
        current_practice,
        generation,
        payload.get("mastery"),
    )
    practice_questions = build_practice_questions(
        generation,
        questions if isinstance(questions, list) else [],
        selected_weak_subtopics,
    )
    if not practice_questions:
        practice_questions = fallback_practice_questions_from_quiz(generation, selected_weak_subtopics)
        logger.info(f"[practice] fallback_questions for {generation_id}: count={len(practice_questions)}, topics={bool(selected_weak_subtopics)}")

    logger.info(
        f"[practice] request: gen={generation_id}, weak={current_practice.get('weak_subtopics', [])}, "
        f"selected={selected_weak_subtopics}, pending={pending_weak_subtopics}, q_count={len(practice_questions)}, all_done={all_done}"
    )

    if all_done:
        update_practice_state(
            generation_id,
            {
                "status": "completed",
                "stage": "quiz",
                "weak_subtopics": [],
                "current_weak_subtopics": [],
                "pending_weak_subtopics": [],
                "practice_round": int(current_practice.get("practice_round") or 0),
                "round_submitted": True,
                "practice_completed": True,
                "request": {
                    "weak_subtopics": [],
                    "questions": [],
                },
                "summary": [],
                "quiz": [],
                "error_message": "",
                "stale_reason": "",
                "mastery": current_practice.get("mastery", {}),
                "mastery_order": current_practice.get("mastery_order", []),
            },
        )
        practice = get_generation(generation_id)
        return practice_completion_view(practice.get("practice", default_practice_state()) if practice else default_practice_state())

    practice_request = {
        "weak_subtopics": selected_weak_subtopics,
        "questions": practice_questions,
        "mastery": current_practice.get("mastery", {}),
    }
    practice_context = build_practice_payload(generation, selected_weak_subtopics, practice_questions)
    
    update_practice_state(
        generation_id,
        {
            "status": "processing_summary",
            "stage": "summary",
            "weak_subtopics": selected_weak_subtopics,
            "current_weak_subtopics": selected_weak_subtopics,
            "pending_weak_subtopics": pending_weak_subtopics,
            "practice_round": int(current_practice.get("practice_round") or 0),
            "round_submitted": False,
            "practice_completed": False,
            "request": practice_request,
            "summary": [],
            "quiz": [],
            "error_message": "",
            "stale_reason": "",
            "mastery": current_practice.get("mastery", {}),
            "mastery_order": current_practice.get("mastery_order", []),
        },
    )

    api_key = get_ml_api_key()
    if not api_key:
        raise HTTPException(status_code=500, detail="Сервис дообучения не настроен.")

    ml_client = MLServiceClient(api_key=api_key, base_url=ML_URL)
    try:
        practice_summary = await ml_client.make_practice_summary(practice_context)
        update_practice_state(
            generation_id,
            {
                "status": "summary_ready",
                "stage": "summary",
                "weak_subtopics": selected_weak_subtopics,
                "current_weak_subtopics": selected_weak_subtopics,
                "pending_weak_subtopics": pending_weak_subtopics,
                "practice_round": int(current_practice.get("practice_round") or 0),
                "round_submitted": False,
                "practice_completed": False,
                "request": practice_request,
                "summary": practice_summary,
                "quiz": [],
                "error_message": "",
                "stale_reason": "",
                "mastery": current_practice.get("mastery", {}),
                "mastery_order": current_practice.get("mastery_order", []),
            },
        )
    except MLServiceError as exc:
        logger.error(f"[practice] ml error: {exc.user_message}", exc_info=True)
        update_practice_state(
            generation_id,
            {
                "status": "failed",
                "stage": "summary",
                "weak_subtopics": selected_weak_subtopics,
                "current_weak_subtopics": selected_weak_subtopics,
                "pending_weak_subtopics": pending_weak_subtopics,
                "practice_round": int(current_practice.get("practice_round") or 0),
                "round_submitted": False,
                "practice_completed": False,
                "request": practice_request,
                "summary": [],
                "quiz": [],
                "error_message": exc.user_message,
                "stale_reason": "",
                "mastery": current_practice.get("mastery", {}),
                "mastery_order": current_practice.get("mastery_order", []),
            },
        )
        raise HTTPException(status_code=500, detail=exc.user_message)

    practice = get_generation(generation_id)
    return practice_completion_view(practice.get("practice", default_practice_state()) if practice else default_practice_state())


@router.post("/api/student/{generation_id}/practice/quiz")
async def api_student_practice_quiz(request: Request, generation_id: str):
    """Generates the quiz for the active student practice round."""
    ensure_guest_user(request)
    generation = get_generation(generation_id)
    if not generation_has_student_material(generation):
        raise HTTPException(status_code=404, detail="Материал недоступен.")

    practice = normalize_practice_state(generation.get("practice", {}))
    if practice.get("status") == "completed" and isinstance(practice.get("quiz"), list) and practice.get("quiz"):
        return {"practice": practice}
    if practice.get("status") not in {"summary_ready", "failed", "processing_quiz"} or not isinstance(practice.get("summary"), list) or not practice.get("summary"):
        raise HTTPException(status_code=400, detail="Сначала нужно сгенерировать практический конспект.")

    api_key = get_ml_api_key()
    if not api_key:
        raise HTTPException(status_code=500, detail="Сервис дообучения не настроен.")

    update_practice_state(
        generation_id,
        {
            "status": "processing_quiz",
            "stage": "quiz",
            "error_message": "",
            "stale_reason": "",
        },
    )
    ml_client = MLServiceClient(api_key=api_key, base_url=ML_URL)
    try:
        practice_quiz = shuffle_quiz_options(await ml_client.make_quiz(practice["summary"]))
        update_practice_state(
            generation_id,
            {
                "status": "completed",
                "stage": "quiz",
                "summary": practice["summary"],
                "quiz": practice_quiz,
                "weak_subtopics": practice.get("weak_subtopics", []),
                "request": practice.get("request", {}),
                "error_message": "",
                "stale_reason": "",
            },
        )
    except MLServiceError as exc:
        update_practice_state(
            generation_id,
            {
                "status": "failed",
                "stage": "quiz",
                "summary": practice["summary"],
                "quiz": [],
                "weak_subtopics": practice.get("weak_subtopics", []),
                "request": practice.get("request", {}),
                "error_message": exc.user_message,
                "stale_reason": "",
            },
        )
        raise HTTPException(status_code=500, detail=exc.user_message)

    practice = get_generation(generation_id)
    return {"practice": practice.get("practice", default_practice_state()) if practice else default_practice_state()}


@router.post("/api/student/{generation_id}/practice/complete")
async def api_student_practice_complete(request: Request, generation_id: str, payload: dict[str, Any]):
    """Submits answers for a practice round, evaluates score, updates topic mastery."""
    ensure_guest_user(request)
    generation = get_generation(generation_id)
    if not generation_has_practice_quiz(generation):
        raise HTTPException(status_code=404, detail="Материал недоступен.")

    practice = normalize_practice_state(generation.get("practice", {}))
    if not isinstance(practice.get("quiz"), list) or not practice.get("quiz"):
        raise HTTPException(status_code=400, detail="Сначала нужно сгенерировать практический тест.")

    answers = payload.get("answers", []) if isinstance(payload, dict) else []
    if not isinstance(answers, list):
        raise HTTPException(status_code=400, detail="Некорректный формат ответов.")

    graded = await grade_quiz_attempt(generation, practice.get("quiz", []), answers)
    current_mastery = normalize_mastery_map(practice.get("mastery", {}))
    current_mastery = {**current_mastery}
    round_subtopics = quiz_subtopics(practice.get("quiz", []))
    round_mastery = build_mastery_from_results(graded["results"], round_subtopics)
    for item in round_mastery:
        subtopic = str(item.get("subtopic") or "").strip()
        if not subtopic:
            continue
        try:
            percent = int(item.get("percent", 0) or 0)
        except (TypeError, ValueError):
            percent = 0
        current_mastery[subtopic] = max(0, min(100, percent))

    order = practice_mastery_order(practice, round_subtopics)
    low_topics = practice_low_topics(current_mastery, order)
    pending_weak_subtopics = [str(item.get("subtopic") or "").strip() for item in low_topics if str(item.get("subtopic") or "").strip()]
    practice_completed = not pending_weak_subtopics
    practice_patch = {
        "status": "completed",
        "stage": "quiz",
        "weak_subtopics": practice.get("current_weak_subtopics", practice.get("weak_subtopics", [])),
        "current_weak_subtopics": practice.get("current_weak_subtopics", practice.get("weak_subtopics", [])),
        "pending_weak_subtopics": pending_weak_subtopics,
        "practice_round": int(practice.get("practice_round") or 0),
        "round_submitted": True,
        "practice_completed": practice_completed,
        "summary": practice.get("summary", []),
        "quiz": practice.get("quiz", []),
        "request": practice.get("request", {}),
        "mastery": current_mastery,
        "mastery_order": order,
        "error_message": "",
        "stale_reason": "",
    }
    update_practice_state(generation_id, practice_patch)
    practice = get_generation(generation_id)
    return {
        "practice": practice.get("practice", default_practice_state()) if practice else default_practice_state(),
        "results": graded["results"],
        "mastery": graded["mastery"],
        "recommendation": graded["recommendation"],
        "subtopic_to_revise": graded["subtopic_to_revise"],
        "recommendations": graded["recommendations"],
    }


@router.post("/api/student/{generation_id}/check")
async def api_student_check(request: Request, generation_id: str, payload: dict[str, Any]):
    """Grades quiz attempt, registers attempts in DB, recalculates topic mastery levels."""
    user_id = ensure_guest_user(request)
    generation = get_generation(generation_id)
    payload = payload if isinstance(payload, dict) else {}

    quiz = generation.get("quiz", []) if generation and isinstance(generation.get("quiz"), list) else []
    payload_quiz = payload.get("quiz", [])
    if (not quiz) and isinstance(payload_quiz, list) and payload_quiz:
        quiz = payload_quiz
        if generation:
            update_generation(generation_id, {"quiz": quiz})

    if not quiz:
        raise HTTPException(status_code=404, detail="Материал недоступен.")

    existing_attempt = load_student_attempt(generation_id, user_id)
    if existing_attempt:
        return existing_attempt

    quiz_subtopics_list = quiz_subtopics(quiz)
    answers = payload.get("answers", [])
    if not isinstance(answers, list):
        raise HTTPException(status_code=400, detail="Некорректный формат ответов.")

    answers_by_id = {}
    for item in answers:
        qid = str(item.get("question_id", ""))
        if qid:
            answers_by_id[qid] = item

    results = []
    open_payload = []
    open_subtopics_by_id: dict[str, str] = {}
    for idx, q in enumerate(quiz):
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
            score = 1 if ua == int(q.get("correct_answer", -999)) else 0
        results.append({"question_id": qid, "subtopic": subtopic, "score": score})

    if open_payload:
        api_key = get_ml_api_key()
        if not api_key:
            raise HTTPException(status_code=500, detail="Сервис проверки не настроен.")
        ml_client = MLServiceClient(api_key=api_key, base_url=ML_URL)
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

    attempt = save_student_attempt(generation_id, user_id, answers, results, recommendation, subtopic_to_revise, quiz=quiz)

    return {
        "results": results,
        "mastery": attempt["mastery"],
        "recommendation": recommendation,
        "subtopic_to_revise": subtopic_to_revise,
        "recommendations": recommendations,
    }
