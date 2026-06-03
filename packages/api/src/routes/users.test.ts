import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { prisma } from "../prisma.js";
import { truncateAll } from "../test/db.js";

const app = createApp();
const ADMIN = "00000000-0000-0000-0000-000000000009";

describe("users router", () => {
  beforeEach(async () => {
    await truncateAll();
  });
  afterAll(async () => {
    const { connection, gameEventsQueue } = await import("../queue.js");
    await gameEventsQueue.close();
    await connection.quit();
  });

  it("requires admin", async () => {
    const res = await request(app).get("/api/users");
    expect(res.status).toBe(401);
  });

  it("lists users with linked flag", async () => {
    await prisma.user.create({ data: { telegramUserId: 1n, displayName: "A", discordUserId: "d-a" } });
    await prisma.user.create({ data: { telegramUserId: 2n, displayName: "B" } });
    const res = await request(app).get("/api/users").set("x-test-admin-id", ADMIN);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    const linkedFlags = res.body.map((u: { linked: boolean }) => u.linked).sort();
    expect(linkedFlags).toEqual([false, true]);
  });

  it("unlinks an existing user", async () => {
    const u = await prisma.user.create({ data: { telegramUserId: 3n, displayName: "C", discordUserId: "d-c" } });
    const res = await request(app).post(`/api/users/${u.id}/unlink-discord`).set("x-test-admin-id", ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.linked).toBe(false);
    const after = await prisma.user.findUnique({ where: { id: u.id } });
    expect(after?.discordUserId).toBeNull();
  });

  it("returns 404 unlinking an unknown user", async () => {
    const res = await request(app)
      .post("/api/users/00000000-0000-0000-0000-0000000000aa/unlink-discord")
      .set("x-test-admin-id", ADMIN);
    expect(res.status).toBe(404);
  });
});
