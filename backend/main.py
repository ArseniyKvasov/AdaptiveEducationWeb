from __future__ import annotations

import os
import logging
import asyncio
from pathlib import Path
from dotenv import load_dotenv

# Resolve base directories and load environment variables before importing other local modules
BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")

# Expose fields for test/legacy compatibility
DATA_DIR = BASE_DIR / "data"
DB_PATH = Path(os.getenv("DB_PATH", str(DATA_DIR / "app.db")))

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware
from contextlib import asynccontextmanager

from .database import init_db, now_iso, get_generation
from .ml_service import MLServiceClient, _mask_key
ML_API_KEY = os.getenv("ML_API_KEY", "")
ML_URL = os.getenv("ML_URL", "https://ml.fastclass.ru")

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger(__name__)
logger.info(f"Startup: ML_URL={ML_URL} ML_API_KEY={_mask_key(ML_API_KEY)}")

# Lazy initialization of DB and resumption of tasks via Lifespan
@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    if not os.getenv("PYTEST_CURRENT_TEST"):
        from .queue_manager import resume_queued_tasks
        asyncio.create_task(resume_queued_tasks())
    yield

app = FastAPI(lifespan=lifespan)

# Session middleware configuration
app.add_middleware(
    SessionMiddleware,
    secret_key=os.getenv("SESSION_SECRET", "dev-secret-change-me"),
    same_site="lax",
    https_only=False,
    max_age=60 * 60 * 24 * 30
)

# Import and register sub-routers
from .routes import teacher, student, websockets
app.include_router(teacher.router)
app.include_router(student.router)
app.include_router(websockets.router)

# Define base paths
PUBLIC_DIR = BASE_DIR / "public"

# Minimal frontend and page routes
@app.get("/")
async def root_redirect():
    return FileResponse(PUBLIC_DIR / "teacher" / "index.html")


@app.get("/teacher/")
@app.get("/teacher/index.html")
async def teacher_redirect():
    return RedirectResponse(url="/")


@app.get("/student/index.html")
async def legacy_student_redirect(request: Request):
    generation_id = request.query_params.get("generation_id", "").strip()
    if generation_id:
        return RedirectResponse(url=f"/material/{generation_id}/")
    return FileResponse(PUBLIC_DIR / "student" / "index.html")


@app.get("/material/{generation_id}")
async def material_redirect(generation_id: str):
    return FileResponse(PUBLIC_DIR / "student" / "index.html")


@app.get("/material/{generation_id}/")
async def material_page(generation_id: str):
    return FileResponse(PUBLIC_DIR / "student" / "index.html")

# Serve remaining static frontend assets
app.mount("/", StaticFiles(directory=str(PUBLIC_DIR), html=True), name="static")
