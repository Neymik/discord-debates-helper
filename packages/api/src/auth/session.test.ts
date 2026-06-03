import { describe, it, expect } from "vitest";
import { signSession, verifySession } from "./session.js";

const secret = "x".repeat(32);

describe("session JWT", () => {
  it("round-trips a userId", async () => {
    const token = await signSession("user-1", secret);
    expect(await verifySession(token, secret)).toBe("user-1");
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signSession("user-1", secret);
    await expect(verifySession(token, "y".repeat(32))).rejects.toThrow();
  });
});
