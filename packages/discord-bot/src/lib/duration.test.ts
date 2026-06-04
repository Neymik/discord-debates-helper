import { describe, it, expect } from "vitest";
import { formatDuration } from "./duration.js";

describe("formatDuration", () => {
  it("formats seconds under a minute", () => {
    expect(formatDuration(42)).toBe("42s");
  });

  it("formats minutes and seconds", () => {
    expect(formatDuration(412)).toBe("6m 52s");
  });

  it("formats hours, minutes, seconds", () => {
    expect(formatDuration(3 * 3600 + 5 * 60 + 9)).toBe("3h 5m 9s");
  });

  it("formats zero", () => {
    expect(formatDuration(0)).toBe("0s");
  });

  it("floors fractional seconds", () => {
    expect(formatDuration(90.9)).toBe("1m 30s");
  });
});
