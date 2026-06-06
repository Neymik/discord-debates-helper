import { loadEnv } from "@debates/shared";

export interface BotConfig {
  botToken: string;
  clientId: string;
  guildId: string | undefined;
  apiBaseUrl: string;
  botApiToken: string;
  recordingsDir: string;
  announceChannelId: string;
  fallbackChannelId: string;
  redisUrl: string;
  maxSessionHours: number;
  announceEnabled: boolean;
}

/**
 * Builds the Discord bot's typed config from the shared env loader.
 * API_BASE_URL / RECORDINGS_DIR / DISCORD_GUILD_ID are bot-local and not part of
 * the shared schema, so they are read directly off `source` with defaults.
 */
export function buildBotConfig(source: Record<string, string | undefined> = process.env): BotConfig {
  const env = loadEnv(source);
  return {
    botToken: env.DISCORD_BOT_TOKEN,
    clientId: env.DISCORD_CLIENT_ID,
    guildId: source.DISCORD_GUILD_ID && source.DISCORD_GUILD_ID.length > 0 ? source.DISCORD_GUILD_ID : undefined,
    apiBaseUrl: source.API_BASE_URL ?? "http://api:3000",
    botApiToken: env.DISCORD_BOT_API_TOKEN,
    recordingsDir: source.RECORDINGS_DIR ?? "/var/lib/debates/recordings",
    announceChannelId: env.DEBATE_ANNOUNCE_CHANNEL_ID,
    fallbackChannelId: env.DEBATE_FALLBACK_CHANNEL_ID,
    redisUrl: env.REDIS_URL,
    maxSessionHours: env.MAX_SESSION_HOURS,
    // The pre-debate "starts in 30 min" announcer. On by default; set
    // ANNOUNCE_ENABLED=false to silence it (bot-local, not in the shared schema).
    announceEnabled: source.ANNOUNCE_ENABLED !== "false",
  };
}
