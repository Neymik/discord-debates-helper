import { rm } from "node:fs/promises";
import cron from "node-cron";
import { prisma } from "./prisma.js";
import { buildConfig } from "./config.js";
import { reconcileJobs } from "./scheduler/scheduler.js";

const config = buildConfig();

/** Delete completed AND failed sessions older than 30 days + their dirs. */
export async function cleanupOldRecordings(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 30 * 86400000);
  const sessions = await prisma.recordingSession.findMany({
    where: {
      status: { in: ["completed", "failed"] },
      OR: [{ endedAt: { lt: cutoff } }, { endedAt: null, startedAt: { lt: cutoff } }],
    },
  });
  for (const s of sessions) {
    await rm(s.fileDir, { recursive: true, force: true });
    // dir removed before row; if we crash between the two, next run's force-rm + delete self-heals
    await prisma.recordingSession.delete({ where: { id: s.id } }); // cascades files
  }
  return sessions.length;
}

/** Orphaned 'recording' rows (bot crashed) -> 'failed', releasing the guild lock. */
export async function reapStuckSessions(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - (config.maxSessionHours + 1) * 3600000);
  const result = await prisma.recordingSession.updateMany({
    where: { status: "recording", startedAt: { lt: cutoff } },
    data: { status: "failed", endedAt: now },
  });
  return result.count;
}

/**
 * Registers the scheduled crons. Call once from server.ts.
 * NOTE: in-process, single-instance crons (phase-1, one container). Multiple
 * replicas would need a distributed lock to avoid concurrent runs.
 */
export function startCrons(): void {
  cron.schedule("0 4 * * *", () =>
    cleanupOldRecordings().catch((err) => console.error("[cron] cleanupOldRecordings failed:", err)),
  ); // daily 04:00
  cron.schedule("*/15 * * * *", () =>
    reapStuckSessions().catch((err) => console.error("[cron] reapStuckSessions failed:", err)),
  ); // every 15 min
  cron.schedule("0 * * * *", () =>
    reconcileJobs().catch((err) => console.error("[cron] reconcileJobs failed:", err)),
  ); // hourly reconcile safety net
}
