#!/usr/bin/env python3
"""Transcribe a recording session's per-speaker .ogg files (Russian by default)
and merge them into one wall-clock-ordered, speaker-attributed transcript.

Each speaker file is *compacted* (Discord emits Opus only while that person
talks, so silence is dropped). The bot records a per-burst timeline in
_metadata.json: each `segments` entry has `wall_ms` (offset from session start),
`audio_offset_ms` (position inside the compacted file), and `duration_ms`. Since
bursts are contiguous in audio, they form a piecewise-linear map from talk-time
(Whisper's axis) to wall-clock, letting us interleave speakers correctly.

Usage:  python transcribe.py <session-dir | session-dir-name>
Outputs _transcript.json and _transcript.txt into the session directory.
"""
import os
import sys
import json
import datetime
import subprocess
import tempfile
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
    """Map a talk-time offset (ms, on the compacted file) to wall-clock ms using
    the burst anchors. `segments` must be sorted ascending by audio_offset_ms."""
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


def whisper_segments(model, audio_path, beam_size=BEAM_SIZE):
    """Transcribe a file → list of {start, end, text} (talk-time seconds), non-empty."""
    segs, _info = model.transcribe(
        str(audio_path), language=LANGUAGE, vad_filter=True, beam_size=beam_size
    )
    out = []
    for ws in segs:
        text = ws.text.strip()
        if text:
            out.append({"start": ws.start, "end": ws.end, "text": text})
    return out


def recover_wav(src_path):
    """Re-decode an audio file past corrupt packets into a temp 16 kHz mono WAV.

    A handful of bad Opus packets make faster-whisper bail on the first one and
    return nothing, silently dropping the whole speaker. ffmpeg's discardcorrupt
    skips the bad packets and decodes the rest. Returns the temp WAV path, or None
    if ffmpeg is missing or produced nothing usable. Caller must delete the path.
    """
    fd, tmp = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error",
             "-err_detect", "ignore_err", "-fflags", "+discardcorrupt",
             "-i", str(src_path), "-ar", "16000", "-ac", "1", "-y", tmp],
            check=False,
        )
        if os.path.getsize(tmp) > 1024:  # bigger than an empty WAV header → real audio
            return tmp
    except FileNotFoundError:
        print("[transcriber] ffmpeg not found — cannot recover corrupt file", file=sys.stderr)
    if os.path.exists(tmp):
        os.remove(tmp)
    return None


def _atomic_write(path, text):
    """Write via a temp file + rename so a crash mid-write never leaves a partial
    (and the previous checkpoint survives intact)."""
    tmp = str(path) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(text)
    os.replace(tmp, path)


def write_outputs(session_dir, meta, merged, per_speaker, started):
    """(Re)write _transcript.json/.txt from the accumulated segments. Called after
    every file as a checkpoint, so a later crash (e.g. an OOM on the last file)
    still leaves a complete transcript of everything done so far."""
    ordered = sorted(merged, key=lambda e: e["wall_ms"])
    finished = datetime.datetime.now(datetime.timezone.utc)
    out = {
        "session_id": meta.get("session_id"),
        "language": LANGUAGE,
        "model": MODEL,
        "generated_at": finished.isoformat().replace("+00:00", "Z"),
        "elapsed_sec": round((finished - started).total_seconds(), 1),
        "segments": ordered,
        "per_speaker": per_speaker,
    }
    _atomic_write(session_dir / "_transcript.json", json.dumps(out, ensure_ascii=False, indent=2))
    lines = [f"[{fmt_ts(e['wall_ms'])}] {e['speaker']}: {e['text']}" for e in ordered]
    _atomic_write(session_dir / "_transcript.txt", "\n".join(lines) + "\n")
    return out


def main():
    if len(sys.argv) < 2:
        print("usage: transcribe.py <session-dir | session-dir-name>", file=sys.stderr)
        sys.exit(2)

    arg = sys.argv[1]
    p = Path(arg)
    session_dir = p if p.is_absolute() else Path(RECORDINGS_DIR) / arg
    meta_path = session_dir / "_metadata.json"
    if not meta_path.exists():
        print(f"no _metadata.json in {session_dir}", file=sys.stderr)
        sys.exit(1)
    meta = json.loads(meta_path.read_text(encoding="utf-8"))

    print(f"[transcriber] loading model={MODEL} device={DEVICE} compute={COMPUTE_TYPE} lang={LANGUAGE}", flush=True)
    started = datetime.datetime.now(datetime.timezone.utc)
    model = WhisperModel(MODEL, device=DEVICE, compute_type=COMPUTE_TYPE, download_root=DOWNLOAD_ROOT)

    merged = []
    per_speaker = {}
    files = meta.get("files", [])
    for f in files:
        audio_path = session_dir / f["file"]
        if not audio_path.exists():
            print(f"[transcriber] skip missing file {f['file']}", file=sys.stderr)
            continue
        segs = sorted(f.get("segments", []), key=lambda s: s["audio_offset_ms"])
        speaker = f.get("display_name") or f.get("discord_username") or f.get("discord_user_id")
        print(f"[transcriber] transcribing {f['file']} ({speaker}) ...", flush=True)
        ws_segments = whisper_segments(model, audio_path)

        # Self-heal: 0 segments usually means a few corrupt Opus packets made
        # faster-whisper bail on the first bad packet. Re-decode past the corruption
        # with ffmpeg's discardcorrupt and retry before giving up on the speaker.
        if not ws_segments:
            print("[transcriber]   0 segments — attempting corrupt-packet recovery", flush=True)
            tmp = recover_wav(audio_path)
            if tmp:
                # Recovery is a salvage pass over a whole re-decoded file; run it at
                # beam 1 to keep peak memory down (large-v3 + a second full pass can
                # OOM a small Docker VM) and speed it up. Minor accuracy cost on audio
                # that would otherwise be lost entirely.
                ws_segments = whisper_segments(model, tmp, beam_size=1)
                os.remove(tmp)
                if ws_segments:
                    print(f"[transcriber]   recovered {len(ws_segments)} segments via discardcorrupt", flush=True)

        chunks = []
        for ws in ws_segments:
            entry = {
                "speaker": speaker,
                "discord_username": f.get("discord_username"),
                "discord_user_id": f.get("discord_user_id"),
                "wall_ms": wall_for(segs, ws["start"] * 1000),
                "wall_end_ms": wall_for(segs, ws["end"] * 1000),
                "audio_start_s": round(ws["start"], 2),
                "audio_end_s": round(ws["end"], 2),
                "text": ws["text"],
            }
            merged.append(entry)
            chunks.append(entry)
        per_speaker[f.get("discord_username") or speaker] = {
            "speaker": speaker,
            "file": f["file"],
            "segment_count": len(chunks),
        }
        print(f"[transcriber]   {len(chunks)} segments", flush=True)
        # Checkpoint after every file: if a later file crashes the process (e.g. an
        # OOM during a heavy recovery pass), the work done so far is already saved.
        write_outputs(session_dir, meta, merged, per_speaker, started)

    out = write_outputs(session_dir, meta, merged, per_speaker, started)

    print(
        f"[transcriber] done: {len(files)} files, {len(merged)} segments, "
        f"{out['elapsed_sec']}s → _transcript.json / _transcript.txt",
        flush=True,
    )


if __name__ == "__main__":
    main()
