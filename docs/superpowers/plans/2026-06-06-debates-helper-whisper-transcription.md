# Whisper Transcription (Local, Russian) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A local, Dockerized Whisper service that transcribes a completed recording session's per-speaker `.ogg` files in Russian and merges them — via the burst `segments` timeline — into one wall-clock-ordered, speaker-attributed transcript written next to the audio.

**Architecture:** A self-contained Python container (`faster-whisper`, CTranslate2) reads a session directory off the shared recordings volume, transcribes each speaker file (`large-v3`, `int8`, `language=ru`), maps each Whisper segment's file-relative time to wall-clock using that file's `segments` anchors (`wall_ms + (t − audio_offset_ms)` for the burst containing `t`), sorts all speakers' segments by wall-clock, and writes `_transcript.json` (structured) + `_transcript.txt` (human-readable). No DB/API dependency — `_metadata.json` is self-contained. Manual per-session trigger now (`docker compose run --rm transcriber <session-dir>`); queue auto-trigger is a later step.

**Tech Stack:** Python 3.11, faster-whisper (CTranslate2), Docker, docker-compose. Model/device/compute/language are env vars (`WHISPER_MODEL=large-v3`, `WHISPER_DEVICE=cpu`, `WHISPER_COMPUTE_TYPE=int8`, `WHISPER_LANGUAGE=ru`) so a GPU host can swap `device=cuda` for full speed.

---

## File Structure

- Create: `packages/transcriber/transcribe.py` — the transcription + merge script (entrypoint).
- Create: `packages/transcriber/requirements.txt` — pinned `faster-whisper`.
- Create: `packages/transcriber/Dockerfile` — `python:3.11-slim` + deps + script.
- Create: `packages/transcriber/README.md` — usage.
- Modify: `docker-compose.yml` — add `transcriber` service (profile `tools`) + `whisper-models` volume.

### Local vs production recordings source

The transcriber mounts `${RECORDINGS_SOURCE:-recordings}:/recordings`:
- **Production** (api/bot in Docker): default `recordings` named volume — same files the bot wrote.
- **Local dev** (api/bot native, files in host `/tmp/debates-recordings`): run with `RECORDINGS_SOURCE=/tmp/debates-recordings` so Compose bind-mounts the host dir.

The `large-v3` model (~3 GB) downloads once into the `whisper-models` named volume and is reused.

---

## Merge algorithm (the core)

Each speaker file is *compacted* (silence dropped), so a Whisper segment's `start`/`end` are on the talk-time axis — the same axis as `audio_offset_ms`. The bursts are contiguous in audio, so they form a piecewise-linear map talk-time → wall-clock:

```
wall_for(audio_ms):
  pick the last burst b with b.audio_offset_ms <= audio_ms
  return b.wall_ms + (audio_ms - b.audio_offset_ms)
```

For each Whisper segment: `wall_ms = wall_for(seg.start*1000)`, `wall_end_ms = wall_for(seg.end*1000)`. Collect across all files, sort by `wall_ms`.

---

## Task 1: Transcription script

**Files:** Create `packages/transcriber/transcribe.py`

- [ ] **Step 1: Write `transcribe.py`** (full content in the repo). Reads `RECORDINGS_DIR`, resolves the session dir from argv, loads `_metadata.json`, builds the model once, transcribes each file with `language=ru, vad_filter=True, beam_size=5`, maps via `wall_for`, writes `_transcript.json` (`ensure_ascii=False`) + `_transcript.txt` (UTF-8).

- [ ] **Step 2: requirements.txt** — `faster-whisper==1.0.3`.

- [ ] **Step 3: Dockerfile** — `python:3.11-slim`, `pip install -r requirements.txt`, copy script, `ENTRYPOINT ["python","transcribe.py"]`, env defaults (`RECORDINGS_DIR=/recordings`, `WHISPER_DOWNLOAD_ROOT=/models`, `HF_HOME=/models`).

## Task 2: docker-compose integration

**Files:** Modify `docker-compose.yml`

- [ ] Add `transcriber` service (build `packages/transcriber`, `profiles: ["tools"]`, the env vars above, volumes `${RECORDINGS_SOURCE:-recordings}:/recordings` + `whisper-models:/models`).
- [ ] Add `whisper-models:` to top-level `volumes:`.

## Task 3: Build, benchmark, validate (Russian)

- [ ] `docker compose build transcriber`.
- [ ] Run on the real session and time it:
      `RECORDINGS_SOURCE=/tmp/debates-recordings docker compose run --rm transcriber <session-dir-name>`.
- [ ] Verify `_transcript.json` + `_transcript.txt` appear in the session dir; inspect the Russian text and that turns interleave by wall-clock; record the wall-clock runtime (the real CPU benchmark).

## Later (not in this plan)

- Auto-trigger: enqueue a `transcribe` job on session completion; a worker consumes it.
- Optional English translation (`task=translate`) alongside Russian.
- Word-level timestamps (`word_timestamps=True`) if finer alignment is needed.
