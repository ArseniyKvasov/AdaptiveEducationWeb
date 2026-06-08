from __future__ import annotations

import os
import sqlite3
import json
import uuid
import logging
from datetime import datetime, timezone
from pathlib import Path
from contextlib import contextmanager
from typing import Generator, Any, Optional
from fastapi import Request

from .text_repair import repair_latex_value

logger = logging.getLogger(__name__)

# Resolve base directories
BACKEND_DIR = Path(__file__).resolve().parent
BASE_DIR = BACKEND_DIR.parent
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)
UPLOAD_DIR = DATA_DIR / "queued_uploads"

def _get_db_path() -> Path:
    """Dynamically resolves the SQLite database file path, supporting test suite overrides."""
    import sys
    for mod_name in ("adaptlearning.backend.main", "Web.backend.main", "backend.main", "main"):
        main_mod = sys.modules.get(mod_name)
        if main_mod and hasattr(main_mod, "DB_PATH"):
            return main_mod.DB_PATH
    return Path(os.getenv("DB_PATH", str(DATA_DIR / "app.db")))


@contextmanager
def get_db() -> Generator[sqlite3.Connection, None, None]:
    """Provides a thread-safe connection to the SQLite database with WAL mode enabled."""
    conn = sqlite3.connect(_get_db_path())
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA foreign_keys=ON;")
    try:
        yield conn
        conn.commit()
    except Exception as exc:
        conn.rollback()
        logger.error(f"Database transaction error, rolled back: {exc}")
        raise
    finally:
        conn.close()


def db_conn() -> sqlite3.Connection:
    """Legacy compatibility helper. Returns a raw SQLite connection with WAL enabled."""
    conn = sqlite3.connect(_get_db_path())
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA foreign_keys=ON;")
    return conn


def now_iso() -> str:
    """Returns current UTC timestamp in ISO 8601 format."""
    return datetime.now(timezone.utc).isoformat()


def ensure_guest_user(request: Request) -> str:
    """Ensures guest user session and database record exist."""
    user_id = request.session.get("user_id")
    if user_id:
        return user_id

    user_id = f"guest_{uuid.uuid4().hex[:14]}"
    with get_db() as conn:
        user_cols = {row["name"] for row in conn.execute("PRAGMA table_info(users)").fetchall()}
        if "role" in user_cols:
            conn.execute("INSERT INTO users (id, role, created_at) VALUES (?, ?, ?)", (user_id, "guest", now_iso()))
        else:
            conn.execute("INSERT INTO users (id, created_at) VALUES (?, ?)", (user_id, now_iso()))
    request.session["user_id"] = user_id
    return user_id


def row_to_generation(row: sqlite3.Row) -> dict[str, Any]:
    """Converts a database Row into a structured generation dict. LaTeX sanitation is assumed done on write."""
    creator_id = row["creator_id"] if "creator_id" in row.keys() else row["user_id"]
    practice_raw = {}
    if "practice_json" in row.keys():
        try:
            practice_raw = json.loads(row["practice_json"]) if row["practice_json"] else {}
        except json.JSONDecodeError:
            practice_raw = {}
            
    transcript = repair_latex_value(json.loads(row["transcript_json"])) if row["transcript_json"] else []
    mini_summary = repair_latex_value(json.loads(row["mini_summary_json"])) if "mini_summary_json" in row.keys() and row["mini_summary_json"] else []
    summary = repair_latex_value(json.loads(row["summary_json"])) if row["summary_json"] else []
    quiz = repair_latex_value(json.loads(row["quiz_json"])) if row["quiz_json"] else []
    analytics = json.loads(row["analytics_json"]) if row["analytics_json"] else {}
    
    return {
        "id": row["id"],
        "user_id": row["user_id"],
        "creator_id": creator_id,
        "file_name": row["file_name"],
        "status": row["status"],
        "progress_percent": float(row["progress_percent"]) if "progress_percent" in row.keys() and row["progress_percent"] is not None else 0.0,
        "created_at": row["created_at"],
        "transcript": transcript,
        "mini_summary": mini_summary,
        "summary": summary,
        "quiz": quiz,
        "practice": repair_latex_value(practice_raw) if isinstance(practice_raw, dict) else {},
        "analytics": analytics,
        "error_message": row["error_message"] if "error_message" in row.keys() else "",
    }


def get_generation(generation_id: str) -> Optional[dict[str, Any]]:
    """Fetches a single generation by ID, returning a normalized dict or None."""
    with get_db() as conn:
        row = conn.execute("SELECT * FROM generations WHERE id = ?", (generation_id,)).fetchone()
    if not row:
        return None
    return row_to_generation(row)


