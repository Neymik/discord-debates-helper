import { describe, it, expect } from "vitest";
import { backoffSchedule, retryWithBackoff } from "./backoff.js";

describe("backoffSchedule", () => {
  it("starts at the base delay and doubles, capped per-step", () => {
    const delays = backoffSchedule({ baseMs: 1000, capMs: 60_000, totalBudgetMs: 3_600_000 });
    expect(delays[0]).toBe(1000);
    expect(delays[1]).toBe(2000);
    expect(delays[2]).toBe(4000);
    // never exceeds the per-step cap
    expect(Math.max(...delays)).toBeLessThanOrEqual(60_000);
  });

  it("stops once the cumulative budget (~1h) is exhausted", () => {
    const delays = backoffSchedule({ baseMs: 1000, capMs: 60_000, totalBudgetMs: 3_600_000 });
    const total = delays.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(3_600_000);
    // enough attempts to actually span ~1h with a 60s cap (>= ~55 steps)
    expect(delays.length).toBeGreaterThan(50);
  });
});

describe("retryWithBackoff", () => {
  it("resolves on the first success without waiting", async () => {
    let calls = 0;
    const result = await retryWithBackoff(
      async () => {
        calls++;
        return "ok";
      },
      { baseMs: 1, capMs: 1, totalBudgetMs: 10 },
      () => Promise.resolve(),
    );
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  it("retries on failure then succeeds, using the injected sleep", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const result = await retryWithBackoff(
      async () => {
        calls++;
        if (calls < 3) throw new Error("boom");
        return "done";
      },
      { baseMs: 1000, capMs: 60_000, totalBudgetMs: 3_600_000 },
      async (ms) => {
        sleeps.push(ms);
      },
    );
    expect(result).toBe("done");
    expect(calls).toBe(3);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it("throws the last error when the budget is exhausted", async () => {
    await expect(
      retryWithBackoff(
        async () => {
          throw new Error("always");
        },
        { baseMs: 1000, capMs: 1000, totalBudgetMs: 2500 },
        async () => {},
      ),
    ).rejects.toThrow("always");
  });
});
