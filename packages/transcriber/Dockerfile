# Self-contained Whisper transcription tool. CPU by default (int8); on a GPU host
# set WHISPER_DEVICE=cuda + WHISPER_COMPUTE_TYPE=float16 for a large speedup.
FROM python:3.11-slim

WORKDIR /app

# faster-whisper pulls ctranslate2 + av (PyAV bundles its own ffmpeg libs, so no
# system ffmpeg is needed to decode .ogg/opus).
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY transcribe.py .

ENV RECORDINGS_DIR=/recordings \
    WHISPER_MODEL=large-v3 \
    WHISPER_DEVICE=cpu \
    WHISPER_COMPUTE_TYPE=int8 \
    WHISPER_LANGUAGE=ru \
    WHISPER_DOWNLOAD_ROOT=/models \
    HF_HOME=/models

ENTRYPOINT ["python", "transcribe.py"]
