import { describe, it, expect } from "vitest";
import { loadEnv } from "./env.js";

const base = {
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
  JWT_SECRET: "x".repeat(32),
  PUBLIC_URL: "https://debates.example.com",
  ADMIN_TELEGRAM_IDS: "898912046,123",
  DISCORD_BOT_API_TOKEN: "a".repeat(32),
  TELEGRAM_BOT_API_TOKEN: "b".repeat(32),
  DISCORD_BOT_TOKEN: "dtoken",
  DISCORD_CLIENT_ID: "1511558875571159201",
  DEBATE_ANNOUNCE_CHANNEL_ID: "607662041561563167",
  DEBATE_FALLBACK_CHANNEL_ID: "607662041561563167",
  TELEGRAM_BOT_TOKEN: "ttoken",
  TELEGRAM_BOT_USERNAME: "tooronkaich_bot",
};

describe("loadEnv", () => {
  it("parses a valid environment and coerces admin IDs to bigint[]", () => {
    const env = loadEnv(base);
    expect(env.ADMIN_TELEGRAM_IDS).toEqual([898912046n, 123n]);
    expect(env.MAX_SESSION_HOURS).toBe(4); // default applied
  });

  it("throws a descriptive error when a required var is missing", () => {
    const { DATABASE_URL, ...withoutDb } = base;
    expect(() => loadEnv(withoutDb)).toThrow(/DATABASE_URL/);
  });

  it("rejects a JWT_SECRET shorter than 32 chars", () => {
    expect(() => loadEnv({ ...base, JWT_SECRET: "short" })).toThrow(/JWT_SECRET/);
  });
});
