FROM python:3.12.11-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    SWITCHYARD_HOST=0.0.0.0 \
    SWITCHYARD_PORT=8000 \
    SWITCHYARD_DATABASE_URL=sqlite:////data/switchyard.db

WORKDIR /app
COPY backend/requirements.txt /app/requirements.txt
RUN python -m pip install --no-cache-dir -r /app/requirements.txt \
    && addgroup --system --gid 10001 switchyard \
    && adduser --system --uid 10001 --ingroup switchyard switchyard \
    && mkdir -p /data \
    && chown switchyard:switchyard /data

COPY --chown=switchyard:switchyard backend/app /app/app
USER switchyard

EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=2).read()"]
CMD ["python", "-m", "app"]
