# Debates Helper — Plan 2: API Domain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the full API domain on top of Plan 1's schema/skeleton: the BullMQ scheduler with the **past-offset guard** and **boot/hourly reconciliation**, games CRUD, recording-session endpoints (session create with 409 concurrency, file registration, completion + `_metadata.json`), link issue/redeem, admin auth via Telegram Login Widget + JWT, the users endpoints, and the `cleanup_old_recordings` / `reap_stuck_sessions` / `reconcile_jobs` crons.

**Architecture:** Pure scheduling logic (`jobsToEnqueue`) is unit-tested in isolation; a thin `scheduler` wraps it around a real BullMQ `Queue`. Service modules own Prisma access; thin Express routers validate with `shared` DTOs and delegate. Admin endpoints require a JWT session cookie; bot endpoints require the Plan 1 `requireBotToken` guard. Router integration tests run against the docker-compose Postgres with a truncate-between-tests helper.

**Tech Stack:** BullMQ + ioredis, `jose` (JWT), `cookie-parser`, `node-cron`, Prisma, Express, Zod, Vitest + Supertest.

**Depends on:** Plan 1 (schema, `shared` DTOs/constants, `app.ts` router seam, `requireBotToken`, `prisma.ts`, `buildConfig`).

**This is Plan 2 of 6.** It defines the HTTP contracts that **Plan 3 (Discord bot)** and **Plan 4 (Telegram bot)** call, and the `game-events` job payloads they consume.

---

## File structure introduced by this plan

```
packages/api/src/
├── queue.ts                      # BullMQ Queue + ioredis connection (game-events)
├── scheduler/
│   ├── jobs.ts                   # jobsToEnqueue() pure logic — past-offset guard
│   ├── jobs.test.ts
│   ├── scheduler.ts              # enqueue/remove/reschedule/reconcile around the Queue
│   └── scheduler.test.ts         # against a real (compose) Redis
├── services/
│   ├── games.ts                  # Prisma CRUD + participant sync
│   ├── recordings.ts             # session/file/complete + _metadata.json
│   ├── recordings.test.ts        # metadata writer unit test (fs)
│   └── linkcodes.ts              # generate/issue/redeem
├── auth/
│   ├── telegramLogin.ts          # HMAC verify of Login Widget payload
│   ├── telegramLogin.test.ts
│   ├── session.ts                # JWT sign/verify + cookie helpers
│   ├── session.test.ts
│   └── requireAdmin.ts           # admin session middleware
├── routes/
│   ├── games.ts                  # /api/games*
│   ├── recordings.ts             # /api/recordings/*
│   ├── link.ts                   # /api/link/*
│   ├── users.ts                  # /api/users*
│   └── adminAuth.ts              # /api/admin/auth/*, /api/admin/me
├── crons.ts                      # cleanup, reap_stuck_sessions, reconcile_jobs
└── test/
    └── db.ts                     # truncateAll() helper for integration tests
```

---

## Task 1: BullMQ queue + Redis connection

**Files:**
- Modify: `packages/api/package.json` (add deps)
- Create: `packages/api/src/queue.ts`

- [ ] **Step 1: Add dependencies**

Edit `packages/api/package.json` `dependencies` to add:

```json
"bullmq": "^5.13.0",
"ioredis": "^5.4.0",
"jose": "^5.9.0",
"cookie-parser": "^1.4.7",
"node-cron": "^3.0.3"
```

and `devDependencies` to add:

```json
"@types/cookie-parser": "^1.4.7",
"@types/node-cron": "^3.0.11"
```

Run: `npm install`
Expected: installs without error.

- [ ] **Step 2: Create `packages/api/src/queue.ts`**

