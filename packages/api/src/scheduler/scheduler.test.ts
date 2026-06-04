import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { gameEventsQueue, connection } from "../queue.js";
import { enqueueGameJobs, removeGameJobs } from "./scheduler.js";

const gameId = "22222222-2222-2222-2222-222222222222";

async function jobIdsForGame(id: string): Promise<string[]> {
  const delayed = await gameEventsQueue.getDelayed();
  return delayed
    .map((j) => j.id ?? "")
    .filter((jid) => jid.startsWith(`game:${id}:`))
    .sort();
}

describe("scheduler enqueue/remove", () => {
  beforeEach(async () => {
    await removeGameJobs(gameId);
  });

  afterAll(async () => {
    await removeGameJobs(gameId);
    await gameEventsQueue.close();
    await connection.quit();
  });

  it("enqueues delayed jobs with deterministic ids and skips past offsets", async () => {
    const now = new Date();
    const scheduledAt = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000); // 2 days out
    await enqueueGameJobs(gameId, scheduledAt, now);
    const ids = await jobIdsForGame(gameId);
    expect(ids).toContain(`game:${gameId}:notify_day_before`);
    expect(ids).not.toContain(`game:${gameId}:notify_week_before`); // past -> skipped
  });

  it("removeGameJobs clears all delayed jobs for the game", async () => {
    const now = new Date();
    const scheduledAt = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
    await enqueueGameJobs(gameId, scheduledAt, now);
    await removeGameJobs(gameId);
    expect(await jobIdsForGame(gameId)).toEqual([]);
  });

  it("re-enqueue with the same jobId is idempotent (reconcile-safe)", async () => {
    const now = new Date();
    const scheduledAt = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
    await enqueueGameJobs(gameId, scheduledAt, now);
    await enqueueGameJobs(gameId, scheduledAt, now); // no duplicates
    const ids = await jobIdsForGame(gameId);
    const uniq = new Set(ids);
    expect(ids.length).toBe(uniq.size);
  });

  it("attaches the announce payload only to the announce_t30 job", async () => {
    const now = new Date();
    const scheduledAt = new Date(now.getTime() + 31 * 60 * 1000); // 31 min out → announce_t30 (-30m) is +1m future, notify_t10 (-10m) is +21m
    const announce = {
      motion: "THW test",
      participants: [{ display_name: "A", discord_user_id: "d1", telegram_username: "a_tg" }],
    };
    await enqueueGameJobs(gameId, scheduledAt, now, announce);
    const delayed = await gameEventsQueue.getDelayed();
    const mine = delayed.filter((j) => (j.id ?? "").startsWith(`game:${gameId}:`));
    const announceJob = mine.find((j) => j.name === "announce_t30");
    const t10Job = mine.find((j) => j.name === "notify_t10");
    expect(announceJob?.data.announce).toEqual(announce);
    expect(t10Job?.data.announce).toBeUndefined();
  });
});
