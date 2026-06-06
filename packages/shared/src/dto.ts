import { z } from "zod";

const snowflake = z.string().min(1).max(32);

export const CreateRecordingSessionBody = z.object({
  started_by_discord_user_id: snowflake,
  voice_channel_id: snowflake,
  voice_channel_name: z.string().min(1).max(200),
  guild_id: snowflake,
});
export type CreateRecordingSessionBody = z.infer<typeof CreateRecordingSessionBody>;

/**
 * One contiguous speaking burst within a speaker's compacted .ogg file.
 * `wall_ms` is the offset from the session's started_at; `audio_offset_ms` is
 * where the burst begins inside the compacted audio (which omits silence).
 * Together they let a transcription pipeline convert Whisper's file-relative
 * timestamps to wall-clock and merge speakers into a single ordered timeline.
 */
export const RecordingSegment = z.object({
  wall_ms: z.number().int().nonnegative(),
  audio_offset_ms: z.number().int().nonnegative(),
  duration_ms: z.number().int().nonnegative(),
});
export type RecordingSegment = z.infer<typeof RecordingSegment>;

export const RegisterRecordingFileBody = z.object({
  discord_user_id: snowflake,
  discord_username: z.string().min(1).max(200),
  file_path: z.string().min(1),
  duration_sec: z.number().int().nonnegative(),
  size_bytes: z.number().int().nonnegative(),
  // Optional for backward compatibility; older callers register files without a timeline.
  segments: z.array(RecordingSegment).default([]),
});
export type RegisterRecordingFileBody = z.infer<typeof RegisterRecordingFileBody>;

export const IssueLinkBody = z.object({
  telegram_user_id: z.coerce.bigint(),
});
export type IssueLinkBody = z.infer<typeof IssueLinkBody>;

export const RedeemLinkBody = z.object({
  code: z.string().min(1).max(32),
  discord_user_id: snowflake,
  discord_username: z.string().min(1).max(200),
});
export type RedeemLinkBody = z.infer<typeof RedeemLinkBody>;
