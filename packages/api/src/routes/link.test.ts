import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { prisma } from "../prisma.js";
import { truncateAll } from "../test/db.js";
import { buildConfig } from "../config.js";

const app = createApp();
const cfg = buildConfig();

describe("link router", () => {
  beforeEach(async () => {
    await truncateAll();
  });
  afterAll(async () => {
    const { connection, gameEventsQueue } = await import("../queue.js");
    await gameEventsQueue.close();
    await connection.quit();
  });

  it("issue requires the telegram bot token", async () => {
    const res = await request(app).post("/api/link/issue").send({ telegram_user_id: 1 });
    expect(res.status).toBe(401);
  });

  it("issues then redeems a code end to end", async () => {
    await prisma.user.create({ data: { telegramUserId: 42n, displayName: "Zed" } });
    const issued = await request(app)
      .post("/api/link/issue")
      .set("authorization", `Bearer ${cfg.telegramBotApiToken}`)
      .send({ telegram_user_id: 42 });
    expect(issued.status).toBe(201);
    const code = issued.body.code;
    const redeemed = await request(app)
      .post("/api/link/redeem")
      .set("authorization", `Bearer ${cfg.discordBotApiToken}`)
      .send({ code, discord_user_id: "d-42", discord_username: "zed" });
    expect(redeemed.status).toBe(200);
    expect(redeemed.body).toMatchObject({ telegram_user_id: 42, display_name: "Zed" });
  });

  it("redeem returns 404 for an unknown code", async () => {
    const res = await request(app)
      .post("/api/link/redeem")
      .set("authorization", `Bearer ${cfg.discordBotApiToken}`)
      .send({ code: "LINK-NOPE", discord_user_id: "d", discord_username: "x" });
    expect(res.status).toBe(404);
  });
});
