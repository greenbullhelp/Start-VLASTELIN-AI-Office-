FROM python:3.12-slim

ARG WITH_WHISPER=1
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=1 DATA_DIR=/data

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates tzdata \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt \
    && if [ "$WITH_WHISPER" = "1" ]; then pip install faster-whisper==1.2.1; fi

COPY app ./app
COPY static ./static

# той самий користувач, що й у Hermes (10000) — спільна робоча папка без проблем із правами
RUN useradd -u 10000 -m jarvis && mkdir -p /data && chown -R jarvis /data
USER jarvis

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8000/health')"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
