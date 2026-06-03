import { Router } from "express";
import { CreateRecordingSessionBody, RegisterRecordingFileBody } from "@debates/shared";
import { requireBotToken } from "../middleware/botAuth.js";
import { buildConfig } from "../config.js";
import * as rec from "../services/recordings.js";

const config = buildConfig();

export const recordingsRouter = Router();

// Bot-only write endpoints.
recordingsRouter.post("/sessions", requireBotToken(config.discordBotApiToken), async (req, res) => {
  const body = CreateRecordingSessionBody.parse(req.body);
  try {
    const session = await rec.createSession({
      startedByDiscordUserId: body.started_by_discord_user_id,
      voiceChannelId: body.voice_channel_id,
      voiceChannelName: body.voice_channel_name,
      guildId: body.guild_id,
    });
    res.status(201).json(session);
  } catch (err) {
    if (err instanceof rec.ActiveSessionConflict) {
      return res.status(409).json({ error: "active_session_exists" });
    }
    throw err;
  }
});

recordingsRouter.post<{ id: string }>("/sessions/:id/files", requireBotToken(config.discordBotApiToken), async (req, res) => {
  const body = RegisterRecordingFileBody.parse(req.body);
  const file = await rec.registerFile(req.params.id, {
    discordUserId: body.discord_user_id,
    discordUsername: body.discord_username,
    filePath: body.file_path,
    durationSec: body.duration_sec,
    sizeBytes: body.size_bytes,
  });
  res.status(201).json({ session_id: file.sessionId, discord_user_id: file.discordUserId });
});

recordingsRouter.post<{ id: string }>("/sessions/:id/complete", requireBotToken(config.discordBotApiToken), async (req, res) => {
  const session = await rec.completeSession(req.params.id);
  if (!session) return res.status(404).json({ error: "not_found" });
  res.json(session);
});

// Admin read endpoints are added in Task 6 (list/detail/download/zip).
