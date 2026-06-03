# Debates Helper — Plan 1: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the npm-workspaces monorepo, the `shared` package, the full Prisma database schema (six tables + the partial unique index), and a minimal Express API skeleton (config, health check, bot-token auth, error handling) that boots against a docker-compose Postgres + Redis.

**Architecture:** Single repo, npm workspaces, TypeScript ESM throughout. `shared` exports a Zod-validated env loader, constants, and request DTOs consumed by every other package. `api` is the sole Postgres writer (Prisma). This plan stops at the skeleton — domain endpoints, the BullMQ scheduler, and the bots come in later plans. Everything here is independently testable: migrations apply cleanly, `GET /healthz` returns ok, and the auth middleware is unit-tested.

**Tech Stack:** Node 20 (Docker) / Node 22 (local dev), TypeScript (ESM, NodeNext), Prisma + postgres:16, Express, Zod, Vitest + Supertest, tsx, Docker Compose.

**Plan series (this is Plan 1 of 6):**
1. **Foundation** (this doc) — monorepo, shared, DB schema, API skeleton
2. API domain — games CRUD, BullMQ scheduler (past-offset guard + reconciliation), recording-session + link endpoints, cron jobs
3. Discord bot — `/link`, `/record start|stop`, per-speaker voice capture
4. Telegram bot — registration, `game-events` consumer, link-code DMs
5. Web admin — React SPA (games, recordings, users)
6. Deployment — nginx, host bootstrap, backups

---

## File structure introduced by this plan

```
discord-debates-helper/
├── package.json                      # workspaces root, shared scripts
├── tsconfig.base.json                # shared compiler options
├── vitest.workspace.ts               # discovers per-package vitest configs
├── .gitignore
├── .env.example
├── docker-compose.yml                # postgres, redis, api
├── packages/
│   ├── shared/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── vitest.config.ts
│   │   └── src/
│   │       ├── index.ts              # re-exports
│   │       ├── env.ts                # Zod-validated process.env loader
│   │       ├── env.test.ts
│   │       ├── constants.ts          # job types, statuses, enums
│   │       ├── dto.ts                # Zod request/response schemas
│   │       └── dto.test.ts
│   └── api/
│       ├── package.json
│       ├── tsconfig.json
│       ├── vitest.config.ts
│       ├── Dockerfile
│       ├── prisma/
│       │   ├── schema.prisma
│       │   └── migrations/           # generated + hand-edited partial index
│       └── src/
│           ├── config.ts             # typed config built from shared env
│           ├── config.test.ts
│           ├── prisma.ts             # PrismaClient singleton
│           ├── app.ts                # Express app factory (no listen)
│           ├── app.test.ts           # supertest against the factory
│           ├── server.ts             # binds app.listen()
│           └── middleware/
│               ├── botAuth.ts        # Bearer service-token guard
│               ├── botAuth.test.ts
│               ├── errorHandler.ts   # central error + 404
│               └── errorHandler.test.ts
```

---

## Task 1: Monorepo + tooling bootstrap

**Files:**
- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `vitest.workspace.ts`
- Create: `.gitignore`

- [ ] **Step 1: Create the workspaces root `package.json`**

```json
{
  "name": "discord-debates-helper",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "workspaces": ["packages/*"],
  "scripts": {
    "build": "npm run build --workspaces --if-present",
    "typecheck": "tsc -b packages/shared packages/api",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.1.0",
    "tsx": "^4.19.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "composite": true,
    "sourceMap": true,
    "forceConsistentCasingInFileNames": true,
    "noUncheckedIndexedAccess": true
  }
}
```

- [ ] **Step 3: Create `vitest.workspace.ts`**

```ts
export default ["packages/*/vitest.config.ts"];
```

- [ ] **Step 4: Create `.gitignore`**

```gitignore
node_modules/
dist/
*.tsbuildinfo
.env
recordings/
coverage/
```

- [ ] **Step 5: Install root dev deps and verify**

Run: `npm install`
Expected: completes without error; `node_modules/` created.

