export interface BackoffOpts {
  baseMs: number;
  capMs: number;
  totalBudgetMs: number;
}

/** Pure delay schedule: doubling from base, clamped to cap, summing to <= budget. */
export function backoffSchedule(opts: BackoffOpts): number[] {
  const delays: number[] = [];
  let spent = 0;
  let next = opts.baseMs;
  while (spent + next <= opts.totalBudgetMs) {
    delays.push(next);
    spent += next;
    next = Math.min(next * 2, opts.capMs);
    if (next <= 0) break;
  }
  return delays;
}

export type Sleep = (ms: number) => Promise<void>;

const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fn`, retrying on rejection along `backoffSchedule(opts)`. The `sleep`
 * param is injectable so tests run instantly. Rethrows the last error when the
 * ~1h budget is exhausted (spec §5: files stay on disk, recoverable manually).
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: BackoffOpts,
  sleep: Sleep = realSleep,
): Promise<T> {
  const delays = backoffSchedule(opts);
  let lastErr: unknown;
  try {
    return await fn();
  } catch (err) {
    lastErr = err;
  }
  for (const delay of delays) {
    await sleep(delay);
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}
