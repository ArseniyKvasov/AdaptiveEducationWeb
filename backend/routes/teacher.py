from __future__ import annotations

import uuid
import hashlib
import json
import logging
from typing import Any, Optional
from fastapi import APIRouter, Request, HTTPException, BackgroundTasks, UploadFile, File, Response
from fastapi.responses import JSONResponse

from ..database import (
    get_db,
    get_generation,
    update_generation,
    ensure_guest_user,
    row_to_generation,
    get_cached_transcript,
    now_iso,
    UPLOAD_DIR,
)
from ..audio_processor import sanitize_uploaded_filename
from ..queue_manager import (
    RUNNING_TASKS,
    MAX_QUEUE_SIZE,
    queued_task_wrapper,
    notify_queue_updates,
    cleanup_queued_file,
)
from ..xlsx_exporter import (
    build_xlsx_bytes,
    build_speech_analysis_export_worksheets_precise,
    build_speech_analysis_export_worksheets_from_payload,
)

logger = logging.getLogger(__name__)

router = APIRouter()


def content_hash_for_bytes(file_bytes: bytes) -> str:
    """Calculates SHA-256 hex digest of file contents for transcript caching."""
    return hashlib.sha256(file_bytes).hexdigest()


def get_queued_positions() -> dict[str, int]:
    """Retrieves queue position index dictionary from the database."""
    with get_db() as conn:
        rows = conn.execute("SELECT id FROM generations WHERE status = 'queued' ORDER BY created_at ASC").fetchall()
    return {row["id"]: idx + 1 for idx, row in enumerate(rows)}


@router.get("/api/me")
async def api_me(request: Request):
    """Returns guest or active session user identifier details."""
    user_id = ensure_guest_user(request)
    return {"user_id": user_id}


@router.get("/api/generations")
async def api_generations(request: Request):
    """Retrieves the list of most recent generations belonging to the user."""
    user_id = ensure_guest_user(request)
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM generations WHERE COALESCE(creator_id, user_id) = ? ORDER BY created_at DESC LIMIT 20",
            (user_id,),
        ).fetchall()
    queued_positions = get_queued_positions()
    items = []
    for r in rows:
        gen = row_to_generation(r)
        if gen["status"] == "queued":
            gen["queue_position"] = queued_positions.get(gen["id"])
        items.append(gen)
    return {"items": items}


