import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { truncateAll } from "../test/db.js";
import { buildConfig } from "../config.js";

const app = createApp();
const token = buildConfig().discordBotApiToken;

function bot(req: request.Test) {
  return req.set("authorization", `Bearer ${token}`);
}

const sessionBody = {
  started_by_discord_user_id: "111",
  voice_channel_id: "v1",
  voice_channel_name: "Main",
  guild_id: "g1",
};

describe("recordings router", () => {
  beforeEach(async () => {
    await truncateAll();
  });
  afterAll(async () => {
    const { connection, gameEventsQueue } = await import("../queue.js");
    await gameEventsQueue.close();
    await connection.quit();
  });

  it("rejects without bot token", async () => {
    const res = await request(app).post("/api/recordings/sessions").send(sessionBody);
    expect(res.status).toBe(401);
  });

  it("creates a session then 409s on a concurrent second start in the same guild", async () => {
    const first = await bot(request(app).post("/api/recordings/sessions").send(sessionBody));
    expect(first.status).toBe(201);
    const second = await bot(request(app).post("/api/recordings/sessions").send(sessionBody));
    expect(second.status).toBe(409);
  });

  it("GET /api/recordings/sessions lists sessions for admin", async () => {
    await bot(request(app).post("/api/recordings/sessions").send(sessionBody));
    const res = await request(app)
      .get("/api/recordings/sessions")
      .set("x-test-admin-id", "00000000-0000-0000-0000-000000000001");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });
});
