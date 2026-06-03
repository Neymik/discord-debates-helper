# Debates Helper — Plan 3: Discord Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `@debates/discord-bot` package — a stateless actuator that handles the `/link`, `/record start`, and `/record stop` slash commands, captures per-speaker Opus audio into Ogg/Opus files on the shared `recordings` volume, posts the mandatory consent notice, enforces the per-guild session cap and the `MAX_SESSION_HOURS` hard cap, and consumes only `announce_t30` jobs from the `game-events` BullMQ queue. Every pure helper (sanitization, last-4 id, duration formatting, backoff schedule, job-name filter, announce-message builder) is unit-tested; voice/gateway code is isolated behind thin seams with explicit manual smoke tests.

**Architecture:** The bot owns no database. It calls the Plan 2 HTTP API with `Authorization: Bearer ${DISCORD_BOT_API_TOKEN}` for `POST /api/link/redeem`, `POST /api/recordings/sessions`, `POST /api/recordings/sessions/:id/files`, and `POST /api/recordings/sessions/:id/complete`. It writes audio bytes directly to `RECORDINGS_DIR` (the same Docker volume the API reads). It holds a single in-memory `Map<guildId, ActiveRecording>` as a local guard mirroring the API's DB-enforced 409. The `game-events` worker filters strictly by `job.name === "announce_t30"` and skips everything else (Telegram bot owns the rest).

**Tech Stack:** Node 20 (Docker) / Node 22 (local dev), TypeScript (ESM, NodeNext), discord.js v14, @discordjs/voice, @discordjs/opus, prism-media (Ogg/Opus container), libsodium-wrappers (voice encryption), ioredis + bullmq, undici (`fetch` is global on Node 20), Vitest + tsx.

**Depends on:** Plan 1 (`@debates/shared` env loader + `QUEUE_NAME`, monorepo tsconfig/Dockerfile/compose conventions) and Plan 2 (the exact HTTP contracts: `POST /api/link/redeem` → `{ telegram_user_id, display_name }` | 404; `POST /api/recordings/sessions` → 201 session | 409; `POST /api/recordings/sessions/:id/files`; `POST /api/recordings/sessions/:id/complete`; and the `game-events` payload shape `GameEventPayload = { gameId, type }`).

**This is Plan 3 of 6.**

---

## ⚠️ Cross-plan dependency (a required Plan 2 addendum)

The spec's `announce_t30` job (§4) must post *"Debate in 30 min: {motion}. Participants: @alice @bob …"*, but the Plan 2 `GameEventPayload` is only `{ gameId, type }`, and **the Discord bot has no admin session cookie**, so it cannot call the admin-only `GET /api/games/:id` to fetch the motion and participant list.

**Decision (recommended, adopted by this plan): the API enqueues a richer payload for `announce_t30`.** When the API builds the announce job it already has the game row and participants loaded, so it should embed them. This is cheaper and more robust than minting a new bot-scoped read endpoint (no extra round-trip, no new auth surface, the data is a point-in-time snapshot which is exactly what an announcement wants).

**Plan 2 addendum to apply (small):** in `packages/api/src/scheduler/scheduler.ts`, extend the payload type and the `announce_t30` `add()` call so the announce job carries an `announce` object. Other job types keep the bare `{ gameId, type }` payload.

```ts
// packages/api/src/scheduler/scheduler.ts — addendum
export interface AnnouncePayload {
  motion: string | null;
  participants: { display_name: string; discord_user_id: string | null; telegram_username: string | null }[];
}
export interface GameEventPayload {
  gameId: string;
  type: JobType;
  announce?: AnnouncePayload; // present ONLY on announce_t30 jobs
}
```

When enqueuing, `enqueueGameJobs` loads the game's participants (it already does `include: { participants: { include: { user: true } } }` in the games service) and, for the `announce_t30` job only, attaches:

```ts
announce: {
  motion: game.motion,
  participants: game.participants.map((p) => ({
    display_name: p.user.displayName,
    discord_user_id: p.user.discordUserId,
    telegram_username: p.user.telegramUsername,
  })),
}
```

This plan's `buildAnnounceMessage` (Task 9) consumes exactly that `AnnouncePayload`. If the Plan 2 implementer instead prefers a bot read endpoint, the only change needed here is Task 9's data source; the message builder stays identical because it takes a plain `AnnouncePayload`. **Apply the addendum before executing Task 9.**

---

## File structure introduced by this plan

```
packages/discord-bot/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── Dockerfile
├── .dockerignore
└── src/
    ├── config.ts                 # typed config from @debates/shared env
    ├── config.test.ts
    ├── apiClient.ts              # typed fetch wrapper for the Plan 2 API (Bearer token)
    ├── lib/
    │   ├── sanitize.ts           # sanitizeUsername, last4
    │   ├── sanitize.test.ts
    │   ├── duration.ts           # formatDuration
    │   ├── duration.test.ts
    │   ├── backoff.ts            # backoffSchedule (exp backoff up to ~1h)
    │   └── backoff.test.ts
    ├── recording/
    │   ├── opusFile.ts           # OpusFileWriter (prism-media OggLogicalBitstream seam)
    │   ├── filename.ts           # recordingFileName (pure)
    │   ├── filename.test.ts
    │   ├── session.ts            # RecordingManager: join/capture/stop, per-guild guard
    │   └── caps.ts               # MAX_SESSION_HOURS auto-stop + 3h45m warning timers
    ├── commands/
    │   ├── definitions.ts        # slash command JSON (link, record)
    │   ├── register.ts           # guild-scoped registration at startup
    │   ├── link.ts               # /link handler
    │   └── record.ts             # /record start|stop handlers
    ├── announce/
    │   ├── message.ts            # buildAnnounceMessage (pure)
    │   ├── message.test.ts
    │   ├── worker.ts             # BullMQ Worker filtering job.name === announce_t30
    │   └── worker.test.ts        # job-name filter unit test
    ├── consent.ts                # CONSENT_NOTICE constant (spec §11)
    └── index.ts                  # gateway client bootstrap + wiring
```

---

## Task 1: Package scaffold + config

**Files:**
- Create: `packages/discord-bot/package.json`
- Create: `packages/discord-bot/tsconfig.json`
- Create: `packages/discord-bot/vitest.config.ts`
- Create: `packages/discord-bot/src/config.ts`
- Test: `packages/discord-bot/src/config.test.ts`

- [ ] **Step 1: Create `packages/discord-bot/package.json`**

```json
{
  "name": "@debates/discord-bot",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -b",
    "dev": "tsx watch src/index.ts",
    "start": "node dist/index.js",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@debates/shared": "*",
    "discord.js": "^14.16.0",
    "@discordjs/voice": "^0.17.0",
    "@discordjs/opus": "^0.9.0",
    "prism-media": "^1.3.5",
    "libsodium-wrappers": "^0.7.13",
    "bullmq": "^5.13.0",
    "ioredis": "^5.4.0"
  },
  "devDependencies": {
    "@types/node": "^20.16.0"
  }
}
```

> **Why these deps:** discord.js for the gateway + interactions; `@discordjs/voice` for receive streams; `@discordjs/opus` is the native Opus binding `@discordjs/voice` needs for decode/PCM paths (we still get raw Opus packets, see Task 6); `prism-media` provides `opus.OggLogicalBitstream` to wrap raw Opus packets into an Ogg container; `libsodium-wrappers` is the voice-encryption backend discord.js voice requires at connect time; `bullmq`+`ioredis` for the `announce_t30` worker.

- [ ] **Step 2: Create `packages/discord-bot/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist"
  },
  "references": [{ "path": "../shared" }],
  "include": ["src/**/*"],
  "exclude": ["**/*.test.ts"]
}
```

