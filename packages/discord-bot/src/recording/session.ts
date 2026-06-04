import { mkdir } from "node:fs/promises";
import { statSync } from "node:fs";
import path from "node:path";
import {
  joinVoiceChannel,
  EndBehaviorType,
  getVoiceConnection,
  type VoiceConnection,
} from "@discordjs/voice";
import type { VoiceBasedChannel, TextBasedChannel } from "discord.js";
import type { ApiClient } from "../apiClient.js";
import type { BotConfig } from "../config.js";
import { OpusFileWriter } from "./opusFile.js";
import { recordingFileName } from "./filename.js";
import { retryWithBackoff } from "../lib/backoff.js";
import { capTimings } from "./caps.js";

interface UserCapture {
  writer: OpusFileWriter;
  filePath: string;
  fileName: string;
  discordUsername: string;
  startedAtMs: number;
  finished: Promise<{ bytesWritten: number }>;
}

interface ActiveRecording {
  sessionId: string;
  fileDir: string;
  guildId: string;
  voiceChannelName: string;
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

    receiver.speaking.on("start", (userId: string) => {
      if (captures.has(userId)) return; // already capturing this user
      const member = voiceChannel.members.get(userId);
      const username = member?.user.username ?? "user";
      const fileName = recordingFileName(username, userId);
      const filePath = path.join(session.fileDir, fileName);
      const opusStream = receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.Manual }, // we end it ourselves on /record stop
      });
      const writer = new OpusFileWriter(filePath);
      writer.start(opusStream);
      captures.set(userId, {
        writer,
        filePath,
        fileName,
        discordUsername: username,
        startedAtMs: Date.now(),
        finished: writer.finish(),
      });
    });

    const { warnAfterMs, stopAfterMs } = capTimings(this.cfg.maxSessionHours);
    const warnTimer = setTimeout(onWarn, warnAfterMs);
    const stopTimer = setTimeout(onAutoStop, stopAfterMs);

    this.active.set(guildId, {
      sessionId: session.id,
      fileDir: session.fileDir,
      guildId,
      voiceChannelName: voiceChannel.name,
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
    rec.connection.destroy();
    getVoiceConnection(guildId)?.destroy();
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

    // End every receive stream and let each writer flush its Ogg file.
    rec.connection.receiver.speaking.removeAllListeners();
    rec.connection.destroy();

    let totalDurationSec = 0;
    let speakerCount = 0;
    for (const [discordUserId, cap] of rec.captures) {
      const { bytesWritten } = await cap.finished;
      if (bytesWritten <= 0) continue; // skip empty files (spec §5 step 2: non-empty only)
      let sizeBytes = bytesWritten;
      try {
        sizeBytes = statSync(cap.filePath).size;
      } catch {
        /* keep the in-memory count */
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
          }),
        BACKOFF,
      );
    }

    await retryWithBackoff(() => this.api.completeSession(rec.sessionId), BACKOFF);
    this.active.delete(guildId);
    return { speakerCount, totalDurationSec };
  }
}