```ts
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { QUEUE_NAME } from "@debates/shared";
import { buildConfig } from "./config.js";

const config = buildConfig();

// BullMQ requires maxRetriesPerRequest: null on the shared connection.
export const connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });

export const gameEventsQueue = new Queue(QUEUE_NAME, { connection });
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck -w @debates/api`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/api/package.json packages/api/src/queue.ts package-lock.json
git commit -m "feat(api): add BullMQ game-events queue and Redis connection"
```

---

## Task 2: Scheduler pure logic — the past-offset guard (fix #1)

**Files:**
- Create: `packages/api/src/scheduler/jobs.ts`
- Test: `packages/api/src/scheduler/jobs.test.ts`

- [ ] **Step 1: Write the failing test** (encodes spec §4 past-offset guard)

`packages/api/src/scheduler/jobs.test.ts`:

```ts
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
    // week/day before are in the past -> dropped
    expect(jobs.some((j) => j.type === "notify_week_before")).toBe(false);
    expect(jobs.some((j) => j.type === "notify_day_before")).toBe(false);
  });

  it("returns nothing when the game is in the past entirely", () => {
    const now = new Date("2026-06-11T00:00:00Z");
    const scheduledAt = new Date("2026-06-10T19:00:00Z");
    expect(jobsToEnqueue(gameId, scheduledAt, now)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/api/src/scheduler/jobs.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `packages/api/src/scheduler/jobs.ts`**

```ts
import { JOB_TYPES, JOB_OFFSETS_MS, jobIdFor, type JobType } from "@debates/shared";

export interface PlannedJob {
  type: JobType;
  jobId: string;
  /** Milliseconds from `now` until the job should fire (always >= 0). */
  delayMs: number;
}

/**
 * Computes the BullMQ jobs to enqueue for a game.
 * Past-offset guard (spec §4): any job whose fire time is already <= now is
 * dropped, because BullMQ runs non-positive-delay jobs immediately — without
 * this guard a short-notice game would instantly fire "Debate next week".
 */
export function jobsToEnqueue(gameId: string, scheduledAt: Date, now: Date): PlannedJob[] {
  const planned: PlannedJob[] = [];
  for (const type of JOB_TYPES) {
    const fireAt = scheduledAt.getTime() - JOB_OFFSETS_MS[type];
    const delayMs = fireAt - now.getTime();
    if (delayMs < 0) continue; // already past -> skip
    planned.push({ type, jobId: jobIdFor(gameId, type), delayMs });
  }
  return planned;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/api/src/scheduler/jobs.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/scheduler/jobs.ts packages/api/src/scheduler/jobs.test.ts
git commit -m "feat(api): scheduler past-offset guard (jobsToEnqueue)"
```

---

## Task 3: Scheduler — enqueue / remove / reschedule / reconcile (fix #2)

**Files:**
- Create: `packages/api/src/scheduler/scheduler.ts`
- Test: `packages/api/src/scheduler/scheduler.test.ts`
- Create: `packages/api/src/test/db.ts`

> Integration tests in this plan need the compose Postgres + Redis running:
> `docker compose up -d postgres redis` and `.env` present (Plan 1 Task 4).

- [ ] **Step 1: Create the truncate helper `packages/api/src/test/db.ts`**

```ts
import { prisma } from "../prisma.js";

/** Wipes all domain tables. Call in beforeEach for integration tests. */
export async function truncateAll(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE
       recording_files, recording_sessions,
       game_participants, games, link_codes, users
     RESTART IDENTITY CASCADE;`,
  );
}
```

- [ ] **Step 2: Write the failing scheduler test** (against a real queue)

`packages/api/src/scheduler/scheduler.test.ts`:

```ts
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
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run packages/api/src/scheduler/scheduler.test.ts`
Expected: FAIL — `./scheduler.js` not found.

- [ ] **Step 4: Implement `packages/api/src/scheduler/scheduler.ts`**

```ts
import { JOB_TYPES, jobIdFor, type JobType } from "@debates/shared";
import { prisma } from "../prisma.js";
import { gameEventsQueue } from "../queue.js";
import { jobsToEnqueue } from "./jobs.js";

export interface GameEventPayload {
  gameId: string;
  type: JobType;
}

/** Enqueue all (future-dated) notification jobs for a game. Idempotent. */
export async function enqueueGameJobs(gameId: string, scheduledAt: Date, now = new Date()): Promise<void> {
  const planned = jobsToEnqueue(gameId, scheduledAt, now);
  for (const job of planned) {
    await gameEventsQueue.add(
      job.type,
      { gameId, type: job.type } satisfies GameEventPayload,
      { jobId: job.jobId, delay: job.delayMs, removeOnComplete: true, removeOnFail: 1000 },
    );
  }
}

/** Remove all unfired jobs for a game (used on reschedule and cancel). */
export async function removeGameJobs(gameId: string): Promise<void> {
  for (const type of JOB_TYPES) {
    const job = await gameEventsQueue.getJob(jobIdFor(gameId, type));
    if (job) {
      // Only delayed/waiting jobs are removable; ignore already-active/finished.
      await job.remove().catch(() => undefined);
    }
  }
}

/** Reschedule = remove then re-enqueue at the new offsets (applies the guard). */
export async function rescheduleGameJobs(gameId: string, scheduledAt: Date, now = new Date()): Promise<void> {
  await removeGameJobs(gameId);
  await enqueueGameJobs(gameId, scheduledAt, now);
}

/**
 * Reconciliation (spec §4, fix #2): re-derive jobs from Postgres for every
 * future scheduled game and enqueue any missing ones. Idempotent via jobId,
 * so a wiped Redis self-heals. Run at API boot and hourly (see crons.ts).
 */
export async function reconcileJobs(now = new Date()): Promise<number> {
  const games = await prisma.game.findMany({
    where: { status: "scheduled", scheduledAt: { gt: now } },
    select: { id: true, scheduledAt: true },
  });
  for (const game of games) {
    await enqueueGameJobs(game.id, game.scheduledAt, now);
  }
  return games.length;
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `docker compose up -d redis postgres && npx vitest run packages/api/src/scheduler/scheduler.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/scheduler/scheduler.ts packages/api/src/scheduler/scheduler.test.ts packages/api/src/test/db.ts
git commit -m "feat(api): scheduler enqueue/remove/reschedule/reconcile (Redis self-heal)"
```

---

## Task 4: Games service + router

**Files:**
- Create: `packages/api/src/services/games.ts`
- Create: `packages/api/src/routes/games.ts`
- Test: `packages/api/src/routes/games.test.ts`
- Modify: `packages/api/src/app.ts`

- [ ] **Step 1: Implement the games service `packages/api/src/services/games.ts`**

```ts
import { prisma } from "../prisma.js";
import { enqueueGameJobs, removeGameJobs, rescheduleGameJobs } from "../scheduler/scheduler.js";

export interface CreateGameInput {
  scheduledAt: Date;
  motion: string | null;
  createdById: string;
  participantUserIds: string[];
}

export async function createGame(input: CreateGameInput) {
  const game = await prisma.game.create({
    data: {
      scheduledAt: input.scheduledAt,
      motion: input.motion,
      createdById: input.createdById,
      participants: { create: input.participantUserIds.map((userId) => ({ userId })) },
    },
    include: { participants: true },
  });
  await enqueueGameJobs(game.id, game.scheduledAt);
  return game;
}

export async function listGames(filter: { status?: "scheduled" | "cancelled"; from?: Date; to?: Date }) {
  return prisma.game.findMany({
    where: {
      status: filter.status,
      scheduledAt: { gte: filter.from, lte: filter.to },
    },
    orderBy: { scheduledAt: "asc" },
    include: { participants: true },
  });
}

export async function getGame(id: string) {
  return prisma.game.findUnique({ where: { id }, include: { participants: true } });
}

export interface UpdateGameInput {
  scheduledAt?: Date;
  motion?: string | null;
  participantUserIds?: string[];
}

export async function updateGame(id: string, input: UpdateGameInput) {
  const existing = await prisma.game.findUnique({ where: { id } });
  if (!existing) return null;

  const game = await prisma.$transaction(async (tx) => {
    if (input.participantUserIds) {
      await tx.gameParticipant.deleteMany({ where: { gameId: id } });
      await tx.gameParticipant.createMany({
        data: input.participantUserIds.map((userId) => ({ gameId: id, userId })),
      });
    }
    return tx.game.update({
      where: { id },
      data: { scheduledAt: input.scheduledAt, motion: input.motion },
      include: { participants: true },
    });
  });

  if (input.scheduledAt && input.scheduledAt.getTime() !== existing.scheduledAt.getTime()) {
    await rescheduleGameJobs(id, game.scheduledAt);
  }
  return game;
}

export async function cancelGame(id: string) {
  const existing = await prisma.game.findUnique({ where: { id } });
  if (!existing) return null;
  const game = await prisma.game.update({
    where: { id },
    data: { status: "cancelled", cancelledAt: new Date() },
  });
  await removeGameJobs(id);
  return game;
}
```

- [ ] **Step 2: Write the failing router test**

`packages/api/src/routes/games.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { prisma } from "../prisma.js";
import { truncateAll } from "../test/db.js";
import { gameEventsQueue, connection } from "../queue.js";

const app = createApp();

async function seedAdminUser() {
  return prisma.user.create({
    data: { telegramUserId: 898912046n, displayName: "Admin", telegramUsername: "admin" },
  });
}

// Test bypass: in these tests we inject the admin via a header the test build trusts.
// (requireAdmin reads req.adminUserId; see Task 7 for the cookie path.)
function asAdmin(req: request.Test, userId: string) {
  return req.set("x-test-admin-id", userId);
}

describe("games router", () => {
  beforeEach(async () => {
    await truncateAll();
  });
  afterAll(async () => {
    await gameEventsQueue.close();
    await connection.quit();
  });

  it("POST /api/games creates a game and 201s", async () => {
    const admin = await seedAdminUser();
    const res = await asAdmin(
      request(app)
        .post("/api/games")
        .send({
          scheduled_at: new Date(Date.now() + 3 * 86400000).toISOString(),
          motion: "THW ban X",
          participant_user_ids: [admin.id],
        }),
      admin.id,
    );
    expect(res.status).toBe(201);
    expect(res.body.motion).toBe("THW ban X");
    expect(res.body.participants).toHaveLength(1);
  });

  it("GET /api/games lists scheduled games", async () => {
    const admin = await seedAdminUser();
    await prisma.game.create({
      data: { scheduledAt: new Date(Date.now() + 86400000), createdById: admin.id },
    });
    const res = await asAdmin(request(app).get("/api/games?status=scheduled"), admin.id);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it("POST /api/games/:id/cancel sets status cancelled", async () => {
    const admin = await seedAdminUser();
    const game = await prisma.game.create({
      data: { scheduledAt: new Date(Date.now() + 86400000), createdById: admin.id },
    });
    const res = await asAdmin(request(app).post(`/api/games/${game.id}/cancel`), admin.id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run packages/api/src/routes/games.test.ts`
Expected: FAIL — `../app.js` has no `/api/games` route (404) and `x-test-admin-id` unhandled.

- [ ] **Step 4: Implement `packages/api/src/routes/games.ts`**

```ts
import { Router } from "express";
import { z } from "zod";
import { requireAdmin } from "../auth/requireAdmin.js";
import * as games from "../services/games.js";

const CreateBody = z.object({
  scheduled_at: z.string().datetime(),
  motion: z.string().max(2000).nullish(),
  participant_user_ids: z.array(z.string().uuid()).default([]),
});

const UpdateBody = z.object({
  scheduled_at: z.string().datetime().optional(),
  motion: z.string().max(2000).nullish(),
  participant_user_ids: z.array(z.string().uuid()).optional(),
});

export const gamesRouter = Router();
gamesRouter.use(requireAdmin);

gamesRouter.get("/", async (req, res) => {
  const status = req.query.status === "cancelled" ? "cancelled" : req.query.status === "scheduled" ? "scheduled" : undefined;
  const from = typeof req.query.from === "string" ? new Date(req.query.from) : undefined;
  const to = typeof req.query.to === "string" ? new Date(req.query.to) : undefined;
  res.json(await games.listGames({ status, from, to }));
});

gamesRouter.post("/", async (req, res) => {
  const body = CreateBody.parse(req.body);
  const game = await games.createGame({
    scheduledAt: new Date(body.scheduled_at),
    motion: body.motion ?? null,
    createdById: req.adminUserId!,
    participantUserIds: body.participant_user_ids,
  });
  res.status(201).json(game);
});

gamesRouter.get("/:id", async (req, res) => {
  const game = await games.getGame(req.params.id);
  if (!game) return res.status(404).json({ error: "not_found" });
  res.json(game);
});

gamesRouter.patch("/:id", async (req, res) => {
  const body = UpdateBody.parse(req.body);
  const game = await games.updateGame(req.params.id, {
    scheduledAt: body.scheduled_at ? new Date(body.scheduled_at) : undefined,
    motion: body.motion === undefined ? undefined : body.motion ?? null,
    participantUserIds: body.participant_user_ids,
  });
  if (!game) return res.status(404).json({ error: "not_found" });
  res.json(game);
});

gamesRouter.post("/:id/cancel", async (req, res) => {
  const game = await games.cancelGame(req.params.id);
  if (!game) return res.status(404).json({ error: "not_found" });
  res.json(game);
});
```

- [ ] **Step 5: Create a test-friendly `requireAdmin` stub now, real impl in Task 7**

Create `packages/api/src/auth/requireAdmin.ts`:

```ts
import type { Request, Response, NextFunction } from "express";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      adminUserId?: string;
    }
  }
}

/**
 * Admin guard. Real cookie/JWT verification is added in Task 7 (verifySession).
 * In tests (NODE_ENV==='test') it trusts the `x-test-admin-id` header so router
 * tests don't need a full login round-trip.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (process.env.NODE_ENV === "test") {
    const id = req.header("x-test-admin-id");
    if (id) {
      req.adminUserId = id;
      return next();
    }
  }
  // Replaced/extended by real session verification in Task 7.
  if (req.adminUserId) return next();
  res.status(401).json({ error: "unauthorized" });
}
```

- [ ] **Step 6: Mount the router in `app.ts`**

Replace the `// Domain routers are mounted here in Plan 2.` line with:

```ts
  app.use("/api/games", gamesRouter);
```

and add the import at the top of `app.ts`:

```ts
import { gamesRouter } from "./routes/games.js";
```

- [ ] **Step 7: Set `NODE_ENV=test` for vitest**

Edit `packages/api/vitest.config.ts` to add `env`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "api",
    include: ["src/**/*.test.ts"],
    environment: "node",
    env: { NODE_ENV: "test" },
  },
});
```

- [ ] **Step 8: Run to verify it passes**

Run: `npx vitest run packages/api/src/routes/games.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 9: Commit**

