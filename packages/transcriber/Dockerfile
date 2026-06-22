# Self-contained Whisper transcription tool. CPU by default (int8); on a GPU host
# set WHISPER_DEVICE=cuda + WHISPER_COMPUTE_TYPE=float16 for a large speedup.
FROM python:3.11-slim

WORKDIR /app

# PyAV bundles ffmpeg libs for decoding, but the corrupt-packet recovery fallback
# shells out to the ffmpeg CLI (-fflags +discardcorrupt) to re-decode files that a
# few bad Opus packets would otherwise make faster-whisper bail on. So install it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# faster-whisper pulls ctranslate2 + av.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY transcribe.py transcribe_one.py worker.py ./

ENV RECORDINGS_DIR=/recordings \
    WHISPER_MODEL=large-v3 \
    WHISPER_DEVICE=cpu \
    WHISPER_COMPUTE_TYPE=int8 \
    WHISPER_LANGUAGE=ru \
    WHISPER_DOWNLOAD_ROOT=/models \
    HF_HOME=/models

ENTRYPOINT ["python", "transcribe.py"]
