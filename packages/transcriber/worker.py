#!/usr/bin/env python3
"""Long-running transcription worker for the Docker stack.

Polls RECORDINGS_DIR for finished sessions the bot has opted in for transcription
and runs transcribe.py on each, one at a time. A session is eligible when:

  - `_metadata.json` exists      (the API wrote it at completeSession → files ready)
  - `_transcribe.request` exists (the bot dropped the opt-in marker for
                                  `/record stop transcribe:true`, or recovery did)
  - `_transcript.json` is absent (not already transcribed)

`_transcript.json` (written by transcribe.py) is the idempotency guard: once
present the session is never reprocessed. A `_transcript.lock` (O_CREAT|O_EXCL)
guards against overlap. Each session is transcribed in a SUBPROCESS so a leak or
OOM in one session can't accumulate across the worker's lifetime — the subprocess
dies, the worker logs it and moves on (transcribe.py itself checkpoints after each
speaker file and self-heals corrupt audio, so partial progress survives a kill).
"""
import os
import sys
import time
import json
import subprocess
from pathlib import Path

RECORDINGS_DIR = os.environ.get("RECORDINGS_DIR", "/recordings")
POLL_INTERVAL_SEC = int(os.environ.get("POLL_INTERVAL_SEC", "30"))
# A lock older than this was orphaned by a worker crash mid-transcription; reclaim it.
STALE_LOCK_SEC = int(os.environ.get("STALE_LOCK_SEC", "7200"))  # 2h > any single-session run
# Stop retrying a session that keeps failing (corrupt audio, repeatable crash) so a
# poison session can't burn CPU every poll forever.
MAX_ATTEMPTS = int(os.environ.get("MAX_TRANSCRIBE_ATTEMPTS", "3"))
HERE = Path(__file__).resolve().parent

METADATA = "_metadata.json"
MARKER = "_transcribe.request"
TRANSCRIPT = "_transcript.json"
LOCK = "_transcript.lock"
ATTEMPTS = "_transcribe.attempts"
FAILED = "_transcribe.failed"


def transcript_complete(d: Path) -> bool:
    """True only once transcribe.py has finished ALL files. transcribe.py checkpoints
    _transcript.json after every speaker (so a crash keeps partial work), writing
    complete=false until the final pass — so a partial checkpoint is NOT mistaken
    for a finished transcript and the session is retried."""
    f = d / TRANSCRIPT
    if not f.exists():
        return False
    try:
        return bool(json.loads(f.read_text(encoding="utf-8")).get("complete", False))
    except Exception:
        return False  # unreadable / torn partial write → not complete


def lock_held(d: Path) -> bool:
    """A live lock blocks; a stale one (worker died mid-run) is reclaimed."""
    lock = d / LOCK
    try:
        age = time.time() - lock.stat().st_mtime
    except FileNotFoundError:
        return False
    if age > STALE_LOCK_SEC:
        try:
            lock.unlink()
        except FileNotFoundError:
            pass
        return False
    return True


def eligible(d: Path) -> bool:
    return (
        (d / METADATA).exists()
        and (d / MARKER).exists()
        and not transcript_complete(d)
        and not lock_held(d)
    )


def _attempts(d: Path) -> int:
    try:
        return int((d / ATTEMPTS).read_text())
    except Exception:
        return 0


def _unlink(d: Path, name: str) -> None:
    try:
        (d / name).unlink()
    except FileNotFoundError:
        pass


def transcribe(d: Path) -> None:
    lock = d / LOCK
    try:
        # Atomic claim (stale locks already reclaimed by lock_held()).
        fd = os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.write(fd, str(int(time.time())).encode())
        os.close(fd)
    except FileExistsError:
        return
    try:
        print(f"[worker] transcribing {d.name} ...", flush=True)
        # Subprocess for memory isolation; transcribe.py reads RECORDINGS_DIR + dir name.
        proc = subprocess.run([sys.executable, str(HERE / "transcribe.py"), d.name])
        if proc.returncode == 0 and transcript_complete(d):
            print(f"[worker] done {d.name}", flush=True)
            _unlink(d, MARKER)   # success → stop reconsidering
            _unlink(d, ATTEMPTS)
        else:
            n = _attempts(d) + 1
            (d / ATTEMPTS).write_text(str(n))
            if n >= MAX_ATTEMPTS:
                # Give up on a poison session: drop the marker so it stops retrying,
                # leave a breadcrumb. transcribe.py keeps any partial _transcript.* it wrote.
                (d / FAILED).write_text(f"gave up after {n} attempts; last exit {proc.returncode}\n")
                _unlink(d, MARKER)
                print(f"[worker] GIVING UP {d.name} after {n} attempts (exit {proc.returncode})", flush=True)
            else:
                # Transient (e.g. OOM exit 137): leave the marker; transcribe.py
                # checkpoints partial progress and recovers corrupt audio at lower beam.
                print(f"[worker] FAILED {d.name} (exit {proc.returncode}) — attempt {n}/{MAX_ATTEMPTS}, will retry", flush=True)
    finally:
        _unlink(d, LOCK)


def scan_once() -> int:
    root = Path(RECORDINGS_DIR)
    if not root.is_dir():
        return 0
    # Oldest-first so a backlog drains in recording order.
    dirs = sorted((d for d in root.iterdir() if d.is_dir()), key=lambda p: p.name)
    n = 0
    for d in dirs:
        if eligible(d):
            transcribe(d)
            n += 1
    return n


def main() -> None:
    print(
        f"[worker] watching {RECORDINGS_DIR} every {POLL_INTERVAL_SEC}s "
        f"(model={os.environ.get('WHISPER_MODEL', 'large-v3')})",
        flush=True,
    )
    while True:
        try:
            scan_once()
        except Exception as e:  # never let one bad scan kill the worker
            print(f"[worker] scan error: {e}", file=sys.stderr, flush=True)
        time.sleep(POLL_INTERVAL_SEC)


if __name__ == "__main__":
    main()