Run: `npx tsc --version`
Expected: prints `Version 5.6.x` (or compatible).

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.base.json vitest.workspace.ts .gitignore package-lock.json
git commit -m "chore: bootstrap npm workspaces monorepo"
```

---

## Task 2: `shared` package scaffold + env loader

**Files:**
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/vitest.config.ts`
- Create: `packages/shared/src/index.ts`
- Create: `packages/shared/src/env.ts`
- Test: `packages/shared/src/env.test.ts`

- [ ] **Step 1: Create `packages/shared/package.json`**

```json
{
  "name": "@debates/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": "./dist/index.js" },
  "scripts": {
    "build": "tsc -b",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "zod": "^3.23.0"
  }
}
```

- [ ] **Step 2: Create `packages/shared/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist"
  },
  "include": ["src/**/*"],
  "exclude": ["**/*.test.ts"]
}
```

- [ ] **Step 3: Create `packages/shared/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "shared",
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 4: Install the workspace dep**

Run: `npm install` (from repo root — links the workspace and installs `zod`)
Expected: `@debates/shared` appears under `node_modules/@debates/shared` as a symlink.

- [ ] **Step 5: Write the failing test for the env loader**

`packages/shared/src/env.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { loadEnv } from "./env.js";

const base = {
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
  JWT_SECRET: "x".repeat(32),
  PUBLIC_URL: "https://debates.example.com",
  ADMIN_TELEGRAM_IDS: "898912046,123",
  DISCORD_BOT_API_TOKEN: "a".repeat(32),
  TELEGRAM_BOT_API_TOKEN: "b".repeat(32),
  DISCORD_BOT_TOKEN: "dtoken",
  DISCORD_CLIENT_ID: "1511558875571159201",
  DEBATE_ANNOUNCE_CHANNEL_ID: "607662041561563167",
  DEBATE_FALLBACK_CHANNEL_ID: "607662041561563167",
  TELEGRAM_BOT_TOKEN: "ttoken",
  TELEGRAM_BOT_USERNAME: "tooronkaich_bot",
};

