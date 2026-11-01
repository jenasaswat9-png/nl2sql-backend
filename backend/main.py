"""
backend/main.py

FastAPI layer for the Text-to-SQL multi-agent system.

    POST /upload   multipart SQLite file  -> {"db_path": ...}
    POST /query    {"question", "db_path"} -> rows + SQL + retry count
    GET  /health   liveness probe (handy for Render)

Run from the project root:
    uvicorn backend.main:app --reload
"""

from __future__ import annotations

import logging
import math
import os
import shutil
import time
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field

from backend.agents import run_pipeline
from backend.database import (
    DEFAULT_DB_PATH,
    MAX_UPLOAD_BYTES,
    UPLOAD_ROOT,
    save_uploaded_file,
)

logger = logging.getLogger("text2sql.api")

UPLOAD_TTL_SECONDS = 60 * 60  # uploads older than this are purged (ephemeral BYOD)

app = FastAPI(title="Text-to-SQL Multi-Agent API", version="1.0.0")

# Allow every origin so any frontend (Vercel, localhost, file://) can connect.
# Credentials stay off: browsers reject "*" combined with credentials, and this
# API uses no cookies.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --------------------------------------------------------------------------- #
# Schemas
# --------------------------------------------------------------------------- #

class QueryRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    question: str = Field(..., min_length=1, max_length=1000)
    db_path: Optional[str] = None  # omit to use the default northwind.db


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #

def _purge_stale_uploads() -> None:
    """Delete upload folders older than UPLOAD_TTL_SECONDS (keeps disk bounded)."""
    if not UPLOAD_ROOT.is_dir():
        return
    cutoff = time.time() - UPLOAD_TTL_SECONDS
    for folder in UPLOAD_ROOT.iterdir():
        try:
            if folder.is_dir() and folder.stat().st_mtime < cutoff:
                shutil.rmtree(folder, ignore_errors=True)
        except OSError:
            continue


def _resolve_db_path(db_path: Optional[str]) -> str:
    """
    The client sends db_path back to us, so it must never be trusted: only the
    default database or a file inside the upload directory is accepted. This
    stops callers from pointing the pipeline at arbitrary files on the server.
    """
    if not db_path:
        return str(DEFAULT_DB_PATH)

    candidate = Path(db_path).resolve()
    allowed = candidate == DEFAULT_DB_PATH.resolve() or (
        UPLOAD_ROOT.resolve() in candidate.parents
    )
    if not allowed:
        raise HTTPException(
            status_code=400,
            detail="Invalid db_path. Use the path returned by /upload.",
        )
    if not candidate.is_file():
        raise HTTPException(
            status_code=404,
            detail="Database not found. Uploads expire after an hour - please upload again.",
        )
    return str(candidate)


def _json_safe(value: Any) -> Any:
    """Make one cell JSON-serialisable (BLOBs and inf/NaN would break encoding)."""
    if isinstance(value, (bytes, bytearray, memoryview)):
        return f"<BLOB {len(value)} bytes>"
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


# --------------------------------------------------------------------------- #
# Endpoints
# --------------------------------------------------------------------------- #

@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/upload")
async def upload_database(file: UploadFile = File(...)) -> dict:
    """Save an uploaded SQLite file to a temp directory and return its path."""
    # Read at most one byte past the limit so a huge upload is never fully buffered.
    data = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File too large. Limit is {MAX_UPLOAD_BYTES // (1024 * 1024)} MB.",
        )

    await run_in_threadpool(_purge_stale_uploads)

    filename = file.filename or "upload.db"
    try:
        db_path = await run_in_threadpool(save_uploaded_file, data, filename)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return {"db_path": db_path, "filename": filename}


@app.post("/query")
def run_query(payload: QueryRequest) -> dict:
    """
    Run the LangGraph workflow (profiler -> generator -> executor <-> critic).

    Declared as a plain `def` so FastAPI executes it in a worker thread; the
    graph and the Groq call are blocking.
    """
    if not os.getenv("GROQ_API_KEY"):
        raise HTTPException(
            status_code=503, detail="GROQ_API_KEY is not configured on the server."
        )

    db_path = _resolve_db_path(payload.db_path)

    try:
        result = run_pipeline(payload.question, db_path)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:  # LLM/network/etc. - log details, hide internals
        logger.exception("Pipeline failed")
        raise HTTPException(
            status_code=500,
            detail="The query pipeline failed unexpectedly. Check the server logs.",
        ) from exc

    # data_result is the DataFrame already serialised to a list of row dicts.
    rows = [
        {column: _json_safe(value) for column, value in row.items()}
        for row in (result["data_result"] or [])
    ]
    error = result["error_msg"] or None

    return {
        "success": error is None,
        "sql_query": result["sql_query"],
        "data": rows,
        "columns": list(rows[0].keys()) if rows else [],
        "row_count": len(rows),
        "retries": result["retries"],
        "error": error,
        "chart_config": result.get("chart_config")
    }