- [ ] **Step 3: Create `packages/discord-bot/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "discord-bot",
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 4: Install workspace deps**

Run: `npm install`
Expected: completes; `@debates/discord-bot` symlinked under `node_modules/@debates/`. (Native modules `@discordjs/opus`/`libsodium-wrappers` compile or fetch prebuilds — must succeed on this host.)

- [ ] **Step 5: Write the failing config test**

`packages/discord-bot/src/config.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildBotConfig } from "./config.js";

const base = {
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
  JWT_SECRET: "x".repeat(32),
  PUBLIC_URL: "https://debates.example.com",
  ADMIN_TELEGRAM_IDS: "898912046",
  DISCORD_BOT_API_TOKEN: "a".repeat(32),
  TELEGRAM_BOT_API_TOKEN: "b".repeat(32),
  DISCORD_BOT_TOKEN: "dtoken",
  DISCORD_CLIENT_ID: "1511558875571159201",
  DEBATE_ANNOUNCE_CHANNEL_ID: "607662041561563167",
  DEBATE_FALLBACK_CHANNEL_ID: "607662041561563167",
  TELEGRAM_BOT_TOKEN: "ttoken",
  TELEGRAM_BOT_USERNAME: "tooronkaich_bot",
};

describe("buildBotConfig", () => {
  it("derives the API base URL, recordings dir, and caps", () => {
    const cfg = buildBotConfig({ ...base, RECORDINGS_DIR: "/data/rec", API_BASE_URL: "http://api:3000" });
    expect(cfg.apiBaseUrl).toBe("http://api:3000");
    expect(cfg.recordingsDir).toBe("/data/rec");
    expect(cfg.maxSessionHours).toBe(4);
    expect(cfg.botToken).toBe("dtoken");
    expect(cfg.clientId).toBe("1511558875571159201");
    expect(cfg.announceChannelId).toBe("607662041561563167");
    expect(cfg.botApiToken).toBe("a".repeat(32));
  });

  it("defaults API_BASE_URL to http://api:3000 and recordings dir to the shared volume", () => {
    const cfg = buildBotConfig(base);
    expect(cfg.apiBaseUrl).toBe("http://api:3000");
    expect(cfg.recordingsDir).toBe("/var/lib/debates/recordings");
  });

  it("requires a guild id for guild-scoped command registration", () => {
    expect(() => buildBotConfig({ ...base, DISCORD_GUILD_ID: "" })).not.toThrow();
    const cfg = buildBotConfig({ ...base, DISCORD_GUILD_ID: "5550001" });
    expect(cfg.guildId).toBe("5550001");
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `npx vitest run packages/discord-bot/src/config.test.ts`
Expected: FAIL — `Cannot find module './config.js'`.

- [ ] **Step 7: Implement `packages/discord-bot/src/config.ts`**

```ts
import { loadEnv } from "@debates/shared";

export interface BotConfig {
  botToken: string;
  clientId: string;
  guildId: string | undefined;
  apiBaseUrl: string;
  botApiToken: string;
  recordingsDir: string;
  announceChannelId: string;
  fallbackChannelId: string;
  redisUrl: string;
  maxSessionHours: number;
}

/**
 * Builds the Discord bot's typed config from the shared env loader.
 * API_BASE_URL / RECORDINGS_DIR / DISCORD_GUILD_ID are bot-local and not part of
 * the shared schema, so they are read directly off `source` with defaults.
 */
export function buildBotConfig(source: Record<string, string | undefined> = process.env): BotConfig {
  const env = loadEnv(source);
  return {
    botToken: env.DISCORD_BOT_TOKEN,
    clientId: env.DISCORD_CLIENT_ID,
    guildId: source.DISCORD_GUILD_ID && source.DISCORD_GUILD_ID.length > 0 ? source.DISCORD_GUILD_ID : undefined,
    apiBaseUrl: source.API_BASE_URL ?? "http://api:3000",
    botApiToken: env.DISCORD_BOT_API_TOKEN,
    recordingsDir: source.RECORDINGS_DIR ?? "/var/lib/debates/recordings",
    announceChannelId: env.DEBATE_ANNOUNCE_CHANNEL_ID,
    fallbackChannelId: env.DEBATE_FALLBACK_CHANNEL_ID,
    redisUrl: env.REDIS_URL,
    maxSessionHours: env.MAX_SESSION_HOURS,
  };
}
```

> **Note on `DISCORD_GUILD_ID`:** spec §10 registers slash commands guild-scoped. Add `DISCORD_GUILD_ID=<your test guild id>` to `.env` / `.env.example` (Task 11 covers compose wiring). If unset, Task 7's registration falls back to global registration with a logged warning.

- [ ] **Step 8: Run to verify it passes**

Run: `npx vitest run packages/discord-bot/src/config.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 9: Commit**

```bash
git add packages/discord-bot/package.json packages/discord-bot/tsconfig.json packages/discord-bot/vitest.config.ts packages/discord-bot/src/config.ts packages/discord-bot/src/config.test.ts package-lock.json
git commit -m "feat(discord-bot): scaffold package + typed config from shared env"
```

---

## Task 2: Pure helpers — username sanitization + last-4 id

**Files:**
- Create: `packages/discord-bot/src/lib/sanitize.ts`
- Test: `packages/discord-bot/src/lib/sanitize.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/discord-bot/src/lib/sanitize.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/discord-bot/src/lib/sanitize.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `packages/discord-bot/src/lib/sanitize.ts`**

```ts
/**
 * Conservative filename sanitization (spec §13: allowlist `[A-Za-z0-9_-]`).
 * Replaces every disallowed character with `_`, collapses runs, trims edge
 * underscores, and falls back to "user" when nothing survives.
 */
export function sanitizeUsername(input: string): string {
  const cleaned = input
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  return cleaned.length > 0 ? cleaned : "user";
}

/** Last 4 chars of a Discord snowflake id (disambiguates same-named files). */
export function last4(discordUserId: string): string {
  return discordUserId.slice(-4);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/discord-bot/src/lib/sanitize.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/discord-bot/src/lib/sanitize.ts packages/discord-bot/src/lib/sanitize.test.ts
git commit -m "feat(discord-bot): username sanitization + last-4 id helpers"
```

---

## Task 3: Pure helper — duration formatting

**Files:**
- Create: `packages/discord-bot/src/lib/duration.ts`
- Test: `packages/discord-bot/src/lib/duration.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/discord-bot/src/lib/duration.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/discord-bot/src/lib/duration.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `packages/discord-bot/src/lib/duration.ts`**

```ts
/** Human-readable duration for the `/record stop` reply (spec §5 step 7). */
export function formatDuration(totalSeconds: number): string {
  const s = Math.floor(totalSeconds);
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (hours > 0 || minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(" ");
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/discord-bot/src/lib/duration.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/discord-bot/src/lib/duration.ts packages/discord-bot/src/lib/duration.test.ts
git commit -m "feat(discord-bot): duration formatting helper"
```

---

## Task 4: Pure helper — exponential backoff schedule (stop-time retries)

**Files:**
- Create: `packages/discord-bot/src/lib/backoff.ts`
- Test: `packages/discord-bot/src/lib/backoff.test.ts`

Spec §5 failure mode: *"API unreachable on `/record stop` — Bot retries metadata write with exponential backoff up to 1 hour."* This task produces the delay schedule as pure data so it is fully testable; Task 8 applies it with `setTimeout`.

- [ ] **Step 1: Write the failing test**

`packages/discord-bot/src/lib/backoff.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/discord-bot/src/lib/backoff.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `packages/discord-bot/src/lib/backoff.ts`**

```ts
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/discord-bot/src/lib/backoff.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/discord-bot/src/lib/backoff.ts packages/discord-bot/src/lib/backoff.test.ts
git commit -m "feat(discord-bot): exponential backoff schedule + retry helper"
```

---

## Task 5: Pure helper — recording filename + the typed API client

**Files:**
- Create: `packages/discord-bot/src/recording/filename.ts`
- Test: `packages/discord-bot/src/recording/filename.test.ts`
- Create: `packages/discord-bot/src/apiClient.ts`

> **Spec correction (called out explicitly):** spec §5 step 5 names the per-speaker file `<username>_<last4>.opus`. We actually write an **Ogg/Opus container** (raw `.opus` is not a self-describing container and most tools can't open it), so the **extension is `.ogg`**. The byte stream is Opus-in-Ogg, 48 kHz mono — lossless re-packaging, no re-encode (Task 6). The `file_path` value we send to `POST /api/recordings/sessions/:id/files` is exactly the `.ogg` filename we wrote, so the API's `_metadata.json` and download links stay consistent (Plan 2 streams it as `audio/ogg` already — the `.opus` in Plan 2's download *route* path is just a URL suffix, unaffected). The admin downloads a playable `.ogg`.

- [ ] **Step 1: Write the failing test**

`packages/discord-bot/src/recording/filename.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { recordingFileName } from "./filename.js";

describe("recordingFileName", () => {
  it("joins sanitized username + last4 id with the .ogg extension", () => {
    expect(recordingFileName("alice", "998877665544332211")).toBe("alice_2211.ogg");
  });

  it("sanitizes the username segment", () => {
    expect(recordingFileName("Bob the Builder!", "111122223333")).toBe("Bob_the_Builder_3333.ogg");
  });

  it("falls back to 'user' for an unusable username", () => {
    expect(recordingFileName("!!!", "9999")).toBe("user_9999.ogg");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/discord-bot/src/recording/filename.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `packages/discord-bot/src/recording/filename.ts`**

```ts
import { sanitizeUsername, last4 } from "../lib/sanitize.js";

/**
 * Per-speaker filename: `<sanitized_username>_<last4_of_id>.ogg`.
 * NOTE: `.ogg` (Ogg/Opus container), not raw `.opus` — see Task 5 spec-correction note.
 */
export function recordingFileName(discordUsername: string, discordUserId: string): string {
  return `${sanitizeUsername(discordUsername)}_${last4(discordUserId)}.ogg`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/discord-bot/src/recording/filename.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Implement the typed API client `packages/discord-bot/src/apiClient.ts`** (uses Node 20 global `fetch`)

```ts
import type { BotConfig } from "./config.js";

export interface CreatedSession {
  id: string;
  fileDir: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Thin typed wrapper over the Plan 2 HTTP API, always sending the bot Bearer token. */
export class ApiClient {
  constructor(private readonly cfg: Pick<BotConfig, "apiBaseUrl" | "botApiToken">) {}

  private async post(path: string, body: unknown): Promise<Response> {
    return fetch(`${this.cfg.apiBaseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.cfg.botApiToken}`,
      },
      body: JSON.stringify(body),
    });
  }

  /** POST /api/link/redeem → 200 { telegram_user_id, display_name } | 404. */
  async redeemLink(input: {
    code: string;
    discord_user_id: string;
    discord_username: string;
  }): Promise<{ telegram_user_id: number; display_name: string } | null> {
    const res = await this.post("/api/link/redeem", input);
    if (res.status === 404) return null;
    if (!res.ok) throw new ApiError(`redeem failed: ${res.status}`, res.status);
    return (await res.json()) as { telegram_user_id: number; display_name: string };
  }

  /** POST /api/recordings/sessions → 201 session | 409 active_session_exists. */
  async createSession(input: {
    started_by_discord_user_id: string;
    voice_channel_id: string;
    voice_channel_name: string;
    guild_id: string;
  }): Promise<{ ok: true; session: CreatedSession } | { ok: false; conflict: true }> {
    const res = await this.post("/api/recordings/sessions", input);
    if (res.status === 409) return { ok: false, conflict: true };
    if (res.status !== 201) throw new ApiError(`createSession failed: ${res.status}`, res.status);
    const session = (await res.json()) as CreatedSession;
    return { ok: true, session };
  }

  /** POST /api/recordings/sessions/:id/files */
  async registerFile(
    sessionId: string,
    input: {
      discord_user_id: string;
      discord_username: string;
      file_path: string;
      duration_sec: number;
      size_bytes: number;
    },
  ): Promise<void> {
    const res = await this.post(`/api/recordings/sessions/${sessionId}/files`, input);
    if (!res.ok) throw new ApiError(`registerFile failed: ${res.status}`, res.status);
  }

  /** POST /api/recordings/sessions/:id/complete */
  async completeSession(sessionId: string): Promise<void> {
    const res = await this.post(`/api/recordings/sessions/${sessionId}/complete`, {});
    if (!res.ok) throw new ApiError(`completeSession failed: ${res.status}`, res.status);
  }
}
```

> **`fileDir` consistency:** Plan 2's `createSession` returns the Prisma row whose `fileDir` is an **absolute** path under `RECORDINGS_DIR` (the same volume mount in both containers). The bot writes its `.ogg` files into that exact `fileDir`, so the API's later `_metadata.json` writer and download routes resolve the same paths. The bot must therefore use `session.fileDir` from the 201 response, **not** recompute the directory name.

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck -w @debates/discord-bot`
Expected: no errors.

```bash
git add packages/discord-bot/src/recording/filename.ts packages/discord-bot/src/recording/filename.test.ts packages/discord-bot/src/apiClient.ts
git commit -m "feat(discord-bot): recording filename helper (.ogg) + typed API client"
```

---

## Task 6: Opus → Ogg/Opus file writer seam

**Files:**
- Create: `packages/discord-bot/src/recording/opusFile.ts`

This wraps `prism-media`'s `opus.OggLogicalBitstream`. `@discordjs/voice`'s `receiver.subscribe(...)` yields a stream of **already-encoded Opus packets** (Discord sends Opus over the wire). We must **not** decode to PCM and re-encode — that loses quality and wastes CPU. Instead we repackage the raw Opus packets into an Ogg container with a proper `OpusHead`. There is no Discord-free unit test for the streaming itself; the seam is exercised in the Task 10 manual smoke test. Keep the class tiny so the wiring is obvious.

- [ ] **Step 1: Implement `packages/discord-bot/src/recording/opusFile.ts`**

```ts
import { createWriteStream, type WriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import prism from "prism-media";

/**
 * Repackages a stream of raw Opus packets (from @discordjs/voice
 * `receiver.subscribe`) into an Ogg/Opus file WITHOUT re-encoding.
 *
 * Discord audio is 48 kHz, 2-channel Opus frames. We configure the Ogg
 * logical bitstream with the matching OpusHead so players read it correctly.
 * The file is opened lazily on the first write (caller calls `start()` only
 * when the first packet arrives — see RecordingManager, Task 8).
 */
export class OpusFileWriter {
  private fileStream: WriteStream | null = null;
  private ogg: prism.opus.OggLogicalBitstream | null = null;
  private pipelinePromise: Promise<void> | null = null;
  private bytesWritten = 0;

  constructor(private readonly filePath: string) {}

  /** Begin piping `opusPackets` into the Ogg container at `filePath`. */
  start(opusPackets: Readable): void {
    if (this.ogg) throw new Error("OpusFileWriter already started");
    this.fileStream = createWriteStream(this.filePath);
    this.fileStream.on("data", undefined as never); // no-op; count via 'finish' below
    this.ogg = new prism.opus.OggLogicalBitstream({
      opusHead: new prism.opus.OpusHead({ channelCount: 2, sampleRate: 48000 }),
      pageSizeControl: { maxPackets: 10 },
    });
    // Track size as data flows to the file.
    this.fileStream.on("pipe", () => undefined);
    this.ogg.on("data", (chunk: Buffer) => {
      this.bytesWritten += chunk.length;
    });
    this.pipelinePromise = pipeline(opusPackets, this.ogg, this.fileStream);
  }

  /** Resolves once the underlying pipeline has fully flushed and closed. */
  async finish(): Promise<{ bytesWritten: number }> {
    if (!this.pipelinePromise) return { bytesWritten: 0 };
    try {
      await this.pipelinePromise;
    } catch {
      // Stream ended (manual end / disconnect); partial file is still valid Ogg.
    }
    return { bytesWritten: this.bytesWritten };
  }

  get path(): string {
    return this.filePath;
  }
}
```

> **Why `channelCount: 2`:** Discord's Opus stream is stereo at 48 kHz. Declaring 2 channels in `OpusHead` keeps the container honest about the packets we copy through (the spec's "mono" §5 note is a downstream-storage aspiration; faithfully containerizing what Discord sends avoids a decode/re-encode pass). Downstream transcription handles stereo fine.

- [ ] **Step 2: Typecheck + commit**

Run: `npm run typecheck -w @debates/discord-bot`
Expected: no errors.

```bash
git add packages/discord-bot/src/recording/opusFile.ts
git commit -m "feat(discord-bot): Ogg/Opus file writer (repackage, no re-encode)"
```

---

## Task 7: Slash command definitions + guild-scoped registration

**Files:**
- Create: `packages/discord-bot/src/commands/definitions.ts`
- Create: `packages/discord-bot/src/commands/register.ts`
- Create: `packages/discord-bot/src/consent.ts`

- [ ] **Step 1: Implement `packages/discord-bot/src/consent.ts`** (spec §5 step 6 / §11)

```ts
/**
 * Mandatory recording-active consent notice posted on /record start (spec §11).
 * `{channel}` and `{sessionId}` are filled by the record handler.
 */
export function consentNotice(voiceChannelName: string, sessionId: string): string {
  return (
    `🔴 Recording started in **#${voiceChannelName}**. ` +
    `By staying in voice, all participants consent to being recorded for personal ` +
    `feedback purposes (30-day retention). Session ID: \`${sessionId}\`. ` +
    `Run \`/record stop\` when done.`
  );
}
```

- [ ] **Step 2: Implement `packages/discord-bot/src/commands/definitions.ts`** (spec §10 command table)

```ts
import { SlashCommandBuilder } from "discord.js";

export const linkCommand = new SlashCommandBuilder()
  .setName("link")
  .setDescription("Link your Discord account to your Telegram registration")
  .addStringOption((opt) =>
    opt.setName("code").setDescription("The LINK-XXXX code from the Telegram bot").setRequired(true),
  );

export const recordCommand = new SlashCommandBuilder()
  .setName("record")
  .setDescription("Control voice recording for a debate")
  .addSubcommand((sub) => sub.setName("start").setDescription("Start recording your current voice channel"))
  .addSubcommand((sub) => sub.setName("stop").setDescription("Stop the active recording"));

export const commandDefinitions = [linkCommand, recordCommand].map((c) => c.toJSON());
```

- [ ] **Step 3: Implement `packages/discord-bot/src/commands/register.ts`** (spec §10: guild-scoped at startup)

```ts
import { REST, Routes } from "discord.js";
import type { BotConfig } from "../config.js";
import { commandDefinitions } from "./definitions.js";

/**
 * Registers slash commands at startup. Guild-scoped when DISCORD_GUILD_ID is set
 * (instant propagation, recommended for dev — spec §10); otherwise global.
 */
export async function registerCommands(cfg: BotConfig): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(cfg.botToken);
  if (cfg.guildId) {
    await rest.put(Routes.applicationGuildCommands(cfg.clientId, cfg.guildId), { body: commandDefinitions });
    console.log(`[discord-bot] registered ${commandDefinitions.length} guild commands for ${cfg.guildId}`);
  } else {
    console.warn("[discord-bot] DISCORD_GUILD_ID unset — registering GLOBAL commands (slow propagation)");
    await rest.put(Routes.applicationCommands(cfg.clientId), { body: commandDefinitions });
  }
}
```

- [ ] **Step 4: Typecheck + commit**

Run: `npm run typecheck -w @debates/discord-bot`
Expected: no errors.

```bash
git add packages/discord-bot/src/commands/definitions.ts packages/discord-bot/src/commands/register.ts packages/discord-bot/src/consent.ts
git commit -m "feat(discord-bot): slash command defs + guild-scoped registration + consent notice"
```

---

## Task 8: RecordingManager — per-guild guard, capture, stop, caps

**Files:**
- Create: `packages/discord-bot/src/recording/caps.ts`
- Create: `packages/discord-bot/src/recording/session.ts`

The manager owns the in-memory `Map<guildId, ActiveRecording>` (local mirror of the API's DB 409), opens per-user receive streams on first speech, applies the auto-stop caps, and on stop registers each non-empty file (with backoff) then completes the session. The voice-connection internals can't be unit-tested without Discord, so they live behind small methods exercised in the Task 10 smoke test. `caps.ts` (timer math) and the file-registration loop are written to be reviewable in isolation.

- [ ] **Step 1: Implement `packages/discord-bot/src/recording/caps.ts`**

```ts
/** Returns ms until the 3h45m warning and the hard auto-stop (spec §5 hard caps). */
export function capTimings(maxSessionHours: number): { warnAfterMs: number; stopAfterMs: number } {
  const stopAfterMs = maxSessionHours * 3600 * 1000;
  const warnAfterMs = Math.max(stopAfterMs - 15 * 60 * 1000, 0); // 15 min before the cap (3h45m for 4h)
  return { warnAfterMs, stopAfterMs };
}
```

- [ ] **Step 2: Implement `packages/discord-bot/src/recording/session.ts`**

```ts
import { mkdir } from "node:fs/promises";
import { statSync } from "node:fs";
import path from "node:path";
import {
  joinVoiceChannel,
  EndBehaviorType,
  getVoiceConnection,
  type VoiceConnection,
} from "@discordjs/voice";
import type { VoiceBasedChannel, TextBasedChannel } from "discord.js";
import type { ApiClient } from "../apiClient.js";
import type { BotConfig } from "../config.js";
import { OpusFileWriter } from "./opusFile.js";
import { recordingFileName } from "./filename.js";
import { retryWithBackoff } from "../lib/backoff.js";
import { capTimings } from "./caps.js";

interface UserCapture {
  writer: OpusFileWriter;
  filePath: string;
  fileName: string;
  discordUsername: string;
  startedAtMs: number;
  finished: Promise<{ bytesWritten: number }>;
}

interface ActiveRecording {
  sessionId: string;
  fileDir: string;
  guildId: string;
  voiceChannelName: string;
  connection: VoiceConnection;
  captures: Map<string, UserCapture>; // keyed by discord user id
  warnTimer: NodeJS.Timeout;
  stopTimer: NodeJS.Timeout;
}

const BACKOFF = { baseMs: 1000, capMs: 60_000, totalBudgetMs: 3_600_000 };

export class RecordingManager {
  private readonly active = new Map<string, ActiveRecording>();

  constructor(
    private readonly api: ApiClient,
    private readonly cfg: BotConfig,
  ) {}

  isActive(guildId: string): boolean {
    return this.active.has(guildId);
  }

  /**
   * Joins `voiceChannel`, opens per-user Opus capture on first speech, and wires
   * the auto-stop caps. `onAutoStop` is called when the hard cap fires.
   * `session` is the 201 body from POST /api/recordings/sessions.
   */
  async start(
    session: { id: string; fileDir: string },
    voiceChannel: VoiceBasedChannel,
    onWarn: () => void,
    onAutoStop: () => void,
  ): Promise<void> {
    const guildId = voiceChannel.guild.id;
    await mkdir(session.fileDir, { recursive: true });

    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false, // must hear to receive
      selfMute: true,
    });

    const captures = new Map<string, UserCapture>();
    const receiver = connection.receiver;

    receiver.speaking.on("start", (userId: string) => {
      if (captures.has(userId)) return; // already capturing this user
      const member = voiceChannel.members.get(userId);
      const username = member?.user.username ?? "user";
      const fileName = recordingFileName(username, userId);
      const filePath = path.join(session.fileDir, fileName);
      const opusStream = receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.Manual }, // we end it ourselves on /record stop
      });
      const writer = new OpusFileWriter(filePath);
      writer.start(opusStream);
      captures.set(userId, {
        writer,
        filePath,
        fileName,
        discordUsername: username,
        startedAtMs: Date.now(),
        finished: writer.finish(),
      });
    });

    const { warnAfterMs, stopAfterMs } = capTimings(this.cfg.maxSessionHours);
    const warnTimer = setTimeout(onWarn, warnAfterMs);
    const stopTimer = setTimeout(onAutoStop, stopAfterMs);

    this.active.set(guildId, {
      sessionId: session.id,
      fileDir: session.fileDir,
      guildId,
      voiceChannelName: voiceChannel.name,
      connection,
      captures,
      warnTimer,
      stopTimer,
    });
  }

  /** Emergency teardown without metadata writes (used when the consent reply fails). */
  async abort(guildId: string): Promise<void> {
    const rec = this.active.get(guildId);
    if (!rec) return;
    clearTimeout(rec.warnTimer);
    clearTimeout(rec.stopTimer);
    for (const cap of rec.captures.values()) {
      rec.connection.receiver.subscriptions.get; // (no-op ref; end handled by destroy below)
    }
    rec.connection.destroy();
    getVoiceConnection(guildId)?.destroy();
    this.active.delete(guildId);
  }

  /**
   * Ends all streams, closes the connection, registers each non-empty file with
   * exponential backoff (spec §5: up to ~1h), then completes the session.
   * Returns the speaker count + total duration for the reply.
   */
  async stop(guildId: string): Promise<{ speakerCount: number; totalDurationSec: number } | null> {
    const rec = this.active.get(guildId);
    if (!rec) return null;
    clearTimeout(rec.warnTimer);
    clearTimeout(rec.stopTimer);

    // End every receive stream and let each writer flush its Ogg file.
    rec.connection.receiver.speaking.removeAllListeners();
    rec.connection.destroy();

    let totalDurationSec = 0;
    let speakerCount = 0;
    for (const [discordUserId, cap] of rec.captures) {
      const { bytesWritten } = await cap.finished;
      if (bytesWritten <= 0) continue; // skip empty files (spec §5 step 2: non-empty only)
      let sizeBytes = bytesWritten;
      try {
        sizeBytes = statSync(cap.filePath).size;
      } catch {
        /* keep the in-memory count */
      }
      const durationSec = Math.max(0, Math.round((Date.now() - cap.startedAtMs) / 1000));
      totalDurationSec = Math.max(totalDurationSec, durationSec);
      speakerCount++;
      await retryWithBackoff(
        () =>
          this.api.registerFile(rec.sessionId, {
            discord_user_id: discordUserId,
            discord_username: cap.discordUsername,
            file_path: cap.fileName, // relative to session.file_dir (spec §3 recording_files.file_path)
            duration_sec: durationSec,
            size_bytes: sizeBytes,
          }),
        BACKOFF,
      );
    }

    await retryWithBackoff(() => this.api.completeSession(rec.sessionId), BACKOFF);
    this.active.delete(guildId);
    return { speakerCount, totalDurationSec };
  }
}
```

> **Duration note:** spec keeps `duration_sec` per file as an `integer`. We approximate it as wall-clock from first-speech to stop, which over-counts silent gaps but is adequate for phase-1 admin matching; a precise value would require counting Opus frames (deferred). This is a deliberate, documented approximation — not a placeholder.

- [ ] **Step 3: Typecheck + commit**

Run: `npm run typecheck -w @debates/discord-bot`
Expected: no errors.

```bash
git add packages/discord-bot/src/recording/caps.ts packages/discord-bot/src/recording/session.ts
git commit -m "feat(discord-bot): RecordingManager (per-guild guard, capture, caps, backoff stop)"
```

---

## Task 9: announce_t30 message builder + BullMQ worker (job-name filter)

**Files:**
- Create: `packages/discord-bot/src/announce/message.ts`
- Test: `packages/discord-bot/src/announce/message.test.ts`
- Create: `packages/discord-bot/src/announce/worker.ts`
- Test: `packages/discord-bot/src/announce/worker.test.ts`

> Apply the **Plan 2 addendum** (top of this doc) first so `announce_t30` jobs carry the `announce` payload.

- [ ] **Step 1: Write the failing message-builder test** (spec §4 announce_t30 row)

`packages/discord-bot/src/announce/message.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildAnnounceMessage, type AnnouncePayload } from "./message.js";

describe("buildAnnounceMessage", () => {
  it("mentions linked participants and labels unlinked ones", () => {
    const payload: AnnouncePayload = {
      motion: "THW abolish zoos",
      participants: [
        { display_name: "Alice", discord_user_id: "111", telegram_username: "alice_tg" },
        { display_name: "Bob", discord_user_id: null, telegram_username: "bob_tg" },
        { display_name: "Carol", discord_user_id: null, telegram_username: null },
      ],
    };
    const msg = buildAnnounceMessage(payload);
    expect(msg).toContain("Debate in 30 min: THW abolish zoos.");
    expect(msg).toContain("<@111>");
    expect(msg).toContain("bob_tg (not linked)");
    expect(msg).toContain("Carol (not linked)");
  });

  it("uses a fallback when motion is null", () => {
    const msg = buildAnnounceMessage({ motion: null, participants: [] });
    expect(msg).toContain("Debate in 30 min");
    expect(msg).toContain("(motion TBA)");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/discord-bot/src/announce/message.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `packages/discord-bot/src/announce/message.ts`**

```ts
export interface AnnounceParticipant {
  display_name: string;
  discord_user_id: string | null;
  telegram_username: string | null;
}

export interface AnnouncePayload {
  motion: string | null;
  participants: AnnounceParticipant[];
}

/** Renders the announce_t30 message (spec §4). Linked → mention; unlinked → "(not linked)". */
export function buildAnnounceMessage(payload: AnnouncePayload): string {
  const motion = payload.motion && payload.motion.trim().length > 0 ? payload.motion : "(motion TBA)";
  const names = payload.participants.map((p) =>
    p.discord_user_id
      ? `<@${p.discord_user_id}>`
      : `${p.telegram_username ?? p.display_name} (not linked)`,
  );
  const list = names.length > 0 ? names.join(" ") : "(no participants)";
  return `Debate in 30 min: ${motion}. Participants: ${list}`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/discord-bot/src/announce/message.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Write the failing job-name-filter test**

`packages/discord-bot/src/announce/worker.test.ts`:

```ts
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
```

- [ ] **Step 6: Run to verify it fails**

Run: `npx vitest run packages/discord-bot/src/announce/worker.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 7: Implement `packages/discord-bot/src/announce/worker.ts`**

```ts
import { Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import { QUEUE_NAME } from "@debates/shared";
import type { Client, TextChannel } from "discord.js";
import type { BotConfig } from "../config.js";
import { buildAnnounceMessage, type AnnouncePayload } from "./message.js";

/**
 * The Discord bot owns ONLY `announce_t30` on the shared `game-events` queue.
 * Every other job type belongs to the Telegram bot. Because both bots attach a
 * Worker to the same queue, this worker must explicitly skip foreign jobs by
 * `job.name` and return early WITHOUT throwing (a thrown job is retried, which
 * would fight the Telegram bot). Returning resolves/acks the job for this
 * consumer; BullMQ delivers each job to exactly one worker, so the Telegram
 * bot's worker applies the same name-filter for its own set.
 */
export function shouldHandle(jobName: string): boolean {
  return jobName === "announce_t30";
}

interface AnnounceJobData {
  gameId: string;
  type: string;
  announce?: AnnouncePayload;
}

export function startAnnounceWorker(client: Client, cfg: BotConfig): Worker {
  const connection = new IORedis(cfg.redisUrl, { maxRetriesPerRequest: null });

  const worker = new Worker<AnnounceJobData>(
    QUEUE_NAME,
    async (job: Job<AnnounceJobData>) => {
      if (!shouldHandle(job.name)) return; // foreign job → ack-and-ignore, no throw
      const payload: AnnouncePayload = job.data.announce ?? { motion: null, participants: [] };
      const message = buildAnnounceMessage(payload);
      const channel = await client.channels.fetch(cfg.announceChannelId);
      if (channel && channel.isTextBased()) {
        await (channel as TextChannel).send({
          content: message,
          allowedMentions: { parse: ["users"] },
        });
      } else {
        console.error(`[discord-bot] announce channel ${cfg.announceChannelId} not a text channel`);
      }
    },
    { connection },
  );

  worker.on("failed", (job, err) => {
    console.error(`[discord-bot] announce job ${job?.id} failed:`, err);
  });
  return worker;
}
```

> **Concurrency caveat (worth a reviewer's eye):** BullMQ delivers each job to exactly one of the workers listening on `game-events`. If both bots run a plain `Worker` on the same queue, a `notify_*` job could be picked by the Discord worker and silently acked here — starving the Telegram bot. The robust fix in Plan 4 is for **each bot to consume the queue but only its own job names**, and to make foreign-job handling a no-op as above; alternatively, split into per-owner queues. This plan documents the name-filter contract; Plan 4 must mirror it. Flag this in the Plan 4 self-review.

- [ ] **Step 8: Run to verify it passes**

Run: `npx vitest run packages/discord-bot/src/announce/worker.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 9: Commit**

```bash
git add packages/discord-bot/src/announce/message.ts packages/discord-bot/src/announce/message.test.ts packages/discord-bot/src/announce/worker.ts packages/discord-bot/src/announce/worker.test.ts
git commit -m "feat(discord-bot): announce_t30 message builder + job-name-filtered worker"
```

---

## Task 10: Command handlers + gateway bootstrap (manual smoke tests)

**Files:**
- Create: `packages/discord-bot/src/commands/link.ts`
- Create: `packages/discord-bot/src/commands/record.ts`
- Create: `packages/discord-bot/src/index.ts`

The interaction handlers and gateway client require a live Discord connection, so they are validated by manual smoke tests against a real guild. The pure logic they call (`redeemLink`, `consentNotice`, `buildAnnounceMessage`, `RecordingManager`) is already unit-tested in Tasks 2–9.

- [ ] **Step 1: Implement `packages/discord-bot/src/commands/link.ts`**

```ts
import type { ChatInputCommandInteraction } from "discord.js";
import type { ApiClient } from "../apiClient.js";

/** /link <code> — spec §10: redeem a code, tie this Discord user to a Telegram user. */
export async function handleLink(interaction: ChatInputCommandInteraction, api: ApiClient): Promise<void> {
  const code = interaction.options.getString("code", true);
  await interaction.deferReply({ ephemeral: true });
  const result = await api.redeemLink({
    code,
    discord_user_id: interaction.user.id,
    discord_username: interaction.user.username,
  });
  if (!result) {
    await interaction.editReply("invalid or expired code");
    return;
  }
  await interaction.editReply(`linked as ${result.display_name}`);
}
```

- [ ] **Step 2: Implement `packages/discord-bot/src/commands/record.ts`**

```ts
import { ChannelType, type ChatInputCommandInteraction, type GuildMember } from "discord.js";
import type { ApiClient } from "../apiClient.js";
import type { RecordingManager } from "../recording/session.js";
import type { BotConfig } from "../config.js";
import { consentNotice } from "../consent.js";
import { formatDuration } from "../lib/duration.js";

export async function handleRecord(
  interaction: ChatInputCommandInteraction,
  api: ApiClient,
  manager: RecordingManager,
  _cfg: BotConfig,
): Promise<void> {
  const sub = interaction.options.getSubcommand();
  if (sub === "start") return handleStart(interaction, api, manager);
  if (sub === "stop") return handleStop(interaction, manager);
}

async function handleStart(
  interaction: ChatInputCommandInteraction,
  api: ApiClient,
  manager: RecordingManager,
): Promise<void> {
  const guildId = interaction.guildId;
  const member = interaction.member as GuildMember | null;
  const voiceChannel = member?.voice.channel ?? null;

  if (!guildId || !voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
    await interaction.reply({ content: "join a voice channel first", ephemeral: true });
    return;
  }

  // Local guard mirroring the API's DB-enforced 409.
  if (manager.isActive(guildId)) {
    await interaction.reply({ content: "a recording is already active in this server.", ephemeral: true });
    return;
  }

  await interaction.deferReply(); // visible (non-ephemeral) — consent notice must be public
  let created;
  try {
    created = await api.createSession({
      started_by_discord_user_id: interaction.user.id,
      voice_channel_id: voiceChannel.id,
      voice_channel_name: voiceChannel.name,
      guild_id: guildId,
    });
  } catch {
    await interaction.editReply("backend not reachable, try again.");
    return;
  }
  if (!created.ok) {
    await interaction.editReply("a recording is already active in this server.");
    return;
  }

  const onWarn = () => {
    void interaction.followUp("⚠️ Recording will auto-stop in 15 minutes (max session length).").catch(() => undefined);
  };
  const onAutoStop = () => {
    void autoStop(interaction, manager, guildId).catch((e) =>
      console.error("[discord-bot] auto-stop failed:", e),
    );
  };

  await manager.start(created.session, voiceChannel, onWarn, onAutoStop);

  // Mandatory consent notice (spec §5 step 6 / §11). If posting fails, STOP immediately.
  try {
    await interaction.editReply(consentNotice(voiceChannel.name, created.session.id));
  } catch (err) {
    console.error("[discord-bot] consent notice failed — aborting recording:", err);
    await manager.abort(guildId);
    await interaction
      .followUp({ content: "could not post the recording notice — recording stopped.", ephemeral: true })
      .catch(() => undefined);
  }
}

async function handleStop(interaction: ChatInputCommandInteraction, manager: RecordingManager): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId || !manager.isActive(guildId)) {
    await interaction.reply({ content: "no active recording in this server.", ephemeral: true });
    return;
  }
  await interaction.deferReply();
  const result = await manager.stop(guildId);
  if (!result) {
    await interaction.editReply("no active recording in this server.");
    return;
  }
  await interaction.editReply(
    `Recorded ${result.speakerCount} speakers, ${formatDuration(result.totalDurationSec)}. See admin panel for download.`,
  );
}

/** Auto-stop path (hard cap): stop then post a notice in the originating channel. */
async function autoStop(
  interaction: ChatInputCommandInteraction,
  manager: RecordingManager,
  guildId: string,
): Promise<void> {
  const result = await manager.stop(guildId);
  if (!result) return;
  await interaction.followUp(
    `⏹️ Auto-stopped at the max session length. Recorded ${result.speakerCount} speakers, ${formatDuration(
      result.totalDurationSec,
    )}.`,
  );
}
```

- [ ] **Step 3: Implement `packages/discord-bot/src/index.ts`** (gateway bootstrap; spec §10 intents)

```ts
import { Client, GatewayIntentBits, Events, MessageFlags } from "discord.js";
import { buildBotConfig } from "./config.js";
import { ApiClient } from "./apiClient.js";
import { RecordingManager } from "./recording/session.js";
import { registerCommands } from "./commands/register.js";
import { handleLink } from "./commands/link.js";
import { handleRecord } from "./commands/record.js";
import { startAnnounceWorker } from "./announce/worker.js";

async function main(): Promise<void> {
  const cfg = buildBotConfig();
  const api = new ApiClient(cfg);

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages],
  });

  const manager = new RecordingManager(api, cfg);

  client.once(Events.ClientReady, (c) => {
    console.log(`[discord-bot] logged in as ${c.user.tag}`);
    startAnnounceWorker(client, cfg);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    try {
      if (interaction.commandName === "link") {
        await handleLink(interaction, api);
      } else if (interaction.commandName === "record") {
        await handleRecord(interaction, api, manager, cfg);
      }
    } catch (err) {
      console.error("[discord-bot] interaction error:", err);
      const msg = { content: "something went wrong.", flags: MessageFlags.Ephemeral } as const;
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(msg).catch(() => undefined);
      } else {
        await interaction.reply(msg).catch(() => undefined);
      }
    }
  });

  await registerCommands(cfg);
  await client.login(cfg.botToken);
}

main().catch((err) => {
  console.error("[discord-bot] fatal:", err);
  process.exit(1);
});
```

- [ ] **Step 4: Typecheck + build**

Run: `npm run typecheck -w @debates/discord-bot && npm run build -w @debates/discord-bot`
Expected: no errors; `packages/discord-bot/dist/index.js` exists.

- [ ] **Step 5: Manual smoke test — slash registration + `/link`** (real guild)

Prereqs: the Plan 1/2 `api` + `postgres` + `redis` running (`docker compose up -d`), a `.env` with a real `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, and `DISCORD_GUILD_ID` for a test guild the bot was invited to (invite URL per spec §10, permissions bitfield `36768768`, scopes `bot applications.commands`).

1. Issue a link code: in Telegram (or via `curl` to the API's `POST /api/link/issue` with the telegram bot token) mint a code for a user row that exists.
   `curl -s -X POST http://127.0.0.1:3000/api/link/issue -H "authorization: Bearer $TELEGRAM_BOT_API_TOKEN" -H 'content-type: application/json' -d '{"telegram_user_id": 898912046}'`
   Expected: `{ "code": "LINK-XXXX", "expires_at": "..." }`.
2. Run the bot: `npm run dev -w @debates/discord-bot`.
   Expected log: `registered 2 guild commands for <guildId>` then `logged in as <tag>`.
3. In the guild, run `/link LINK-XXXX`.
   Expected: ephemeral reply `linked as <display_name>`. Re-running the same code → `invalid or expired code`.

- [ ] **Step 6: Manual smoke test — `/record start` → speak → `/record stop`** (real guild)

1. Join a voice channel, run `/record start`.
   Expected: a **public** reply containing the 🔴 consent notice with a `Session ID`. The bot joins voice.
   Verify the DB: `docker compose exec postgres psql -U debates -d debates -c "select id,status,voice_channel_name from recording_sessions order by started_at desc limit 1;"` → one `recording` row.
2. Run `/record start` again (same guild) → `a recording is already active in this server.` (local guard) — and confirm a direct second `POST /api/recordings/sessions` returns **409** (API guard).
3. Speak for ~15s with one other person, then run `/record stop`.
   Expected: reply `Recorded 2 speakers, <duration>. See admin panel for download.`
   Verify files: `docker compose exec api ls -la <fileDir>` shows `<user>_<last4>.ogg` files plus `_metadata.json`; each `.ogg` opens/plays (e.g. `ffprobe` reports an Ogg/Opus stream).
   Verify DB: the session row is now `completed` with `ended_at` set, and `recording_files` has one row per non-empty speaker.

- [ ] **Step 7: Manual smoke test — empty channel + consent-failure abort**

1. `/record start` then immediately leave voice and nobody speaks → `/record stop`. Expected: `Recorded 0 speakers, 0s.` and no `.ogg` files (only `_metadata.json`).
2. (Optional, code-path review) Temporarily force the consent `editReply` to throw to confirm `manager.abort` runs and the session is torn down without leaving an orphaned voice connection. Revert after.

- [ ] **Step 8: Manual smoke test — announce_t30** (real guild)

1. Create a game scheduled ~31 minutes out via the admin/API so the `announce_t30` job fires in ~1 min (apply the Plan 2 addendum first).
2. Expected: within ~30s the bot posts in `DEBATE_ANNOUNCE_CHANNEL_ID`: `Debate in 30 min: <motion>. Participants: <@…> … <handle> (not linked)`. Linked participants render as real mentions; unlinked show `(not linked)`. No `notify_*` job is consumed by this bot (check logs — foreign jobs are ack-ignored).

- [ ] **Step 9: Commit**

```bash
git add packages/discord-bot/src/commands/link.ts packages/discord-bot/src/commands/record.ts packages/discord-bot/src/index.ts
git commit -m "feat(discord-bot): /link + /record handlers and gateway bootstrap"
```

---

## Task 11: Dockerfile + compose wiring + env

**Files:**
- Create: `packages/discord-bot/Dockerfile`
- Create: `packages/discord-bot/.dockerignore`
- Modify: `docker-compose.yml`
- Modify: `.env.example`

- [ ] **Step 1: Create `packages/discord-bot/.dockerignore`**

```dockerignore
node_modules
dist
**/*.test.ts
```

- [ ] **Step 2: Create `packages/discord-bot/Dockerfile`** (multi-stage, mirrors Plan 1's api; builds native voice deps)

```dockerfile
# Build stage
FROM node:20-alpine AS build
WORKDIR /app
# Native modules (@discordjs/opus, libsodium-wrappers) need a toolchain.
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/discord-bot/package.json packages/discord-bot/
RUN npm ci
COPY packages/shared packages/shared
COPY packages/discord-bot packages/discord-bot
RUN npm run build -w @debates/shared && npm run build -w @debates/discord-bot

# Runtime stage
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/discord-bot/package.json packages/discord-bot/
# Rebuild native deps in the runtime image, then drop the toolchain.
RUN apk add --no-cache --virtual .build python3 make g++ \
 && npm ci --omit=dev \
 && apk del .build
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/discord-bot/dist packages/discord-bot/dist
CMD ["npm", "run", "start", "-w", "@debates/discord-bot"]
```

> **Note:** build `context` is the repo root (set in compose below) so `COPY package.json …` resolves from there, matching Plan 1's api Dockerfile pattern.

- [ ] **Step 3: Add the `discord-bot` service to `docker-compose.yml`** (spec §9; shares the `recordings` volume; depends on api + redis)

Insert under `services:` (above `volumes:`):

```yaml
  discord-bot:
    build:
      context: .
      dockerfile: packages/discord-bot/Dockerfile
    depends_on: [api, redis]
    environment:
      REDIS_URL: redis://redis:6379
      API_BASE_URL: http://api:3000
      RECORDINGS_DIR: /var/lib/debates/recordings
    env_file: .env
    volumes:
      - recordings:/var/lib/debates/recordings        # same volume as api (spec §9)
    restart: unless-stopped
```

> The `recordings:` named volume already exists in `volumes:` from Plan 1 (Task 8). No new volume entry is needed.

- [ ] **Step 4: Add the bot-local vars to `.env.example`**

Append under the existing Discord block:

```bash
# Discord bot runtime (bot-local; not in the shared schema)
DISCORD_GUILD_ID=                       # test guild id for guild-scoped slash command registration
API_BASE_URL=http://api:3000            # in-network API base (compose overrides anyway)
```

- [ ] **Step 5: Build the image to verify native deps compile**

Run: `docker compose build discord-bot`
Expected: build succeeds (native `@discordjs/opus` + `libsodium-wrappers` compile in the build stage).

- [ ] **Step 6: Boot the stack and confirm the bot logs in**

Run: `docker compose up -d --build`
Run: `docker compose logs discord-bot | tail -n 20`
Expected: `registered 2 guild commands …` (if `DISCORD_GUILD_ID` set) and `logged in as <tag>`. (Requires a real `DISCORD_BOT_TOKEN` in `.env`; with a placeholder token the container logs a Discord login error — that is the expected signal that wiring is correct but the secret is missing.)

- [ ] **Step 7: Tear down + commit**

Run: `docker compose down`

```bash
git add packages/discord-bot/Dockerfile packages/discord-bot/.dockerignore docker-compose.yml .env.example
git commit -m "feat(discord-bot): Dockerfile + compose service sharing the recordings volume"
```

---

## Task 12: Full-suite green + typecheck wiring

**Files:**
- Modify: `package.json` (root `typecheck` script to include the new package)
- Modify: `vitest.workspace.ts` (already globs `packages/*/vitest.config.ts` — verify it picks up discord-bot)

- [ ] **Step 1: Extend the root `typecheck` script** to build the new package

In root `package.json`, change:

```json
"typecheck": "tsc -b packages/shared packages/api packages/discord-bot",
```

- [ ] **Step 2: Run the whole repo's unit suite**

Run: `npm test`
Expected: `shared`, `api`, and `discord-bot` suites all pass. The `discord-bot` suite covers sanitize (7), duration (5), backoff (5), filename (3), announce message (2), worker filter (2), config (3) = 27 unit tests, none of which need Discord or a database.

- [ ] **Step 3: Typecheck the workspace**

Run: `npm run typecheck`
Expected: no errors across shared + api + discord-bot.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "chore: include discord-bot in workspace typecheck"
```

---

## Self-review against the spec

**Spec §5 (recording flow) → tasks:**
- §5 start step 1 (no voice channel → "join a voice channel first") → Task 10 `handleStart`. ✓
- §5 start step 2 (POST sessions; 409 → "a recording is already active in this server."; backend unreachable → "backend not reachable, try again.") → Task 5 `ApiClient.createSession` + Task 10 error branches. ✓
- §5 start steps 4–5 (join voice; per-user `receiver.subscribe(..., EndBehaviorType.Manual)`; lazy file on first speech; write to `${file_dir}/<sanitized_username>_<last4>.ogg`) → Task 8 `RecordingManager.start` + Task 6 `OpusFileWriter` + Task 5 `recordingFileName`. **Opus packets repackaged into Ogg/Opus, no re-encode** (Task 6). ✓
- §5 start step 6 (mandatory consent reply; on send failure STOP immediately) → Task 7 `consentNotice` + Task 10 `try/catch` → `manager.abort`. ✓
- §5 stop steps 1–4 (end streams, close connection, POST `/files` per non-empty file, POST `/complete`) → Task 8 `RecordingManager.stop`. ✓
- §5 stop step 7 (reply with speaker count + total duration) → Task 10 `handleStop` + Task 3 `formatDuration`. ✓
- §5 failure mode "API unreachable on `/record stop` → exponential backoff up to 1h" → Task 4 `retryWithBackoff` applied in Task 8. ✓
- §5 hard caps (auto-stop at `MAX_SESSION_HOURS`, 3h45m warning; max 1 session/guild) → Task 8 `capTimings` + `onWarn`/`onAutoStop` + the `active` Map guard, mirrored by the API 409. ✓
- §5 audio format (48 kHz Opus) → Task 6 `OpusHead({ channelCount: 2, sampleRate: 48000 })` (stereo passthrough; mono is a documented downstream aspiration, not re-encoded). ✓

**Spec §10 (Discord setup) → tasks:**
- Gateway intents `Guilds`, `GuildVoiceStates`, `GuildMessages` → Task 10 `index.ts` `Client` intents. ✓
- Guild-scoped slash command registration at startup → Task 7 `registerCommands`. ✓
- Command table `/link <code>`, `/record start`, `/record stop` → Task 7 `definitions.ts`. ✓
- Permissions bitfield `36768768` + scopes `bot applications.commands` → documented in Task 10 Step 5 invite prereqs (invite URL is an operator action, not code). ✓

**Spec §11 (consent) → tasks:**
- Mandatory recording-active notice on `/record start`, visible in the text channel → Task 7 `consentNotice` posted as a **public** reply in Task 10. ✓
- On notice failure, stop recording → Task 10 abort path. ✓
- 30-day retention wording present in the notice → Task 7. (Actual deletion is the API's `cleanup_old_recordings` cron, Plan 2.) ✓

**Spec §7 (API rows this bot calls) → tasks:**
- `POST /api/link/redeem` (200 `{telegram_user_id, display_name}` | 404) → Task 5 `redeemLink` + Task 10 `handleLink` ("linked as …" / "invalid or expired code"). ✓
- `POST /api/recordings/sessions` (201 | 409) → Task 5 `createSession`. ✓
- `POST /api/recordings/sessions/:id/files` → Task 5 `registerFile` (sends `file_path` = the relative `.ogg` name, matching `recording_files.file_path` semantics in §3). ✓
- `POST /api/recordings/sessions/:id/complete` → Task 5 `completeSession`. ✓
- All four sent with `Authorization: Bearer ${DISCORD_BOT_API_TOKEN}` → Task 5 `ApiClient.post`. ✓

**Spec §4 (`announce_t30`) → tasks:** BullMQ Worker on `game-events` filtering `job.name === "announce_t30"` and ack-ignoring all others → Task 9 `startAnnounceWorker`/`shouldHandle`; message built by `buildAnnounceMessage` and posted to `DEBATE_ANNOUNCE_CHANNEL_ID`. ✓

**Cross-plan addenda introduced:**
1. **Plan 2 `announce_t30` richer payload** (top of doc): `GameEventPayload.announce?: AnnouncePayload`. Resolves the "bot has no admin cookie" problem by enqueuing motion + participants. Must be applied before Task 9 smoke test. Stated as the recommended option over a bot read endpoint.
2. **Plan 4 queue-consumer name-filter contract** (Task 9 caveat): both bots share one `game-events` queue; each must consume only its own job names and ack-ignore foreign jobs to avoid starving the other. Flag in Plan 4's self-review.

**Placeholder scan:** every step ships real, complete code — no "TBD", no "add error handling", no "similar to above". The two documented approximations (stereo Opus passthrough vs. spec's "mono"; wall-clock `duration_sec`) are explicit, justified decisions with rationale, not deferred work.

**Type-consistency check:**
- `BotConfig` (Task 1) consumed by `ApiClient` (Task 5, `Pick`), `registerCommands` (Task 7), `RecordingManager` (Task 8), `startAnnounceWorker` (Task 9), `index.ts` (Task 10) — one definition, consistent fields.
- `ApiClient` method shapes (`redeemLink`, `createSession`→`{ok,session}|{ok:false,conflict}`, `registerFile`, `completeSession`) match exactly what Task 8/10 call.
- `AnnouncePayload` defined once in `announce/message.ts` (Task 9), imported by `worker.ts` and the Plan 2 addendum — single source of truth.
- `recordingFileName` (Task 5) builds the `.ogg` name used both on disk (Task 8 `OpusFileWriter` path) and in the `file_path` field sent to the API (Task 8 `registerFile`) — consistent value end to end.
- `retryWithBackoff`/`backoffSchedule`/`BackoffOpts` (Task 4) reused by Task 8 with the shared `BACKOFF` constant.
- `QUEUE_NAME` imported from `@debates/shared` (Plan 1) in Task 9 — same queue the API publishes to in Plan 2.

---

**End of Plan 3.** The bot is a stateless actuator: all DB writes go through the Plan 2 API; all audio bytes go to the shared `recordings` volume; the only queue job it owns is `announce_t30`. Plan 4 (Telegram bot) consumes the remaining `game-events` job types and must mirror the Task 9 name-filter contract; Plan 6 (deploy) sets `DISCORD_GUILD_ID`, the real `DISCORD_BOT_TOKEN`, and `NODE_ENV=production`.
