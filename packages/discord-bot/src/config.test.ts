import { describe, it, expect } from "vitest";
import { buildBotConfig } from "./config.js";

const base = {
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
  JWT_SECRET: "x".repeat(32),
  PUBLIC_URL: "https://debates.example.com",
  ADMIN_TELEGRAM_IDS: "898912046",
  DISCORD_BOT_API_TOKEN: "a".repeat(32),
  TELEGRAM_BOT_API_TOKEN: "b".repeat(32),
  DISCORD_BOT_TOKEN: "dtoken",
  DISCORD_CLIENT_ID: "1511558875571159201",
  DEBATE_ANNOUNCE_CHANNEL_ID: "607662041561563167",
  DEBATE_FALLBACK_CHANNEL_ID: "607662041561563167",
  TELEGRAM_BOT_TOKEN: "ttoken",
  TELEGRAM_BOT_USERNAME: "tooronkaich_bot",
};

describe("buildBotConfig", () => {
  it("derives the API base URL, recordings dir, and caps", () => {
    const cfg = buildBotConfig({ ...base, RECORDINGS_DIR: "/data/rec", API_BASE_URL: "http://api:3000" });
    expect(cfg.apiBaseUrl).toBe("http://api:3000");
    expect(cfg.recordingsDir).toBe("/data/rec");
    expect(cfg.maxSessionHours).toBe(4);
    expect(cfg.botToken).toBe("dtoken");
    expect(cfg.clientId).toBe("1511558875571159201");
    expect(cfg.announceChannelId).toBe("607662041561563167");
    expect(cfg.botApiToken).toBe("a".repeat(32));
  });

  it("defaults API_BASE_URL to http://api:3000 and recordings dir to the shared volume", () => {
    const cfg = buildBotConfig(base);
    expect(cfg.apiBaseUrl).toBe("http://api:3000");
    expect(cfg.recordingsDir).toBe("/var/lib/debates/recordings");
  });

  it("requires a guild id for guild-scoped command registration", () => {
    expect(() => buildBotConfig({ ...base, DISCORD_GUILD_ID: "" })).not.toThrow();
    const cfg = buildBotConfig({ ...base, DISCORD_GUILD_ID: "5550001" });
    expect(cfg.guildId).toBe("5550001");
  });

  it("enables the announce worker by default and disables it only on ANNOUNCE_ENABLED=false", () => {
    expect(buildBotConfig(base).announceEnabled).toBe(true);
    expect(buildBotConfig({ ...base, ANNOUNCE_ENABLED: "true" }).announceEnabled).toBe(true);
    expect(buildBotConfig({ ...base, ANNOUNCE_ENABLED: "false" }).announceEnabled).toBe(false);
  });
});