@router.post("/api/generations/upload")
async def api_generations_upload(request: Request, background_tasks: BackgroundTasks, file: UploadFile = File(...)):
    """Receives and checks files, registers queue records, triggers background transcription pipelines."""
    user_id = ensure_guest_user(request)
    logger.info(f"api_generations_upload: filename={file.filename}, content_type={file.content_type}")
    try:
        file_bytes = await file.read()
        if not file_bytes:
            raise HTTPException(status_code=400, detail="Empty file")
        if len(file_bytes) > 200 * 1024 * 1024:
            raise HTTPException(status_code=400, detail="File too large")
        safe_file_name = sanitize_uploaded_filename(file.filename or "media")

        with get_db() as conn:
            queued_count = conn.execute("SELECT COUNT(*) FROM generations WHERE status = 'queued'").fetchone()[0]
            if queued_count >= MAX_QUEUE_SIZE:
                raise HTTPException(status_code=429, detail="Очередь переполнена. Пожалуйста, попробуйте позже.")

            generation_id = f"gen_{uuid.uuid4().hex[:14]}"
            conn.execute(
                """
                INSERT INTO generations
                (id, user_id, creator_id, file_name, status, created_at, transcript_json, mini_summary_json, summary_json, quiz_json, practice_json, analytics_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (generation_id, user_id, user_id, safe_file_name, "queued", now_iso(), "[]", "[]", "[]", "[]", "{}", "{}"),
            )

        content_hash = content_hash_for_bytes(file_bytes)
        cached_transcript = get_cached_transcript(content_hash)
        if cached_transcript:
            with get_db() as conn:
                conn.execute(
                    "UPDATE generations SET transcript_json = ? WHERE id = ?",
                    (json.dumps(cached_transcript, ensure_ascii=False), generation_id),
                )
            background_tasks.add_task(
                queued_task_wrapper,
                generation_id,
                task_type="finalize_transcript",
                cached_transcript=cached_transcript,
            )
        else:
            file_path = UPLOAD_DIR / generation_id
            file_path.write_bytes(file_bytes)
            background_tasks.add_task(
                queued_task_wrapper,
                generation_id,
                task_type="full_pipeline",
                file_name=safe_file_name,
                content_type=file.content_type,
                content_hash=content_hash,
            )
        await notify_queue_updates()
        return JSONResponse(status_code=201, content={"id": generation_id, "content_hash": content_hash, "cache_hit": bool(cached_transcript)})
    finally:
        await file.close()


@router.post("/api/generations/{generation_id}/retry")
async def api_generation_retry(request: Request, background_tasks: BackgroundTasks, generation_id: str):
    """Restarts generation flow from saved transcript if downstream task calls failed."""
    user_id = ensure_guest_user(request)
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM generations WHERE id = ? AND COALESCE(creator_id, user_id) = ?",
            (generation_id, user_id),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Not found")

        queued_count = conn.execute("SELECT COUNT(*) FROM generations WHERE status = 'queued'").fetchone()[0]
        if queued_count >= MAX_QUEUE_SIZE:
            raise HTTPException(status_code=429, detail="Очередь переполнена. Пожалуйста, попробуйте позже.")

    generation = row_to_generation(row)
    if generation.get("status") in {"processing", "queued"}:
        raise HTTPException(status_code=409, detail="Генерация уже выполняется или находится в очереди.")
    if not generation.get("transcript"):
        raise HTTPException(status_code=400, detail="Нет сохраненного транскрипта для повторной генерации.")

    update_generation(
        generation_id,
        {
            "status": "queued",
            "progress_percent": 0,
            "error_message": "",
        },
    )
    background_tasks.add_task(queued_task_wrapper, generation_id, task_type="ml_retry")
    await notify_queue_updates()
    return {"ok": True, "queued": True}


@router.get("/api/generations/{generation_id}/speech-analysis.xlsx")
async def api_generation_speech_analysis_export(request: Request, generation_id: str):
    """Generates and serves Excel report worksheets containing teacher speech review details."""
    user_id = ensure_guest_user(request)
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM generations WHERE id = ? AND COALESCE(creator_id, user_id) = ?",
            (generation_id, user_id),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Not found")

    generation = row_to_generation(row)
    worksheets = build_speech_analysis_export_worksheets_precise(generation)
    if not worksheets:
        raise HTTPException(status_code=404, detail="Speech analysis unavailable")

    xlsx_bytes = build_xlsx_bytes(worksheets)
    file_name = f"speech_analysis_{generation_id[:12]}.xlsx"
    return Response(
        content=xlsx_bytes,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{file_name}"'},
    )


@router.post("/api/generations/{generation_id}/speech-analysis.xlsx")
async def api_generation_speech_analysis_export_from_payload(request: Request, generation_id: str):
    """Generates Excel worksheets using current browser edited speech analysis payload."""
    user_id = ensure_guest_user(request)
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM generations WHERE id = ? AND COALESCE(creator_id, user_id) = ?",
            (generation_id, user_id),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Not found")

    try:
        payload = await request.json()
    except Exception:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}

    worksheets = build_speech_analysis_export_worksheets_from_payload(payload)
    if not worksheets:
        generation = row_to_generation(row)
        worksheets = build_speech_analysis_export_worksheets_precise(generation)
    if not worksheets:
        raise HTTPException(status_code=404, detail="Speech analysis unavailable")

    xlsx_bytes = build_xlsx_bytes(worksheets)
    file_name = f"speech_analysis_{generation_id[:12]}.xlsx"
    return Response(
        content=xlsx_bytes,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{file_name}"'},
    )


@router.get("/api/generations/{generation_id}")
async def api_generation_get(request: Request, generation_id: str):
    """Fetches full structured summary, quiz, and processing stats for a generation."""
    user_id = ensure_guest_user(request)
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM generations WHERE id = ? AND COALESCE(creator_id, user_id) = ?",
            (generation_id, user_id),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Not found")
    gen = row_to_generation(row)
    if gen["status"] == "queued":
        queued_positions = get_queued_positions()
        gen["queue_position"] = queued_positions.get(generation_id)
    return gen


@router.delete("/api/generations/{generation_id}")
async def api_generation_delete(request: Request, generation_id: str):
    """Terminates execution thread, unlinks file, removes generation from user database history."""
    user_id = ensure_guest_user(request)
    # Cancel the running task if it exists in queue
    task = RUNNING_TASKS.get(generation_id)
    if task:
        task.cancel()

    with get_db() as conn:
        conn.execute(
            "DELETE FROM generations WHERE id = ? AND COALESCE(creator_id, user_id) = ?",
            (generation_id, user_id),
        )

    cleanup_queued_file(generation_id)
    return {"ok": True}


@router.patch("/api/generations/{generation_id}")
async def api_generation_patch(request: Request, generation_id: str, payload: dict[str, Any]):
    """Saves custom teacher summary, quiz edits, or aggregate rating changes."""
    user_id = ensure_guest_user(request)
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM generations WHERE id = ? AND COALESCE(creator_id, user_id) = ?",
            (generation_id, user_id),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Not found")

    current = row_to_generation(row)
    if isinstance(payload.get("summary"), list):
        current["summary"] = payload["summary"]
    if isinstance(payload.get("quiz"), list):
        current["quiz"] = payload["quiz"]
    if isinstance(payload.get("analytics"), dict):
        current["analytics"] = payload["analytics"]
    update_generation(generation_id, current)
    return {"ok": True}
