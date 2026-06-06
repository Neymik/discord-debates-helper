import { mkdir } from "node:fs/promises";
import { statSync } from "node:fs";
import path from "node:path";
import { joinVoiceChannel, EndBehaviorType, type VoiceConnection } from "@discordjs/voice";
import type { VoiceBasedChannel, TextBasedChannel } from "discord.js";
import type { ApiClient } from "../apiClient.js";
import type { BotConfig } from "../config.js";
import { OpusFileWriter } from "./opusFile.js";
import { recordingFileName } from "./filename.js";
import { retryWithBackoff } from "../lib/backoff.js";
import { capTimings } from "./caps.js";

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
}

const BACKOFF = { baseMs: 1000, capMs: 60_000, totalBudgetMs: 3_600_000 };

export class RecordingManager {
  private readonly active = new Map<string, ActiveRecording>();

  constructor(
    private readonly api: ApiClient,
    private readonly cfg: BotConfig,
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
      cap.segments.push({
        wallMs: cap.openSegment.wallMs,
        audioOffsetMs: cap.openSegment.audioOffsetMs,
        durationMs: Math.max(0, endMs - cap.openSegment.wallMs),
      });
      cap.openSegment = null;
    });

    const { warnAfterMs, stopAfterMs } = capTimings(this.cfg.maxSessionHours);
    const warnTimer = setTimeout(onWarn, warnAfterMs);
    const stopTimer = setTimeout(onAutoStop, stopAfterMs);

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
    });
  }

  /** Emergency teardown without metadata writes (used when the consent reply fails). */
  async abort(guildId: string): Promise<void> {
    const rec = this.active.get(guildId);
    if (!rec) return;
    clearTimeout(rec.warnTimer);
    clearTimeout(rec.stopTimer);
    if (rec.connection.state.status !== "destroyed") rec.connection.destroy();
    this.active.delete(guildId);
  }

  /**
   * Ends all streams, closes the connection, registers each non-empty file with
   * exponential backoff (spec §5: up to ~1h), then completes the session.
   * Returns the speaker count + total duration for the reply.
   */
  async stop(guildId: string): Promise<{ speakerCount: number; totalDurationSec: number } | null> {
    const rec = this.active.get(guildId);
    if (!rec) return null;
    clearTimeout(rec.warnTimer);
    clearTimeout(rec.stopTimer);
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

    let totalDurationSec = 0;
    let speakerCount = 0;
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
      speakerCount++;
      await retryWithBackoff(
        () =>
          this.api.registerFile(rec.sessionId, {
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
          }),
        BACKOFF,
      );
    }

    rec.connection.destroy(); // cleanup (streams already ended above)
    await retryWithBackoff(() => this.api.completeSession(rec.sessionId), BACKOFF);
    this.active.delete(guildId);
    return { speakerCount, totalDurationSec };
  }
}