```bash
git add packages/api/src/services/games.ts packages/api/src/routes/games.ts packages/api/src/auth/requireAdmin.ts packages/api/src/app.ts packages/api/src/vitest.config.ts
git commit -m "feat(api): games CRUD service + router with job scheduling"
```

---

## Task 5: Recording endpoints — session (409), file register, complete + `_metadata.json` (fix #5)

**Files:**
- Create: `packages/api/src/services/recordings.ts`
- Test: `packages/api/src/services/recordings.test.ts`
- Create: `packages/api/src/routes/recordings.ts`
- Test: `packages/api/src/routes/recordings.test.ts`
- Modify: `packages/api/src/app.ts`

- [ ] **Step 1: Write the failing unit test for the metadata writer + session dir naming**

`packages/api/src/services/recordings.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { sessionDirName, buildMetadata } from "./recordings.js";

describe("sessionDirName", () => {
  it("formats timestamp + sanitized channel + sessionId", () => {
    const dir = sessionDirName(new Date("2026-06-03T19:00:00Z"), "Main Stage!!", "abc-123");
    expect(dir).toBe("2026-06-03T19-00-00_Main_Stage_abc-123");
  });
});

describe("buildMetadata", () => {
  it("assembles the _metadata.json shape from session + files", () => {
    const meta = buildMetadata(
      {
        id: "s1",
        startedAt: new Date("2026-06-03T19:00:00Z"),
        endedAt: new Date("2026-06-03T19:48:12Z"),
        voiceChannelId: "v1",
        voiceChannelName: "Main",
      },
      [
        {
          discordUserId: "998877665544332211",
          discordUsername: "alice",
          telegramUserId: 123456n,
          displayName: "Alice K.",
          filePath: "alice_2211.opus",
          durationSec: 412,
        },
      ],
    );
    expect(meta.session_id).toBe("s1");
    expect(meta.voice_channel).toEqual({ id: "v1", name: "Main" });
    expect(meta.files[0]).toMatchObject({
      discord_user_id: "998877665544332211",
      telegram_user_id: 123456,
      file: "alice_2211.opus",
      duration_sec: 412,
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/api/src/services/recordings.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `packages/api/src/services/recordings.ts`**

```ts
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { buildConfig } from "../config.js";

const config = buildConfig();

