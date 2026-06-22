import { openSync, writeSync, fsyncSync, closeSync, appendFileSync, writeFileSync, readFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Crash-safe on-disk sidecars that let a recording be reconstructed after the bot
 * process dies mid-session (SIGKILL / OOM / power loss). The `.ogg` audio is
 * already written incrementally and stays decodable; what lives only in memory is
 * the per-burst speaking timeline, the session identity, and the file→user map.
 * We mirror that to disk as it happens:
 *
 *   <dir>/_session.json                     — written once at start (fsync'd)
 *   <dir>/<file>.ogg.segments.jsonl         — append-only: one `open` line then a
 *                                             `seg` line per closed speaking burst
 *   <dir>/_heartbeat                         — touched every ~30s while live
 *
 * Append-only JSONL is the crash-safe choice: each line is one small (<4 KiB)
 * O_APPEND write (atomic on local fs), and a torn final line on a hard kill is
 * simply skipped by the reader. Recovery (recovery.ts) reads these back.
 */

export const HEARTBEAT_FILE = "_heartbeat";
export const SESSION_FILE = "_session.json";
export const METADATA_FILE = "_metadata.json"; // written by the API on completeSession
export const TRANSCRIBE_MARKER = "_transcribe.request"; // bot → transcription worker

// A normal speaker's JSONL is a few KB (one line per burst). Cap the read so a
// corrupt/huge file on the shared volume can't OOM the bot during recovery.
const MAX_SIDECAR_BYTES = 8 * 1024 * 1024;

const segmentsPath = (fileDir: string, fileName: string): string =>
  path.join(fileDir, `${fileName}.segments.jsonl`);

export interface SessionSidecar {
  sessionId: string;
  guildId: string;
  voiceChannelId: string;
  voiceChannelName: string;
  startedAtMs: number;
}

export interface SidecarSegment {
  wallMs: number;
  audioOffsetMs: number;
  durationMs: number;
}

export interface RecoveredFile {
  fileName: string;
  discordUserId: string;
  discordUsername: string;
  segments: SidecarSegment[];
}

/** Write `_session.json` durably (fsync) so the session identity survives a crash. */
export function writeSessionJson(fileDir: string, s: SessionSidecar): void {
  const data = JSON.stringify(s);
  const fd = openSync(path.join(fileDir, SESSION_FILE), "w");
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** First line of a speaker's JSONL: the identity needed to register the file later. */
export function appendOpen(
  fileDir: string,
  fileName: string,
  who: { discordUserId: string; discordUsername: string },
): void {
  const line = JSON.stringify({ t: "open", ...who, fileName }) + "\n";
  appendFileSync(segmentsPath(fileDir, fileName), line);
}

/** Append one closed speaking burst to a speaker's JSONL. */
export function appendSeg(fileDir: string, fileName: string, seg: SidecarSegment): void {
  const line =
    JSON.stringify({ t: "seg", wall_ms: seg.wallMs, audio_offset_ms: seg.audioOffsetMs, duration_ms: seg.durationMs }) +
    "\n";
  appendFileSync(segmentsPath(fileDir, fileName), line);
}

/** Touch the heartbeat so recovery can tell a live recording from an orphan. */
export function touchHeartbeat(fileDir: string): void {
  writeFileSync(path.join(fileDir, HEARTBEAT_FILE), String(Date.now()));
}

/** Age of the heartbeat in ms (Infinity if missing/unreadable → treated as orphan). */
export function heartbeatAgeMs(fileDir: string, now = Date.now()): number {
  try {
    return now - statSync(path.join(fileDir, HEARTBEAT_FILE)).mtimeMs;
  } catch {
    return Infinity;
  }
}

/**
 * Reconstruct a session's files + timeline from the JSONL sidecars in `dir`.
 * Tolerates a torn final line (partial write at crash) by skipping unparseable
 * lines. Returns one entry per `<file>.ogg.segments.jsonl` that has an `open`
 * record and a still-present `.ogg` on disk.
 */
export function readSidecars(dir: string): { session: SessionSidecar | null; files: RecoveredFile[] } {
  let session: SessionSidecar | null = null;
  try {
    session = JSON.parse(readFileSync(path.join(dir, SESSION_FILE), "utf8")) as SessionSidecar;
  } catch {
    session = null;
  }

  const files: RecoveredFile[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { session, files };
  }

  for (const name of entries) {
    if (!name.endsWith(".segments.jsonl")) continue;
    const fileName = name.slice(0, -".segments.jsonl".length); // strip suffix → "<base>.ogg"
    const full = path.join(dir, name);
    let raw: string;
    try {
      if (statSync(full).size > MAX_SIDECAR_BYTES) {
        console.warn(`[discord-bot] sidecar ${name} exceeds ${MAX_SIDECAR_BYTES} bytes — skipping`);
        continue;
      }
      raw = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    let discordUserId = "";
    let discordUsername = "";
    const segments: SidecarSegment[] = [];
    for (const line of raw.split("\n")) {
      if (!line) continue;
      let rec: { t?: string; discordUserId?: string; discordUsername?: string; wall_ms?: number; audio_offset_ms?: number; duration_ms?: number };
      try {
        rec = JSON.parse(line);
      } catch {
        continue; // torn final line on crash → skip
      }
      if (rec.t === "open") {
        discordUserId = rec.discordUserId ?? "";
        discordUsername = rec.discordUsername ?? "";
      } else if (rec.t === "seg") {
        segments.push({
          wallMs: rec.wall_ms ?? 0,
          audioOffsetMs: rec.audio_offset_ms ?? 0,
          durationMs: rec.duration_ms ?? 0,
        });
      }
    }
    if (!discordUserId) continue; // no identity → cannot register
    files.push({ fileName, discordUserId, discordUsername, segments });
  }
  return { session, files };
}
