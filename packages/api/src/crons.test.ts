import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { prisma } from "./prisma.js";
import { truncateAll } from "./test/db.js";
import { cleanupOldRecordings, reapStuckSessions } from "./crons.js";

describe("cleanupOldRecordings", () => {
  beforeEach(async () => {
    await truncateAll();
  });
  afterAll(async () => {
    const { connection, gameEventsQueue } = await import("./queue.js");
    await gameEventsQueue.close();
    await connection.quit();
  });

  it("deletes completed AND failed sessions older than 30 days, plus their dirs", async () => {
    const oldDir = mkdtempSync(path.join(tmpdir(), "rec-"));
    const old = new Date(Date.now() - 31 * 86400000);
    await prisma.recordingSession.create({
      data: {
        startedByDiscordUserId: "1", voiceChannelId: "v", voiceChannelName: "n",
        guildId: "g1", fileDir: oldDir, status: "failed", startedAt: old, endedAt: old,
      },
    });
    const deleted = await cleanupOldRecordings();
    expect(deleted).toBe(1);
    expect(existsSync(oldDir)).toBe(false);
    expect(await prisma.recordingSession.count()).toBe(0);
  });

  it("does not delete recent sessions", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rec-"));
    await prisma.recordingSession.create({
      data: {
        startedByDiscordUserId: "1", voiceChannelId: "v", voiceChannelName: "n",
        guildId: "g2", fileDir: dir, status: "completed", endedAt: new Date(),
      },
    });
    expect(await cleanupOldRecordings()).toBe(0);
  });
});

describe("reapStuckSessions", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("flips long-running 'recording' sessions to 'failed', releasing the guild lock", async () => {
    const stale = new Date(Date.now() - 6 * 3600000); // 6h ago, cap is 4h
    await prisma.recordingSession.create({
      data: {
        startedByDiscordUserId: "1", voiceChannelId: "v", voiceChannelName: "n",
        guildId: "g3", fileDir: "/tmp/x", status: "recording", startedAt: stale,
      },
    });
    const reaped = await reapStuckSessions();
    expect(reaped).toBe(1);
    const row = await prisma.recordingSession.findFirst({ where: { guildId: "g3" } });
    expect(row?.status).toBe("failed");
    expect(row?.endedAt).not.toBeNull();
  });
});
