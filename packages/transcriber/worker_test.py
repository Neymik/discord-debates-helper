#!/usr/bin/env python3
"""Standalone tests for the transcription worker's gating logic (no pytest needed).

Run:  python3 worker_test.py     (exits non-zero on failure)

Covers the marker/complete/lock state machine that decides whether a session is
eligible for transcription, including the two bugs the review caught: a partial
checkpoint must NOT look "done", and a stale lock (orphaned by a worker crash)
must be reclaimed instead of blocking the session forever.
"""
import os
import sys
import time
import json
import tempfile
import importlib.util
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("worker", HERE / "worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


def _mk(root, name, files, transcript=None, lock_age=None, attempts=None):
    d = Path(root) / name
    d.mkdir(parents=True, exist_ok=True)
    for f in files:
        (d / f).write_text("x")
    if transcript is not None:
        (d / "_transcript.json").write_text(json.dumps(transcript))
    if attempts is not None:
        (d / "_transcribe.attempts").write_text(str(attempts))
    if lock_age is not None:
        lk = d / "_transcript.lock"
        lk.write_text("1")
        t = time.time() - lock_age
        os.utime(lk, (t, t))
    return d


def test_eligibility():
    root = tempfile.mkdtemp()
    M, R = "_metadata.json", "_transcribe.request"
    cases = {
        "ready":      (_mk(root, "ready", [M, R]), True),
        "no_marker":  (_mk(root, "nm", [M]), False),         # not opted in
        "no_meta":    (_mk(root, "nme", [R]), False),         # files not finalized
        "complete":   (_mk(root, "cmp", [M, R], transcript={"complete": True}), False),
        "partial":    (_mk(root, "prt", [M, R], transcript={"complete": False}), True),  # retry
        "legacy":     (_mk(root, "lg", [M, R], transcript={"segments": []}), True),       # no flag → retry
        "fresh_lock": (_mk(root, "fl", [M, R], lock_age=10), False),
        "stale_lock": (_mk(root, "sl", [M, R], lock_age=worker.STALE_LOCK_SEC + 100), True),
    }
    for name, (d, want) in cases.items():
        got = worker.eligible(d)
        assert got == want, f"{name}: eligible={got} want {want}"
    # stale lock must be reclaimed (unlinked) as a side effect of the eligibility check
    assert not (Path(root) / "sl" / "_transcript.lock").exists(), "stale lock not reclaimed"


def test_helpers():
    root = tempfile.mkdtemp()
    d = _mk(root, "a", ["_metadata.json", "_transcribe.request"], attempts=2)
    assert worker._attempts(d) == 2
    worker._unlink(d, "_transcribe.attempts")
    assert worker._attempts(d) == 0           # missing → 0
    worker._unlink(d, "does-not-exist")        # no error on missing


def main():
    for fn in (test_eligibility, test_helpers):
        fn()
        print(f"  ok: {fn.__name__}")
    print("worker_test: ALL PASS")


if __name__ == "__main__":
    main()