export function sanitize(input: string): string {
  // Spec §13: conservative allowlist.
  return input.replace(/[^A-Za-z0-9_-]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
}

export function sessionDirName(startedAt: Date, channelName: string, sessionId: string): string {
  const ts = startedAt.toISOString().slice(0, 19).replace(/:/g, "-"); // 2026-06-03T19-00-00
  return `${ts}_${sanitize(channelName)}_${sessionId}`;
}

export class ActiveSessionConflict extends Error {}

export async function createSession(input: {
  startedByDiscordUserId: string;
  voiceChannelId: string;
  voiceChannelName: string;
  guildId: string;
}) {
  const id = crypto.randomUUID();
  const dirName = sessionDirName(new Date(), input.voiceChannelName, id);
  const fileDir = path.join(config.recordingsDir, dirName);
  try {
    const session = await prisma.recordingSession.create({
      data: {
        id,
        startedByDiscordUserId: input.startedByDiscordUserId,
        voiceChannelId: input.voiceChannelId,
        voiceChannelName: input.voiceChannelName,
        guildId: input.guildId,
        fileDir,
        status: "recording",
      },
    });
    await mkdir(fileDir, { recursive: true });
    return session;
  } catch (err) {
    // Partial unique index `one_active_recording_per_guild` (spec §3, fix #5).
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new ActiveSessionConflict();
    }
    throw err;
  }
}

export async function registerFile(sessionId: string, body: {
  discordUserId: string;
  discordUsername: string;
  filePath: string;
  durationSec: number;
  sizeBytes: number;
}) {
  const user = await prisma.user.findUnique({ where: { discordUserId: body.discordUserId } });
  return prisma.recordingFile.upsert({
    where: { sessionId_discordUserId: { sessionId, discordUserId: body.discordUserId } },
    create: {
      sessionId,
      discordUserId: body.discordUserId,
      userId: user?.id ?? null,
      discordUsername: body.discordUsername,
      filePath: body.filePath,
      durationSec: body.durationSec,
      sizeBytes: BigInt(body.sizeBytes),
    },
    update: {
      durationSec: body.durationSec,
      sizeBytes: BigInt(body.sizeBytes),
      discordUsername: body.discordUsername,
    },
  });
}

export interface SessionMeta {
  id: string;
  startedAt: Date;
  endedAt: Date | null;
  voiceChannelId: string;
  voiceChannelName: string;
}
export interface FileMeta {
  discordUserId: string;
  discordUsername: string;
  telegramUserId: bigint | null;
  displayName: string | null;
  filePath: string;
  durationSec: number;
}

export function buildMetadata(session: SessionMeta, files: FileMeta[]) {
  return {
    session_id: session.id,
    started_at: session.startedAt.toISOString(),
    ended_at: session.endedAt?.toISOString() ?? null,
    voice_channel: { id: session.voiceChannelId, name: session.voiceChannelName },
    files: files.map((f) => ({
      discord_user_id: f.discordUserId,
      discord_username: f.discordUsername,
      telegram_user_id: f.telegramUserId ? Number(f.telegramUserId) : null,
      display_name: f.displayName,
      file: f.filePath,
      duration_sec: f.durationSec,
    })),
  };
}

export async function completeSession(sessionId: string) {
  const session = await prisma.recordingSession.findUnique({
    where: { id: sessionId },
    include: { files: { include: { user: true } } },
  });
  if (!session) return null;

  const endedAt = new Date();
  const meta = buildMetadata(
    { ...session, endedAt },
    session.files.map((f) => ({
      discordUserId: f.discordUserId,
      discordUsername: f.discordUsername,
      telegramUserId: f.user?.telegramUserId ?? null,
      displayName: f.user?.displayName ?? null,
      filePath: f.filePath,
      durationSec: f.durationSec,
    })),
  );
  await writeFile(path.join(session.fileDir, "_metadata.json"), JSON.stringify(meta, null, 2));

  return prisma.recordingSession.update({
    where: { id: sessionId },
    data: { status: "completed", endedAt },
  });
}
```

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `npx vitest run packages/api/src/services/recordings.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Write the failing router test (covers the 409 concurrency guard)**

`packages/api/src/routes/recordings.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { truncateAll } from "../test/db.js";
import { buildConfig } from "../config.js";

const app = createApp();
const token = buildConfig().discordBotApiToken;

function bot(req: request.Test) {
  return req.set("authorization", `Bearer ${token}`);
}

const sessionBody = {
  started_by_discord_user_id: "111",
  voice_channel_id: "v1",
  voice_channel_name: "Main",
  guild_id: "g1",
};

describe("recordings router", () => {
  beforeEach(async () => {
    await truncateAll();
  });
  afterAll(async () => {
    const { connection, gameEventsQueue } = await import("../queue.js");
    await gameEventsQueue.close();
    await connection.quit();
  });

  it("rejects without bot token", async () => {
    const res = await request(app).post("/api/recordings/sessions").send(sessionBody);
    expect(res.status).toBe(401);
  });

  it("creates a session then 409s on a concurrent second start in the same guild", async () => {
    const first = await bot(request(app).post("/api/recordings/sessions").send(sessionBody));
    expect(first.status).toBe(201);
    const second = await bot(request(app).post("/api/recordings/sessions").send(sessionBody));
    expect(second.status).toBe(409);
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `npx vitest run packages/api/src/routes/recordings.test.ts`
Expected: FAIL — route not mounted.

- [ ] **Step 7: Implement `packages/api/src/routes/recordings.ts`**

```ts
import { Router } from "express";
import { CreateRecordingSessionBody, RegisterRecordingFileBody } from "@debates/shared";
import { requireBotToken } from "../middleware/botAuth.js";
import { buildConfig } from "../config.js";
import * as rec from "../services/recordings.js";

const config = buildConfig();

export const recordingsRouter = Router();

// Bot-only write endpoints.
recordingsRouter.post("/sessions", requireBotToken(config.discordBotApiToken), async (req, res) => {
  const body = CreateRecordingSessionBody.parse(req.body);
  try {
    const session = await rec.createSession({
      startedByDiscordUserId: body.started_by_discord_user_id,
      voiceChannelId: body.voice_channel_id,
      voiceChannelName: body.voice_channel_name,
      guildId: body.guild_id,
    });
    res.status(201).json(session);
  } catch (err) {
    if (err instanceof rec.ActiveSessionConflict) {
      return res.status(409).json({ error: "active_session_exists" });
    }
    throw err;
  }
});

recordingsRouter.post("/sessions/:id/files", requireBotToken(config.discordBotApiToken), async (req, res) => {
  const body = RegisterRecordingFileBody.parse(req.body);
  const file = await rec.registerFile(req.params.id, {
    discordUserId: body.discord_user_id,
    discordUsername: body.discord_username,
    filePath: body.file_path,
    durationSec: body.duration_sec,
    sizeBytes: body.size_bytes,
  });
  res.status(201).json({ session_id: file.sessionId, discord_user_id: file.discordUserId });
});

recordingsRouter.post("/sessions/:id/complete", requireBotToken(config.discordBotApiToken), async (req, res) => {
  const session = await rec.completeSession(req.params.id);
  if (!session) return res.status(404).json({ error: "not_found" });
  res.json(session);
});

// Admin read endpoints are added in Task 6 (list/detail/download/zip).
```

- [ ] **Step 8: Mount in `app.ts`**

Add import and mount line:

```ts
import { recordingsRouter } from "./routes/recordings.js";
// ...
  app.use("/api/recordings", recordingsRouter);
