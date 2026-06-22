import { readdirSync, statSync, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { ApiClient } from "../apiClient.js";
import type { BotConfig } from "../config.js";
import { retryWithBackoff } from "../lib/backoff.js";
import {
  readSidecars,
  heartbeatAgeMs,
  SESSION_FILE,
  METADATA_FILE,
  TRANSCRIBE_MARKER,
  type RecoveredFile,
} from "./sidecar.js";

/**
 * On boot, finalize recordings orphaned by a crash. The bot just started with an
 * empty in-memory map, so any session dir on disk that has the sidecars of an
 * in-progress recording (`_session.json` + `*.segments.jsonl`) but no
 * `_metadata.json` (written by the API only at completeSession) is an orphan — the
 * process died after `/record start` but before a clean `/record stop`. The `.ogg`
 * audio is already on disk and decodable; here we reconstruct the file list +
 * cross-speaker timeline from the JSONL sidecars and replay the same idempotent
 * registerFile → completeSession path a normal stop would, which writes
 * `_metadata.json`, releases the per-guild lock, and (optionally) queues
 * transcription. Idempotent: re-running is a no-op once `_metadata.json` exists,
 * and registerFile (upsert) + completeSession (unconditional) are safe to repeat.
 * If the API's reapStuckSessions cron already flipped a long-dead session to
 * 'failed', recovery intentionally re-completes it ('failed'→'completed') — the
 * whole point is to salvage the audio, so re-completing a reaped session is desired.
 */

// Recovery runs in the background at boot (index.ts bounds the foreground wait), so
// a tight per-session budget keeps a phantom/unreachable session from lingering.
const RECOVERY_BACKOFF = { baseMs: 500, capMs: 5_000, totalBudgetMs: 30_000 };
// A header-only Ogg/Opus file (OpusHead+OpusTags, no audio pages) is ~150-300 bytes;
// one audio page (≤10 packets) pushes a real file past ~1KB. 1024 cleanly excludes
// header-only files without dropping any speaker who actually produced audio.
const MIN_OGG_BYTES = 1024;
// Heartbeat is touched every 30s while live; treat >90s (or missing) as an orphan.
const ORPHAN_HEARTBEAT_MS = 90_000;

function fileSize(p: string): number {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

/** Rough duration from the timeline (segments carry the authoritative timing). */
function durationSecFromSegments(f: RecoveredFile): number {
  let end = 0;
  for (const s of f.segments) end = Math.max(end, s.audioOffsetMs + s.durationMs);
  return Math.max(0, Math.round(end / 1000));
}

/** Finalize one orphaned session dir. Returns true if it was recovered. */
async function recoverOne(api: ApiClient, cfg: BotConfig, dir: string): Promise<boolean> {
  const { session, files } = readSidecars(dir);
  if (!session) return false;

  const real = files.filter((f) => fileSize(path.join(dir, f.fileName)) > MIN_OGG_BYTES);
  for (const f of real) {
    await retryWithBackoff(
      () =>
        api.registerFile(session.sessionId, {
          discord_user_id: f.discordUserId,
          discord_username: f.discordUsername,
          file_path: f.fileName,
          duration_sec: durationSecFromSegments(f),
          size_bytes: fileSize(path.join(dir, f.fileName)),
          segments: f.segments.map((s) => ({
            wall_ms: s.wallMs,
            audio_offset_ms: s.audioOffsetMs,
            duration_ms: s.durationMs,
          })),
        }),
      RECOVERY_BACKOFF,
    );
  }
  // Always complete — even a no-audio session must finish so the guild lock frees
  // and the row leaves 'recording'. completeSession writes _metadata.json.
  await retryWithBackoff(() => api.completeSession(session.sessionId), RECOVERY_BACKOFF);

  if (cfg.recoverTranscribe && real.length > 0) {
    try {
      await writeFile(path.join(dir, TRANSCRIBE_MARKER), String(Date.now()));
    } catch (err) {
      console.error(`[discord-bot] recovery: failed to drop transcribe marker for ${dir}:`, err);
    }
  }
  console.warn(
    `[discord-bot] recovered orphaned session ${session.sessionId} (${real.length} speaker file(s)) from ${path.basename(dir)}`,
  );
  return true;
}

/**
 * Scan RECORDINGS_DIR and finalize every orphaned in-progress session.
 * Returns the count recovered. Safe to call on every boot.
 */
export async function recoverOrphans(api: ApiClient, cfg: BotConfig): Promise<number> {
  if (!cfg.recoverOnBoot) return 0;
  let names: string[];
  try {
    names = readdirSync(cfg.recordingsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return 0; // recordings dir not created yet → nothing to recover
  }

  let recovered = 0;
  for (const name of names) {
    const dir = path.join(cfg.recordingsDir, name);
    if (existsSync(path.join(dir, METADATA_FILE))) continue; // already finalized
    if (!existsSync(path.join(dir, SESSION_FILE))) continue; // not a recoverable session
    if (heartbeatAgeMs(dir) < ORPHAN_HEARTBEAT_MS) continue; // a live recording is writing here
    try {
      if (await recoverOne(api, cfg, dir)) recovered++;
    } catch (err) {
      console.error(`[discord-bot] recovery failed for ${dir}:`, err);
    }
  }
  return recovered;
}
