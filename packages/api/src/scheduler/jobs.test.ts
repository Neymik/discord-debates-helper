import { describe, it, expect } from "vitest";
import { jobsToEnqueue } from "./jobs.js";

const gameId = "11111111-1111-1111-1111-111111111111";

describe("jobsToEnqueue", () => {
  it("enqueues all six jobs when the game is more than 7 days out", () => {
    const now = new Date("2026-06-01T00:00:00Z");
    const scheduledAt = new Date("2026-06-10T19:00:00Z"); // 9 days out
    const jobs = jobsToEnqueue(gameId, scheduledAt, now);
    expect(jobs.map((j) => j.type)).toEqual([
      "notify_week_before",
      "notify_day_before",
      "notify_hour_before",
      "nudge_unlinked_40m",
      "announce_t30",
      "notify_t10",
    ]);
  });

  it("drops jobs whose fire time is already in the past (game 2 days out)", () => {
    const now = new Date("2026-06-08T19:00:00Z");
    const scheduledAt = new Date("2026-06-10T19:00:00Z"); // 2 days out
    const jobs = jobsToEnqueue(gameId, scheduledAt, now);
    // notify_week_before (-7d) would fire 5 days ago -> dropped.
    expect(jobs.map((j) => j.type)).toEqual([
      "notify_day_before",
      "notify_hour_before",
      "nudge_unlinked_40m",
      "announce_t30",
      "notify_t10",
    ]);
  });

  it("computes delay = fireAt - now and a deterministic jobId", () => {
    const now = new Date("2026-06-10T18:00:00Z");
    const scheduledAt = new Date("2026-06-10T19:00:00Z"); // 1h out
    const jobs = jobsToEnqueue(gameId, scheduledAt, now);
    const hourBefore = jobs.find((j) => j.type === "notify_hour_before");
    expect(hourBefore).toBeDefined();
    expect(hourBefore!.delayMs).toBe(0); // fires exactly now
    expect(hourBefore!.jobId).toBe(`game:${gameId}:notify_hour_before`);
    expect(jobs.some((j) => j.type === "notify_week_before")).toBe(false);
    expect(jobs.some((j) => j.type === "notify_day_before")).toBe(false);
  });

  it("returns nothing when the game is in the past entirely", () => {
    const now = new Date("2026-06-11T00:00:00Z");
    const scheduledAt = new Date("2026-06-10T19:00:00Z");
    expect(jobsToEnqueue(gameId, scheduledAt, now)).toEqual([]);
  });
});
