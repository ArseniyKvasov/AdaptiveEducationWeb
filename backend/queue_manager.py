from __future__ import annotations

import os
import json
import logging
import asyncio
from pathlib import Path
from typing import Any, Optional

from .database import get_db, update_generation, UPLOAD_DIR

logger = logging.getLogger(__name__)

# Queue configuration limits
MAX_CONCURRENT_GENERATIONS = int(os.getenv("MAX_CONCURRENT_GENERATIONS", "3"))
MAX_QUEUE_SIZE = int(os.getenv("MAX_QUEUE_SIZE", "10"))

RUNNING_TASKS: dict[str, asyncio.Task] = {}
SEMAPHORE: Optional[asyncio.Semaphore] = None


def get_semaphore() -> asyncio.Semaphore:
    """Lazily initializes the concurrency control semaphore."""
    global SEMAPHORE
    if SEMAPHORE is None:
        SEMAPHORE = asyncio.Semaphore(MAX_CONCURRENT_GENERATIONS)
    return SEMAPHORE


def cleanup_queued_file(generation_id: str) -> None:
    """Removes temporary raw upload files once processing starts or completes."""
    file_path = UPLOAD_DIR / generation_id
    if file_path.exists():
        try:
            file_path.unlink()
            logger.info(f"Cleaned up queued raw file: {file_path}")
        except Exception as e:
            logger.error(f"Failed to delete queued file {file_path}: {e}")


async def notify_queue_updates() -> None:
    """Broadcasts positions to all currently queued users via WebSocket."""
    with get_db() as conn:
        rows = conn.execute("SELECT id, creator_id, user_id FROM generations WHERE status = 'queued' ORDER BY created_at ASC").fetchall()
    
    queued_positions = {row["id"]: idx + 1 for idx, row in enumerate(rows)}
    for row in rows:
        gen_id = row["id"]
        user_id = row["creator_id"] or row["user_id"]
        if user_id:
            try:
                loop = asyncio.get_running_loop()
                payload = {
                    "type": "generation_updated",
                    "generation_id": gen_id,
                    "status": "queued",
                    "queue_position": queued_positions.get(gen_id),
                }
                from .routes.websockets import broadcast_to_user
                loop.create_task(broadcast_to_user(user_id, payload))
            except (RuntimeError, ImportError):
                pass


async def queued_task_wrapper(generation_id: str, task_type: str, **kwargs) -> None:
    """Executes a pipeline job under the semaphore lock, updating database states and queue updates."""
    sem = get_semaphore()
    RUNNING_TASKS[generation_id] = asyncio.current_task()
    
    try:
        async with sem:
            # Check if generation still exists in DB
            with get_db() as conn:
                row = conn.execute("SELECT status FROM generations WHERE id = ?", (generation_id,)).fetchone()
            if not row:
                return
            
            # Transition status to processing
            update_generation(generation_id, {"status": "processing"})
            await notify_queue_updates()
            
            # Import pipeline functions locally to prevent circular dependencies
            from .pipeline import run_generation_pipeline, finalize_generation_from_transcript, run_ml_retry_pipeline
            
            if task_type == "full_pipeline":
                file_path = UPLOAD_DIR / generation_id
                if not file_path.exists():
                    update_generation(generation_id, {"status": "failed", "error_message": "Файл не найден на сервере."})
                    return
                try:
                    file_bytes = file_path.read_bytes()
                except Exception as e:
                    update_generation(generation_id, {"status": "failed", "error_message": f"Не удалось прочитать файл: {e}"})
                    return
                
                await run_generation_pipeline(
                    generation_id=generation_id,
                    file_bytes=file_bytes,
                    file_name=kwargs.get("file_name"),
                    content_type=kwargs.get("content_type"),
                    content_hash=kwargs.get("content_hash"),
                )
            elif task_type == "finalize_transcript":
                await finalize_generation_from_transcript(
                    generation_id=generation_id,
                    transcript=kwargs.get("cached_transcript"),
                )
            elif task_type == "ml_retry":
                await run_ml_retry_pipeline(generation_id=generation_id)
                
    except asyncio.CancelledError:
        cleanup_queued_file(generation_id)
        try:
            with get_db() as conn:
                row = conn.execute("SELECT status FROM generations WHERE id = ?").fetchone()
            if row:
                update_generation(generation_id, {"status": "failed", "error_message": "Обработка отменена."})
        except Exception:
            pass
        raise
    except Exception as e:
        # Import local utility helper for formatting user message if needed
        from .pipeline import make_user_error_message
        update_generation(generation_id, {"status": "failed", "error_message": make_user_error_message(e)})
        logger.error(f"Error in queued task {generation_id}: {e}", exc_info=True)
    finally:
        RUNNING_TASKS.pop(generation_id, None)
        cleanup_queued_file(generation_id)
        await notify_queue_updates()


async def resume_queued_tasks() -> None:
    """Scans SQLite database for incomplete processing/queued generations to resume on server boot."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, status, file_name, transcript_json FROM generations WHERE status IN ('processing', 'queued') ORDER BY created_at ASC"
        ).fetchall()

    for row in rows:
        gen_id = row["id"]
        file_name = row["file_name"]

        # Parse transcript if any
        transcript = []
        try:
            transcript = json.loads(row["transcript_json"]) if row["transcript_json"] else []
        except Exception:
            pass

        file_path = UPLOAD_DIR / gen_id
        if transcript:
            update_generation(gen_id, {"status": "queued", "progress_percent": 0})
            task = asyncio.create_task(
                queued_task_wrapper(
                    gen_id,
                    task_type="finalize_transcript",
                    cached_transcript=transcript,
                )
            )
            RUNNING_TASKS[gen_id] = task
        elif file_path.exists():
            update_generation(gen_id, {"status": "queued", "progress_percent": 0})
            task = asyncio.create_task(
                queued_task_wrapper(
                    gen_id,
                    task_type="full_pipeline",
                    file_name=file_name,
                    content_type="audio/wav",
                )
            )
            RUNNING_TASKS[gen_id] = task
        else:
            update_generation(
                gen_id,
                {
                    "status": "failed",
                    "error_message": "Файл утерян после перезапуска сервера. Пожалуйста, загрузите заново.",
                },
            )

    await notify_queue_updates()
