import { JOB_TYPES, JOB_OFFSETS_MS, jobIdFor, type JobType } from "@debates/shared";

export interface PlannedJob {
  type: JobType;
  jobId: string;
  /** Milliseconds from `now` until the job should fire (always >= 0). */
  delayMs: number;
}

/**
 * Computes the BullMQ jobs to enqueue for a game.
 * Past-offset guard (spec §4): any job whose fire time is already <= now is
 * dropped, because BullMQ runs non-positive-delay jobs immediately — without
 * this guard a short-notice game would instantly fire "Debate next week".
 */
export function jobsToEnqueue(gameId: string, scheduledAt: Date, now: Date): PlannedJob[] {
  const planned: PlannedJob[] = [];
  for (const type of JOB_TYPES) {
    const fireAt = scheduledAt.getTime() - JOB_OFFSETS_MS[type];
    const delayMs = fireAt - now.getTime();
    if (delayMs < 0) continue; // already past -> skip
    planned.push({ type, jobId: jobIdFor(gameId, type), delayMs });
  }
  return planned;
}
