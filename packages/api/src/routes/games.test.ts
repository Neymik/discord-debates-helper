import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { prisma } from "../prisma.js";
import { truncateAll } from "../test/db.js";
import { gameEventsQueue, connection } from "../queue.js";

const app = createApp();

async function seedAdminUser() {
  return prisma.user.create({
    data: { telegramUserId: 898912046n, displayName: "Admin", telegramUsername: "admin" },
  });
}

function asAdmin(req: request.Test, userId: string) {
  return req.set("x-test-admin-id", userId);
}

describe("games router", () => {
  beforeEach(async () => {
    await truncateAll();
  });
  afterAll(async () => {
    await gameEventsQueue.close();
    await connection.quit();
  });

  it("POST /api/games creates a game and 201s", async () => {
    const admin = await seedAdminUser();
    const res = await asAdmin(
      request(app)
        .post("/api/games")
        .send({
          scheduled_at: new Date(Date.now() + 3 * 86400000).toISOString(),
          motion: "THW ban X",
          participant_user_ids: [admin.id],
        }),
      admin.id,
    );
    expect(res.status).toBe(201);
    expect(res.body.motion).toBe("THW ban X");
    expect(res.body.participants).toHaveLength(1);
  });

  it("GET /api/games lists scheduled games", async () => {
    const admin = await seedAdminUser();
    await prisma.game.create({
      data: { scheduledAt: new Date(Date.now() + 86400000), createdById: admin.id },
    });
    const res = await asAdmin(request(app).get("/api/games?status=scheduled"), admin.id);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it("POST /api/games/:id/cancel sets status cancelled", async () => {
    const admin = await seedAdminUser();
    const game = await prisma.game.create({
      data: { scheduledAt: new Date(Date.now() + 86400000), createdById: admin.id },
    });
    const res = await asAdmin(request(app).post(`/api/games/${game.id}/cancel`), admin.id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");
  });
});
