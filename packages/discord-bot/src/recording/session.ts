import { mkdir, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { spawn as nodeSpawn } from "node:child_process";
import path from "node:path";
import { joinVoiceChannel, EndBehaviorType, type VoiceConnection } from "@discordjs/voice";
import type { VoiceBasedChannel, TextBasedChannel } from "discord.js";
import type { ApiClient } from "../apiClient.js";
import type { BotConfig } from "../config.js";
import { OpusFileWriter } from "./opusFile.js";
import { recordingFileName } from "./filename.js";
import { retryWithBackoff } from "../lib/backoff.js";
import { capTimings } from "./caps.js";
import {
  writeSessionJson,
  appendOpen,
  appendSeg,
  touchHeartbeat,
  TRANSCRIBE_MARKER,
} from "./sidecar.js";

/** How often the live recording touches its heartbeat so recovery can spot orphans. */
const HEARTBEAT_INTERVAL_MS = 30_000;

/** One contiguous speaking burst (internal, camelCase; mapped to snake_case at registerFile). */
interface BurstSegment {
  wallMs: number; // offset from session start
  audioOffsetMs: number; // talk-time written into this user's file when the burst began
  durationMs: number; // wall-clock length of the burst
}

interface UserCapture {
  writer: OpusFileWriter;
  filePath: string;
  fileName: string;
  discordUsername: string;
  startedAtMs: number;
  opusStream: import("node:stream").Readable;
  finished: Promise<{ bytesWritten: number; audioPackets: number }>;
  segments: BurstSegment[];
  openSegment: { wallMs: number; audioOffsetMs: number } | null; // burst in progress, if any
}

interface ActiveRecording {
  sessionId: string;
  fileDir: string;
  guildId: string;
  voiceChannelName: string;
  sessionStartedAtMs: number;
  connection: VoiceConnection;
  captures: Map<string, UserCapture>; // keyed by discord user id
  warnTimer: NodeJS.Timeout;
  stopTimer: NodeJS.Timeout;
  heartbeat: NodeJS.Timeout; // periodic _heartbeat touch so recovery can spot orphans
}

const BACKOFF = { baseMs: 1000, capMs: 60_000, totalBudgetMs: 3_600_000 };

/** The file-registration payload, sourced from ApiClient so the two never drift. */
type RegisterFileInput = Parameters<ApiClient["registerFile"]>[1];

/** Post-stop transcription request, set from the `/record stop` flags. */
export interface TranscribeOpts {
  transcribe: boolean;
  type: string; // "batch" (implemented) | "incremental" (reserved)
}

/** Minimal spawn shape so tests can inject a fake instead of launching a process. */
export type SpawnFn = (
  command: string,
  args: string[],
  options: { detached: boolean; stdio: "ignore" },
) => { unref(): void };

export class RecordingManager {
  private readonly active = new Map<string, ActiveRecording>();
  /** In-flight background persist() promises, so shutdown can wait for them. */
  private readonly persisting = new Set<Promise<void>>();

  constructor(
    private readonly api: ApiClient,
    private readonly cfg: BotConfig,
    private readonly spawnFn: SpawnFn = (c, a, o) => nodeSpawn(c, a, o),
  ) {}

  isActive(guildId: string): boolean {
    return this.active.has(guildId);
  }

  /**
   * Joins `voiceChannel`, opens per-user Opus capture on first speech, and wires
   * the auto-stop caps. `onAutoStop` is called when the hard cap fires.
   * `session` is the 201 body from POST /api/recordings/sessions.
   */
  async start(
    session: { id: string; fileDir: string },
    voiceChannel: VoiceBasedChannel,
    onWarn: () => void,
    onAutoStop: () => void,
  ): Promise<void> {
    const guildId = voiceChannel.guild.id;
    const sessionStartedAtMs = Date.now();
    await mkdir(session.fileDir, { recursive: true });

    // Crash-safe: persist the session identity + first heartbeat to disk up front
    // so a hard kill mid-recording can be reconstructed and finalized on restart.
    try {
      writeSessionJson(session.fileDir, {
        sessionId: session.id,
        guildId,
        voiceChannelId: voiceChannel.id,
        voiceChannelName: voiceChannel.name,
        startedAtMs: sessionStartedAtMs,
      });
      touchHeartbeat(session.fileDir);
    } catch (err) {
      console.error("[discord-bot] failed to write session sidecar:", err);
    }

    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false, // must hear to receive
      selfMute: true,
    });

    const captures = new Map<string, UserCapture>();
    const receiver = connection.receiver;

    // A user's file + subscription opens on their first burst; every later burst
    // (re)opens a segment. The Manual subscription stays open for the whole
    // session, so all of a user's bursts concatenate into one compacted file.
    receiver.speaking.on("start", (userId: string) => {
      const nowMs = Date.now() - sessionStartedAtMs;
      let cap = captures.get(userId);
      if (!cap) {
        const member = voiceChannel.members.get(userId);
        const username = member?.user.username ?? "user";
        const fileName = recordingFileName(username, userId);
        const filePath = path.join(session.fileDir, fileName);
        const opusStream = receiver.subscribe(userId, {
          end: { behavior: EndBehaviorType.Manual }, // we end it ourselves on /record stop
        });
        const writer = new OpusFileWriter(filePath);
        writer.start(opusStream);
        cap = {
          writer,
          filePath,
          fileName,
          discordUsername: username,
          startedAtMs: Date.now(),
          opusStream,
          finished: writer.finish(),
          segments: [],
          openSegment: null,
        };
        captures.set(userId, cap);
        // Persist this speaker's identity (file→user map) for crash recovery.
        try {
          appendOpen(session.fileDir, fileName, { discordUserId: userId, discordUsername: username });
        } catch (err) {
          console.error("[discord-bot] failed to write open sidecar:", err);
        }
      }
      // Open a burst anchored to the current talk-time offset in this user's file.
      if (!cap.openSegment) {
        cap.openSegment = { wallMs: nowMs, audioOffsetMs: cap.writer.audioMs() };
      }
    });

    receiver.speaking.on("end", (userId: string) => {
      const cap = captures.get(userId);
      if (!cap?.openSegment) return;
      const endMs = Date.now() - sessionStartedAtMs;
      const seg = {
        wallMs: cap.openSegment.wallMs,
        audioOffsetMs: cap.openSegment.audioOffsetMs,
        durationMs: Math.max(0, endMs - cap.openSegment.wallMs),
      };
      cap.segments.push(seg);
      cap.openSegment = null;
      // Append the closed burst to disk so the timeline survives a crash.
      try {
        appendSeg(session.fileDir, cap.fileName, seg);
      } catch (err) {
        console.error("[discord-bot] failed to append seg sidecar:", err);
      }
    });

    const { warnAfterMs, stopAfterMs } = capTimings(this.cfg.maxSessionHours);
    const warnTimer = setTimeout(onWarn, warnAfterMs);
    const stopTimer = setTimeout(onAutoStop, stopAfterMs);
    const heartbeat = setInterval(() => {
      try {
        touchHeartbeat(session.fileDir);
      } catch {
        /* best-effort liveness signal */
      }
    }, HEARTBEAT_INTERVAL_MS);
    heartbeat.unref?.(); // don't keep the event loop alive for the heartbeat alone

    this.active.set(guildId, {
      sessionId: session.id,
      fileDir: session.fileDir,
      guildId,
      voiceChannelName: voiceChannel.name,
      sessionStartedAtMs,
      connection,
      captures,
      warnTimer,
      stopTimer,
      heartbeat,
    });
  }

  /** Emergency teardown without metadata writes (used when the consent reply fails). */
  async abort(guildId: string): Promise<void> {
    const rec = this.active.get(guildId);
    if (!rec) return;
    clearTimeout(rec.warnTimer);
    clearTimeout(rec.stopTimer);
    clearInterval(rec.heartbeat);
    if (rec.connection.state.status !== "destroyed") rec.connection.destroy();
    this.active.delete(guildId);
  }

  /**
   * Finalize every active recording — used by the process shutdown handlers
   * (SIGTERM/SIGINT/uncaught). Each stop() ends the streams (flushing the final
   * Ogg page) and schedules a background persist; we then await those persists so
   * the register/complete HTTP calls land before exit. The ENTIRE operation is
   * bounded by a single `graceMs` deadline (default 20s, comfortably under the
   * compose `stop_grace_period: 30s`) so a slow flush can't starve the persist
   * wait and a hung backend can't block exit past Docker's SIGKILL. Anything that
   * doesn't finish in time is picked up by boot recovery on the next start.
   */
  async stopAll(graceMs = 20_000): Promise<void> {
    const guildIds = [...this.active.keys()];
    if (guildIds.length === 0) return;
    console.warn(`[discord-bot] shutdown: finalizing ${guildIds.length} active recording(s)`);
    const finalizeAll = (async () => {
      // stop() ends streams (flushes the final Ogg page) + schedules background persist.
      await Promise.allSettled(guildIds.map((g) => this.stop(g, { transcribe: false, type: "batch" })));
      // Then wait for those background persists (registerFile + completeSession) to land.
      await Promise.allSettled([...this.persisting]);
    })();
    await Promise.race([finalizeAll, new Promise<void>((resolve) => setTimeout(resolve, graceMs))]);
  }

  /**
   * Ends all streams and frees the guild (voice connection + in-memory state)
   * IMMEDIATELY, then registers files + completes the session in the background
   * with exponential backoff (spec §5: up to ~1h). Freeing first is what keeps a
   * slow or failed backend from wedging the per-guild lock or stalling the Discord
   * interaction reply (which previously expired the interaction token → 10062, and
   * left the session stuck at status='recording'). Returns speaker count + total
   * duration for the reply (files are on disk; persistence is resilient/async).
   */
  async stop(
    guildId: string,
    opts?: TranscribeOpts,
  ): Promise<{ speakerCount: number; totalDurationSec: number } | null> {
    const rec = this.active.get(guildId);
    if (!rec) return null;
    this.active.delete(guildId); // release the in-memory per-guild lock up front
    clearTimeout(rec.warnTimer);
    clearTimeout(rec.stopTimer);
    clearInterval(rec.heartbeat);
    rec.connection.receiver.speaking.removeAllListeners(); // no new captures or burst events

    // Close any burst still open at stop time (the speaker was talking when /record
    // stop fired, so no `end` event will arrive).
    const stopWallMs = Date.now() - rec.sessionStartedAtMs;
    for (const cap of rec.captures.values()) {
      if (cap.openSegment) {
        cap.segments.push({
          wallMs: cap.openSegment.wallMs,
          audioOffsetMs: cap.openSegment.audioOffsetMs,
          durationMs: Math.max(0, stopWallMs - cap.openSegment.wallMs),
        });
        cap.openSegment = null;
      }
    }

    // Gracefully end each receive stream so the Ogg _flush writes the final page.
    for (const cap of rec.captures.values()) {
      cap.opusStream.push(null);
    }

    // Finalize each file (await the flush) and build registration payloads.
    let totalDurationSec = 0;
    const files: RegisterFileInput[] = [];
    for (const [discordUserId, cap] of rec.captures) {
      const { audioPackets } = await cap.finished;
      if (audioPackets === 0) continue; // no real audio → skip (spec §5 step 2)
      let sizeBytes = 0;
      try {
        sizeBytes = statSync(cap.filePath).size;
      } catch {
        sizeBytes = 0;
      }
      const durationSec = Math.max(0, Math.round((Date.now() - cap.startedAtMs) / 1000));
      totalDurationSec = Math.max(totalDurationSec, durationSec);
      files.push({
        discord_user_id: discordUserId,
        discord_username: cap.discordUsername,
        file_path: cap.fileName, // relative to session.file_dir (spec §3 recording_files.file_path)
        duration_sec: durationSec,
        size_bytes: sizeBytes,
        segments: cap.segments.map((s) => ({
          wall_ms: s.wallMs,
          audio_offset_ms: s.audioOffsetMs,
          duration_ms: s.durationMs,
        })),
      });
    }

    try {
      rec.connection.destroy(); // cleanup (streams already ended above)
    } catch {
      /* already destroyed */
    }

    // Persist out-of-band so the long backoff never blocks the reply or the guild.
    // Track the promise so shutdown (stopAll) can wait for it to settle.
    const p = this.persist(rec.sessionId, files, rec.fileDir, opts).catch((err) =>
      console.error(`[discord-bot] persist failed for session ${rec.sessionId}:`, err),
    );
    this.persisting.add(p);
    void p.finally(() => this.persisting.delete(p));

    return { speakerCount: files.length, totalDurationSec };
  }

  /**
   * Registers each file then completes the session, each with backoff (spec §5).
   * Only after completeSession succeeds — which is when the API writes
   * `_metadata.json` (recordings.ts) that the transcriber reads — do we kick off
   * transcription, if `/record stop transcribe:true` was used.
   */
  private async persist(
    sessionId: string,
    files: RegisterFileInput[],
    fileDir: string,
    opts?: TranscribeOpts,
  ): Promise<void> {
    for (const f of files) {
      await retryWithBackoff(() => this.api.registerFile(sessionId, f), BACKOFF);
    }
    await retryWithBackoff(() => this.api.completeSession(sessionId), BACKOFF);
    if (opts?.transcribe) this.fireTranscription(fileDir, opts.type);
  }

  /**
   * Requests transcription of a finished session. Two delivery paths:
   *  - Host dev (TRANSCRIBE_HOOK set): spawn the hook detached with
   *    `<session-dir-name> <type>` — runs `docker compose run transcriber` on the host.
   *  - In-container (no hook): drop a `_transcribe.request` marker into the session
   *    dir; the long-running transcriber-worker container picks it up. This is how
   *    `/record stop transcribe:true` reaches the worker without a host docker CLI.
   */
  private fireTranscription(fileDir: string, type: string): void {
    const hook = this.cfg.transcribeHook;
    const dirName = path.basename(fileDir);
    if (hook) {
      try {
        this.spawnFn(hook, [dirName, type], { detached: true, stdio: "ignore" }).unref();
        console.log(`[discord-bot] transcription launched for ${dirName} (type=${type}) via ${hook}`);
      } catch (err) {
        console.error("[discord-bot] failed to launch transcription hook:", err);
      }
      return;
    }
    // No hook → marker for the worker. Fire-and-forget (the worker polls).
    void this.dropTranscribeMarker(fileDir);
  }

  /** Drop the `_transcribe.request` marker the transcriber-worker watches for. */
  async dropTranscribeMarker(fileDir: string): Promise<void> {
    try {
      await writeFile(path.join(fileDir, TRANSCRIBE_MARKER), String(Date.now()));
      console.log(`[discord-bot] transcribe marker dropped for ${path.basename(fileDir)}`);
    } catch (err) {
      console.error("[discord-bot] failed to drop transcribe marker:", err);
    }
  }
}