def update_generation(generation_id: str, patch: dict[str, Any], broadcast_event_type: str = "generation_updated") -> None:
    """Updates a generation record with new fields. Sanitizes LaTeX once at write time."""
    current = get_generation(generation_id)
    if not current:
        return
    merged = {**current, **patch}
    
    # Check if practice needs invalidation
    if ("summary" in patch or "quiz" in patch) and "practice" not in patch:
        # Note: Local import helper for practice management
        from .practice_helpers import normalize_practice_state, practice_is_active, invalidate_practice_state
        current_practice = normalize_practice_state(current.get("practice", {}))
        if practice_is_active(current_practice):
            merged["practice"] = invalidate_practice_state("Практика устарела после изменения конспекта или теста.")
            
    # Sanitize LaTeX JSON escapes once on write
    merged = repair_latex_value(merged)
    
    from .practice_helpers import normalize_practice_state # fallback standard normalization
    
    with get_db() as conn:
        conn.execute(
            """
            UPDATE generations
            SET status = ?, progress_percent = ?, transcript_json = ?, mini_summary_json = ?, summary_json = ?, quiz_json = ?, practice_json = ?, analytics_json = ?, error_message = ?
            WHERE id = ?
            """,
            (
                merged["status"],
                float(merged.get("progress_percent", 0.0) or 0.0),
                json.dumps(merged.get("transcript", []), ensure_ascii=False),
                json.dumps(merged.get("mini_summary", []), ensure_ascii=False),
                json.dumps(merged.get("summary", []), ensure_ascii=False),
                json.dumps(merged.get("quiz", []), ensure_ascii=False),
                json.dumps(normalize_practice_state(merged.get("practice", {})), ensure_ascii=False),
                json.dumps(merged.get("analytics", {}), ensure_ascii=False),
                merged.get("error_message", ""),
                generation_id,
            ),
        )
        
    user_id = merged.get("creator_id") or merged.get("user_id")
    if user_id:
        try:
            import asyncio
            loop = asyncio.get_running_loop()
            payload: dict[str, Any] = {
                "type": broadcast_event_type,
                "generation_id": generation_id,
                "status": merged.get("status", ""),
            }
            if broadcast_event_type == "generation_analytics_updated":
                analytics = merged.get("analytics", {}) if isinstance(merged.get("analytics"), dict) else {}
                payload["studentsCompleted"] = analytics.get("studentsCompleted", 0)
                
            from .routes.websockets import broadcast_to_user
            loop.create_task(broadcast_to_user(user_id, payload))
        except (RuntimeError, ImportError):
            pass


def update_generation_progress(generation_id: str, progress_percent: float, broadcast_event_type: str = "generation_updated") -> None:
    """Updates only the progress percentage of a generation."""
    current = get_generation(generation_id)
    if not current:
        return
    current["progress_percent"] = float(progress_percent)
    
    with get_db() as conn:
        conn.execute(
            "UPDATE generations SET progress_percent = ? WHERE id = ?",
            (float(progress_percent), generation_id),
        )
        
    user_id = current.get("creator_id") or current.get("user_id")
    if user_id:
        try:
            import asyncio
            loop = asyncio.get_running_loop()
            payload: dict[str, Any] = {
                "type": broadcast_event_type,
                "generation_id": generation_id,
                "status": current.get("status", ""),
            }
            from .routes.websockets import broadcast_to_user
            loop.create_task(broadcast_to_user(user_id, payload))
        except (RuntimeError, ImportError):
            pass


def get_cached_transcript(content_hash: str) -> Optional[list[dict[str, Any]]]:
    """Fetches a cached transcript by its content hash."""
    with get_db() as conn:
        row = conn.execute(
            "SELECT transcript_json FROM transcript_cache WHERE content_hash = ?",
            (content_hash,),
        ).fetchone()
    if row and row["transcript_json"]:
        try:
            return json.loads(row["transcript_json"])
        except Exception:
            pass
    return None


def store_cached_transcript(content_hash: str, transcript: list[dict[str, Any]]) -> None:
    """Stores a transcript in cache, running LaTeX repair first."""
    repaired_transcript = repair_latex_value(transcript)
    with get_db() as conn:
        conn.execute(
            """
            INSERT OR REPLACE INTO transcript_cache (content_hash, transcript_json, created_at)
            VALUES (?, ?, ?)
            """,
            (content_hash, json.dumps(repaired_transcript, ensure_ascii=False), now_iso()),
        )


