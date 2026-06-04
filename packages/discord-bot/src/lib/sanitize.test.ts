import { describe, it, expect } from "vitest";
import { sanitizeUsername, last4 } from "./sanitize.js";

describe("sanitizeUsername", () => {
  it("keeps the conservative allowlist [A-Za-z0-9_-]", () => {
    expect(sanitizeUsername("Alice_K")).toBe("Alice_K");
  });

  it("replaces disallowed chars with underscore and collapses runs", () => {
    expect(sanitizeUsername("alice .  bob!!")).toBe("alice_bob");
  });

  it("strips leading/trailing underscores", () => {
    expect(sanitizeUsername("__weird__")).toBe("weird");
  });

  it("falls back to 'user' when nothing survives", () => {
    expect(sanitizeUsername("!!!")).toBe("user");
    expect(sanitizeUsername("")).toBe("user");
  });

  it("handles unicode handles by stripping them", () => {
    expect(sanitizeUsername("алиса")).toBe("user");
  });
});

describe("last4", () => {
  it("returns the last 4 characters of a snowflake id", () => {
    expect(last4("998877665544332211")).toBe("2211");
  });

  it("returns the whole id when shorter than 4", () => {
    expect(last4("12")).toBe("12");
  });
});
