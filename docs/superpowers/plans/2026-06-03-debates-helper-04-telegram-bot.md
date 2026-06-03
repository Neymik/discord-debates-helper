# Telegram Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `@debates/telegram-bot` package — a long-polling grammy bot that registers players on `/start`, issues link codes on `/code`, lists a user's upcoming games on `/games`, and consumes its five `game-events` job types (`notify_week_before`, `notify_day_before`, `notify_hour_before`, `nudge_unlinked_40m`, `notify_t10`) from the shared BullMQ queue — DMing every participant per the spec §4 templates, minting a fresh link code per unlinked participant for the `notify_hour_before` and `nudge_unlinked_40m` jobs. Every pure helper (message templates, link-instruction appending, recipient-fail isolation, job-name filter) is unit-tested with grammy's `Api` mocked; the live long-polling bits are isolated behind thin seams with explicit manual smoke tests.

**Architecture:** The bot owns no database. It calls the Plan 2 HTTP API with `Authorization: Bearer ${TELEGRAM_BOT_API_TOKEN}` for `POST /api/users/register` (new — see addendum below), `POST /api/link/issue`, and `GET /api/users/:telegram_user_id/games` (new — see addendum below). It attaches a BullMQ `Worker` to the same `game-events` queue the Discord bot uses, and **strictly filters by `job.name`** — handling only its own five job types and ack-ignoring `announce_t30` (Discord's) **without throwing**, so neither bot starves the other. The notification worker reads the richer enqueue payload the API attaches (motion, scheduledAt, participant list with `telegram_user_id` + linked status) so it never needs an admin-scoped read. Per-recipient DM failures are caught and isolated: one blocked recipient (Telegram 403 because they never `/start`-ed) never aborts the rest of the broadcast.

**Tech Stack:** Node 20 (Docker) / Node 22 (local dev), TypeScript (ESM, NodeNext), grammy v1, bullmq + ioredis, undici (`fetch` is global on Node 20), Vitest + tsx.

**Depends on:** Plan 1 (`@debates/shared` env loader + `QUEUE_NAME` + `JOB_TYPES`; monorepo tsconfig/Dockerfile/compose conventions) and Plan 2 (the HTTP contracts: `POST /api/link/issue` → `{ code, expires_at }`; plus the two **Plan 2 addenda** below). It **mirrors the Plan 3 (Discord bot) shared queue contract**: both bots run a `Worker` on `game-events` and must consume only their own `job.name`s, ack-ignoring foreign jobs without throwing (Plan 3 Task 9 caveat). This plan implements the Telegram half of that contract.

**This is Plan 4 of 6.**

---

## ⚠️ Cross-plan dependencies (three required Plan 2 addenda)

This plan introduces three small Plan 2 additions. Apply them before executing the tasks that depend on them (noted per task). All three are stated here with exact endpoint code so the Plan 2 implementer (or whoever picks these up) has no ambiguity.

### Addendum A — bot-scoped `POST /api/users/register` (needed by `/start`)

The spec §3 says users are created on `/start`; spec §8 makes the **API the sole writer to Postgres**. Plan 2 only auto-creates a `users` row for *admins* on Telegram-Login (`adminAuth.ts` upsert). There is no path to create an ordinary player. So `/start` must call a new **telegram-bot-token-scoped** endpoint that upserts the player by `telegram_user_id`.

Add to `packages/api/src/routes/users.ts` (the bot route is **public to the admin guard** — it uses `requireBotToken(telegramBotApiToken)`, not `requireAdmin`, so mount it on its own sub-path or guard it inline):

```ts
// packages/api/src/routes/users.ts — addendum A
import { z } from "zod";
import { requireBotToken } from "../middleware/botAuth.js";
import { buildConfig } from "../config.js";

const config = buildConfig();

const RegisterUserBody = z.object({
  telegram_user_id: z.coerce.bigint(),
  telegram_username: z.string().max(200).nullish(),
  display_name: z.string().min(1).max(200),
});

// Telegram bot registers a player on /start. Bot-token scoped, NOT admin.
usersRouter.post("/register", requireBotToken(config.telegramBotApiToken), async (req, res) => {
  const body = RegisterUserBody.parse(req.body);
  const user = await prisma.user.upsert({
    where: { telegramUserId: body.telegram_user_id },
    create: {
      telegramUserId: body.telegram_user_id,
      telegramUsername: body.telegram_username ?? null,
      displayName: body.display_name,
    },
    update: {
      telegramUsername: body.telegram_username ?? null,
      displayName: body.display_name,
    },
  });
  res.status(201).json({
    id: user.id,
    telegram_user_id: Number(user.telegramUserId),
    display_name: user.displayName,
    linked: user.discordUserId !== null,
  });
});
```

> **Ordering note:** `usersRouter.use(requireAdmin)` in Plan 2 Task 8 guards the whole router. The `/register` (and `/:telegram_user_id/games` below) bot routes must be registered **before** `usersRouter.use(requireAdmin)` OR mounted on a separate router that is not behind `requireAdmin`. Recommended: keep a separate `botUsersRouter` and mount it at `/api/users` ahead of the admin router. The Plan 2 implementer chooses; this plan only needs the two endpoints reachable with the telegram bot token.

### Addendum B — bot-scoped `GET /api/users/:telegram_user_id/games` (needed by `/games`)

`/games` lists a user's upcoming games. The bot has no admin cookie and the admin `GET /api/games` returns *all* games, not one user's. Add a telegram-bot-token-scoped read returning only that user's future `scheduled` games:

```ts
// packages/api/src/routes/users.ts — addendum B (same botUsersRouter as A)
botUsersRouter.get(
  "/:telegram_user_id/games",
  requireBotToken(config.telegramBotApiToken),
  async (req, res) => {
    const telegramUserId = BigInt(req.params.telegram_user_id);
    const user = await prisma.user.findUnique({ where: { telegramUserId } });
    if (!user) return res.status(404).json({ error: "not_found" });
    const games = await prisma.game.findMany({
      where: {
        status: "scheduled",
        scheduledAt: { gt: new Date() },
        participants: { some: { userId: user.id } },
      },
      orderBy: { scheduledAt: "asc" },
      select: { id: true, scheduledAt: true, motion: true },
    });
    res.json(
      games.map((g) => ({
        id: g.id,
        scheduled_at: g.scheduledAt.toISOString(),
        motion: g.motion,
      })),
    );
  },
);
```

### Addendum C — richer enqueue payloads for the `notify_*` / `nudge_*` jobs (needed by the notification worker)

Plan 3 already proposed enriching the `announce_t30` payload with motion + participants so the Discord bot needs no admin read. **The Telegram bot's five jobs need the same treatment**, for the same reason: the worker must DM each participant, and for `notify_hour_before` / `nudge_unlinked_40m` must know which participants are **unlinked** (to mint a code and append link instructions). Rather than a per-recipient admin read, the API enqueues a `notify` payload alongside the existing `announce` one. This is consistent with Plan 3's recommendation (prefer richer enqueue payloads over new bot read endpoints) and is a point-in-time snapshot, which is exactly what a notification wants.

Extend the Plan 2 scheduler payload type (building on Plan 3's addendum to the same file):

```ts
// packages/api/src/scheduler/scheduler.ts — addendum C (extends Plan 3's AnnouncePayload addendum)
export interface NotifyParticipant {
  telegram_user_id: number;          // for DM addressing + per-recipient code minting
  display_name: string;
  linked: boolean;                   // discordUserId !== null
}
export interface NotifyPayload {
  motion: string | null;
  scheduled_at: string;              // ISO8601 — the worker renders date/time
  participants: NotifyParticipant[];
}
export interface GameEventPayload {
  gameId: string;
  type: JobType;
  announce?: AnnouncePayload;        // present ONLY on announce_t30 (Plan 3)
  notify?: NotifyPayload;            // present on the five Telegram jobs (this plan)
}
```

When enqueuing, `enqueueGameJobs` already loads `include: { participants: { include: { user: true } } }` (Plan 2 games service / Plan 3 addendum). For every job **except** `announce_t30`, attach:

```ts
notify: {
  motion: game.motion,
  scheduled_at: game.scheduledAt.toISOString(),
  participants: game.participants.map((p) => ({
    telegram_user_id: Number(p.user.telegramUserId),
    display_name: p.user.displayName,
    linked: p.user.discordUserId !== null,
  })),
}
```

This plan's worker (Task 7) consumes exactly that `NotifyPayload`. If the Plan 2 implementer instead prefers a bot read endpoint, only the worker's data source changes; the template + dispatch logic (Tasks 4–6) stay identical because they take plain typed inputs. **Apply addendum C before executing Task 7's smoke test.**

> **Mirror note (Plan 3 contract):** the Discord bot's `announce_t30` worker (Plan 3 Task 9) ack-ignores the five Telegram job names; this plan's worker (Task 7) ack-ignores `announce_t30`. Together they make the shared `game-events` queue safe for two consumers. Flagged again in this plan's self-review.

---

## File structure introduced by this plan

```
packages/telegram-bot/
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
    │   ├── datetime.ts           # formatGameDate (pure, UTC)
    │   ├── datetime.test.ts
    │   ├── templates.ts          # notification message templates (pure)
    │   ├── templates.test.ts
    │   ├── linkInstructions.ts   # appendLinkInstructions (pure)
    │   └── linkInstructions.test.ts
    ├── notify/
    │   ├── dispatch.ts           # broadcastToParticipants: per-recipient fail isolation
    │   ├── dispatch.test.ts      # "one fails, others still sent" with mocked Api
    │   ├── worker.ts             # BullMQ Worker filtering the five owned job names
    │   └── worker.test.ts        # job-name filter unit test
    ├── commands/
    │   ├── start.ts              # /start handler (register)
    │   ├── code.ts               # /code handler (issue link code)
    │   └── games.ts             # /games handler (list upcoming)
    └── index.ts                  # grammy Bot bootstrap + long polling + worker wiring
```

---

## Task 1: Package scaffold + config

**Files:**
- Create: `packages/telegram-bot/package.json`
- Create: `packages/telegram-bot/tsconfig.json`
- Create: `packages/telegram-bot/vitest.config.ts`
- Create: `packages/telegram-bot/src/config.ts`
- Test: `packages/telegram-bot/src/config.test.ts`

- [ ] **Step 1: Create `packages/telegram-bot/package.json`**

```json
{
  "name": "@debates/telegram-bot",
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
    "grammy": "^1.30.0",
    "bullmq": "^5.13.0",
    "ioredis": "^5.4.0"
  },
  "devDependencies": {
    "@types/node": "^20.16.0"
  }
}
```

> **Why these deps:** grammy for the Telegram bot (long polling + `Api` for `sendMessage`); `bullmq` + `ioredis` for the `game-events` worker. No native modules — this image builds without a toolchain (simpler than the Discord bot's Dockerfile).

- [ ] **Step 2: Create `packages/telegram-bot/tsconfig.json`**

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

- [ ] **Step 3: Create `packages/telegram-bot/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "telegram-bot",
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 4: Install workspace deps**

Run: `npm install`
Expected: completes; `@debates/telegram-bot` symlinked under `node_modules/@debates/`.

- [ ] **Step 5: Write the failing config test**

`packages/telegram-bot/src/config.test.ts`:

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
  it("derives the bot token, API base URL, API token, and redis url", () => {
    const cfg = buildBotConfig({ ...base, API_BASE_URL: "http://api:3000" });
    expect(cfg.botToken).toBe("ttoken");
    expect(cfg.apiBaseUrl).toBe("http://api:3000");
    expect(cfg.botApiToken).toBe("b".repeat(32));
    expect(cfg.redisUrl).toBe("redis://localhost:6379");
  });

  it("defaults API_BASE_URL to http://api:3000", () => {
    const cfg = buildBotConfig(base);
    expect(cfg.apiBaseUrl).toBe("http://api:3000");
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `npx vitest run packages/telegram-bot/src/config.test.ts`
Expected: FAIL — `Cannot find module './config.js'`.

- [ ] **Step 7: Implement `packages/telegram-bot/src/config.ts`**

```ts
import { loadEnv } from "@debates/shared";

export interface BotConfig {
  botToken: string;
  apiBaseUrl: string;
  botApiToken: string;
  redisUrl: string;
}

/**
 * Builds the Telegram bot's typed config from the shared env loader.
 * API_BASE_URL is bot-local (not in the shared schema), so it is read directly
 * off `source` with a default matching the in-network compose service name.
 */
export function buildBotConfig(source: Record<string, string | undefined> = process.env): BotConfig {
  const env = loadEnv(source);
  return {
    botToken: env.TELEGRAM_BOT_TOKEN,
    apiBaseUrl: source.API_BASE_URL ?? "http://api:3000",
    botApiToken: env.TELEGRAM_BOT_API_TOKEN,
    redisUrl: env.REDIS_URL,
  };
}
```

- [ ] **Step 8: Run to verify it passes**

Run: `npx vitest run packages/telegram-bot/src/config.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 9: Commit**

```bash
git add packages/telegram-bot/package.json packages/telegram-bot/tsconfig.json packages/telegram-bot/vitest.config.ts packages/telegram-bot/src/config.ts packages/telegram-bot/src/config.test.ts package-lock.json
git commit -m "feat(telegram-bot): scaffold package + typed config from shared env"
```

---

## Task 2: Pure helper — game date/time formatting

**Files:**
- Create: `packages/telegram-bot/src/lib/datetime.ts`
- Test: `packages/telegram-bot/src/lib/datetime.test.ts`

The spec §4 templates read *"{date} at {time}"*. Phase 1 is English-only and single-club; we render the game's `scheduled_at` in UTC with a fixed, unambiguous format (`Mon 10 Jun 2026 at 19:00 UTC`). Keeping it pure + UTC makes it deterministically testable (no machine-timezone flakiness).

- [ ] **Step 1: Write the failing test**

`packages/telegram-bot/src/lib/datetime.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { formatGameDate } from "./datetime.js";

describe("formatGameDate", () => {
  it("formats an ISO timestamp as 'Wed 10 Jun 2026 at 19:00 UTC'", () => {
    expect(formatGameDate("2026-06-10T19:00:00Z")).toBe("Wed 10 Jun 2026 at 19:00 UTC");
  });

  it("zero-pads the time", () => {
    expect(formatGameDate("2026-01-05T09:05:00Z")).toBe("Mon 05 Jan 2026 at 09:05 UTC");
  });

  it("accepts a Date instance too", () => {
    expect(formatGameDate(new Date("2026-12-31T23:59:00Z"))).toBe("Thu 31 Dec 2026 at 23:59 UTC");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/telegram-bot/src/lib/datetime.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `packages/telegram-bot/src/lib/datetime.ts`**

```ts
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

/**
 * Renders a game timestamp in a fixed, unambiguous UTC format for DM copy:
 * `Wed 10 Jun 2026 at 19:00 UTC`. Phase 1 is single-club/English; UTC keeps it
 * deterministic and timezone-flake-free (spec §1 removes i18n).
 */
export function formatGameDate(scheduledAt: string | Date): string {
  const d = typeof scheduledAt === "string" ? new Date(scheduledAt) : scheduledAt;
  const day = DAYS[d.getUTCDay()];
  const date = pad2(d.getUTCDate());
  const month = MONTHS[d.getUTCMonth()];
  const year = d.getUTCFullYear();
  const time = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
  return `${day} ${date} ${month} ${year} at ${time} UTC`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/telegram-bot/src/lib/datetime.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/telegram-bot/src/lib/datetime.ts packages/telegram-bot/src/lib/datetime.test.ts
git commit -m "feat(telegram-bot): UTC game date/time formatting helper"
```

---

## Task 3: Pure helper — link-code instructions appender

**Files:**
- Create: `packages/telegram-bot/src/lib/linkInstructions.ts`
- Test: `packages/telegram-bot/src/lib/linkInstructions.test.ts`

Spec §4 (`notify_hour_before`, `nudge_unlinked_40m`): for each unlinked participant the worker mints a fresh `LINK-XXXX` and appends instructions to run `/link LINK-XXXX` in Discord. This is a pure string builder so the worker's wiring stays trivial.

- [ ] **Step 1: Write the failing test**

`packages/telegram-bot/src/lib/linkInstructions.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { appendLinkInstructions } from "./linkInstructions.js";

describe("appendLinkInstructions", () => {
  it("appends a code line and the /link instruction to a base message", () => {
    const out = appendLinkInstructions("Debate in 1 hour.", "LINK-7F2X");
    expect(out).toContain("Debate in 1 hour.");
    expect(out).toContain("LINK-7F2X");
    expect(out).toContain("/link LINK-7F2X");
    // base message stays first
    expect(out.indexOf("Debate in 1 hour.")).toBe(0);
  });

  it("separates the base and the instructions with a blank line", () => {
    const out = appendLinkInstructions("Base.", "LINK-ABCD");
    expect(out).toBe(
      "Base.\n\nYou haven't linked Discord yet. Code: LINK-ABCD. In Discord, run `/link LINK-ABCD`.",
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/telegram-bot/src/lib/linkInstructions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `packages/telegram-bot/src/lib/linkInstructions.ts`**

```ts
/**
 * Appends link-code instructions to a base DM (spec §4: notify_hour_before /
 * nudge_unlinked_40m). The caller mints a fresh code via POST /api/link/issue
 * per recipient; this renders the user-facing instruction to redeem it in Discord.
 */
export function appendLinkInstructions(baseMessage: string, code: string): string {
  return `${baseMessage}\n\nYou haven't linked Discord yet. Code: ${code}. In Discord, run \`/link ${code}\`.`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/telegram-bot/src/lib/linkInstructions.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/telegram-bot/src/lib/linkInstructions.ts packages/telegram-bot/src/lib/linkInstructions.test.ts
git commit -m "feat(telegram-bot): link-code instructions appender"
```

---

## Task 4: Notification message templates (spec §4 / §13 — finalize English copy)

**Files:**
- Create: `packages/telegram-bot/src/lib/templates.ts`
- Test: `packages/telegram-bot/src/lib/templates.test.ts`

This is where the spec §13 open question ("Exact Telegram message copy — English templates to be drafted in implementation plan") is **resolved**. One pure function per Telegram job type, each taking the rendered motion + date string. The `notify_hour_before` and `nudge_unlinked_40m` base templates are plain text; link instructions are appended per-recipient at dispatch time (Task 3 + Task 6).

- [ ] **Step 1: Write the failing test**

`packages/telegram-bot/src/lib/templates.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { renderTemplate, type TemplateInput } from "./templates.js";

const input: TemplateInput = {
  motion: "THW abolish zoos",
  dateText: "Wed 10 Jun 2026 at 19:00 UTC",
};
const noMotion: TemplateInput = { motion: null, dateText: "Wed 10 Jun 2026 at 19:00 UTC" };

describe("renderTemplate", () => {
  it("notify_week_before mentions 'next week' and the motion + date", () => {
    const msg = renderTemplate("notify_week_before", input);
    expect(msg).toContain("next week");
    expect(msg).toContain("THW abolish zoos");
    expect(msg).toContain("Wed 10 Jun 2026 at 19:00 UTC");
  });

  it("notify_day_before says 'tomorrow'", () => {
    expect(renderTemplate("notify_day_before", input)).toContain("tomorrow");
  });

  it("notify_hour_before says 'in 1 hour'", () => {
    expect(renderTemplate("notify_hour_before", input)).toContain("in 1 hour");
  });

  it("nudge_unlinked_40m says 'in 40 min' and warns about linking", () => {
    const msg = renderTemplate("nudge_unlinked_40m", input);
    expect(msg).toContain("40 min");
    expect(msg.toLowerCase()).toContain("haven't linked");
  });

  it("notify_t10 tells players to be in the voice channel", () => {
    const msg = renderTemplate("notify_t10", input);
    expect(msg).toContain("10 min");
    expect(msg.toLowerCase()).toContain("voice channel");
  });

  it("falls back to '(motion TBA)' when motion is null", () => {
    expect(renderTemplate("notify_week_before", noMotion)).toContain("(motion TBA)");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/telegram-bot/src/lib/templates.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `packages/telegram-bot/src/lib/templates.ts`**

```ts
/** The five game-events job types the Telegram bot owns (spec §4). */
export type TelegramJobType =
  | "notify_week_before"
  | "notify_day_before"
  | "notify_hour_before"
  | "nudge_unlinked_40m"
  | "notify_t10";

export interface TemplateInput {
  motion: string | null;
  dateText: string; // pre-rendered via formatGameDate (Task 2)
}

function motionText(motion: string | null): string {
  return motion && motion.trim().length > 0 ? motion : "(motion TBA)";
}

/**
 * Finalized English notification copy (spec §4 templates, §13 open question).
 * Each function returns the BASE message; link instructions for unlinked
 * recipients are appended later (Task 3 appendLinkInstructions) at dispatch.
 */
const TEMPLATES: Record<TelegramJobType, (i: TemplateInput) => string> = {
  notify_week_before: (i) =>
    `Debate next week: ${motionText(i.motion)}.\n${i.dateText}.`,
  notify_day_before: (i) =>
    `Debate tomorrow: ${motionText(i.motion)}.\n${i.dateText}.`,
  notify_hour_before: (i) =>
    `Debate in 1 hour: ${motionText(i.motion)}.\n${i.dateText}.`,
  nudge_unlinked_40m: (i) =>
    `Debate in 40 min: ${motionText(i.motion)}.\nYou still haven't linked Discord — link now so your recording is attributed to you.`,
  notify_t10: (i) =>
    `Starting in 10 min: ${motionText(i.motion)}.\nPlease be in the voice channel now.`,
};

export function renderTemplate(type: TelegramJobType, input: TemplateInput): string {
  return TEMPLATES[type](input);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/telegram-bot/src/lib/templates.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/telegram-bot/src/lib/templates.ts packages/telegram-bot/src/lib/templates.test.ts
git commit -m "feat(telegram-bot): finalize English notification templates"
```

---

## Task 5: Typed API client

**Files:**
- Create: `packages/telegram-bot/src/apiClient.ts`

The thin wrapper over the Plan 2 HTTP API (plus addenda A/B). Always sends `Authorization: Bearer ${TELEGRAM_BOT_API_TOKEN}`. No unit test for the network shapes here (covered by the consuming command/worker tests with a mocked client); typecheck is the gate.

- [ ] **Step 1: Implement `packages/telegram-bot/src/apiClient.ts`** (uses Node 20 global `fetch`)

```ts
import type { BotConfig } from "./config.js";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface RegisteredUser {
  id: string;
  telegram_user_id: number;
  display_name: string;
  linked: boolean;
}

export interface IssuedCode {
  code: string;
  expires_at: string;
}

export interface UpcomingGame {
  id: string;
  scheduled_at: string;
  motion: string | null;
}

/** Thin typed wrapper over the Plan 2 HTTP API, always sending the bot Bearer token. */
export class ApiClient {
  constructor(private readonly cfg: Pick<BotConfig, "apiBaseUrl" | "botApiToken">) {}

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.cfg.botApiToken}`,
    };
  }

  /** POST /api/users/register (addendum A) → 201 registered user. Upsert by telegram_user_id. */
  async registerUser(input: {
    telegram_user_id: number;
    telegram_username: string | null;
    display_name: string;
  }): Promise<RegisteredUser> {
    const res = await fetch(`${this.cfg.apiBaseUrl}/api/users/register`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(input),
    });
    if (res.status !== 201) throw new ApiError(`registerUser failed: ${res.status}`, res.status);
    return (await res.json()) as RegisteredUser;
  }

  /** POST /api/link/issue → 201 { code, expires_at }. */
  async issueLinkCode(telegramUserId: number): Promise<IssuedCode> {
    const res = await fetch(`${this.cfg.apiBaseUrl}/api/link/issue`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ telegram_user_id: telegramUserId }),
    });
    if (res.status !== 201) throw new ApiError(`issueLinkCode failed: ${res.status}`, res.status);
    return (await res.json()) as IssuedCode;
  }

  /** GET /api/users/:telegram_user_id/games (addendum B) → 200 list | 404 unknown user. */
  async listUpcomingGames(telegramUserId: number): Promise<UpcomingGame[] | null> {
    const res = await fetch(`${this.cfg.apiBaseUrl}/api/users/${telegramUserId}/games`, {
      method: "GET",
      headers: this.headers(),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new ApiError(`listUpcomingGames failed: ${res.status}`, res.status);
    return (await res.json()) as UpcomingGame[];
  }
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `npm run typecheck -w @debates/telegram-bot`
Expected: no errors.

```bash
git add packages/telegram-bot/src/apiClient.ts
git commit -m "feat(telegram-bot): typed API client (register, issue, list games)"
```

---

## Task 6: Notification dispatch — per-recipient failure isolation

**Files:**
- Create: `packages/telegram-bot/src/notify/dispatch.ts`
- Test: `packages/telegram-bot/src/notify/dispatch.test.ts`

The core robustness requirement: Telegram returns **403** when DMing a user who never `/start`-ed the bot. `broadcastToParticipants` must catch each per-recipient send/issue failure and continue, so one blocked recipient never aborts the broadcast. The grammy `Api` is mocked; the test proves "one recipient fails, the others are still sent." For unlinked recipients on the hour/40m jobs it mints a fresh code (via the injected `ApiClient`) and appends instructions (Task 3).

- [ ] **Step 1: Write the failing test** (mocked grammy `Api` + mocked `ApiClient`)

`packages/telegram-bot/src/notify/dispatch.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { broadcastToParticipants, type DispatchDeps } from "./dispatch.js";
import type { NotifyParticipant } from "./worker.js";

function deps(over: Partial<DispatchDeps> = {}): DispatchDeps {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    issueLinkCode: vi.fn().mockResolvedValue({ code: "LINK-7F2X", expires_at: "2026-06-11T00:00:00Z" }),
    ...over,
  };
}

const linked: NotifyParticipant = { telegram_user_id: 1, display_name: "Alice", linked: true };
const linked2: NotifyParticipant = { telegram_user_id: 2, display_name: "Bob", linked: true };
const unlinked: NotifyParticipant = { telegram_user_id: 3, display_name: "Carol", linked: false };

describe("broadcastToParticipants", () => {
  it("sends the base message to every participant for a plain reminder", async () => {
    const d = deps();
    const result = await broadcastToParticipants("notify_week_before", [linked, linked2], "Body", d);
    expect(d.sendMessage).toHaveBeenCalledTimes(2);
    expect(d.sendMessage).toHaveBeenCalledWith(1, "Body");
    expect(d.sendMessage).toHaveBeenCalledWith(2, "Body");
    expect(result).toEqual({ sent: 2, failed: 0 });
  });

  it("isolates a single failing recipient: others still receive the DM", async () => {
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce(undefined) // recipient 1 ok
      .mockRejectedValueOnce(Object.assign(new Error("Forbidden"), { error_code: 403 })) // 2 blocked
      .mockResolvedValueOnce(undefined); // 3 ok
    const d = deps({ sendMessage });
    const result = await broadcastToParticipants(
      "notify_week_before",
      [linked, linked2, { telegram_user_id: 9, display_name: "Dan", linked: true }],
      "Body",
      d,
    );
    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ sent: 2, failed: 1 });
  });

  it("for notify_hour_before mints a code + appends instructions ONLY for unlinked recipients", async () => {
    const d = deps();
    await broadcastToParticipants("notify_hour_before", [linked, unlinked], "Body", d);
    // linked → no code minted, plain body
    expect(d.sendMessage).toHaveBeenCalledWith(1, "Body");
    // unlinked → code minted once, instructions appended
    expect(d.issueLinkCode).toHaveBeenCalledTimes(1);
    expect(d.issueLinkCode).toHaveBeenCalledWith(3);
    const carolCall = (d.sendMessage as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0] === 3);
    expect(carolCall?.[1]).toContain("/link LINK-7F2X");
  });

  it("for nudge_unlinked_40m sends ONLY to unlinked recipients", async () => {
    const d = deps();
    const result = await broadcastToParticipants("nudge_unlinked_40m", [linked, unlinked], "Body", d);
    expect(d.sendMessage).toHaveBeenCalledTimes(1);
    expect(d.sendMessage).toHaveBeenCalledWith(3, expect.stringContaining("/link LINK-7F2X"));
    expect(result).toEqual({ sent: 1, failed: 0 });
  });

  it("a failing issueLinkCode for one unlinked recipient does not abort the rest", async () => {
    const issueLinkCode = vi
      .fn()
      .mockRejectedValueOnce(new Error("issue boom"))
      .mockResolvedValue({ code: "LINK-OK22", expires_at: "2026-06-11T00:00:00Z" });
    const d = deps({ issueLinkCode });
    const unlinked2: NotifyParticipant = { telegram_user_id: 4, display_name: "Eve", linked: false };
    const result = await broadcastToParticipants("nudge_unlinked_40m", [unlinked, unlinked2], "Body", d);
    expect(result).toEqual({ sent: 1, failed: 1 });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/telegram-bot/src/notify/dispatch.test.ts`
Expected: FAIL — `./dispatch.js` not found (and `./worker.js` type import — created in Task 7; define `NotifyParticipant` there. To keep this task self-contained, the test imports the type from `./worker.js`, so Task 7 must export it. If running Task 6 strictly before Task 7, temporarily inline the type; the committed code imports from `worker.js`.)

> **Sequencing:** `NotifyParticipant` is the worker's payload type (addendum C). Implement Task 7's `worker.ts` type export first OR create a tiny `worker.ts` stub exporting only the interface, then flesh it out in Task 7. The plan implements `worker.ts`'s types as part of this task's prerequisites below.

- [ ] **Step 3: Implement `packages/telegram-bot/src/notify/dispatch.ts`**

```ts
import { appendLinkInstructions } from "../lib/linkInstructions.js";
import type { TelegramJobType } from "../lib/templates.js";
import type { NotifyParticipant } from "./worker.js";
import type { IssuedCode } from "../apiClient.js";

/** Injectable side-effects so dispatch is unit-testable without grammy or HTTP. */
export interface DispatchDeps {
  /** Wraps grammy `bot.api.sendMessage(chatId, text)`. Rejects on Telegram errors (e.g. 403). */
  sendMessage: (telegramUserId: number, text: string) => Promise<void>;
  /** Wraps ApiClient.issueLinkCode — mints a fresh LINK-XXXX for an unlinked recipient. */
  issueLinkCode: (telegramUserId: number) => Promise<IssuedCode>;
}

export interface DispatchResult {
  sent: number;
  failed: number;
}

/** Jobs that DM ONLY unlinked participants (spec §4 nudge_unlinked_40m). */
const UNLINKED_ONLY: ReadonlySet<TelegramJobType> = new Set(["nudge_unlinked_40m"]);
/** Jobs that append a fresh link code for each UNLINKED participant (spec §4). */
const APPEND_CODE: ReadonlySet<TelegramJobType> = new Set(["notify_hour_before", "nudge_unlinked_40m"]);

/**
 * DMs `baseMessage` to the right subset of `participants` for `jobType`, isolating
 * per-recipient failures (a blocked recipient who never /start-ed yields a 403 from
 * Telegram — caught and counted, never aborting the rest). For code-appending jobs,
 * each unlinked recipient gets a freshly minted LINK-XXXX with /link instructions.
 */
export async function broadcastToParticipants(
  jobType: TelegramJobType,
  participants: NotifyParticipant[],
  baseMessage: string,
  deps: DispatchDeps,
): Promise<DispatchResult> {
  let sent = 0;
  let failed = 0;

  const targets = UNLINKED_ONLY.has(jobType)
    ? participants.filter((p) => !p.linked)
    : participants;

  for (const p of targets) {
    try {
      let text = baseMessage;
      if (APPEND_CODE.has(jobType) && !p.linked) {
        const { code } = await deps.issueLinkCode(p.telegram_user_id);
        text = appendLinkInstructions(baseMessage, code);
      }
      await deps.sendMessage(p.telegram_user_id, text);
      sent++;
    } catch (err) {
      failed++;
      console.error(`[telegram-bot] dispatch to ${p.telegram_user_id} failed (${jobType}):`, err);
    }
  }

  return { sent, failed };
}
```

- [ ] **Step 4: Run to verify it passes** (after Task 7's `NotifyParticipant` export exists)

Run: `npx vitest run packages/telegram-bot/src/notify/dispatch.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/telegram-bot/src/notify/dispatch.ts packages/telegram-bot/src/notify/dispatch.test.ts
git commit -m "feat(telegram-bot): notification dispatch with per-recipient failure isolation"
```

---

## Task 7: BullMQ worker — owns five job names, ack-ignores announce_t30

**Files:**
- Create: `packages/telegram-bot/src/notify/worker.ts`
- Test: `packages/telegram-bot/src/notify/worker.test.ts`

> Apply **Plan 2 addendum C** (top of doc) first so the five jobs carry the `notify` payload. Mirrors **Plan 3 Task 9**: the Discord bot's worker handles only `announce_t30` and ack-ignores these five; this worker handles only these five and ack-ignores `announce_t30`, **without throwing** (a thrown job retries and would fight the other bot).

- [ ] **Step 1: Write the failing job-name-filter test**

`packages/telegram-bot/src/notify/worker.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { shouldHandle, TELEGRAM_JOB_NAMES } from "./worker.js";

describe("shouldHandle", () => {
  it("handles exactly the five Telegram-owned job names", () => {
    for (const name of [
      "notify_week_before",
      "notify_day_before",
      "notify_hour_before",
      "nudge_unlinked_40m",
      "notify_t10",
    ]) {
      expect(shouldHandle(name)).toBe(true);
    }
  });

  it("ignores announce_t30 (owned by the Discord bot)", () => {
    expect(shouldHandle("announce_t30")).toBe(false);
  });

  it("ignores unknown job names", () => {
    expect(shouldHandle("something_else")).toBe(false);
  });

  it("TELEGRAM_JOB_NAMES has exactly five entries and excludes announce_t30", () => {
    expect(TELEGRAM_JOB_NAMES).toHaveLength(5);
    expect(TELEGRAM_JOB_NAMES).not.toContain("announce_t30");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/telegram-bot/src/notify/worker.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `packages/telegram-bot/src/notify/worker.ts`**

```ts
import { Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import { QUEUE_NAME } from "@debates/shared";
import type { Api } from "grammy";
import type { BotConfig } from "../config.js";
import type { ApiClient } from "../apiClient.js";
import type { TelegramJobType } from "../lib/templates.js";
import { renderTemplate } from "../lib/templates.js";
import { formatGameDate } from "../lib/datetime.js";
import { broadcastToParticipants, type DispatchDeps } from "./dispatch.js";

/** Participant shape carried in the enqueue payload (Plan 2 addendum C). */
export interface NotifyParticipant {
  telegram_user_id: number;
  display_name: string;
  linked: boolean;
}

export interface NotifyPayload {
  motion: string | null;
  scheduled_at: string; // ISO8601
  participants: NotifyParticipant[];
}

interface GameEventJobData {
  gameId: string;
  type: string;
  notify?: NotifyPayload;
}

/** The five job names this bot owns on `game-events` (spec §4); excludes announce_t30. */
export const TELEGRAM_JOB_NAMES: readonly TelegramJobType[] = [
  "notify_week_before",
  "notify_day_before",
  "notify_hour_before",
  "nudge_unlinked_40m",
  "notify_t10",
];

const OWNED = new Set<string>(TELEGRAM_JOB_NAMES);

/**
 * True only for the five Telegram-owned job names. `announce_t30` (Discord's) and
 * anything unknown return false → the worker ack-ignores them WITHOUT throwing,
 * mirroring Plan 3 Task 9 so the two bots don't starve each other on the shared queue.
 */
export function shouldHandle(jobName: string): boolean {
  return OWNED.has(jobName);
}

/**
 * Processes one game-events job for the Telegram bot. Pure-ish: all side effects
 * go through `deps` so the broadcast logic stays unit-tested (Task 6). Returns the
 * dispatch result (or null when ack-ignoring a foreign job).
 */
export async function processJob(
  jobName: string,
  data: GameEventJobData,
  deps: DispatchDeps,
): Promise<{ sent: number; failed: number } | null> {
  if (!shouldHandle(jobName)) return null; // foreign job → ack-and-ignore, no throw
  const payload = data.notify ?? { motion: null, scheduled_at: new Date().toISOString(), participants: [] };
  const base = renderTemplate(jobName as TelegramJobType, {
    motion: payload.motion,
    dateText: formatGameDate(payload.scheduled_at),
  });
  return broadcastToParticipants(jobName as TelegramJobType, payload.participants, base, deps);
}

/** Wires a live BullMQ Worker to grammy `Api` + the typed `ApiClient`. */
export function startNotifyWorker(api: Api, apiClient: ApiClient, cfg: BotConfig): Worker {
  const connection = new IORedis(cfg.redisUrl, { maxRetriesPerRequest: null });
  const deps: DispatchDeps = {
    sendMessage: async (telegramUserId, text) => {
      await api.sendMessage(telegramUserId, text);
    },
    issueLinkCode: (telegramUserId) => apiClient.issueLinkCode(telegramUserId),
  };

  const worker = new Worker<GameEventJobData>(
    QUEUE_NAME,
    async (job: Job<GameEventJobData>) => {
      const result = await processJob(job.name, job.data, deps);
      if (result) {
        console.log(`[telegram-bot] ${job.name} game=${job.data.gameId} sent=${result.sent} failed=${result.failed}`);
      }
    },
    { connection },
  );

  worker.on("failed", (job, err) => {
    console.error(`[telegram-bot] job ${job?.id} (${job?.name}) failed:`, err);
  });
  return worker;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/telegram-bot/src/notify/worker.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Re-run the dispatch test now that `NotifyParticipant` is exported**

Run: `npx vitest run packages/telegram-bot/src/notify/dispatch.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck -w @debates/telegram-bot`
Expected: no errors.

```bash
git add packages/telegram-bot/src/notify/worker.ts packages/telegram-bot/src/notify/worker.test.ts
git commit -m "feat(telegram-bot): game-events worker (five owned jobs, ack-ignore announce_t30)"
```

---

## Task 8: Command handlers — /start, /code, /games

**Files:**
- Create: `packages/telegram-bot/src/commands/start.ts`
- Test: `packages/telegram-bot/src/commands/start.test.ts`
- Create: `packages/telegram-bot/src/commands/code.ts`
- Create: `packages/telegram-bot/src/commands/games.ts`

The handlers take a small `CommandContext` (the bits of grammy's `Context` we use) plus the injected `ApiClient`, so the registration logic is unit-testable without a live bot. `/start` is the one with branching worth a test (display-name derivation + register call); `/code` and `/games` are thin and validated by the Task 10 smoke tests.

- [ ] **Step 1: Write the failing test for `/start`**

`packages/telegram-bot/src/commands/start.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { handleStart, deriveDisplayName, type StartCtx } from "./start.js";

describe("deriveDisplayName", () => {
  it("joins first + last name", () => {
    expect(deriveDisplayName({ first_name: "Ada", last_name: "Lovelace", username: "ada" })).toBe("Ada Lovelace");
  });
  it("falls back to username when no names", () => {
    expect(deriveDisplayName({ username: "ada" })).toBe("ada");
  });
  it("falls back to 'Player' when nothing is present", () => {
    expect(deriveDisplayName({})).toBe("Player");
  });
});

describe("handleStart", () => {
  function ctx(over: Partial<StartCtx["from"]> = {}): StartCtx {
    return {
      from: { id: 898912046, first_name: "Ada", last_name: "Lovelace", username: "ada", ...over },
      reply: vi.fn().mockResolvedValue(undefined),
    } as unknown as StartCtx;
  }

  it("registers the user via the API and replies with a welcome", async () => {
    const c = ctx();
    const apiClient = {
      registerUser: vi.fn().mockResolvedValue({ id: "u1", telegram_user_id: 898912046, display_name: "Ada Lovelace", linked: false }),
    };
    await handleStart(c, apiClient as never);
    expect(apiClient.registerUser).toHaveBeenCalledWith({
      telegram_user_id: 898912046,
      telegram_username: "ada",
      display_name: "Ada Lovelace",
    });
    expect(c.reply).toHaveBeenCalledOnce();
    expect((c.reply as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatch(/registered|welcome/i);
  });

  it("ignores updates without a `from` (channel posts etc.)", async () => {
    const c = { from: undefined, reply: vi.fn() } as unknown as StartCtx;
    const apiClient = { registerUser: vi.fn() };
    await handleStart(c, apiClient as never);
    expect(apiClient.registerUser).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/telegram-bot/src/commands/start.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `packages/telegram-bot/src/commands/start.ts`**

```ts
import type { ApiClient } from "../apiClient.js";

export interface StartCtx {
  from?: { id: number; first_name?: string; last_name?: string; username?: string };
  reply: (text: string) => Promise<unknown>;
}

/** display_name = "first [last]" || username || "Player" (spec §8 admin-login parity). */
export function deriveDisplayName(from: {
  first_name?: string;
  last_name?: string;
  username?: string;
}): string {
  const full = [from.first_name, from.last_name].filter(Boolean).join(" ").trim();
  return full || from.username || "Player";
}

/** /start — register (upsert) the player via the API (spec §3: users created on /start). */
export async function handleStart(ctx: StartCtx, api: ApiClient): Promise<void> {
  const from = ctx.from;
  if (!from) return; // channel post / no user — nothing to register
  const displayName = deriveDisplayName(from);
  await api.registerUser({
    telegram_user_id: from.id,
    telegram_username: from.username ?? null,
    display_name: displayName,
  });
  await ctx.reply(
    `You're registered, ${displayName}! ` +
      `I'll DM you before each debate. ` +
      `Use /code to get a link code and run \`/link\` in Discord, and /games to see upcoming debates.`,
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/telegram-bot/src/commands/start.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Implement `packages/telegram-bot/src/commands/code.ts`**

```ts
import type { ApiClient } from "../apiClient.js";

export interface CodeCtx {
  from?: { id: number };
  reply: (text: string) => Promise<unknown>;
}

/** /code — mint a fresh link code and DM redemption instructions (spec §2, §4). */
export async function handleCode(ctx: CodeCtx, api: ApiClient): Promise<void> {
  const from = ctx.from;
  if (!from) return;
  try {
    const { code } = await api.issueLinkCode(from.id);
    await ctx.reply(
      `Your link code is ${code}.\n` +
        `In Discord, run \`/link ${code}\` to connect your account. ` +
        `The code is valid for 24 hours.`,
    );
  } catch {
    await ctx.reply("Couldn't issue a code right now — make sure you've run /start first, then try again.");
  }
}
```

- [ ] **Step 6: Implement `packages/telegram-bot/src/commands/games.ts`**

```ts
import type { ApiClient } from "../apiClient.js";
import { formatGameDate } from "../lib/datetime.js";

export interface GamesCtx {
  from?: { id: number };
  reply: (text: string) => Promise<unknown>;
}

/** /games — list this user's upcoming scheduled games (spec §2; addendum B). */
export async function handleGames(ctx: GamesCtx, api: ApiClient): Promise<void> {
  const from = ctx.from;
  if (!from) return;
  const games = await api.listUpcomingGames(from.id);
  if (games === null) {
    await ctx.reply("You're not registered yet — send /start first.");
    return;
  }
  if (games.length === 0) {
    await ctx.reply("You have no upcoming debates scheduled.");
    return;
  }
  const lines = games.map((g) => {
    const motion = g.motion && g.motion.trim().length > 0 ? g.motion : "(motion TBA)";
    return `• ${formatGameDate(g.scheduled_at)} — ${motion}`;
  });
  await ctx.reply(`Your upcoming debates:\n${lines.join("\n")}`);
}
```

- [ ] **Step 7: Typecheck + commit**

Run: `npm run typecheck -w @debates/telegram-bot`
Expected: no errors.

```bash
git add packages/telegram-bot/src/commands/start.ts packages/telegram-bot/src/commands/start.test.ts packages/telegram-bot/src/commands/code.ts packages/telegram-bot/src/commands/games.ts
git commit -m "feat(telegram-bot): /start, /code, /games command handlers"
```

---

## Task 9: grammy Bot bootstrap + worker wiring (manual smoke tests)

**Files:**
- Create: `packages/telegram-bot/src/index.ts`

The long-polling Bot and the live worker need a real Telegram token + Redis, so they're validated by manual smoke tests. The pure logic they call (templates, dispatch, worker filter, command handlers) is already unit-tested in Tasks 2–8.

- [ ] **Step 1: Implement `packages/telegram-bot/src/index.ts`**

```ts
import { Bot } from "grammy";
import { buildBotConfig } from "./config.js";
import { ApiClient } from "./apiClient.js";
import { handleStart } from "./commands/start.js";
import { handleCode } from "./commands/code.js";
import { handleGames } from "./commands/games.js";
import { startNotifyWorker } from "./notify/worker.js";

async function main(): Promise<void> {
  const cfg = buildBotConfig();
  const api = new ApiClient(cfg);
  const bot = new Bot(cfg.botToken);

  // Slash-style commands shown in Telegram's UI menu.
  await bot.api.setMyCommands([
    { command: "start", description: "Register and start receiving debate notifications" },
    { command: "code", description: "Get a fresh link code to connect Discord" },
    { command: "games", description: "List your upcoming debates" },
  ]);

  bot.command("start", (ctx) => handleStart(ctx, api));
  bot.command("code", (ctx) => handleCode(ctx, api));
  bot.command("games", (ctx) => handleGames(ctx, api));

  bot.catch((err) => {
    console.error("[telegram-bot] handler error:", err.error);
  });

  // Consume the five owned game-events jobs (ack-ignore announce_t30).
  startNotifyWorker(bot.api, api, cfg);

  console.log("[telegram-bot] starting long polling");
  await bot.start({
    onStart: (me) => console.log(`[telegram-bot] logged in as @${me.username}`),
  });
}

main().catch((err) => {
  console.error("[telegram-bot] fatal:", err);
  process.exit(1);
});
```

- [ ] **Step 2: Typecheck + build**

Run: `npm run typecheck -w @debates/telegram-bot && npm run build -w @debates/telegram-bot`
Expected: no errors; `packages/telegram-bot/dist/index.js` exists.

- [ ] **Step 3: Manual smoke test — `/start` registration** (real bot)

Prereqs: Plan 1/2 `api` + `postgres` + `redis` running (`docker compose up -d`), `.env` with a real `TELEGRAM_BOT_TOKEN` and the matching `TELEGRAM_BOT_API_TOKEN`, and **addenda A/B applied** to the API so `/api/users/register` and `/api/users/:id/games` exist.

1. Run the bot: `npm run dev -w @debates/telegram-bot`.
   Expected log: `logged in as @<botusername>` then `starting long polling`.
2. In Telegram, DM the bot `/start`.
   Expected: reply `You're registered, <name>! …`. Verify the DB:
   `docker compose exec postgres psql -U debates -d debates -c "select telegram_user_id, display_name from users order by created_at desc limit 1;"` → your row.
3. Send `/start` again → still succeeds (upsert), display name refreshed.

- [ ] **Step 4: Manual smoke test — `/code` and `/games`** (real bot)

1. DM `/code`.
   Expected: reply `Your link code is LINK-XXXX. In Discord, run /link LINK-XXXX …`. Verify a `link_codes` row exists with `expires_at` ~24h out.
2. (Optional) Redeem it in Discord via Plan 3's `/link LINK-XXXX` to confirm the end-to-end link.
3. Create a scheduled game with your user as a participant (via the admin/API). DM `/games`.
   Expected: a bulleted list including that game with the UTC date + motion. With no upcoming games → `You have no upcoming debates scheduled.`

- [ ] **Step 5: Manual smoke test — notifications + recipient-fail isolation** (real bot + Redis)

1. Create a game scheduled ~11 minutes out with two participants: yourself (who `/start`-ed) and a second user row whose `telegram_user_id` has **never** `/start`-ed the bot (insert directly via SQL). Apply **addendum C** first so the `notify_t10` job carries the payload.
2. Expected: within ~30s of `scheduled_at − 10m`, you receive the `notify_t10` DM (*"Starting in 10 min …"*). The bot log shows `notify_t10 game=<id> sent=1 failed=1` — the never-started recipient's 403 is isolated, your DM still arrives.
3. Create a game ~41 min out with an **unlinked** participant (a user with `discord_user_id` NULL who has `/start`-ed). Expected: at `scheduled_at − 40m` the `nudge_unlinked_40m` DM arrives **only** for the unlinked user, containing a freshly minted `LINK-XXXX` and `/link` instructions. Confirm the Discord bot does **not** consume any `notify_*`/`nudge_*` job (Plan 3 worker logs nothing for them), and this bot does not consume `announce_t30`.

- [ ] **Step 6: Commit**

```bash
git add packages/telegram-bot/src/index.ts
git commit -m "feat(telegram-bot): grammy bot bootstrap + worker wiring"
```

---

## Task 10: Dockerfile + compose wiring + env

**Files:**
- Create: `packages/telegram-bot/Dockerfile`
- Create: `packages/telegram-bot/.dockerignore`
- Modify: `docker-compose.yml`
- Modify: `.env.example`

- [ ] **Step 1: Create `packages/telegram-bot/.dockerignore`**

```dockerignore
node_modules
dist
**/*.test.ts
```

- [ ] **Step 2: Create `packages/telegram-bot/Dockerfile`** (multi-stage; mirrors Plan 1's api — no native deps, so no toolchain needed)

```dockerfile
# Build stage
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/telegram-bot/package.json packages/telegram-bot/
RUN npm ci
COPY packages/shared packages/shared
COPY packages/telegram-bot packages/telegram-bot
RUN npm run build -w @debates/shared && npm run build -w @debates/telegram-bot

# Runtime stage
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/telegram-bot/package.json packages/telegram-bot/
RUN npm ci --omit=dev
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/telegram-bot/dist packages/telegram-bot/dist
CMD ["npm", "run", "start", "-w", "@debates/telegram-bot"]
```

> **Note:** build `context` is the repo root (set in compose below) so `COPY package.json …` resolves from there, matching the Plan 1 api + Plan 3 discord-bot Dockerfile pattern.

- [ ] **Step 3: Add the `telegram-bot` service to `docker-compose.yml`** (spec §9; depends on api + redis; **no recordings volume**)

Insert under `services:` (above `volumes:`):

```yaml
  telegram-bot:
    build:
      context: .
      dockerfile: packages/telegram-bot/Dockerfile
    depends_on: [api, redis]
    environment:
      REDIS_URL: redis://redis:6379
      API_BASE_URL: http://api:3000
    env_file: .env
    restart: unless-stopped
```

> No `volumes:` entry — the Telegram bot never touches the recordings disk (spec §2: it only DMs and issues codes). It only needs Redis (the queue) and the API over the network.

- [ ] **Step 4: Add the bot-local var to `.env.example`**

Append under the existing Telegram block:

```bash
# Telegram bot runtime (bot-local; not in the shared schema)
API_BASE_URL=http://api:3000            # in-network API base (compose overrides anyway)
```

> `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_API_TOKEN`, and `TELEGRAM_BOT_USERNAME` already exist in `.env.example` from Plan 1.

- [ ] **Step 5: Build the image**

Run: `docker compose build telegram-bot`
Expected: build succeeds (no native modules — fast, no toolchain).

- [ ] **Step 6: Boot the stack and confirm the bot logs in**

Run: `docker compose up -d --build`
Run: `docker compose logs telegram-bot | tail -n 20`
Expected: `logged in as @<botusername>` then `starting long polling`. (Requires a real `TELEGRAM_BOT_TOKEN` in `.env`; with a placeholder token the container logs a Telegram auth error — the expected signal that wiring is correct but the secret is missing.)

- [ ] **Step 7: Tear down + commit**

Run: `docker compose down`

```bash
git add packages/telegram-bot/Dockerfile packages/telegram-bot/.dockerignore docker-compose.yml .env.example
git commit -m "feat(telegram-bot): Dockerfile + compose service (no recordings volume)"
```

---

## Task 11: Full-suite green + typecheck wiring

**Files:**
- Modify: `package.json` (root `typecheck` script to include the new package)
- Verify: `vitest.workspace.ts` (already globs `packages/*/vitest.config.ts`)

- [ ] **Step 1: Extend the root `typecheck` script** to build the new package

In root `package.json`, change (building on Plan 3's value):

```json
"typecheck": "tsc -b packages/shared packages/api packages/discord-bot packages/telegram-bot",
```

- [ ] **Step 2: Run the whole repo's unit suite**

Run: `npm test`
Expected: `shared`, `api`, `discord-bot`, and `telegram-bot` suites all pass. The `telegram-bot` suite covers config (2), datetime (3), linkInstructions (2), templates (6), dispatch (5), worker filter (4), start (5) = 27 unit tests, none of which need Telegram, Redis, or a database.

- [ ] **Step 3: Typecheck the workspace**

Run: `npm run typecheck`
Expected: no errors across all four packages.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "chore: include telegram-bot in workspace typecheck"
```

---

## Self-review against the spec

**Spec §4 (jobs table — each Telegram-owned job type → tasks):**
- `notify_week_before` (DM every participant, "next week", {motion}/{date/time}) → Task 4 template + Task 6 broadcast (all participants) + Task 7 worker. ✓
- `notify_day_before` ("tomorrow") → Task 4 template + Task 6/7. ✓
- `notify_hour_before` ("in 1 hour"; for each **unlinked** participant mint a fresh code via `POST /api/link/issue` and append link instructions; linked get the plain reminder) → Task 4 template + Task 3 `appendLinkInstructions` + Task 6 `APPEND_CODE` branch (per-unlinked `issueLinkCode`) + Task 5 `issueLinkCode`. ✓
- `nudge_unlinked_40m` (DM **only** unlinked; mint a fresh code per recipient; "/link LINK-XXXX") → Task 6 `UNLINKED_ONLY` + `APPEND_CODE` + Task 4 template. ✓
- `notify_t10` ("Starting in 10 min — be in the voice channel") → Task 4 template + Task 6/7. ✓
- `announce_t30` is **Discord's** → Task 7 `shouldHandle` returns false and the worker ack-ignores it without throwing. ✓
- Past-offset guard / reconciliation / deterministic jobId are the **API's** responsibility (Plan 2 Task 2/3) — out of scope here; this bot only consumes whatever delayed jobs fire. ✓

**Spec §7 (API rows this bot calls) → tasks:**
- `POST /api/link/issue` → `{ code, expires_at }` → Task 5 `issueLinkCode`, used by Task 6 (per-unlinked) and Task 8 `/code`. Sent with `Authorization: Bearer ${TELEGRAM_BOT_API_TOKEN}`. ✓
- `POST /api/users/register` (**addendum A**, new bot-scoped) → Task 5 `registerUser` + Task 8 `/start`. ✓
- `GET /api/users/:telegram_user_id/games` (**addendum B**, new bot-scoped) → Task 5 `listUpcomingGames` + Task 8 `/games`. ✓
- All bot calls carry the telegram bot Bearer token; none require an admin cookie. ✓

**Spec §8 (player auth) → tasks:**
- Telegram identity is the `telegram_user_id` from the update's `from.id` — used directly for register/issue/games (Task 8), no separate auth. ✓
- The bot ↔ API boundary is the scoped `TELEGRAM_BOT_API_TOKEN` (Task 1 config → Task 5 client header), matching the spec's "only telegram-bot endpoints" scoping; addenda A/B endpoints are guarded by `requireBotToken(telegramBotApiToken)`. ✓
- `display_name` derivation on `/start` mirrors the admin-login rule (first [last] || username) — Task 8 `deriveDisplayName`. ✓

**DM failure handling (the §-level robustness requirement):** Telegram 403 for a never-`/start`-ed recipient is caught per-recipient in Task 6 `broadcastToParticipants`; unit-tested by "one recipient fails, others still sent" (dispatch.test.ts) and the failing-`issueLinkCode` isolation case. The worker never throws on a foreign job either (Task 7). ✓

**Cross-plan addenda introduced (for Plan 2):**
1. **Addendum A — `POST /api/users/register`** (telegram-bot-token scoped, upsert by `telegram_user_id`). Needed because Plan 2 only auto-creates *admin* users; ordinary players are created on `/start`. Exact endpoint code given at the top. Apply before Task 8.
2. **Addendum B — `GET /api/users/:telegram_user_id/games`** (telegram-bot-token scoped) returning the user's future `scheduled` games. Needed for `/games`; the admin list endpoint is the wrong scope/shape. Exact code at top. Apply before Task 8.
3. **Addendum C — richer `notify` enqueue payload** on the five Telegram jobs (`motion`, `scheduled_at`, `participants[] { telegram_user_id, display_name, linked }`), consistent with Plan 3's `announce_t30` richer-payload recommendation (prefer richer enqueue payloads over new bot read endpoints). Needed so the worker can render templates and identify unlinked participants without an admin read. Exact `GameEventPayload` extension at top. Apply before Task 7's smoke test.

**Mirror of Plan 3 queue contract:** both bots run a `Worker` on the single `game-events` queue. Plan 3's `announce_t30` worker ack-ignores the five Telegram job names; this plan's worker (Task 7 `shouldHandle`/`processJob`) ack-ignores `announce_t30` and unknown names **without throwing** (a thrown job retries and would fight the other consumer). Unit-tested in `worker.test.ts`. ✓

**Placeholder scan:** every step ships real, complete code — no "TBD", no "add error handling", no "similar to above". The UTC date format and the English template copy are explicit, finalized decisions (resolving spec §13's two relevant open questions), not deferred work.

**Type-consistency check:**
- `BotConfig` (Task 1) consumed by `ApiClient` (Task 5, `Pick`), `startNotifyWorker` (Task 7), `index.ts` (Task 9) — one definition, consistent fields.
- `ApiClient` method shapes (`registerUser`, `issueLinkCode`, `listUpcomingGames`) match exactly what Tasks 6/8 call; `IssuedCode`/`RegisteredUser`/`UpcomingGame` defined once.
- `TelegramJobType` defined once in `lib/templates.ts` (Task 4), reused by `dispatch.ts` (Task 6) and `worker.ts` (Task 7) — single source of truth for the five owned names.
- `NotifyParticipant`/`NotifyPayload` defined once in `notify/worker.ts` (Task 7, matching addendum C's payload), imported by `dispatch.ts` (Task 6). The `dispatch.test.ts` import path (`./worker.js`) is satisfied by Task 7's export.
- `DispatchDeps` (Task 6) is implemented by `startNotifyWorker` (Task 7) wrapping grammy `Api.sendMessage` + `ApiClient.issueLinkCode` — same signatures the dispatch tests mock.
- `formatGameDate` (Task 2) reused by `templates`? No — templates take a pre-rendered `dateText`; the worker (Task 7) and `/games` (Task 8) call `formatGameDate`, keeping templates pure of date logic. Consistent.
- `QUEUE_NAME` imported from `@debates/shared` (Plan 1) in Task 7 — the same queue the API publishes to (Plan 2) and the Discord bot consumes (Plan 3).

---

**End of Plan 4.** The Telegram bot is a stateless actuator: all DB writes go through the Plan 2 API (via the three addenda + `POST /api/link/issue`); it owns no disk and only the five `notify_*`/`nudge_*` job names on the shared `game-events` queue, mirroring Plan 3's name-filter contract. Plan 5 (web admin) and Plan 6 (deploy — sets the real `TELEGRAM_BOT_TOKEN` + `NODE_ENV=production`, wires nginx + host bootstrap) follow.
