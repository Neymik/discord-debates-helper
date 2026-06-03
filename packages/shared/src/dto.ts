import { z } from "zod";

const snowflake = z.string().min(1).max(32);

export const CreateRecordingSessionBody = z.object({
  started_by_discord_user_id: snowflake,
  voice_channel_id: snowflake,
  voice_channel_name: z.string().min(1).max(200),
  guild_id: snowflake,
});
export type CreateRecordingSessionBody = z.infer<typeof CreateRecordingSessionBody>;

export const RegisterRecordingFileBody = z.object({
  discord_user_id: snowflake,
  discord_username: z.string().min(1).max(200),
  file_path: z.string().min(1),
  duration_sec: z.number().int().nonnegative(),
  size_bytes: z.number().int().nonnegative(),
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
