import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { generateCode, issueCode, redeemCode } from "./linkcodes.js";
import { prisma } from "../prisma.js";
import { truncateAll } from "../test/db.js";

describe("generateCode", () => {
  it("produces LINK-XXXX uppercase alphanumeric", () => {
    const code = generateCode();
    expect(code).toMatch(/^LINK-[A-Z0-9]{4,}$/);
  });
});

describe("issue + redeem", () => {
  beforeEach(async () => {
    await truncateAll();
  });
  afterAll(async () => {
    const { connection, gameEventsQueue } = await import("../queue.js");
    await gameEventsQueue.close();
    await connection.quit();
  });

  it("redeems a valid code and links the discord id to the user", async () => {
    const user = await prisma.user.create({ data: { telegramUserId: 5n, displayName: "Bo" } });
    const { code } = await issueCode(5n);
    const result = await redeemCode(code, "disc-1", "bo#1");
    expect(result).toMatchObject({ telegram_user_id: 5, display_name: "Bo" });
    const updated = await prisma.user.findUnique({ where: { id: user.id } });
    expect(updated?.discordUserId).toBe("disc-1");
  });

  it("returns null for an expired code", async () => {
    await prisma.user.create({ data: { telegramUserId: 6n, displayName: "Ex" } });
    await prisma.linkCode.create({
      data: { code: "LINK-DEAD", telegramUserId: 6n, expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await redeemCode("LINK-DEAD", "disc-2", "ex")).toBeNull();
  });

  it("returns null for an already-used code", async () => {
    await prisma.user.create({ data: { telegramUserId: 7n, displayName: "Us" } });
    const { code } = await issueCode(7n);
    await redeemCode(code, "disc-3", "us");
    expect(await redeemCode(code, "disc-4", "us")).toBeNull();
  });
});
