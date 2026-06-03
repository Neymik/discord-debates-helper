import { describe, it, expect } from "vitest";
import { createHash, createHmac } from "node:crypto";
import { verifyTelegramLogin } from "./telegramLogin.js";

const BOT_TOKEN = "123:abc";

function signPayload(data: Record<string, string>): Record<string, string> {
  const checkString = Object.keys(data).sort().map((k) => `${k}=${data[k]}`).join("\n");
  const secret = createHash("sha256").update(BOT_TOKEN).digest();
  const hash = createHmac("sha256", secret).update(checkString).digest("hex");
  return { ...data, hash };
}

describe("verifyTelegramLogin", () => {
  const now = Math.floor(Date.now() / 1000);

  it("accepts a correctly signed, fresh payload", () => {
    const payload = signPayload({ id: "898912046", first_name: "Ada", auth_date: String(now) });
    const result = verifyTelegramLogin(payload, BOT_TOKEN, now);
    expect(result).toMatchObject({ id: 898912046n, first_name: "Ada" });
  });

  it("rejects a tampered payload", () => {
    const payload = signPayload({ id: "898912046", first_name: "Ada", auth_date: String(now) });
    expect(() => verifyTelegramLogin({ ...payload, id: "1" }, BOT_TOKEN, now)).toThrow(/signature/);
  });

  it("rejects a stale auth_date (> 24h old, replay defense)", () => {
    const old = now - 25 * 3600;
    const payload = signPayload({ id: "898912046", first_name: "Ada", auth_date: String(old) });
    expect(() => verifyTelegramLogin(payload, BOT_TOKEN, now)).toThrow(/expired/);
  });
});
