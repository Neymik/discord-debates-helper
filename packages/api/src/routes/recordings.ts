import { Router } from "express";
import { createReadStream } from "node:fs";
import path from "node:path";
import archiver from "archiver";
import { CreateRecordingSessionBody, RegisterRecordingFileBody } from "@debates/shared";
import { requireBotToken } from "../middleware/botAuth.js";
import { requireAdmin } from "../auth/requireAdmin.js";
import { buildConfig } from "../config.js";
import { prisma } from "../prisma.js";
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

recordingsRouter.get("/sessions", requireAdmin, async (_req, res) => {
  const sessions = await prisma.recordingSession.findMany({
    orderBy: { startedAt: "desc" },
    include: { _count: { select: { files: true } }, files: { select: { userId: true } } },
  });
  res.json(
    sessions.map((s) => ({
      id: s.id,
      started_at: s.startedAt,
      ended_at: s.endedAt,
      voice_channel_name: s.voiceChannelName,
      status: s.status,
      speaker_count: s._count.files,
      identified_count: s.files.filter((f) => f.userId).length,
    })),
  );
});

recordingsRouter.get<{ id: string }>("/sessions/:id", requireAdmin, async (req, res) => {
  const session = await prisma.recordingSession.findUnique({
    where: { id: req.params.id },
    include: { files: { include: { user: true } } },
  });
  if (!session) return res.status(404).json({ error: "not_found" });
  res.json({
    ...session,
    files: session.files.map((f) => ({
      ...f,
      sizeBytes: f.sizeBytes.toString(),
      user: f.user ? { ...f.user, telegramUserId: f.user.telegramUserId.toString() } : null,
    })),
  });
});

recordingsRouter.get<{ id: string; discordUserId: string }>("/sessions/:id/files/:discordUserId.opus", requireAdmin, async (req, res) => {
  const file = await prisma.recordingFile.findUnique({
    where: { sessionId_discordUserId: { sessionId: req.params.id, discordUserId: req.params.discordUserId } },
    include: { session: true },
  });
  if (!file) return res.status(404).json({ error: "not_found" });
  res.setHeader("Content-Type", "audio/ogg");
  res.setHeader("Content-Disposition", `attachment; filename="${path.basename(file.filePath)}"`);
  const stream = createReadStream(path.join(file.session.fileDir, file.filePath));
  stream.on("error", (err: NodeJS.ErrnoException) => {
    if (!res.headersSent) {
      res.status(err.code === "ENOENT" ? 404 : 500).json({ error: err.code === "ENOENT" ? "file_not_found" : "read_error" });
    } else {
      res.destroy(err);
    }
  });
  stream.pipe(res);
});

recordingsRouter.get<{ id: string }>("/sessions/:id/zip", requireAdmin, async (req, res) => {
  const session = await prisma.recordingSession.findUnique({
    where: { id: req.params.id },
    include: { files: true },
  });
  if (!session) return res.status(404).json({ error: "not_found" });
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="session-${session.id}.zip"`);
  const archive = archiver("zip");
  archive.on("error", (e) => res.destroy(e));
  archive.on("warning", (err) => console.warn(`[api] zip warning for session ${session.id}:`, err));
  archive.pipe(res);
  for (const f of session.files) {
    archive.file(path.join(session.fileDir, f.filePath), { name: f.filePath });
  }
  archive.file(path.join(session.fileDir, "_metadata.json"), { name: "_metadata.json" });
  await archive.finalize();
});
