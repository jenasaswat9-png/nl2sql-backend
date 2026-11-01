FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Dependencies first, so this layer is cached until requirements.txt changes.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Run as an unprivileged user. /app must be writable for security_audit.log.
RUN useradd --create-home --uid 1000 appuser && chown appuser:appuser /app

# The code imports its siblings as `backend.database` / `backend.agents`, so the
# source lives in /app/backend. PYTHONPATH makes both `backend.*` (via /app) and
# the top-level `main:app` entrypoint (via /app/backend) importable.
COPY --chown=appuser:appuser . ./backend/
ENV PYTHONPATH=/app:/app/backend

USER appuser

EXPOSE 7860
ENTRYPOINT ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "7860"]