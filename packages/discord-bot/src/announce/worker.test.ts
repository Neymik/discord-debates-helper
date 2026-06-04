import { describe, it, expect } from "vitest";
import { shouldHandle } from "./worker.js";

describe("shouldHandle", () => {
  it("handles only announce_t30", () => {
    expect(shouldHandle("announce_t30")).toBe(true);
  });

  it("ignores every job type owned by the Telegram bot", () => {
    for (const other of [
      "notify_week_before",
      "notify_day_before",
      "notify_hour_before",
      "nudge_unlinked_40m",
      "notify_t10",
    ]) {
      expect(shouldHandle(other)).toBe(false);
    }
  });
});
