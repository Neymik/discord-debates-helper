import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createHash, createHmac } from "node:crypto";
import { createApp } from "../app.js";
import { truncateAll } from "../test/db.js";

const app = createApp();
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const ADMIN_ID = process.env.ADMIN_TELEGRAM_IDS!.split(",")[0]!.trim();

function sign(data: Record<string, string>): Record<string, string> {
  const checkString = Object.keys(data).sort().map((k) => `${k}=${data[k]}`).join("\n");
  const secret = createHash("sha256").update(BOT_TOKEN).digest();
  const hash = createHmac("sha256", secret).update(checkString).digest("hex");
  return { ...data, hash };
}

function authDate(): string {
  // current unix seconds; tests run with NODE_ENV=test but the /auth/telegram
  // route does NOT use the test bypass, so the signature + freshness are real.
  return String(Math.floor(Date.now() / 1000));
}

describe("admin auth router", () => {
  beforeEach(async () => {
    await truncateAll();
  });
  afterAll(async () => {
    const { connection, gameEventsQueue } = await import("../queue.js");
    await gameEventsQueue.close();
    await connection.quit();
  });

  it("logs in an allowlisted admin and returns display_name", async () => {
    const res = await request(app)
      .post("/api/admin/auth/telegram")
      .send(sign({ id: ADMIN_ID, first_name: "Ada", last_name: "Love", auth_date: authDate() }));
    expect(res.status).toBe(200);
    expect(res.body.display_name).toBe("Ada Love");
    expect(res.headers["set-cookie"]?.[0]).toMatch(/debates_session=/);
  });

  it("refreshes display_name on re-login", async () => {
    await request(app)
      .post("/api/admin/auth/telegram")
      .send(sign({ id: ADMIN_ID, first_name: "Old", auth_date: authDate() }));
    const res = await request(app)
      .post("/api/admin/auth/telegram")
      .send(sign({ id: ADMIN_ID, first_name: "New", auth_date: authDate() }));
    expect(res.status).toBe(200);
    expect(res.body.display_name).toBe("New");
  });

  it("rejects a non-allowlisted telegram id with 403", async () => {
    const res = await request(app)
      .post("/api/admin/auth/telegram")
      .send(sign({ id: "999999999", first_name: "Mallory", auth_date: authDate() }));
    expect(res.status).toBe(403);
  });

  it("rejects a tampered signature with 401", async () => {
    const good = sign({ id: ADMIN_ID, first_name: "Ada", auth_date: authDate() });
    const res = await request(app)
      .post("/api/admin/auth/telegram")
      .send({ ...good, id: "111" });
    expect(res.status).toBe(401);
  });

  it("logout clears the cookie", async () => {
    const res = await request(app).post("/api/admin/auth/logout");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