```

- [ ] **Step 9: Run to verify it passes**

Run: `npx vitest run packages/api/src/routes/recordings.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 10: Commit**

```bash
git add packages/api/src/services/recordings.ts packages/api/src/services/recordings.test.ts packages/api/src/routes/recordings.ts packages/api/src/routes/recordings.test.ts packages/api/src/app.ts
git commit -m "feat(api): recording session/file/complete endpoints with 409 guard and metadata"
```

---

## Task 6: Recording admin read endpoints (list, detail, single-file stream, zip)

**Files:**
- Modify: `packages/api/src/routes/recordings.ts`
- Modify: `packages/api/package.json` (add `archiver`)
- Test: `packages/api/src/routes/recordings.test.ts` (extend)

- [ ] **Step 1: Add the zip dependency**

Edit `packages/api/package.json` dependencies: add `"archiver": "^7.0.1"` and devDeps `"@types/archiver": "^6.0.2"`.
Run: `npm install`

- [ ] **Step 2: Extend the router test with admin reads**

Append to `packages/api/src/routes/recordings.test.ts` inside the `describe`:

```ts
  it("GET /api/recordings/sessions lists sessions for admin", async () => {
    await bot(request(app).post("/api/recordings/sessions").send(sessionBody));
    const res = await request(app)
      .get("/api/recordings/sessions")
      .set("x-test-admin-id", "00000000-0000-0000-0000-000000000001");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run packages/api/src/routes/recordings.test.ts -t "lists sessions"`
Expected: FAIL — 404 (route not mounted).

- [ ] **Step 4: Add admin read routes to `packages/api/src/routes/recordings.ts`**

Add imports at top:

```ts
import { createReadStream } from "node:fs";
import path from "node:path";
import archiver from "archiver";
import { requireAdmin } from "../auth/requireAdmin.js";
import { prisma } from "../prisma.js";
```

Append before the trailing comment:

```ts
recordingsRouter.get("/sessions", requireAdmin, async (_req, res) => {
  const sessions = await prisma.recordingSession.findMany({
    orderBy: { startedAt: "desc" },
    include: { _count: { select: { files: true } }, files: { select: { userId: true } } },
  });
  res.json(
    sessions.map((s) => ({
      id: s.id,
      started_at: s.startedAt,
      ended_at: s.endedAt,
      voice_channel_name: s.voiceChannelName,
      status: s.status,
      speaker_count: s._count.files,
      identified_count: s.files.filter((f) => f.userId).length,
    })),
  );
});

recordingsRouter.get("/sessions/:id", requireAdmin, async (req, res) => {
  const session = await prisma.recordingSession.findUnique({
    where: { id: req.params.id },
    include: { files: { include: { user: true } } },
  });
  if (!session) return res.status(404).json({ error: "not_found" });
  res.json(session);
});

recordingsRouter.get("/sessions/:id/files/:discordUserId.opus", requireAdmin, async (req, res) => {
  const file = await prisma.recordingFile.findUnique({
    where: { sessionId_discordUserId: { sessionId: req.params.id, discordUserId: req.params.discordUserId } },
    include: { session: true },
  });
  if (!file) return res.status(404).json({ error: "not_found" });
  res.setHeader("Content-Type", "audio/ogg");
  res.setHeader("Content-Disposition", `attachment; filename="${path.basename(file.filePath)}"`);
  createReadStream(path.join(file.session.fileDir, file.filePath)).pipe(res);
});

recordingsRouter.get("/sessions/:id/zip", requireAdmin, async (req, res) => {
  const session = await prisma.recordingSession.findUnique({
    where: { id: req.params.id },
    include: { files: true },
  });
  if (!session) return res.status(404).json({ error: "not_found" });
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="session-${session.id}.zip"`);
  const archive = archiver("zip");
  archive.on("error", (e) => res.destroy(e));
  archive.pipe(res);
  for (const f of session.files) {
    archive.file(path.join(session.fileDir, f.filePath), { name: f.filePath });
  }
  archive.file(path.join(session.fileDir, "_metadata.json"), { name: "_metadata.json" });
  await archive.finalize();
});
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run packages/api/src/routes/recordings.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/routes/recordings.ts packages/api/src/routes/recordings.test.ts packages/api/package.json package-lock.json
git commit -m "feat(api): admin recording list/detail/download/zip endpoints"
```

---

## Task 7: Admin auth — Telegram Login Widget HMAC + JWT session + real requireAdmin

**Files:**
- Create: `packages/api/src/auth/telegramLogin.ts`
- Test: `packages/api/src/auth/telegramLogin.test.ts`
- Create: `packages/api/src/auth/session.ts`
- Test: `packages/api/src/auth/session.test.ts`
- Modify: `packages/api/src/auth/requireAdmin.ts`
- Create: `packages/api/src/routes/adminAuth.ts`
- Modify: `packages/api/src/app.ts`

- [ ] **Step 1: Write the failing test for HMAC verification** (spec §8)

`packages/api/src/auth/telegramLogin.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createHash, createHmac } from "node:crypto";
import { verifyTelegramLogin } from "./telegramLogin.js";

const BOT_TOKEN = "123:abc";

function signPayload(data: Record<string, string>): Record<string, string> {
  const checkString = Object.keys(data).sort().map((k) => `${k}=${data[k]}`).join("\n");
  const secret = createHash("sha256").update(BOT_TOKEN).digest();
  const hash = createHmac("sha256", secret).update(checkString).digest("hex");
  return { ...data, hash };
}

