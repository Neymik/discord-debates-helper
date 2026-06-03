import { describe, it, expect } from "vitest";
import { buildConfig } from "./config.js";

const env = {
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
  PORT: "3000",
  RECORDINGS_DIR: "/var/lib/debates/recordings",
};

describe("buildConfig", () => {
  it("exposes port and recordings dir with defaults", () => {
    const cfg = buildConfig(env);
    expect(cfg.port).toBe(3000);
    expect(cfg.recordingsDir).toBe("/var/lib/debates/recordings");
    expect(cfg.discordBotApiToken).toBe("a".repeat(32));
  });

  it("defaults port to 3000 and recordingsDir when unset", () => {
    const { PORT, RECORDINGS_DIR, ...rest } = env;
    const cfg = buildConfig(rest);
    expect(cfg.port).toBe(3000);
    expect(cfg.recordingsDir).toBe("/var/lib/debates/recordings");
  });

  it("honors an explicit non-default PORT", () => {
    const cfg = buildConfig({ ...env, PORT: "4100" });
    expect(cfg.port).toBe(4100);
  });

  it("falls back to 3000 when PORT is non-numeric", () => {
    const cfg = buildConfig({ ...env, PORT: "abc" });
    expect(cfg.port).toBe(3000);
  });
});
