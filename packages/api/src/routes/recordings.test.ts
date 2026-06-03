import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { truncateAll } from "../test/db.js";
import { buildConfig } from "../config.js";
import { prisma } from "../prisma.js";

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

  it("GET /api/recordings/sessions/:id serializes BigInt fields (linked user) without 500", async () => {
    // user linked to a discord id
    const user = await prisma.user.create({
      data: { telegramUserId: 555000n, displayName: "Linked", discordUserId: "d-linked" },
    });
    // create a session via the bot endpoint
    const created = await bot(request(app).post("/api/recordings/sessions").send(sessionBody));
    const sessionId = created.body.id;
    // register a file for that discord user (resolves user_id)
    await bot(
      request(app)
        .post(`/api/recordings/sessions/${sessionId}/files`)
        .send({ discord_user_id: "d-linked", discord_username: "linked", file_path: "linked.opus", duration_sec: 10, size_bytes: 12345 }),
    );
    const res = await request(app)
      .get(`/api/recordings/sessions/${sessionId}`)
      .set("x-test-admin-id", user.id);
    expect(res.status).toBe(200);
    expect(res.body.files).toHaveLength(1);
    expect(res.body.files[0].sizeBytes).toBe("12345");
    expect(res.body.files[0].user.telegramUserId).toBe("555000");
  });

  it("GET .../files/:discordUserId.opus returns 404 when the file is missing on disk", async () => {
    const created = await bot(request(app).post("/api/recordings/sessions").send(sessionBody));
    const sessionId = created.body.id;
    await bot(
      request(app)
        .post(`/api/recordings/sessions/${sessionId}/files`)
        .send({ discord_user_id: "d-x", discord_username: "x", file_path: "missing.opus", duration_sec: 5, size_bytes: 1 }),
    );
    const res = await request(app)
      .get(`/api/recordings/sessions/${sessionId}/files/d-x.opus`)
      .set("x-test-admin-id", "00000000-0000-0000-0000-000000000001");
    expect(res.status).toBe(404);
  });
});
