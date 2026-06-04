import { JOB_TYPES, jobIdFor, type JobType } from "@debates/shared";
import { prisma } from "../prisma.js";
import { gameEventsQueue } from "../queue.js";
import { jobsToEnqueue } from "./jobs.js";

export interface AnnounceParticipant {
  display_name: string;
  discord_user_id: string | null;
  telegram_username: string | null;
}
export interface AnnouncePayload {
  motion: string | null;
  participants: AnnounceParticipant[];
}
export interface GameEventPayload {
  gameId: string;
  type: JobType;
  announce?: AnnouncePayload; // present ONLY on announce_t30 jobs
}

/** Builds the announce snapshot from a game with participants+users loaded. */
export function announceFromGame(game: {
  motion: string | null;
  participants: { user: { displayName: string; discordUserId: string | null; telegramUsername: string | null } }[];
}): AnnouncePayload {
  return {
    motion: game.motion,
    participants: game.participants.map((p) => ({
      display_name: p.user.displayName,
      discord_user_id: p.user.discordUserId,
      telegram_username: p.user.telegramUsername,
    })),
  };
}

/** Enqueue all (future-dated) notification jobs for a game. Idempotent. */
export async function enqueueGameJobs(
  gameId: string,
  scheduledAt: Date,
  now = new Date(),
  announce?: AnnouncePayload,
): Promise<void> {
  const planned = jobsToEnqueue(gameId, scheduledAt, now);
  for (const job of planned) {
    const data: GameEventPayload = { gameId, type: job.type };
    if (job.type === "announce_t30" && announce) data.announce = announce;
    await gameEventsQueue.add(job.type, data, {
      jobId: job.jobId,
      delay: job.delayMs,
      removeOnComplete: true,
      removeOnFail: 1000,
    });
  }
}

/** Remove all unfired jobs for a game (used on reschedule and cancel). */
export async function removeGameJobs(gameId: string): Promise<void> {
  for (const type of JOB_TYPES) {
    const job = await gameEventsQueue.getJob(jobIdFor(gameId, type));
    if (job) {
      // Only delayed/waiting jobs are removable; ignore already-active/finished.
      await job.remove().catch(() => undefined);
    }
  }
}

/** Reschedule = remove then re-enqueue at the new offsets (applies the guard). */
export async function rescheduleGameJobs(
  gameId: string,
  scheduledAt: Date,
  now = new Date(),
  announce?: AnnouncePayload,
): Promise<void> {
  await removeGameJobs(gameId);
  await enqueueGameJobs(gameId, scheduledAt, now, announce);
}

/**
 * Reconciliation (spec §4): re-derive jobs from Postgres for every future
 * scheduled game and enqueue any missing ones. Idempotent via jobId, so a
 * wiped Redis self-heals. Run at API boot and hourly (see crons.ts).
 */
export async function reconcileJobs(now = new Date()): Promise<number> {
  const games = await prisma.game.findMany({
    where: { status: "scheduled", scheduledAt: { gt: now } },
    include: { participants: { include: { user: true } } },
  });
  for (const game of games) {
    await enqueueGameJobs(game.id, game.scheduledAt, now, announceFromGame(game));
  }
  return games.length;
}