describe("loadEnv", () => {
  it("parses a valid environment and coerces admin IDs to bigint[]", () => {
    const env = loadEnv(base);
    expect(env.ADMIN_TELEGRAM_IDS).toEqual([898912046n, 123n]);
    expect(env.MAX_SESSION_HOURS).toBe(4); // default applied
  });

  it("throws a descriptive error when a required var is missing", () => {
    const { DATABASE_URL, ...withoutDb } = base;
    expect(() => loadEnv(withoutDb)).toThrow(/DATABASE_URL/);
  });

  it("rejects a JWT_SECRET shorter than 32 chars", () => {
    expect(() => loadEnv({ ...base, JWT_SECRET: "short" })).toThrow(/JWT_SECRET/);
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run packages/shared/src/env.test.ts`
Expected: FAIL — `Cannot find module './env.js'` / `loadEnv is not a function`.

- [ ] **Step 7: Implement `packages/shared/src/env.ts`**

```ts
import { z } from "zod";

const csvBigInts = z
  .string()
  .min(1)
  .transform((s) => s.split(",").map((part) => BigInt(part.trim())));

export const EnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 chars"),
  PUBLIC_URL: z.string().url(),
  ADMIN_TELEGRAM_IDS: csvBigInts,
  DISCORD_BOT_API_TOKEN: z.string().min(32),
  TELEGRAM_BOT_API_TOKEN: z.string().min(32),
  DISCORD_BOT_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  DEBATE_ANNOUNCE_CHANNEL_ID: z.string().min(1),
  DEBATE_FALLBACK_CHANNEL_ID: z.string().min(1),
  MAX_SESSION_HOURS: z.coerce.number().int().positive().default(4),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_BOT_USERNAME: z.string().min(1),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment: ${issues}`);
  }
  return result.data;
}
```

- [ ] **Step 8: Create the re-export barrel `packages/shared/src/index.ts`**

```ts
export * from "./env.js";
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `npx vitest run packages/shared/src/env.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 10: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): add Zod-validated env loader"
```

---

## Task 3: `shared` constants + request DTOs

**Files:**
- Create: `packages/shared/src/constants.ts`
- Create: `packages/shared/src/dto.ts`
- Test: `packages/shared/src/dto.test.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Create `packages/shared/src/constants.ts`**

```ts
/** BullMQ job type names on the `game-events` queue (Plan 2 consumes these). */
export const JOB_TYPES = [
  "notify_week_before",
  "notify_day_before",
  "notify_hour_before",
  "nudge_unlinked_40m",
  "announce_t30",
  "notify_t10",
] as const;
export type JobType = (typeof JOB_TYPES)[number];

/** Offset in milliseconds BEFORE scheduled_at at which each job fires. */
export const JOB_OFFSETS_MS: Record<JobType, number> = {
  notify_week_before: 7 * 24 * 60 * 60 * 1000,
  notify_day_before: 24 * 60 * 60 * 1000,
  notify_hour_before: 60 * 60 * 1000,
  nudge_unlinked_40m: 40 * 60 * 1000,
  announce_t30: 30 * 60 * 1000,
  notify_t10: 10 * 60 * 1000,
};

export const GAME_STATUS = ["scheduled", "cancelled"] as const;
export type GameStatus = (typeof GAME_STATUS)[number];

export const RECORDING_STATUS = ["recording", "completed", "failed"] as const;
export type RecordingStatus = (typeof RECORDING_STATUS)[number];

export const QUEUE_NAME = "game-events";

/** Deterministic BullMQ jobId so reconciliation/reschedule are idempotent. */
export function jobIdFor(gameId: string, type: JobType): string {
  return `game:${gameId}:${type}`;
}
```

- [ ] **Step 2: Write the failing test for DTOs and `jobIdFor`**

`packages/shared/src/dto.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { jobIdFor } from "./constants.js";
import { CreateRecordingSessionBody, RegisterRecordingFileBody, RedeemLinkBody } from "./dto.js";

describe("jobIdFor", () => {
  it("builds a stable id", () => {
    expect(jobIdFor("abc", "announce_t30")).toBe("game:abc:announce_t30");
  });
});

describe("CreateRecordingSessionBody", () => {
  it("accepts a valid payload", () => {
    const parsed = CreateRecordingSessionBody.parse({
      started_by_discord_user_id: "998877665544332211",
      voice_channel_id: "111",
      voice_channel_name: "Main",
      guild_id: "222",
    });
    expect(parsed.voice_channel_name).toBe("Main");
  });

  it("rejects a missing guild_id", () => {
    expect(() =>
      CreateRecordingSessionBody.parse({
        started_by_discord_user_id: "1",
        voice_channel_id: "111",
        voice_channel_name: "Main",
      }),
    ).toThrow();
  });
});

describe("RegisterRecordingFileBody", () => {
  it("requires non-negative duration and size", () => {
    expect(() =>
      RegisterRecordingFileBody.parse({
        discord_user_id: "1",
        discord_username: "alice",
        file_path: "alice_2211.opus",
        duration_sec: -1,
        size_bytes: 10,
      }),
    ).toThrow();
  });
});

describe("RedeemLinkBody", () => {
  it("accepts a code redemption", () => {
    const parsed = RedeemLinkBody.parse({
      code: "LINK-7F2X",
      discord_user_id: "1",
      discord_username: "alice",
    });
    expect(parsed.code).toBe("LINK-7F2X");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run packages/shared/src/dto.test.ts`
Expected: FAIL — `Cannot find module './dto.js'`.

- [ ] **Step 4: Implement `packages/shared/src/dto.ts`**

```ts
import { z } from "zod";

const snowflake = z.string().min(1).max(32);

export const CreateRecordingSessionBody = z.object({
  started_by_discord_user_id: snowflake,
  voice_channel_id: snowflake,
  voice_channel_name: z.string().min(1).max(200),
  guild_id: snowflake,
});
export type CreateRecordingSessionBody = z.infer<typeof CreateRecordingSessionBody>;

export const RegisterRecordingFileBody = z.object({
  discord_user_id: snowflake,
  discord_username: z.string().min(1).max(200),
  file_path: z.string().min(1),
  duration_sec: z.number().int().nonnegative(),
  size_bytes: z.number().int().nonnegative(),
});
export type RegisterRecordingFileBody = z.infer<typeof RegisterRecordingFileBody>;

export const IssueLinkBody = z.object({
  telegram_user_id: z.coerce.bigint(),
});
export type IssueLinkBody = z.infer<typeof IssueLinkBody>;

export const RedeemLinkBody = z.object({
  code: z.string().min(1).max(32),
  discord_user_id: snowflake,
  discord_username: z.string().min(1).max(200),
});
export type RedeemLinkBody = z.infer<typeof RedeemLinkBody>;
```

- [ ] **Step 5: Update `packages/shared/src/index.ts`**

```ts
export * from "./env.js";
export * from "./constants.js";
export * from "./dto.js";
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run packages/shared/src/dto.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 7: Build the shared package so dependents resolve `dist/`**

Run: `npm run build -w @debates/shared`
Expected: `packages/shared/dist/index.js` exists.

- [ ] **Step 8: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): add constants, job offsets, and request DTOs"
```

---

## Task 4: `api` package scaffold + Prisma schema + migration

**Files:**
- Create: `packages/api/package.json`
- Create: `packages/api/tsconfig.json`
- Create: `packages/api/prisma/schema.prisma`
- Create: `packages/api/src/prisma.ts`
- Create: `docker-compose.yml`
- Create: `.env.example`

- [ ] **Step 1: Create `packages/api/package.json`**

```json
{
  "name": "@debates/api",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -b",
    "dev": "tsx watch src/server.ts",
    "start": "node dist/server.js",
    "typecheck": "tsc --noEmit",
    "prisma:generate": "prisma generate",
    "prisma:migrate": "prisma migrate deploy",
    "prisma:migrate:dev": "prisma migrate dev"
  },
  "dependencies": {
    "@debates/shared": "*",
    "@prisma/client": "^5.20.0",
    "express": "^4.21.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/node": "^20.16.0",
    "@types/supertest": "^6.0.2",
    "prisma": "^5.20.0",
    "supertest": "^7.0.0"
  }
}
```

- [ ] **Step 2: Create `packages/api/tsconfig.json`**

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

- [ ] **Step 3: Create `packages/api/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "api",
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 4: Create `packages/api/prisma/schema.prisma`** (all six tables from spec §3)

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum GameStatus {
  scheduled
  cancelled
}

enum RecordingStatus {
  recording
  completed
  failed
}

model User {
  id                String    @id @default(uuid()) @db.Uuid
  telegramUserId    BigInt    @unique @map("telegram_user_id")
  telegramUsername  String?   @map("telegram_username")
  discordUserId     String?   @unique @map("discord_user_id")
  displayName       String    @map("display_name")
  createdAt         DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt         DateTime  @updatedAt @map("updated_at") @db.Timestamptz(6)

  linkCodes         LinkCode[]
  createdGames      Game[]            @relation("GameCreatedBy")
  participations    GameParticipant[]
  recordingFiles    RecordingFile[]

  @@map("users")
}

model LinkCode {
  code            String    @id
  telegramUserId  BigInt    @map("telegram_user_id")
  expiresAt       DateTime  @map("expires_at") @db.Timestamptz(6)
  usedAt          DateTime? @map("used_at") @db.Timestamptz(6)

  user            User      @relation(fields: [telegramUserId], references: [telegramUserId])

  @@map("link_codes")
}

model Game {
  id            String      @id @default(uuid()) @db.Uuid
  scheduledAt   DateTime    @map("scheduled_at") @db.Timestamptz(6)
  motion        String?
  status        GameStatus  @default(scheduled)
  createdById   String      @map("created_by") @db.Uuid
  cancelledAt   DateTime?   @map("cancelled_at") @db.Timestamptz(6)
  createdAt     DateTime    @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt     DateTime    @updatedAt @map("updated_at") @db.Timestamptz(6)

  createdBy     User              @relation("GameCreatedBy", fields: [createdById], references: [id])
  participants  GameParticipant[]

  @@map("games")
}

model GameParticipant {
  gameId  String  @map("game_id") @db.Uuid
  userId  String  @map("user_id") @db.Uuid

  game    Game    @relation(fields: [gameId], references: [id], onDelete: Cascade)
  user    User    @relation(fields: [userId], references: [id])

  @@id([gameId, userId])
  @@map("game_participants")
}

model RecordingSession {
  id                     String          @id @default(uuid()) @db.Uuid
  startedAt              DateTime        @default(now()) @map("started_at") @db.Timestamptz(6)
  endedAt                DateTime?       @map("ended_at") @db.Timestamptz(6)
  startedByDiscordUserId String          @map("started_by_discord_user_id")
  voiceChannelId         String          @map("voice_channel_id")
  voiceChannelName       String          @map("voice_channel_name")
  guildId                String          @map("guild_id")
  fileDir                String          @map("file_dir")
  status                 RecordingStatus @default(recording)

  files                  RecordingFile[]

  @@map("recording_sessions")
}

model RecordingFile {
  sessionId       String  @map("session_id") @db.Uuid
  discordUserId   String  @map("discord_user_id")
  userId          String? @map("user_id") @db.Uuid
  discordUsername String  @map("discord_username")
  filePath        String  @map("file_path")
  durationSec     Int     @map("duration_sec")
  sizeBytes       BigInt  @map("size_bytes")

  session         RecordingSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  user            User?            @relation(fields: [userId], references: [id])

  @@id([sessionId, discordUserId])
  @@map("recording_files")
}
```

- [ ] **Step 5: Create `.env.example`** (mirrors spec §9; never commit real `.env`)

```bash
# Postgres
POSTGRES_USER=debates
POSTGRES_PASSWORD=change-me
POSTGRES_DB=debates
DATABASE_URL=postgresql://debates:change-me@localhost:5432/debates

# Redis
REDIS_URL=redis://localhost:6379

# API
JWT_SECRET=replace-with-openssl-rand-hex-32-............
PUBLIC_URL=https://debates.animeenigma.com
ADMIN_TELEGRAM_IDS=898912046

# Bot <-> API service tokens (openssl rand -hex 32)
DISCORD_BOT_API_TOKEN=replace-with-openssl-rand-hex-32-........
TELEGRAM_BOT_API_TOKEN=replace-with-openssl-rand-hex-32-.......

# Discord
DISCORD_BOT_TOKEN=change-me
DISCORD_CLIENT_ID=1511558875571159201
DEBATE_ANNOUNCE_CHANNEL_ID=607662041561563167
DEBATE_FALLBACK_CHANNEL_ID=607662041561563167
MAX_SESSION_HOURS=4

# Telegram
TELEGRAM_BOT_TOKEN=change-me
TELEGRAM_BOT_USERNAME=tooronkaich_bot
```

> **Note on DATABASE_URL host:** for local dev (running `prisma` and tests from the host) use `localhost:5432`. Inside docker-compose the api service overrides the host to `postgres:5432` via its own env (Task 8). Keep `localhost` in `.env.example`.

- [ ] **Step 6: Create `docker-compose.yml`** (Postgres + Redis now; `api` service added in Task 8)

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    volumes: [pgdata:/var/lib/postgresql/data]
    ports: ["127.0.0.1:5432:5432"]
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    command: redis-server --appendonly yes
    volumes: [redisdata:/data]
    ports: ["127.0.0.1:6379:6379"]
    restart: unless-stopped

volumes:
  pgdata:
  redisdata:
```

- [ ] **Step 7: Install and start the database**

Run: `npm install`
Run: `cp .env.example .env` (then leave the placeholder secrets — fine for local dev)
Run: `docker compose up -d postgres redis`
Expected: both containers report healthy/running (`docker compose ps`).

- [ ] **Step 8: Generate the initial migration**

Run: `npm run prisma:migrate:dev -w @debates/api -- --name init`
Expected: creates `packages/api/prisma/migrations/<ts>_init/migration.sql`, applies it, generates the client. Verify tables exist:

Run: `docker compose exec postgres psql -U debates -d debates -c "\dt"`
Expected: lists `users`, `link_codes`, `games`, `game_participants`, `recording_sessions`, `recording_files`, plus `_prisma_migrations`.

- [ ] **Step 9: Add the partial unique index (spec §3, §5 — one active recording per guild)**

Create a follow-up migration directory and SQL. Run:

`npm run prisma:migrate:dev -w @debates/api -- --create-only --name one_active_recording_per_guild`

Then replace the generated `migration.sql` body with:

```sql
CREATE UNIQUE INDEX "one_active_recording_per_guild"
  ON "recording_sessions" ("guild_id")
  WHERE "status" = 'recording';
```

Apply it:

Run: `npm run prisma:migrate:dev -w @debates/api`
Expected: migration applies cleanly. Verify:

Run: `docker compose exec postgres psql -U debates -d debates -c "\d recording_sessions"`
Expected: shows `one_active_recording_per_guild" UNIQUE, ... WHERE status = 'recording'`.

- [ ] **Step 10: Create the PrismaClient singleton `packages/api/src/prisma.ts`**

```ts
import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();
```

- [ ] **Step 11: Commit**

```bash
git add packages/api .env.example docker-compose.yml package-lock.json
git commit -m "feat(api): add Prisma schema, migrations, and partial unique index"
```

---

## Task 5: API config (typed, from shared env)

**Files:**
- Create: `packages/api/src/config.ts`
- Test: `packages/api/src/config.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/api/src/config.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildConfig } from "./config.js";

const env = {
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
  PORT: "3000",
  RECORDINGS_DIR: "/var/lib/debates/recordings",
};

describe("buildConfig", () => {
  it("exposes port and recordings dir with defaults", () => {
    const cfg = buildConfig(env);
    expect(cfg.port).toBe(3000);
    expect(cfg.recordingsDir).toBe("/var/lib/debates/recordings");
    expect(cfg.discordBotApiToken).toBe("a".repeat(32));
  });

  it("defaults port to 3000 and recordingsDir when unset", () => {
    const { PORT, RECORDINGS_DIR, ...rest } = env;
    const cfg = buildConfig(rest);
    expect(cfg.port).toBe(3000);
    expect(cfg.recordingsDir).toBe("/var/lib/debates/recordings");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/api/src/config.test.ts`
Expected: FAIL — `Cannot find module './config.js'`.

- [ ] **Step 3: Implement `packages/api/src/config.ts`**

```ts
import { loadEnv } from "@debates/shared";

export interface Config {
  port: number;
  recordingsDir: string;
  databaseUrl: string;
  redisUrl: string;
  jwtSecret: string;
  publicUrl: string;
  adminTelegramIds: bigint[];
  discordBotApiToken: string;
  telegramBotApiToken: string;
  maxSessionHours: number;
}

export function buildConfig(source: Record<string, string | undefined> = process.env): Config {
  const env = loadEnv(source);
  return {
    port: source.PORT ? Number(source.PORT) : 3000,
    recordingsDir: source.RECORDINGS_DIR ?? "/var/lib/debates/recordings",
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    jwtSecret: env.JWT_SECRET,
    publicUrl: env.PUBLIC_URL,
    adminTelegramIds: env.ADMIN_TELEGRAM_IDS,
    discordBotApiToken: env.DISCORD_BOT_API_TOKEN,
    telegramBotApiToken: env.TELEGRAM_BOT_API_TOKEN,
    maxSessionHours: env.MAX_SESSION_HOURS,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/api/src/config.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/config.ts packages/api/src/config.test.ts
git commit -m "feat(api): add typed config built from shared env"
```

---

## Task 6: Bot-token auth middleware

**Files:**
- Create: `packages/api/src/middleware/botAuth.ts`
- Test: `packages/api/src/middleware/botAuth.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/api/src/middleware/botAuth.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";
import { requireBotToken } from "./botAuth.js";

function mockRes() {
  const res = {} as Response;
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

describe("requireBotToken", () => {
  const mw = requireBotToken("secret-token-value");

  it("calls next() when the Bearer token matches", () => {
    const req = { headers: { authorization: "Bearer secret-token-value" } } as Request;
    const res = mockRes();
    const next = vi.fn();
    mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("returns 401 when the header is missing", () => {
    const req = { headers: {} } as Request;
    const res = mockRes();
    const next = vi.fn();
    mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when the token does not match", () => {
    const req = { headers: { authorization: "Bearer wrong" } } as Request;
    const res = mockRes();
    const next = vi.fn();
    mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/api/src/middleware/botAuth.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `packages/api/src/middleware/botAuth.ts`** (constant-time compare to avoid token-timing leaks)

```ts
import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Guards bot-only endpoints by comparing the Bearer token to `expected`. */
export function requireBotToken(expected: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization ?? "";
    const prefix = "Bearer ";
    if (!header.startsWith(prefix) || !safeEqual(header.slice(prefix.length), expected)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/api/src/middleware/botAuth.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/middleware/botAuth.ts packages/api/src/middleware/botAuth.test.ts
git commit -m "feat(api): add bot-token auth middleware"
```

---

## Task 7: Error handler + 404, then the Express app factory + health check

**Files:**
- Create: `packages/api/src/middleware/errorHandler.ts`
- Test: `packages/api/src/middleware/errorHandler.test.ts`
- Create: `packages/api/src/app.ts`
- Test: `packages/api/src/app.test.ts`
- Create: `packages/api/src/server.ts`

- [ ] **Step 1: Write the failing test for the error handler + 404**

`packages/api/src/middleware/errorHandler.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { notFoundHandler, errorHandler } from "./errorHandler.js";

function appWithThrow() {
  const app = express();
  app.get("/boom", () => {
    throw new Error("kaboom");
  });
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

describe("errorHandler", () => {
  it("returns 404 JSON for unknown routes", async () => {
    const res = await request(appWithThrow()).get("/nope");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
  });

  it("returns 500 JSON when a handler throws", async () => {
    const res = await request(appWithThrow()).get("/boom");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "internal_error" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/api/src/middleware/errorHandler.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `packages/api/src/middleware/errorHandler.ts`**

```ts
import type { Request, Response, NextFunction } from "express";

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: "not_found" });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  console.error("[api] unhandled error:", err);
  res.status(500).json({ error: "internal_error" });
}
```

- [ ] **Step 4: Run the error-handler test to verify it passes**

Run: `npx vitest run packages/api/src/middleware/errorHandler.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Write the failing test for the app factory + health check**

`packages/api/src/app.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "./app.js";

describe("createApp", () => {
  it("GET /healthz returns 200 ok", async () => {
    const app = createApp();
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("unknown route returns 404 json", async () => {
    const app = createApp();
    const res = await request(app).get("/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
  });
});
```

- [ ] **Step 6: Run the app test to verify it fails**

Run: `npx vitest run packages/api/src/app.test.ts`
Expected: FAIL — `Cannot find module './app.js'`.

- [ ] **Step 7: Implement `packages/api/src/app.ts`**

```ts
import express, { type Express } from "express";
import { notFoundHandler, errorHandler } from "./middleware/errorHandler.js";

/** Builds the Express app without binding a port (so tests can use supertest). */
export function createApp(): Express {
  const app = express();
  app.use(express.json());

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Domain routers are mounted here in Plan 2.

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
```

- [ ] **Step 8: Run the app test to verify it passes**

Run: `npx vitest run packages/api/src/app.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 9: Implement `packages/api/src/server.ts`** (binds the port; not unit-tested)

```ts
import { buildConfig } from "./config.js";
import { createApp } from "./app.js";

const config = buildConfig();
const app = createApp();

app.listen(config.port, () => {
  console.log(`[api] listening on :${config.port}`);
});
```

- [ ] **Step 10: Run the full test suite**

Run: `npm test`
Expected: all suites pass (shared: 8 tests, api: 7 tests).

- [ ] **Step 11: Commit**

```bash
git add packages/api/src
git commit -m "feat(api): add error/404 handlers, app factory, health check, server entrypoint"
```

---

## Task 8: Dockerfile for `api` + compose wiring + boot smoke test

**Files:**
- Create: `packages/api/Dockerfile`
- Create: `packages/api/.dockerignore`
- Modify: `docker-compose.yml`

- [ ] **Step 1: Create `packages/api/.dockerignore`**

```dockerignore
node_modules
dist
**/*.test.ts
```

- [ ] **Step 2: Create `packages/api/Dockerfile`** (multi-stage; builds shared + api from the workspace root context)

```dockerfile
# Build stage
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/api/package.json packages/api/
RUN npm ci
COPY packages/shared packages/shared
COPY packages/api packages/api
RUN npx prisma generate --schema packages/api/prisma/schema.prisma
RUN npm run build -w @debates/shared && npm run build -w @debates/api

# Runtime stage
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/api/package.json packages/api/
RUN npm ci --omit=dev
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/api/dist packages/api/dist
COPY --from=build /app/packages/api/prisma packages/api/prisma
COPY --from=build /app/node_modules/.prisma node_modules/.prisma
EXPOSE 3000
CMD ["sh", "-c", "npm run prisma:migrate -w @debates/api && npm run start -w @debates/api"]
```

> **Note:** the `Dockerfile`'s build `context` is the repo root (set in compose below), so `COPY package.json ...` resolves from there.

- [ ] **Step 3: Add the `api` service to `docker-compose.yml`**

Insert under `services:` (above `volumes:`):

```yaml
  api:
    build:
      context: .
      dockerfile: packages/api/Dockerfile
    depends_on: [postgres, redis]
    environment:
      DATABASE_URL: postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}
      REDIS_URL: redis://redis:6379
      RECORDINGS_DIR: /var/lib/debates/recordings
    env_file: .env
    volumes:
      - recordings:/var/lib/debates/recordings
    ports: ["127.0.0.1:3000:3000"]
    restart: unless-stopped
```

And add `recordings:` to the `volumes:` block:

```yaml
volumes:
  pgdata:
  redisdata:
  recordings:
```

> The explicit `environment:` block overrides `.env`'s `localhost` `DATABASE_URL`/`REDIS_URL` with the in-network `postgres`/`redis` hostnames. Local host tooling keeps using `localhost` from `.env`.

- [ ] **Step 4: Build and boot the full stack**

Run: `docker compose up -d --build`
Expected: `postgres`, `redis`, `api` all running; the api container runs `prisma migrate deploy` on start then listens.

Run: `docker compose logs api | tail -n 20`
Expected: shows migrations applied and `[api] listening on :3000`.

- [ ] **Step 5: Smoke-test the health endpoint through the container**

Run: `curl -s http://127.0.0.1:3000/healthz`
Expected: `{"status":"ok"}`

- [ ] **Step 6: Tear down**

Run: `docker compose down`
Expected: containers stop and are removed; named volumes persist.

- [ ] **Step 7: Commit**

```bash
git add packages/api/Dockerfile packages/api/.dockerignore docker-compose.yml
git commit -m "feat(api): add Dockerfile and compose wiring; api boots and migrates"
```

---

## Self-review against the spec

- **Spec §2 (five processes):** Plan 1 delivers `api`, `postgres`, `redis`. The `discord-bot` and `telegram-bot` services are Plans 3–4. ✓ (scoped)
- **Spec §3 (six tables):** all present in `schema.prisma` (Task 4). The §3 design-note **partial unique index** (`one_active_recording_per_guild`) is implemented in Task 4 Step 9. ✓
- **Spec §7 (API surface):** Plan 1 ships only `/healthz` (infra) + the auth primitives (`requireBotToken`). The domain endpoints are Plan 2 — `app.ts` has the documented mount point. ✓ (scoped, no gap)
- **Spec §8 (bot↔API tokens):** `DISCORD_BOT_API_TOKEN` / `TELEGRAM_BOT_API_TOKEN` validated in env (Task 2), surfaced in config (Task 5), enforced by `requireBotToken` (Task 6). The Telegram-Login admin JWT auth is Plan 2 (no admin endpoints exist yet). ✓ (scoped)
- **Spec §9 (deployment/env):** `.env.example`, `docker-compose.yml`, multi-stage `Dockerfile`, `recordings` volume all present. nginx + host bootstrap are Plan 6. ✓ (scoped)
- **High-severity spec fixes:** the partial unique index (#5) lands here as the DB guarantee; the past-offset guard, reconciliation, and cron reapers (#1–#4) are scheduler/cron logic delivered in **Plan 2** — flagged here so they aren't lost.
- **Placeholder scan:** every code/step has concrete content; no TBD/TODO. ✓
- **Type consistency:** `loadEnv`/`Env` (Task 2) → `buildConfig`/`Config` (Task 5); `requireBotToken` signature consistent across Task 6 and its future use; DTO names (`CreateRecordingSessionBody`, `RegisterRecordingFileBody`, `IssueLinkBody`, `RedeemLinkBody`) defined once in Task 3 for Plan 2 to import. ✓

---

**End of Plan 1.** Plans 2–6 follow the same structure. Plan 2 (API domain) is the natural next write: it consumes `shared`'s DTOs + `JOB_OFFSETS_MS`/`jobIdFor`, mounts routers on `app.ts`'s documented seam, and implements the scheduler guards (#1–#4) on top of the schema and index built here.
