# @debates/transcriber

Local Whisper transcription for recording sessions. Reads a session directory
(`_metadata.json` + per-speaker `.ogg` files), transcribes each speaker with
[faster-whisper](https://github.com/SYSTRAN/faster-whisper), and merges them via
the burst `segments` timeline into one wall-clock-ordered, speaker-attributed
transcript (`_transcript.json` + `_transcript.txt`).

Defaults: `large-v3`, `int8`, CPU, Russian (`ru`).

## Run (local dev — files in host `/tmp/debates-recordings`)

```bash
docker compose build transcriber
RECORDINGS_SOURCE=/tmp/debates-recordings \
  docker compose run --rm transcriber <session-dir-name>
```

`<session-dir-name>` is the folder under the recordings root, e.g.
`2026-06-06T05-20-38__594974e2-7ced-4f3b-8e4b-712e8d530e30`.

## Run (production — api/bot in Docker, shared `recordings` volume)

```bash
docker compose run --rm transcriber <session-dir-name>
```

## Configuration (env)

| Var | Default | Notes |
|-----|---------|-------|
| `WHISPER_MODEL` | `large-v3` | any faster-whisper model id |
| `WHISPER_DEVICE` | `cpu` | `cuda` on a GPU host |
| `WHISPER_COMPUTE_TYPE` | `int8` | `float16` on GPU |
| `WHISPER_LANGUAGE` | `ru` | ISO code |
| `WHISPER_BEAM_SIZE` | `5` | |
| `RECORDINGS_DIR` | `/recordings` | mount point inside the container |

The `large-v3` model (~3 GB) downloads once into the `whisper-models` volume.