describe("verifyTelegramLogin", () => {
  const now = Math.floor(Date.now() / 1000);

  it("accepts a correctly signed, fresh payload", () => {
    const payload = signPayload({ id: "898912046", first_name: "Ada", auth_date: String(now) });
    const result = verifyTelegramLogin(payload, BOT_TOKEN, now);
    expect(result).toMatchObject({ id: 898912046n, first_name: "Ada" });
  });

  it("rejects a tampered payload", () => {
    const payload = signPayload({ id: "898912046", first_name: "Ada", auth_date: String(now) });
    expect(() => verifyTelegramLogin({ ...payload, id: "1" }, BOT_TOKEN, now)).toThrow(/signature/);
  });

  it("rejects a stale auth_date (> 24h old, replay defense)", () => {
    const old = now - 25 * 3600;
    const payload = signPayload({ id: "898912046", first_name: "Ada", auth_date: String(old) });
    expect(() => verifyTelegramLogin(payload, BOT_TOKEN, now)).toThrow(/expired/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/api/src/auth/telegramLogin.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `packages/api/src/auth/telegramLogin.ts`**

```ts
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export interface TelegramLoginUser {
  id: bigint;
  first_name: string;
  last_name?: string;
  username?: string;
}

const MAX_AGE_SEC = 24 * 3600;

/** Verifies a Telegram Login Widget payload per Telegram's published formula. */
export function verifyTelegramLogin(
  payload: Record<string, string>,
  botToken: string,
  nowSec = Math.floor(Date.now() / 1000),
): TelegramLoginUser {
  const { hash, ...data } = payload;
  if (!hash) throw new Error("missing signature");

  const checkString = Object.keys(data).sort().map((k) => `${k}=${data[k]}`).join("\n");
  const secret = createHash("sha256").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(checkString).digest("hex");

  const a = Buffer.from(hash);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error("invalid signature");

  const authDate = Number(data.auth_date);
  if (!Number.isFinite(authDate) || nowSec - authDate > MAX_AGE_SEC) {
    throw new Error("login expired");
  }

  return {
    id: BigInt(data.id),
    first_name: data.first_name ?? "",
    last_name: data.last_name,
    username: data.username,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/api/src/auth/telegramLogin.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Write the failing session JWT test**

`packages/api/src/auth/session.test.ts`:

```ts
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
```

- [ ] **Step 6: Run to verify it fails, then implement `packages/api/src/auth/session.ts`**

Run: `npx vitest run packages/api/src/auth/session.test.ts` → FAIL (module not found).

```ts
import { SignJWT, jwtVerify } from "jose";

const ALG = "HS256";
export const SESSION_COOKIE = "debates_session";

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signSession(userId: string, secret: string): Promise<string> {
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(key(secret));
}

export async function verifySession(token: string, secret: string): Promise<string> {
  const { payload } = await jwtVerify(token, key(secret), { algorithms: [ALG] });
  if (!payload.sub) throw new Error("no subject");
  return payload.sub;
}
```

Run: `npx vitest run packages/api/src/auth/session.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 7: Replace `requireAdmin` with real cookie verification (keeping the test bypass)**

Replace the body of `packages/api/src/auth/requireAdmin.ts` after the `declare global` block with:

```ts
import { buildConfig } from "../config.js";
import { SESSION_COOKIE, verifySession } from "./session.js";

const config = buildConfig();

export async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (process.env.NODE_ENV === "test") {
    const id = req.header("x-test-admin-id");
    if (id) {
      req.adminUserId = id;
      return next();
    }
  }
  const token = (req as Request & { cookies?: Record<string, string> }).cookies?.[SESSION_COOKIE];
  if (!token) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  try {
    req.adminUserId = await verifySession(token, config.jwtSecret);
    next();
  } catch {
    res.status(401).json({ error: "unauthorized" });
  }
}
```

> Keep the `import type { Request, Response, NextFunction } from "express";` and the `declare global` block at the top of the file unchanged.

- [ ] **Step 8: Implement `packages/api/src/routes/adminAuth.ts`** (spec §7/§8: login, logout, me)

```ts
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { buildConfig } from "../config.js";
import { verifyTelegramLogin } from "../auth/telegramLogin.js";
import { signSession, verifySession, SESSION_COOKIE } from "../auth/session.js";
import { loadEnv } from "@debates/shared";

const config = buildConfig();
const env = loadEnv();

export const adminAuthRouter = Router();

adminAuthRouter.post("/auth/telegram", async (req, res) => {
  const payload = z.record(z.string()).parse(req.body);
  let user;
  try {
    user = verifyTelegramLogin(payload, env.DISCORD_BOT_TOKEN === "" ? "" : env.TELEGRAM_BOT_TOKEN);
  } catch {
    return res.status(401).json({ error: "invalid_login" });
  }
  if (!config.adminTelegramIds.includes(user.id)) {
    return res.status(403).json({ error: "not_admin" });
  }
  const displayName = [user.first_name, user.last_name].filter(Boolean).join(" ") || user.username || "Admin";
  const dbUser = await prisma.user.upsert({
    where: { telegramUserId: user.id },
    create: { telegramUserId: user.id, telegramUsername: user.username ?? null, displayName },
    update: { telegramUsername: user.username ?? null },
  });
  const token = await signSession(dbUser.id, config.jwtSecret);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 7 * 24 * 3600 * 1000,
  });
  res.json({ id: dbUser.id, display_name: dbUser.displayName });
});

adminAuthRouter.post("/auth/logout", (_req, res) => {
  res.clearCookie(SESSION_COOKIE);
  res.json({ ok: true });
});

adminAuthRouter.get("/me", async (req, res) => {
  const token = (req as typeof req & { cookies?: Record<string, string> }).cookies?.[SESSION_COOKIE];
  if (!token) return res.status(401).json({ error: "unauthorized" });
  try {
    const userId = await verifySession(token, config.jwtSecret);
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(401).json({ error: "unauthorized" });
    res.json({ id: user.id, display_name: user.displayName, telegram_username: user.telegramUsername });
  } catch {
    res.status(401).json({ error: "unauthorized" });
  }
});
```

- [ ] **Step 9: Wire `cookie-parser` and the router into `app.ts`**

Add imports:

```ts
import cookieParser from "cookie-parser";
import { adminAuthRouter } from "./routes/adminAuth.js";
```

After `app.use(express.json());` add:

```ts
  app.use(cookieParser());
```

And mount (note path prefix):

```ts
  app.use("/api/admin", adminAuthRouter);
```

- [ ] **Step 10: Run the full suite**

Run: `npm test`
Expected: all api + shared suites pass.

- [ ] **Step 11: Commit**

```bash
git add packages/api/src/auth packages/api/src/routes/adminAuth.ts packages/api/src/app.ts
git commit -m "feat(api): admin auth via Telegram Login Widget HMAC + JWT session cookie"
```

---

## Task 8: Link codes (issue/redeem) + users endpoints

**Files:**
- Create: `packages/api/src/services/linkcodes.ts`
- Test: `packages/api/src/services/linkcodes.test.ts`
- Create: `packages/api/src/routes/link.ts`
- Create: `packages/api/src/routes/users.ts`
- Modify: `packages/api/src/app.ts`

- [ ] **Step 1: Write the failing test for code generation + redemption**

`packages/api/src/services/linkcodes.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { generateCode, issueCode, redeemCode } from "./linkcodes.js";
import { prisma } from "../prisma.js";
import { truncateAll } from "../test/db.js";

describe("generateCode", () => {
  it("produces LINK-XXXX uppercase alphanumeric", () => {
    const code = generateCode();
    expect(code).toMatch(/^LINK-[A-Z0-9]{4,}$/);
  });
});

describe("issue + redeem", () => {
  beforeEach(async () => {
    await truncateAll();
  });
  afterAll(async () => {
    const { connection, gameEventsQueue } = await import("../queue.js");
    await gameEventsQueue.close();
    await connection.quit();
  });

  it("redeems a valid code and links the discord id to the user", async () => {
    const user = await prisma.user.create({ data: { telegramUserId: 5n, displayName: "Bo" } });
    const { code } = await issueCode(5n);
    const result = await redeemCode(code, "disc-1", "bo#1");
    expect(result).toMatchObject({ telegram_user_id: 5, display_name: "Bo" });
    const updated = await prisma.user.findUnique({ where: { id: user.id } });
    expect(updated?.discordUserId).toBe("disc-1");
  });

  it("returns null for an expired code", async () => {
    await prisma.user.create({ data: { telegramUserId: 6n, displayName: "Ex" } });
    await prisma.linkCode.create({
      data: { code: "LINK-DEAD", telegramUserId: 6n, expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await redeemCode("LINK-DEAD", "disc-2", "ex")).toBeNull();
  });

  it("returns null for an already-used code", async () => {
    await prisma.user.create({ data: { telegramUserId: 7n, displayName: "Us" } });
    const { code } = await issueCode(7n);
    await redeemCode(code, "disc-3", "us");
    expect(await redeemCode(code, "disc-4", "us")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/api/src/services/linkcodes.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `packages/api/src/services/linkcodes.ts`**

```ts
import { randomInt } from "node:crypto";
import { prisma } from "../prisma.js";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous 0/O/1/I
const EXPIRY_MS = 24 * 3600 * 1000;

export function generateCode(): string {
  let suffix = "";
  for (let i = 0; i < 4; i++) suffix += ALPHABET[randomInt(ALPHABET.length)];
  return `LINK-${suffix}`;
}

export async function issueCode(telegramUserId: bigint): Promise<{ code: string; expires_at: Date }> {
  const code = generateCode();
  const expiresAt = new Date(Date.now() + EXPIRY_MS);
  await prisma.linkCode.create({ data: { code, telegramUserId, expiresAt } });
  return { code, expires_at: expiresAt };
}

export async function redeemCode(
  code: string,
  discordUserId: string,
  _discordUsername: string,
): Promise<{ telegram_user_id: number; display_name: string } | null> {
  return prisma.$transaction(async (tx) => {
    const row = await tx.linkCode.findUnique({ where: { code } });
    if (!row || row.usedAt || row.expiresAt < new Date()) return null;

    await tx.linkCode.update({ where: { code }, data: { usedAt: new Date() } });
    const user = await tx.user.update({
      where: { telegramUserId: row.telegramUserId },
      data: { discordUserId },
    });
    return { telegram_user_id: Number(user.telegramUserId), display_name: user.displayName };
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/api/src/services/linkcodes.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Implement `packages/api/src/routes/link.ts`** (bot-scoped; spec §7/§8)

```ts
import { Router } from "express";
import { IssueLinkBody, RedeemLinkBody } from "@debates/shared";
import { requireBotToken } from "../middleware/botAuth.js";
import { buildConfig } from "../config.js";
import { issueCode, redeemCode } from "../services/linkcodes.js";

const config = buildConfig();
export const linkRouter = Router();

// Telegram bot mints codes for unlinked participants.
linkRouter.post("/issue", requireBotToken(config.telegramBotApiToken), async (req, res) => {
  const body = IssueLinkBody.parse(req.body);
  const result = await issueCode(body.telegram_user_id);
  res.status(201).json(result);
});

// Discord bot redeems on /link.
linkRouter.post("/redeem", requireBotToken(config.discordBotApiToken), async (req, res) => {
  const body = RedeemLinkBody.parse(req.body);
  const result = await redeemCode(body.code, body.discord_user_id, body.discord_username);
  if (!result) return res.status(404).json({ error: "invalid_or_expired_code" });
  res.json(result);
});
```

- [ ] **Step 6: Implement `packages/api/src/routes/users.ts`** (admin; spec §7)

```ts
import { Router } from "express";
import { prisma } from "../prisma.js";
import { requireAdmin } from "../auth/requireAdmin.js";

export const usersRouter = Router();
usersRouter.use(requireAdmin);

usersRouter.get("/", async (_req, res) => {
  const users = await prisma.user.findMany({ orderBy: { createdAt: "desc" } });
  res.json(
    users.map((u) => ({
      id: u.id,
      telegram_username: u.telegramUsername,
      display_name: u.displayName,
      linked: u.discordUserId !== null,
      created_at: u.createdAt,
    })),
  );
});

usersRouter.post("/:id/unlink-discord", async (req, res) => {
  const user = await prisma.user.update({ where: { id: req.params.id }, data: { discordUserId: null } }).catch(() => null);
  if (!user) return res.status(404).json({ error: "not_found" });
  res.json({ id: user.id, linked: false });
});
```

- [ ] **Step 7: Mount both routers in `app.ts`**

```ts
import { linkRouter } from "./routes/link.js";
import { usersRouter } from "./routes/users.js";
// ...
  app.use("/api/link", linkRouter);
  app.use("/api/users", usersRouter);
```

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: all suites pass.

- [ ] **Step 9: Commit**

```bash
git add packages/api/src/services/linkcodes.ts packages/api/src/services/linkcodes.test.ts packages/api/src/routes/link.ts packages/api/src/routes/users.ts packages/api/src/app.ts
git commit -m "feat(api): link-code issue/redeem and admin users endpoints"
```

---

## Task 9: Crons — cleanup, reap_stuck_sessions, reconcile (fixes #2, #3, #4)

**Files:**
- Create: `packages/api/src/crons.ts`
- Test: `packages/api/src/crons.test.ts`
- Modify: `packages/api/src/server.ts`

- [ ] **Step 1: Write the failing test for the cleanup + reap logic** (pure-ish, against test DB + fs)

`packages/api/src/crons.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { prisma } from "./prisma.js";
import { truncateAll } from "./test/db.js";
import { cleanupOldRecordings, reapStuckSessions } from "./crons.js";

describe("cleanupOldRecordings", () => {
  beforeEach(async () => {
    await truncateAll();
  });
  afterAll(async () => {
    const { connection, gameEventsQueue } = await import("./queue.js");
    await gameEventsQueue.close();
    await connection.quit();
  });

  it("deletes completed AND failed sessions older than 30 days, plus their dirs", async () => {
    const oldDir = mkdtempSync(path.join(tmpdir(), "rec-"));
    const old = new Date(Date.now() - 31 * 86400000);
    await prisma.recordingSession.create({
      data: {
        startedByDiscordUserId: "1", voiceChannelId: "v", voiceChannelName: "n",
        guildId: "g1", fileDir: oldDir, status: "failed", startedAt: old, endedAt: old,
      },
    });
    const deleted = await cleanupOldRecordings();
    expect(deleted).toBe(1);
    expect(existsSync(oldDir)).toBe(false);
    expect(await prisma.recordingSession.count()).toBe(0);
  });

  it("does not delete recent sessions", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rec-"));
    await prisma.recordingSession.create({
      data: {
        startedByDiscordUserId: "1", voiceChannelId: "v", voiceChannelName: "n",
        guildId: "g2", fileDir: dir, status: "completed", endedAt: new Date(),
      },
    });
    expect(await cleanupOldRecordings()).toBe(0);
  });
});

describe("reapStuckSessions", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("flips long-running 'recording' sessions to 'failed', releasing the guild lock", async () => {
    const stale = new Date(Date.now() - 6 * 3600000); // 6h ago, cap is 4h
    await prisma.recordingSession.create({
      data: {
        startedByDiscordUserId: "1", voiceChannelId: "v", voiceChannelName: "n",
        guildId: "g3", fileDir: "/tmp/x", status: "recording", startedAt: stale,
      },
    });
    const reaped = await reapStuckSessions();
    expect(reaped).toBe(1);
    const row = await prisma.recordingSession.findFirst({ where: { guildId: "g3" } });
    expect(row?.status).toBe("failed");
    expect(row?.endedAt).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/api/src/crons.test.ts`
Expected: FAIL — `./crons.js` not found.

- [ ] **Step 3: Implement `packages/api/src/crons.ts`**

```ts
import { rm } from "node:fs/promises";
import cron from "node-cron";
import { prisma } from "./prisma.js";
import { buildConfig } from "./config.js";
import { reconcileJobs } from "./scheduler/scheduler.js";

const config = buildConfig();

/** Fix #3: delete completed AND failed sessions older than 30 days + their dirs. */
export async function cleanupOldRecordings(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 30 * 86400000);
  const sessions = await prisma.recordingSession.findMany({
    where: {
      status: { in: ["completed", "failed"] },
      OR: [{ endedAt: { lt: cutoff } }, { endedAt: null, startedAt: { lt: cutoff } }],
    },
  });
  for (const s of sessions) {
    await rm(s.fileDir, { recursive: true, force: true });
    await prisma.recordingSession.delete({ where: { id: s.id } }); // cascades files
  }
  return sessions.length;
}

/** Fix #4: orphaned 'recording' rows (bot crashed) -> 'failed', releasing the guild lock. */
export async function reapStuckSessions(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - (config.maxSessionHours + 1) * 3600000);
  const result = await prisma.recordingSession.updateMany({
    where: { status: "recording", startedAt: { lt: cutoff } },
    data: { status: "failed", endedAt: now },
  });
  return result.count;
}

/** Registers the scheduled crons. Call once from server.ts. */
export function startCrons(): void {
  cron.schedule("0 4 * * *", () => void cleanupOldRecordings()); // daily 04:00
  cron.schedule("*/15 * * * *", () => void reapStuckSessions()); // every 15 min
  cron.schedule("0 * * * *", () => void reconcileJobs()); // hourly (fix #2 safety net)
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/api/src/crons.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Wire crons + boot reconciliation into `server.ts`**

Replace `packages/api/src/server.ts` with:

```ts
import { buildConfig } from "./config.js";
import { createApp } from "./app.js";
import { startCrons } from "./crons.js";
import { reconcileJobs } from "./scheduler/scheduler.js";

const config = buildConfig();
const app = createApp();

app.listen(config.port, async () => {
  console.log(`[api] listening on :${config.port}`);
  const count = await reconcileJobs(); // fix #2: self-heal Redis on boot
  console.log(`[api] reconciled jobs for ${count} upcoming games`);
  startCrons();
});
```

- [ ] **Step 6: Run the full suite + typecheck**

Run: `npm test && npm run typecheck -w @debates/api`
Expected: all pass, no type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/crons.ts packages/api/src/crons.test.ts packages/api/src/server.ts
git commit -m "feat(api): cleanup/reap/reconcile crons + boot reconciliation"
```

---

## Self-review against the spec

- **§4 jobs table** — all six job types produced by `jobsToEnqueue`/`enqueueGameJobs` (Tasks 2–3). ✓
- **§4 past-offset guard (fix #1)** — Task 2, unit-tested. ✓
- **§4 reconciliation (fix #2)** — `reconcileJobs` at boot (Task 9 server.ts) + hourly cron. ✓
- **§4 reschedule/cancel** — `rescheduleGameJobs`/`removeGameJobs` wired into games service (Task 4). ✓
- **§4 crons (fix #3, #4)** — `cleanupOldRecordings` (completed+failed), `reapStuckSessions`, `reconcileJobs` (Task 9). ✓
- **§3 partial unique index (fix #5)** — surfaced as the 409 path in `createSession` (Task 5), tested. ✓
- **§5 recording flow** — session create → file register → complete + `_metadata.json` (Task 5). The bot-side voice capture is Plan 3. ✓
- **§7 API surface** — every row implemented: admin auth (Task 7), games (Task 4), users (Task 8), recordings read (Task 6) + bot writes (Task 5), link issue/redeem (Task 8). ✓
- **§8 auth** — Telegram Login HMAC + `auth_date` replay check + JWT cookie (Task 7); scoped bot tokens via `requireBotToken` with the correct per-endpoint token (Tasks 5, 8). ✓
- **Placeholder scan** — concrete code in every step; no TBD. ✓
- **Type consistency** — `enqueueGameJobs(gameId, scheduledAt, now?)`, `reconcileJobs(now?)`, `createSession`/`completeSession`, `issueCode(bigint)`/`redeemCode(...)`, `verifyTelegramLogin`/`signSession`/`verifySession`, `requireAdmin` (`req.adminUserId`) all consistent across tasks. ✓

> **Known test-infra note:** router/service integration tests require `docker compose up -d postgres redis` and a migrated DB (Plan 1). The `x-test-admin-id` bypass in `requireAdmin` is gated on `NODE_ENV==='test'` and must never be reachable in production builds — Plan 6's deploy sets `NODE_ENV=production`.

---

## Addenda introduced by later plans (apply when executing those plans)

Drafting Plans 3–5 surfaced small API additions that logically belong to this API package. They are **specified with full code in the plan that needs them** — listed here so Plan 2 stays the authoritative index and nothing is missed if plans run out of order. Treat each as an extra task appended to this plan when you reach the dependent plan.

| # | Addition | Auth scope | Implementing plan |
|---|---|---|---|
| A | Richer `game-events` payloads — enqueue `motion`, `scheduled_at`, and `participants[] { telegram_user_id, display_name, linked }` (+ for `announce_t30`, the linked Discord IDs) on each job so bots need no admin read. Extend `GameEventPayload` and `enqueueGameJobs` to snapshot participant data at enqueue time. | n/a (queue) | Plans 3 & 4 |
| B | `POST /api/users/register` — bot-scoped (`TELEGRAM_BOT_API_TOKEN`), upsert by `telegram_user_id` `{ telegram_user_id, telegram_username, display_name }`. Players are created on `/start`; Plan 2 alone only auto-creates *admin* users on login. | telegram-bot | Plan 4 |
| C | `GET /api/users/:telegram_user_id/games` — bot-scoped (`TELEGRAM_BOT_API_TOKEN`), the user's future `scheduled` games for `/games`. | telegram-bot | Plan 4 |
| D | Static SPA serve — `app.use("/admin", express.static(adminDir))` + `GET /admin/*` SPA fallback to `index.html`, mounted **before** `notFoundHandler` so `/api/*` 404s stay JSON. | none | Plan 5 |

Note the shared-queue contract (from Plan 3, mirrored in Plan 4): both bots run a Worker on the single `game-events` queue and must **ack-ignore foreign `job.name`s without throwing** — the Discord bot owns `announce_t30`; the Telegram bot owns the other five. Addendum A's payload shape must satisfy both consumers.

---

**End of Plan 2.** Plan 3 (Discord bot) calls `POST /api/recordings/sessions|.../files|.../complete` and `POST /api/link/redeem`; Plan 4 (Telegram bot) consumes `game-events` and calls `POST /api/link/issue`. Both use the bot service tokens enforced here.
