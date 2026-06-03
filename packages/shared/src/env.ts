import { z } from "zod";

const csvBigInts = z
  .string()
  .min(1)
  .transform((s, ctx) => {
    const out: bigint[] = [];
    for (const part of s.split(",")) {
      const trimmed = part.trim();
      try {
        out.push(BigInt(trimmed));
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `"${trimmed}" is not a valid integer` });
        return z.NEVER;
      }
    }
    return out;
  });

export const EnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 chars"),
  PUBLIC_URL: z.string().url(),
  ADMIN_TELEGRAM_IDS: csvBigInts,
  DISCORD_BOT_API_TOKEN: z.string().min(32),
  TELEGRAM_BOT_API_TOKEN: z.string().min(32),
  DISCORD_BOT_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  DEBATE_ANNOUNCE_CHANNEL_ID: z.string().min(1),
  DEBATE_FALLBACK_CHANNEL_ID: z.string().min(1),
  MAX_SESSION_HOURS: z.coerce.number().int().positive().default(4),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_BOT_USERNAME: z.string().min(1),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment: ${issues}`);
  }
  return result.data;
}
