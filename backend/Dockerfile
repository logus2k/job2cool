# job2cool-backend — HR-assistant orchestrator (alpha adapter over noted services).
FROM python:3.12-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    JOB2COOL_FRONTEND_DIR=/app/frontend

# Build context is the repo root (see docker-compose.yml) so paths are
# repo-relative and the frontend can be baked in alongside the backend.
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/*.py .
COPY frontend ./frontend

EXPOSE 4920

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "4920"]