def init_db() -> None:
    """Runs standard schema initializations and migrations."""
    logger.info(f"Initializing database at: {_get_db_path()}")
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    with get_db() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
              id TEXT PRIMARY KEY,
              created_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS generations (
              id TEXT PRIMARY KEY,
              user_id TEXT NOT NULL,
              creator_id TEXT NOT NULL DEFAULT '',
              file_name TEXT NOT NULL,
              status TEXT NOT NULL,
              progress_percent REAL NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL,
              transcript_json TEXT NOT NULL,
              mini_summary_json TEXT NOT NULL,
              summary_json TEXT NOT NULL,
              quiz_json TEXT NOT NULL,
              practice_json TEXT NOT NULL,
              analytics_json TEXT NOT NULL,
              error_message TEXT NOT NULL DEFAULT '',
              FOREIGN KEY (user_id) REFERENCES users(id)
            )
            """
        )
        # Migrate columns for generations table
        cols = [r[1] for r in conn.execute("PRAGMA table_info(generations)").fetchall()]
        if "creator_id" not in cols:
            conn.execute("ALTER TABLE generations ADD COLUMN creator_id TEXT NOT NULL DEFAULT ''")
            conn.execute(
                """
                UPDATE generations
                SET creator_id = CASE
                    WHEN creator_id IS NULL OR trim(creator_id) = '' THEN user_id
                    ELSE creator_id
                END
                WHERE creator_id IS NULL OR trim(creator_id) = ''
                """
            )
        if "error_message" not in cols:
            conn.execute("ALTER TABLE generations ADD COLUMN error_message TEXT NOT NULL DEFAULT ''")
        if "progress_percent" not in cols:
            conn.execute("ALTER TABLE generations ADD COLUMN progress_percent REAL NOT NULL DEFAULT 0")
        if "mini_summary_json" not in cols:
            conn.execute("ALTER TABLE generations ADD COLUMN mini_summary_json TEXT NOT NULL DEFAULT '[]'")
        if "practice_json" not in cols:
            conn.execute("ALTER TABLE generations ADD COLUMN practice_json TEXT NOT NULL DEFAULT '{}'")

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS transcript_cache (
              content_hash TEXT PRIMARY KEY,
              transcript_json TEXT NOT NULL,
              created_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS student_attempts (
              id TEXT PRIMARY KEY,
              generation_id TEXT NOT NULL,
              user_id TEXT NOT NULL,
              created_at TEXT NOT NULL,
              answers_json TEXT NOT NULL,
              results_json TEXT NOT NULL,
              mastery_json TEXT NOT NULL,
              recommendation TEXT NOT NULL,
              subtopic_to_revise TEXT NOT NULL,
              FOREIGN KEY (generation_id) REFERENCES generations(id),
              FOREIGN KEY (user_id) REFERENCES users(id)
            )
            """
        )
        # Migrate columns for student_attempts table
        cols_sa = [r[1] for r in conn.execute("PRAGMA table_info(student_attempts)").fetchall()]
        if "user_id" not in cols_sa:
            conn.execute("ALTER TABLE student_attempts ADD COLUMN user_id TEXT NOT NULL DEFAULT ''")
        conn.execute(
            """
            UPDATE student_attempts
            SET user_id = CASE
                WHEN user_id IS NULL OR trim(user_id) = '' THEN 'legacy_' || id
                ELSE user_id
            END
            WHERE user_id IS NULL OR trim(user_id) = ''
            """
        )

        cleanup_student_attempt_duplicates(conn)
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_student_attempts_generation_user ON student_attempts(generation_id, user_id)")
        logger.info("Database schema initialized and migrated successfully.")


def cleanup_student_attempt_duplicates(conn: sqlite3.Connection) -> None:
    """Remove duplicate student attempts keeping only the latest attempt."""
    cursor = conn.execute(
        """
        SELECT generation_id, user_id, COUNT(*) as cnt
        FROM student_attempts
        GROUP BY generation_id, user_id
        HAVING cnt > 1
        """
    )
    duplicates = cursor.fetchall()
    for row in duplicates:
        gen_id = row["generation_id"]
        u_id = row["user_id"]
        # Find all attempts for this group sorted by created_at desc
        sub_cursor = conn.execute(
            """
            SELECT id FROM student_attempts
            WHERE generation_id = ? AND user_id = ?
            ORDER BY created_at DESC
            """,
            (gen_id, u_id),
        )
        ids = [r["id"] for r in sub_cursor.fetchall()]
        if len(ids) > 1:
            # Delete all but the latest
            to_delete = ids[1:]
            logger.info(f"Removing duplicate student attempt records {to_delete} for gen={gen_id}, user={u_id}")
            conn.executemany("DELETE FROM student_attempts WHERE id = ?", [(i,) for i in to_delete])
