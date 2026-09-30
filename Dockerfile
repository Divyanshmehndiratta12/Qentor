# Qentor: one process serves the React build and the API (docs/ARCHITECTURE.md). Two stages: build the web app, then run the backend.

FROM node:22-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
COPY fixtures /fixtures
RUN npm run build

FROM python:3.12-slim AS app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt
COPY backend/qentor backend/qentor
COPY --from=web /web/dist web/dist

# The provenance database must live on a writable path; mount a volume at /data to keep it across restarts.
ENV QENTOR_DB_PATH=/data/qentor.db
RUN useradd --system --create-home qentor && mkdir -p /data && chown qentor /data
USER qentor
VOLUME ["/data"]

# Never bake a key into the image: QENTOR_TUTOR_LLM_ENABLED / QENTOR_TUTOR_LLM_API_KEY are optional and set on the host only.
ENV PORT=8000
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request,os; urllib.request.urlopen('http://127.0.0.1:%s/api/health' % os.environ.get('PORT','8000'))"
CMD ["sh", "-c", "exec python -m uvicorn qentor.api.app:app --app-dir backend --host 0.0.0.0 --port ${PORT}"]
