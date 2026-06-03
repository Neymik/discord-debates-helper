/** BullMQ job type names on the `game-events` queue (Plan 2 consumes these). */
export const JOB_TYPES = [
  "notify_week_before",
  "notify_day_before",
  "notify_hour_before",
  "nudge_unlinked_40m",
  "announce_t30",
  "notify_t10",
] as const;
export type JobType = (typeof JOB_TYPES)[number];

/** Offset in milliseconds BEFORE scheduled_at at which each job fires. */
export const JOB_OFFSETS_MS: Record<JobType, number> = {
  notify_week_before: 7 * 24 * 60 * 60 * 1000,
  notify_day_before: 24 * 60 * 60 * 1000,
  notify_hour_before: 60 * 60 * 1000,
  nudge_unlinked_40m: 40 * 60 * 1000,
  announce_t30: 30 * 60 * 1000,
  notify_t10: 10 * 60 * 1000,
};

export const GAME_STATUS = ["scheduled", "cancelled"] as const;
export type GameStatus = (typeof GAME_STATUS)[number];

export const RECORDING_STATUS = ["recording", "completed", "failed"] as const;
export type RecordingStatus = (typeof RECORDING_STATUS)[number];

export const QUEUE_NAME = "game-events";

/** Deterministic BullMQ jobId so reconciliation/reschedule are idempotent. */
export function jobIdFor(gameId: string, type: JobType): string {
  return `game:${gameId}:${type}`;
}
