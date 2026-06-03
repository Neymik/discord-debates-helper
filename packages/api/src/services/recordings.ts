import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { buildConfig } from "../config.js";

const config = buildConfig();

export function sanitize(input: string): string {
  // Spec §13: conservative allowlist.
  return input.replace(/[^A-Za-z0-9_-]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
}

export function sessionDirName(startedAt: Date, channelName: string, sessionId: string): string {
  const ts = startedAt.toISOString().slice(0, 19).replace(/:/g, "-"); // 2026-06-03T19-00-00
  return `${ts}_${sanitize(channelName)}_${sessionId}`;
}

export class ActiveSessionConflict extends Error {}

export async function createSession(input: {
  startedByDiscordUserId: string;
  voiceChannelId: string;
  voiceChannelName: string;
  guildId: string;
}) {
  const id = crypto.randomUUID();
  const dirName = sessionDirName(new Date(), input.voiceChannelName, id);
  const fileDir = path.join(config.recordingsDir, dirName);
  try {
    const session = await prisma.recordingSession.create({
      data: {
        id,
        startedByDiscordUserId: input.startedByDiscordUserId,
        voiceChannelId: input.voiceChannelId,
        voiceChannelName: input.voiceChannelName,
        guildId: input.guildId,
        fileDir,
        status: "recording",
      },
    });
    await mkdir(fileDir, { recursive: true });
    return session;
  } catch (err) {
    // Partial unique index `one_active_recording_per_guild` (spec §3).
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new ActiveSessionConflict();
    }
    throw err;
  }
}

export async function registerFile(
  sessionId: string,
  body: {
    discordUserId: string;
    discordUsername: string;
    filePath: string;
    durationSec: number;
    sizeBytes: number;
  },
) {
  const user = await prisma.user.findUnique({ where: { discordUserId: body.discordUserId } });
  return prisma.recordingFile.upsert({
    where: { sessionId_discordUserId: { sessionId, discordUserId: body.discordUserId } },
    create: {
      sessionId,
      discordUserId: body.discordUserId,
      userId: user?.id ?? null,
      discordUsername: body.discordUsername,
      filePath: body.filePath,
      durationSec: body.durationSec,
      sizeBytes: BigInt(body.sizeBytes),
    },
    update: {
      durationSec: body.durationSec,
      sizeBytes: BigInt(body.sizeBytes),
      discordUsername: body.discordUsername,
    },
  });
}

export interface SessionMeta {
  id: string;
  startedAt: Date;
  endedAt: Date | null;
  voiceChannelId: string;
  voiceChannelName: string;
}
export interface FileMeta {
  discordUserId: string;
  discordUsername: string;
  telegramUserId: bigint | null;
  displayName: string | null;
  filePath: string;
  durationSec: number;
}

export function buildMetadata(session: SessionMeta, files: FileMeta[]) {
  return {
    session_id: session.id,
    started_at: session.startedAt.toISOString(),
    ended_at: session.endedAt?.toISOString() ?? null,
    voice_channel: { id: session.voiceChannelId, name: session.voiceChannelName },
    files: files.map((f) => ({
      discord_user_id: f.discordUserId,
      discord_username: f.discordUsername,
      telegram_user_id: f.telegramUserId ? Number(f.telegramUserId) : null,
      display_name: f.displayName,
      file: f.filePath,
      duration_sec: f.durationSec,
    })),
  };
}

export async function completeSession(sessionId: string) {
  const session = await prisma.recordingSession.findUnique({
    where: { id: sessionId },
    include: { files: { include: { user: true } } },
  });
  if (!session) return null;

  const endedAt = new Date();
  const meta = buildMetadata(
    { ...session, endedAt },
    session.files.map((f) => ({
      discordUserId: f.discordUserId,
      discordUsername: f.discordUsername,
      telegramUserId: f.user?.telegramUserId ?? null,
      displayName: f.user?.displayName ?? null,
      filePath: f.filePath,
      durationSec: f.durationSec,
    })),
  );
  await writeFile(path.join(session.fileDir, "_metadata.json"), JSON.stringify(meta, null, 2));

  return prisma.recordingSession.update({
    where: { id: sessionId },
    data: { status: "completed", endedAt },
  });
}
