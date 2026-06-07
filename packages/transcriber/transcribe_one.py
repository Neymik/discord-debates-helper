#!/usr/bin/env python3
"""Transcribe ONE audio file and merge it into an existing session transcript.

Used to recover a speaker whose original .ogg failed to decode (e.g. a few
corrupt Opus packets → faster-whisper returns 0 segments). Re-decode the file
with ffmpeg's discardcorrupt to a WAV, then run this against that WAV. It maps
the new segments to wall-clock via the speaker's burst timeline in
_metadata.json, replaces that speaker's entries in _transcript.json, re-sorts,
and rewrites _transcript.json + _transcript.txt.

Usage: transcribe_one.py <session-dir-name> <audio-file-in-session> <metadata-file-key>
  e.g. transcribe_one.py 2026-...__uuid file_c_5360_recovered.wav file_c_5360.ogg
"""
import os
import sys
import json
import datetime
from pathlib import Path

from faster_whisper import WhisperModel

RECORDINGS_DIR = os.environ.get("RECORDINGS_DIR", "/recordings")
MODEL = os.environ.get("WHISPER_MODEL", "large-v3")
DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")
LANGUAGE = os.environ.get("WHISPER_LANGUAGE", "ru")
DOWNLOAD_ROOT = os.environ.get("WHISPER_DOWNLOAD_ROOT", "/models")
BEAM_SIZE = int(os.environ.get("WHISPER_BEAM_SIZE", "5"))


def wall_for(segments, audio_ms):
    if not segments:
        return int(audio_ms)
    chosen = segments[0]
    for s in segments:
        if s["audio_offset_ms"] <= audio_ms:
            chosen = s
        else:
            break
    return int(chosen["wall_ms"] + (audio_ms - chosen["audio_offset_ms"]))


def fmt_ts(ms):
    total = int(ms / 1000)
    return f"{total // 60:02d}:{total % 60:02d}"


def main():
    session_name, audio_file, meta_key = sys.argv[1], sys.argv[2], sys.argv[3]
    session_dir = Path(RECORDINGS_DIR) / session_name
    meta = json.loads((session_dir / "_metadata.json").read_text(encoding="utf-8"))
    f = next((x for x in meta["files"] if x["file"] == meta_key), None)
    if f is None:
        print(f"meta key {meta_key} not found in _metadata.json", file=sys.stderr)
        sys.exit(1)
    segs = sorted(f.get("segments", []), key=lambda s: s["audio_offset_ms"])
    speaker = f.get("display_name") or f.get("discord_username") or f.get("discord_user_id")
    discord_username = f.get("discord_username")

    print(f"[merge] transcribing {audio_file} ({speaker}) with {MODEL}/{LANGUAGE} ...", flush=True)
    model = WhisperModel(MODEL, device=DEVICE, compute_type=COMPUTE_TYPE, download_root=DOWNLOAD_ROOT)
    whisper_segments, _info = model.transcribe(
        str(session_dir / audio_file), language=LANGUAGE, vad_filter=True, beam_size=BEAM_SIZE
    )
    new_entries = []
    for ws in whisper_segments:
        text = ws.text.strip()
        if not text:
            continue
        new_entries.append({
            "speaker": speaker,
            "discord_username": discord_username,
            "discord_user_id": f.get("discord_user_id"),
            "wall_ms": wall_for(segs, ws.start * 1000),
            "wall_end_ms": wall_for(segs, ws.end * 1000),
            "audio_start_s": round(ws.start, 2),
            "audio_end_s": round(ws.end, 2),
            "text": text,
        })
    print(f"[merge] {len(new_entries)} new segments for {speaker}", flush=True)

    tpath = session_dir / "_transcript.json"
    transcript = json.loads(tpath.read_text(encoding="utf-8"))
    # Drop any existing entries for this speaker (idempotent re-runs), add the new ones.
    kept = [e for e in transcript["segments"] if e.get("discord_username") != discord_username]
    merged = sorted(kept + new_entries, key=lambda e: e["wall_ms"])
    transcript["segments"] = merged
    transcript["generated_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    transcript.setdefault("per_speaker", {})[discord_username] = {
        "speaker": speaker, "file": meta_key, "segment_count": len(new_entries), "recovered": True,
    }
    tpath.write_text(json.dumps(transcript, ensure_ascii=False, indent=2), encoding="utf-8")

    lines = [f"[{fmt_ts(e['wall_ms'])}] {e['speaker']}: {e['text']}" for e in merged]
    (session_dir / "_transcript.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"[merge] done: transcript now {len(merged)} segments → _transcript.json / _transcript.txt", flush=True)


if __name__ == "__main__":
    main()
