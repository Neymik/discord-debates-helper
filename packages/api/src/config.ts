import { loadEnv } from "@debates/shared";

export interface Config {
  port: number;
  recordingsDir: string;
  databaseUrl: string;
  redisUrl: string;
  jwtSecret: string;
  publicUrl: string;
  adminTelegramIds: bigint[];
  discordBotApiToken: string;
  telegramBotApiToken: string;
  maxSessionHours: number;
}

function parsePort(raw: string | undefined): number {
  if (!raw) return 3000;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 3000;
}

export function buildConfig(source: Record<string, string | undefined> = process.env): Config {
  const env = loadEnv(source);
  return {
    port: parsePort(source.PORT),
    recordingsDir: source.RECORDINGS_DIR ?? "/var/lib/debates/recordings",
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    jwtSecret: env.JWT_SECRET,
    publicUrl: env.PUBLIC_URL,
    adminTelegramIds: env.ADMIN_TELEGRAM_IDS,
    discordBotApiToken: env.DISCORD_BOT_API_TOKEN,
    telegramBotApiToken: env.TELEGRAM_BOT_API_TOKEN,
    maxSessionHours: env.MAX_SESSION_HOURS,
  };
}
