# Web Admin (React SPA) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `packages/admin` React + Vite + TypeScript SPA that implements every web-admin page in spec §6 (login, games list/new/detail, recordings list/detail, users), talking to the Plan 2 API over `fetch` with `credentials: 'include'`, authenticating via the Telegram Login Widget, and building into `packages/api/public/admin/` so Express serves it at `/admin/*`.

**Architecture:** A single Vite SPA mounted at base path `/admin/`. A typed `src/api.ts` client wraps `fetch` (always `credentials: 'include'`), throws a typed `ApiError` on non-2xx, and exposes one function per Plan 2 endpoint. An auth guard component calls `GET /api/admin/me` and redirects to `/admin/login` on 401. A pure, unit-tested `src/notificationTimeline.ts` derives the six planned notification timestamps from a game's `scheduledAt`, mirroring the API's past-offset guard (spec §4) by flagging each as past/future. React Router drives navigation; TailwindCSS (spec §13) styles minimal components. The build's `outDir` is `../api/public/admin`, and a small **Plan 2 addendum** (defined here) adds the Express static mount + SPA fallback that serves it.

**Tech Stack:** Vite 5, React 18, React Router 6, TypeScript (ESM), TailwindCSS 3, Vitest + @testing-library/react + jsdom (component tests with `fetch` mocked), plain `fetch`.

**Depends on:**
- **Plan 1** (Foundation) — monorepo conventions: npm workspaces, `@debates/*` package names, ESM, root `vitest.workspace.ts` that discovers `packages/*/vitest.config.ts`, the root `.gitignore`.
- **Plan 2** (API domain) — the exact admin endpoints and JSON shapes this SPA consumes: `POST /api/admin/auth/telegram` (sets the httpOnly `debates_session` cookie), `POST /api/admin/auth/logout`, `GET /api/admin/me`, games CRUD (`GET/POST /api/games`, `GET/PATCH /api/games/:id`, `POST /api/games/:id/cancel`), `GET /api/users` + `POST /api/users/:id/unlink-discord`, recordings `GET /api/recordings/sessions`, `GET /api/recordings/sessions/:id`, `GET /api/recordings/sessions/:id/files/:discord_user_id.opus`, `GET /api/recordings/sessions/:id/zip`.

**This is Plan 5 of 6.** Plan 6 (Deployment) wires nginx to proxy `/` → `api:3000`; the static SPA served from `packages/api/public/admin/` (produced by this plan's build) is what nginx ultimately fronts.

> **Critical type note (read before coding the API client):** Plan 2's games endpoints return **raw Prisma objects in camelCase** — a game is `{ id, scheduledAt, motion, status, createdById, cancelledAt, createdAt, updatedAt, participants: [{ gameId, userId }] }`. The **request bodies** for create/update use **snake_case** (`scheduled_at`, `participant_user_ids`). The recordings **list** endpoint returns a hand-mapped snake_case shape `{ id, started_at, ended_at, voice_channel_name, status, speaker_count, identified_count }`, while the recordings **detail** endpoint returns the raw Prisma session in camelCase with `files: [{ sessionId, discordUserId, userId, discordUsername, filePath, durationSec, sizeBytes, user }]`. The users list returns snake_case `{ id, telegram_username, display_name, linked, created_at }`. `GET /api/admin/me` returns `{ id, display_name, telegram_username }`. The `src/api.ts` types below mirror these **exactly** — do not "normalise" them.

---

## File structure introduced by this plan

```
packages/admin/
├── package.json
├── tsconfig.json
├── tsconfig.node.json              # for vite.config / tailwind config typechecking
├── vite.config.ts                  # base '/admin/', build.outDir '../api/public/admin', dev proxy /api
├── vitest.config.ts                # jsdom env, setup file
├── tailwind.config.ts
├── postcss.config.js
├── index.html                      # Vite entry; loads /admin/src/main.tsx
├── src/
│   ├── main.tsx                    # ReactDOM root + RouterProvider
│   ├── index.css                   # tailwind directives
│   ├── test/
│   │   └── setup.ts                # @testing-library/jest-dom + fetch reset
│   ├── notificationTimeline.ts     # PURE: derive 6 timestamps + past flag
│   ├── notificationTimeline.test.ts
│   ├── api.ts                      # typed fetch client (credentials: 'include')
│   ├── api.test.ts                 # error-handling unit tests (fetch mocked)
│   ├── auth/
│   │   ├── useMe.ts                # loads /api/admin/me; {status, user}
│   │   └── RequireAdmin.tsx        # guard: redirect to /admin/login on 401
│   ├── components/
│   │   ├── Layout.tsx              # nav shell + logout
│   │   ├── TelegramLoginButton.tsx # injects telegram.org widget <script>
│   │   ├── Spinner.tsx
│   │   └── ErrorBanner.tsx
│   ├── pages/
│   │   ├── LoginPage.tsx
│   │   ├── GamesListPage.tsx
│   │   ├── GamesListPage.test.tsx
│   │   ├── NewGamePage.tsx
│   │   ├── GameDetailPage.tsx
│   │   ├── RecordingsListPage.tsx
│   │   ├── RecordingDetailPage.tsx
│   │   ├── RecordingDetailPage.test.tsx
│   │   └── UsersPage.tsx
│   └── router.tsx                  # route table
```

Plus a **Plan 2 addendum** to `packages/api/src/app.ts` (static mount + SPA fallback) defined in Task 9.

---

## Task 1: Package scaffold, Vite/Tailwind/Vitest config, entry HTML

**Files:**
- Create: `packages/admin/package.json`
- Create: `packages/admin/tsconfig.json`
- Create: `packages/admin/tsconfig.node.json`
- Create: `packages/admin/vite.config.ts`
- Create: `packages/admin/vitest.config.ts`
- Create: `packages/admin/tailwind.config.ts`
- Create: `packages/admin/postcss.config.js`
- Create: `packages/admin/index.html`
- Create: `packages/admin/src/index.css`
- Create: `packages/admin/src/test/setup.ts`

- [ ] **Step 1: Create `packages/admin/package.json`**

```json
{
  "name": "@debates/admin",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.26.0"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.5.0",
    "@testing-library/react": "^16.0.0",
    "@testing-library/user-event": "^14.5.2",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.1",
    "autoprefixer": "^10.4.20",
    "jsdom": "^25.0.0",
    "postcss": "^8.4.47",
    "tailwindcss": "^3.4.10",
    "typescript": "^5.6.0",
    "vite": "^5.4.0",
    "vitest": "^2.1.0"
  }
}
```

> **Why no `@debates/shared` dependency:** the admin runs in the browser. `@debates/shared` pulls in a Node-oriented Zod env loader; the only thing the SPA needs from it conceptually is the notification offsets, which we re-declare as plain constants in `notificationTimeline.ts` (Task 3). Keeping the SPA free of `@debates/shared` avoids bundling server code.

- [ ] **Step 2: Create `packages/admin/tsconfig.json`** (browser/DOM libs; does **not** extend the Node-oriented base from Plan 1 because the admin targets the DOM, not `NodeNext` module resolution)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "types": ["vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["src", "vite.config.ts", "vitest.config.ts"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

- [ ] **Step 3: Create `packages/admin/tsconfig.node.json`**

```json
{
  "compilerOptions": {
    "composite": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "skipLibCheck": true
  },
  "include": ["vite.config.ts", "tailwind.config.ts"]
}
```

- [ ] **Step 4: Create `packages/admin/vite.config.ts`** (base path, build output into the API package, dev proxy for `/api`)

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The SPA is served by Express under /admin/* in production (spec §6, §9),
// and built into the API package so a single image serves API + admin.
export default defineConfig({
  plugins: [react()],
  base: "/admin/",
  build: {
    outDir: "../api/public/admin",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      // In `vite dev`, forward API calls to the local API (Plan 1/2) so the
      // SPA can run against a real backend without CORS.
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
```

- [ ] **Step 5: Create `packages/admin/vitest.config.ts`** (jsdom + setup file; name `admin` so the root workspace lists it)

```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    name: "admin",
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
```

- [ ] **Step 6: Create `packages/admin/tailwind.config.ts`**

```ts
import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: { extend: {} },
  plugins: [],
} satisfies Config;
```

- [ ] **Step 7: Create `packages/admin/postcss.config.js`**

```js
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
```

- [ ] **Step 8: Create `packages/admin/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Debates Admin</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 9: Create `packages/admin/src/index.css`**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

- [ ] **Step 10: Create `packages/admin/src/test/setup.ts`**

```ts
import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
```

- [ ] **Step 11: Install deps and verify the toolchain resolves**

Run: `npm install` (from repo root — links `@debates/admin` into the workspace)
Expected: completes without error; `packages/admin/node_modules` symlinks resolve.

Run: `npx vitest run --root packages/admin`
Expected: runs and reports "no test files found" (no tests yet) — confirms the jsdom config loads.

- [ ] **Step 12: Commit**

```bash
git add packages/admin/package.json packages/admin/tsconfig.json packages/admin/tsconfig.node.json packages/admin/vite.config.ts packages/admin/vitest.config.ts packages/admin/tailwind.config.ts packages/admin/postcss.config.js packages/admin/index.html packages/admin/src/index.css packages/admin/src/test/setup.ts package-lock.json
git commit -m "chore(admin): scaffold Vite + React + Tailwind + Vitest"
```

---

## Task 2: Notification timeline helper (PURE, TDD) — mirrors the API past-offset guard

**Files:**
- Test: `packages/admin/src/notificationTimeline.test.ts`
- Create: `packages/admin/src/notificationTimeline.ts`

This is the unit-testable core for the `/admin/games/:id` timeline (spec §6). It computes the six planned notification timestamps from `scheduledAt` and flags each as past/future, mirroring the API's past-offset guard (spec §4: jobs whose fire time is already ≤ now are dropped, so past offsets are greyed out in the UI).

- [ ] **Step 1: Write the failing test**

`packages/admin/src/notificationTimeline.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildNotificationTimeline, NOTIFICATION_OFFSETS } from "./notificationTimeline.js";

const scheduledAt = new Date("2026-06-10T19:00:00Z");

describe("NOTIFICATION_OFFSETS", () => {
  it("lists the six offsets in firing order (-7d .. -10m)", () => {
    expect(NOTIFICATION_OFFSETS.map((o) => o.type)).toEqual([
      "notify_week_before",
      "notify_day_before",
      "notify_hour_before",
      "nudge_unlinked_40m",
      "announce_t30",
      "notify_t10",
    ]);
  });
});

describe("buildNotificationTimeline", () => {
  it("computes fireAt = scheduledAt - offset for every entry", () => {
    const now = new Date("2026-06-01T00:00:00Z"); // 9 days before, all future
    const tl = buildNotificationTimeline(scheduledAt, now);
    expect(tl).toHaveLength(6);
    const week = tl.find((e) => e.type === "notify_week_before")!;
    expect(week.fireAt.toISOString()).toBe("2026-06-03T19:00:00.000Z");
    const t10 = tl.find((e) => e.type === "notify_t10")!;
    expect(t10.fireAt.toISOString()).toBe("2026-06-10T18:50:00.000Z");
  });

  it("flags entries whose fireAt is <= now as past (greyed out in the UI)", () => {
    const now = new Date("2026-06-08T19:00:00Z"); // 2 days out
    const tl = buildNotificationTimeline(scheduledAt, now);
    const week = tl.find((e) => e.type === "notify_week_before")!;
    expect(week.isPast).toBe(true); // -7d already fired -> mirrors API drop
    const day = tl.find((e) => e.type === "notify_day_before")!;
    expect(day.isPast).toBe(false);
  });

  it("treats an entry firing exactly now as past (delay <= 0, matches API guard)", () => {
    const now = new Date("2026-06-10T18:00:00Z"); // exactly -1h
    const tl = buildNotificationTimeline(scheduledAt, now);
    const hour = tl.find((e) => e.type === "notify_hour_before")!;
    expect(hour.fireAt.getTime()).toBe(now.getTime());
    expect(hour.isPast).toBe(true);
  });

  it("marks every entry past once the game is over", () => {
    const now = new Date("2026-06-11T00:00:00Z");
    const tl = buildNotificationTimeline(scheduledAt, now);
    expect(tl.every((e) => e.isPast)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/admin/src/notificationTimeline.test.ts`
Expected: FAIL — `Cannot find module './notificationTimeline.js'`.

- [ ] **Step 3: Implement `packages/admin/src/notificationTimeline.ts`**

```ts
/**
 * Planned-notification offsets, mirroring the server's JOB_OFFSETS_MS
 * (@debates/shared, consumed by the API scheduler in Plan 2). Re-declared here
 * as plain browser-safe constants so the SPA does not import server code.
 *
 * Each offset is the number of milliseconds BEFORE scheduled_at at which the
 * job fires. Ordered earliest-firing first.
 */
export interface NotificationOffset {
  type:
    | "notify_week_before"
    | "notify_day_before"
    | "notify_hour_before"
    | "nudge_unlinked_40m"
    | "announce_t30"
    | "notify_t10";
  /** Human label for the timeline UI. */
  label: string;
  /** Milliseconds before scheduled_at. */
  offsetMs: number;
}

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const NOTIFICATION_OFFSETS: readonly NotificationOffset[] = [
  { type: "notify_week_before", label: "Week before", offsetMs: 7 * DAY },
  { type: "notify_day_before", label: "Day before", offsetMs: 1 * DAY },
  { type: "notify_hour_before", label: "1 hour before (link codes)", offsetMs: 1 * HOUR },
  { type: "nudge_unlinked_40m", label: "40 min — nudge unlinked", offsetMs: 40 * MIN },
  { type: "announce_t30", label: "30 min — Discord announce", offsetMs: 30 * MIN },
  { type: "notify_t10", label: "10 min — be in voice", offsetMs: 10 * MIN },
];

export interface TimelineEntry extends NotificationOffset {
  /** Absolute instant this notification is planned to fire. */
  fireAt: Date;
  /**
   * True when fireAt <= now. Mirrors the API past-offset guard (spec §4):
   * the API drops any job whose delay is non-positive, so the UI greys these.
   */
  isPast: boolean;
}

/** Derives the six planned notification timestamps from a game's scheduled_at. */
export function buildNotificationTimeline(scheduledAt: Date, now: Date = new Date()): TimelineEntry[] {
  return NOTIFICATION_OFFSETS.map((o) => {
    const fireAt = new Date(scheduledAt.getTime() - o.offsetMs);
    return { ...o, fireAt, isPast: fireAt.getTime() <= now.getTime() };
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/admin/src/notificationTimeline.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/admin/src/notificationTimeline.ts packages/admin/src/notificationTimeline.test.ts
git commit -m "feat(admin): pure notification-timeline helper mirroring API past-offset guard"
```

---

## Task 3: Typed API client (TDD on error handling)

**Files:**
- Test: `packages/admin/src/api.test.ts`
- Create: `packages/admin/src/api.ts`

The client wraps `fetch` with `credentials: 'include'` (so the httpOnly `debates_session` cookie set by `POST /api/admin/auth/telegram` is sent on every request), throws a typed `ApiError` carrying the HTTP status on non-2xx, and exposes one typed function per Plan 2 endpoint. The error-handling core is unit-tested with `fetch` mocked; the per-endpoint wrappers are thin and exercised by the page component tests (Tasks 6, 8) and manual smoke tests.

- [ ] **Step 1: Write the failing test for the request core**

`packages/admin/src/api.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ApiError, getMe, listGames, request } from "./api.js";

function mockFetch(status: number, body: unknown, ok = status >= 200 && status < 300) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response);
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("request", () => {
  it("sends credentials: 'include' and returns parsed JSON on 2xx", async () => {
    const f = mockFetch(200, { status: "ok" });
    vi.stubGlobal("fetch", f);
    const data = await request<{ status: string }>("/api/healthz");
    expect(data).toEqual({ status: "ok" });
    expect(f).toHaveBeenCalledWith(
      "/api/healthz",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("throws ApiError with the status on non-2xx", async () => {
    vi.stubGlobal("fetch", mockFetch(403, { error: "not_admin" }));
    await expect(request("/api/games")).rejects.toMatchObject({
      name: "ApiError",
      status: 403,
      code: "not_admin",
    });
  });

  it("throws ApiError(status=401) which callers use to redirect to login", async () => {
    vi.stubGlobal("fetch", mockFetch(401, { error: "unauthorized" }));
    const err = await request("/api/admin/me").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
  });

  it("sets JSON content-type and serializes the body for POST", async () => {
    const f = mockFetch(201, { id: "g1" });
    vi.stubGlobal("fetch", f);
    await request("/api/games", { method: "POST", body: { motion: "x" } });
    const [, init] = f.mock.calls[0]!;
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "Content-Type": "application/json" });
    expect(init.body).toBe(JSON.stringify({ motion: "x" }));
  });
});

describe("typed wrappers", () => {
  it("getMe returns the admin profile shape", async () => {
    vi.stubGlobal("fetch", mockFetch(200, { id: "u1", display_name: "Ada", telegram_username: "ada" }));
    const me = await getMe();
    expect(me).toEqual({ id: "u1", display_name: "Ada", telegram_username: "ada" });
  });

  it("listGames forwards status/from/to as query params", async () => {
    const f = mockFetch(200, []);
    vi.stubGlobal("fetch", f);
    await listGames({ status: "scheduled", from: "2026-06-01", to: "2026-06-30" });
    const [url] = f.mock.calls[0]!;
    expect(url).toBe("/api/games?status=scheduled&from=2026-06-01&to=2026-06-30");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/admin/src/api.test.ts`
Expected: FAIL — `Cannot find module './api.js'`.

- [ ] **Step 3: Implement `packages/admin/src/api.ts`**

```ts
// ---- Error type ---------------------------------------------------------

export class ApiError extends Error {
  readonly status: number;
  /** The `error` string from the API JSON body, when present. */
  readonly code: string | undefined;
  constructor(status: number, code: string | undefined, message?: string) {
    super(message ?? `API error ${status}${code ? `: ${code}` : ""}`);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

// ---- Request core -------------------------------------------------------

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
}

/**
 * Wraps fetch. ALWAYS sends `credentials: 'include'` so the httpOnly
 * `debates_session` cookie (set by POST /api/admin/auth/telegram) is attached.
 * Throws ApiError on any non-2xx; the 401 case is what the auth guard catches.
 */
export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const init: RequestInit = {
    method: opts.method ?? "GET",
    credentials: "include",
  };
  if (opts.body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, init);
  if (!res.ok) {
    let code: string | undefined;
    try {
      const data = (await res.json()) as { error?: string };
      code = data?.error;
    } catch {
      code = undefined;
    }
    throw new ApiError(res.status, code);
  }
  // 204 has no body; callers that expect void pass T = void.
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function qs(params: Record<string, string | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== "") as [string, string][];
  if (entries.length === 0) return "";
  return "?" + entries.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
}

// ---- Response/request types (mirror Plan 2 EXACTLY) ---------------------

export interface AdminMe {
  id: string;
  display_name: string;
  telegram_username: string | null;
}

/** Telegram Login Widget payload (string map) POSTed to /api/admin/auth/telegram. */
export type TelegramAuthPayload = Record<string, string>;

export interface GameParticipant {
  gameId: string;
  userId: string;
}

/** Raw Prisma game (camelCase) as returned by Plan 2 games endpoints. */
export interface Game {
  id: string;
  scheduledAt: string;
  motion: string | null;
  status: "scheduled" | "cancelled";
  createdById: string;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
  participants: GameParticipant[];
}

export interface CreateGameBody {
  scheduled_at: string; // ISO 8601
  motion?: string | null;
  participant_user_ids: string[];
}

export interface UpdateGameBody {
  scheduled_at?: string;
  motion?: string | null;
  participant_user_ids?: string[];
}

/** Users list row (snake_case) from GET /api/users. */
export interface UserRow {
  id: string;
  telegram_username: string | null;
  display_name: string;
  linked: boolean;
  created_at: string;
}

/** Recordings LIST row (snake_case, hand-mapped in Plan 2). */
export interface RecordingListRow {
  id: string;
  started_at: string;
  ended_at: string | null;
  voice_channel_name: string;
  status: "recording" | "completed" | "failed";
  speaker_count: number;
  identified_count: number;
}

/** A linked user nested under a recording file (raw Prisma, camelCase). */
export interface RecordingFileUser {
  id: string;
  displayName: string;
  telegramUsername: string | null;
}

/** Recording file row from the DETAIL endpoint (raw Prisma, camelCase). */
export interface RecordingFile {
  sessionId: string;
  discordUserId: string;
  userId: string | null;
  discordUsername: string;
  filePath: string;
  durationSec: number;
  sizeBytes: string; // BigInt serialized as string
  user: RecordingFileUser | null;
}

/** Recording session DETAIL (raw Prisma session + files, camelCase). */
export interface RecordingDetail {
  id: string;
  startedAt: string;
  endedAt: string | null;
  startedByDiscordUserId: string;
  voiceChannelId: string;
  voiceChannelName: string;
  guildId: string;
  fileDir: string;
  status: "recording" | "completed" | "failed";
  files: RecordingFile[];
}

// ---- Endpoint wrappers --------------------------------------------------

export function getMe(): Promise<AdminMe> {
  return request<AdminMe>("/api/admin/me");
}

export function loginWithTelegram(payload: TelegramAuthPayload): Promise<{ id: string; display_name: string }> {
  return request("/api/admin/auth/telegram", { method: "POST", body: payload });
}

export function logout(): Promise<{ ok: true }> {
  return request("/api/admin/auth/logout", { method: "POST" });
}

export function listGames(filter: { status?: string; from?: string; to?: string } = {}): Promise<Game[]> {
  return request<Game[]>(`/api/games${qs(filter)}`);
}

export function getGame(id: string): Promise<Game> {
  return request<Game>(`/api/games/${id}`);
}

export function createGame(body: CreateGameBody): Promise<Game> {
  return request<Game>("/api/games", { method: "POST", body });
}

export function updateGame(id: string, body: UpdateGameBody): Promise<Game> {
  return request<Game>(`/api/games/${id}`, { method: "PATCH", body });
}

export function cancelGame(id: string): Promise<Game> {
  return request<Game>(`/api/games/${id}/cancel`, { method: "POST" });
}

export function listUsers(): Promise<UserRow[]> {
  return request<UserRow[]>("/api/users");
}

export function unlinkDiscord(id: string): Promise<{ id: string; linked: boolean }> {
  return request(`/api/users/${id}/unlink-discord`, { method: "POST" });
}

export function listRecordings(): Promise<RecordingListRow[]> {
  return request<RecordingListRow[]>("/api/recordings/sessions");
}

export function getRecording(id: string): Promise<RecordingDetail> {
  return request<RecordingDetail>(`/api/recordings/sessions/${id}`);
}

/** Direct browser download URLs (anchor href targets; cookie auth applies). */
export function recordingFileUrl(sessionId: string, discordUserId: string): string {
  return `/api/recordings/sessions/${sessionId}/files/${discordUserId}.opus`;
}

export function recordingZipUrl(sessionId: string): string {
  return `/api/recordings/sessions/${sessionId}/zip`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run packages/admin/src/api.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/admin/src/api.ts packages/admin/src/api.test.ts
git commit -m "feat(admin): typed API client with credentials:'include' and ApiError on non-2xx"
```

---

## Task 4: Auth guard, shared UI components, app entry + router

**Files:**
- Create: `packages/admin/src/auth/useMe.ts`
- Create: `packages/admin/src/auth/RequireAdmin.tsx`
- Create: `packages/admin/src/components/Spinner.tsx`
- Create: `packages/admin/src/components/ErrorBanner.tsx`
- Create: `packages/admin/src/components/Layout.tsx`
- Create: `packages/admin/src/router.tsx`
- Create: `packages/admin/src/main.tsx`

- [ ] **Step 1: Create `packages/admin/src/auth/useMe.ts`**

```ts
import { useEffect, useState } from "react";
import { ApiError, getMe, type AdminMe } from "../api.js";

export type MeState =
  | { status: "loading" }
  | { status: "authed"; user: AdminMe }
  | { status: "anon" }
  | { status: "error"; message: string };

/** Loads GET /api/admin/me once. 401 -> "anon" (caller redirects to login). */
export function useMe(): MeState {
  const [state, setState] = useState<MeState>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    getMe()
      .then((user) => {
        if (!cancelled) setState({ status: "authed", user });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          setState({ status: "anon" });
        } else {
          setState({ status: "error", message: err instanceof Error ? err.message : "Failed to load session" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}
```

- [ ] **Step 2: Create `packages/admin/src/components/Spinner.tsx`**

```tsx
export function Spinner() {
  return (
    <div className="flex items-center justify-center p-8 text-gray-500" role="status">
      Loading…
    </div>
  );
}
```

- [ ] **Step 3: Create `packages/admin/src/components/ErrorBanner.tsx`**

```tsx
export function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800" role="alert">
      {message}
    </div>
  );
}
```

- [ ] **Step 4: Create `packages/admin/src/auth/RequireAdmin.tsx`** (redirects to `/admin/login` on `anon`)

```tsx
import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useMe } from "./useMe.js";
import { Spinner } from "../components/Spinner.js";
import { ErrorBanner } from "../components/ErrorBanner.js";

/** Wraps protected routes. Renders children only when GET /api/admin/me is 200. */
export function RequireAdmin({ children }: { children: ReactNode }) {
  const me = useMe();
  if (me.status === "loading") return <Spinner />;
  if (me.status === "anon") return <Navigate to="/login" replace />;
  if (me.status === "error") return <ErrorBanner message={me.message} />;
  return <>{children}</>;
}
```

> Routes are declared **relative to the router `basename`** (`/admin`, set in Task 1/Step 4 base + the router below), so `<Navigate to="/login">` resolves to `/admin/login` in the browser.

- [ ] **Step 5: Create `packages/admin/src/components/Layout.tsx`** (nav shell + logout)

```tsx
import type { ReactNode } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { logout } from "../api.js";

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `px-3 py-2 rounded text-sm ${isActive ? "bg-gray-900 text-white" : "text-gray-700 hover:bg-gray-100"}`;

export function Layout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  async function onLogout() {
    try {
      await logout();
    } finally {
      navigate("/login", { replace: true });
    }
  }
  return (
    <div className="min-h-screen bg-gray-50">
      <header className="border-b bg-white">
        <nav className="mx-auto flex max-w-5xl items-center gap-2 px-4 py-3">
          <span className="mr-4 font-semibold">Debates Admin</span>
          <NavLink to="/games" className={linkClass}>Games</NavLink>
          <NavLink to="/recordings" className={linkClass}>Recordings</NavLink>
          <NavLink to="/users" className={linkClass}>Users</NavLink>
          <button onClick={onLogout} className="ml-auto text-sm text-gray-500 hover:text-gray-900">
            Log out
          </button>
        </nav>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6">{children}</main>
    </div>
  );
}
```

- [ ] **Step 6: Create `packages/admin/src/router.tsx`** (route table; pages stubbed until later tasks — import them now and create placeholder pages so the build is green)

```tsx
import { createBrowserRouter, Navigate } from "react-router-dom";
import { RequireAdmin } from "./auth/RequireAdmin.js";
import { Layout } from "./components/Layout.js";
import { LoginPage } from "./pages/LoginPage.js";
import { GamesListPage } from "./pages/GamesListPage.js";
import { NewGamePage } from "./pages/NewGamePage.js";
import { GameDetailPage } from "./pages/GameDetailPage.js";
import { RecordingsListPage } from "./pages/RecordingsListPage.js";
import { RecordingDetailPage } from "./pages/RecordingDetailPage.js";
import { UsersPage } from "./pages/UsersPage.js";

function Protected({ children }: { children: React.ReactNode }) {
  return (
    <RequireAdmin>
      <Layout>{children}</Layout>
    </RequireAdmin>
  );
}

export const router = createBrowserRouter(
  [
    { path: "/", element: <Navigate to="/games" replace /> },
    { path: "/login", element: <LoginPage /> },
    { path: "/games", element: <Protected><GamesListPage /></Protected> },
    { path: "/games/new", element: <Protected><NewGamePage /></Protected> },
    { path: "/games/:id", element: <Protected><GameDetailPage /></Protected> },
    { path: "/recordings", element: <Protected><RecordingsListPage /></Protected> },
    { path: "/recordings/:id", element: <Protected><RecordingDetailPage /></Protected> },
    { path: "/users", element: <Protected><UsersPage /></Protected> },
  ],
  { basename: "/admin" },
);
```

- [ ] **Step 7: Create `packages/admin/src/main.tsx`**

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { router } from "./router.js";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
```

- [ ] **Step 8: Create placeholder page modules so the router/build resolves**

Create each of the following as a minimal named export; real implementations land in Tasks 5–8. This keeps `tsc -b` + `vite build` green between tasks.

`packages/admin/src/pages/LoginPage.tsx`:

```tsx
export function LoginPage() {
  return <div>Login</div>;
}
```

`packages/admin/src/pages/GamesListPage.tsx`:

```tsx
export function GamesListPage() {
  return <div>Games</div>;
}
```

`packages/admin/src/pages/NewGamePage.tsx`:

```tsx
export function NewGamePage() {
  return <div>New game</div>;
}
```

`packages/admin/src/pages/GameDetailPage.tsx`:

```tsx
export function GameDetailPage() {
  return <div>Game detail</div>;
}
```

`packages/admin/src/pages/RecordingsListPage.tsx`:

```tsx
export function RecordingsListPage() {
  return <div>Recordings</div>;
}
```

`packages/admin/src/pages/RecordingDetailPage.tsx`:

```tsx
export function RecordingDetailPage() {
  return <div>Recording detail</div>;
}
```

`packages/admin/src/pages/UsersPage.tsx`:

```tsx
export function UsersPage() {
  return <div>Users</div>;
}
```

- [ ] **Step 9: Typecheck and build to confirm the shell compiles**

Run: `npm run typecheck -w @debates/admin`
Expected: no errors.

Run: `npm run build -w @debates/admin`
Expected: succeeds; `packages/api/public/admin/index.html` and `packages/api/public/admin/assets/*` exist.

- [ ] **Step 10: Commit**

```bash
git add packages/admin/src/auth packages/admin/src/components packages/admin/src/router.tsx packages/admin/src/main.tsx packages/admin/src/pages
git commit -m "feat(admin): auth guard, layout, router, app entry, page stubs"
```

---

## Task 5: Login page — Telegram Login Widget (spec §8)

**Files:**
- Create: `packages/admin/src/components/TelegramLoginButton.tsx`
- Modify: `packages/admin/src/pages/LoginPage.tsx`

The Telegram Login Widget is a `<script>` from `telegram.org` configured for the bot username (`TELEGRAM_BOT_USERNAME`, e.g. `tooronkaich_bot`). The widget renders a "Log in with Telegram" button and, on success, calls a global JS callback with the signed user payload. We POST that payload to `POST /api/admin/auth/telegram` (Plan 2), which verifies the HMAC, checks the `ADMIN_TELEGRAM_IDS` allowlist, and sets the httpOnly `debates_session` cookie; on success we redirect to `/admin/games`.

> **Widget integration approach.** Two modes exist: `data-auth-url` (widget redirects the browser to a backend URL with the payload as query params) and `data-onauth` (widget calls a JS callback). We use the **callback** mode so the SPA can POST the payload with `credentials:'include'` and then client-route to `/games` — this keeps everything inside the SPA and avoids a separate server redirect endpoint. The bot username comes from the build-time env `VITE_TELEGRAM_BOT_USERNAME` (mapped from `TELEGRAM_BOT_USERNAME` at build; documented in Task 9). The widget requires the site's domain to be registered with `@BotFather` via `/setdomain` (operational note for Plan 6).

- [ ] **Step 1: Create `packages/admin/src/components/TelegramLoginButton.tsx`**

```tsx
import { useEffect, useRef } from "react";
import type { TelegramAuthPayload } from "../api.js";

declare global {
  interface Window {
    onTelegramAuth?: (user: TelegramAuthPayload) => void;
  }
}

export interface TelegramLoginButtonProps {
  botUsername: string;
  onAuth: (payload: TelegramAuthPayload) => void;
}

/**
 * Embeds the official Telegram Login Widget script. On success the widget calls
 * the global `onTelegramAuth(user)` callback with the HMAC-signed payload, which
 * we forward to `onAuth` for POSTing to /api/admin/auth/telegram.
 */
export function TelegramLoginButton({ botUsername, onAuth }: TelegramLoginButtonProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.onTelegramAuth = (user) => onAuth(user);

    const script = document.createElement("script");
    script.src = "https://telegram.org/js/telegram-widget.js?22";
    script.async = true;
    script.setAttribute("data-telegram-login", botUsername);
    script.setAttribute("data-size", "large");
    script.setAttribute("data-userpic", "false");
    script.setAttribute("data-request-access", "write");
    script.setAttribute("data-onauth", "onTelegramAuth(user)");

    const container = containerRef.current;
    container?.appendChild(script);

    return () => {
      if (container) container.innerHTML = "";
      delete window.onTelegramAuth;
    };
  }, [botUsername, onAuth]);

  return <div ref={containerRef} data-testid="telegram-login-widget" />;
}
```

- [ ] **Step 2: Implement `packages/admin/src/pages/LoginPage.tsx`**

```tsx
import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, loginWithTelegram, type TelegramAuthPayload } from "../api.js";
import { TelegramLoginButton } from "../components/TelegramLoginButton.js";
import { ErrorBanner } from "../components/ErrorBanner.js";

const BOT_USERNAME = import.meta.env.VITE_TELEGRAM_BOT_USERNAME ?? "";

export function LoginPage() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  const onAuth = useCallback(
    async (payload: TelegramAuthPayload) => {
      setError(null);
      try {
        await loginWithTelegram(payload);
        navigate("/games", { replace: true });
      } catch (err) {
        if (err instanceof ApiError && err.status === 403) {
          setError("This Telegram account is not on the admin allowlist.");
        } else if (err instanceof ApiError && err.status === 401) {
          setError("Telegram login could not be verified. Please try again.");
        } else {
          setError(err instanceof Error ? err.message : "Login failed.");
        }
      }
    },
    [navigate],
  );

  return (
    <div className="mx-auto mt-24 max-w-sm space-y-6 text-center">
      <h1 className="text-2xl font-semibold">Debates Admin</h1>
      <p className="text-sm text-gray-600">Sign in with the Telegram account on the admin allowlist.</p>
      {error && <ErrorBanner message={error} />}
      {BOT_USERNAME ? (
        <div className="flex justify-center">
          <TelegramLoginButton botUsername={BOT_USERNAME} onAuth={onAuth} />
        </div>
      ) : (
        <ErrorBanner message="VITE_TELEGRAM_BOT_USERNAME is not configured for this build." />
      )}
    </div>
  );
}
```

- [ ] **Step 3: Add the Vite env type so `import.meta.env.VITE_TELEGRAM_BOT_USERNAME` typechecks**

Create `packages/admin/src/vite-env.d.ts`:

```ts
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TELEGRAM_BOT_USERNAME?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck -w @debates/admin`
Expected: no errors.

- [ ] **Step 5: Manual smoke test (deferred to full-stack run; record expected behavior)**

> Requires the API running (Plan 1/2) with `TELEGRAM_BOT_TOKEN`, `ADMIN_TELEGRAM_IDS`, and the SPA built/served at `/admin` (Task 9), plus `@BotFather /setdomain` pointing at the dev/prod host. The widget will not render against a bare `localhost` without a registered domain.

Click-path:
1. Visit `/admin/login`.
2. Expected: the blue "Log in with Telegram" widget button renders.
3. Click it, authorize in the Telegram popup.
4. Expected: browser POSTs the payload to `/api/admin/auth/telegram`, the `debates_session` cookie is set, and the SPA redirects to `/admin/games`.
5. Negative: a non-allowlisted Telegram account → red banner "This Telegram account is not on the admin allowlist." and no redirect.

- [ ] **Step 6: Commit**

```bash
git add packages/admin/src/components/TelegramLoginButton.tsx packages/admin/src/pages/LoginPage.tsx packages/admin/src/vite-env.d.ts
git commit -m "feat(admin): login page with Telegram Login Widget"
```

---

## Task 6: Games list + New game + Game detail pages

**Files:**
- Modify: `packages/admin/src/pages/GamesListPage.tsx`
- Test: `packages/admin/src/pages/GamesListPage.test.tsx`
- Modify: `packages/admin/src/pages/NewGamePage.tsx`
- Modify: `packages/admin/src/pages/GameDetailPage.tsx`

- [ ] **Step 1: Write the failing component test for the games list (fetch mocked)**

`packages/admin/src/pages/GamesListPage.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { GamesListPage } from "./GamesListPage.js";
import type { Game } from "../api.js";

const games: Game[] = [
  {
    id: "g1",
    scheduledAt: "2026-06-10T19:00:00.000Z",
    motion: "THW ban X",
    status: "scheduled",
    createdById: "u1",
    cancelledAt: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    participants: [{ gameId: "g1", userId: "u1" }, { gameId: "g1", userId: "u2" }],
  },
];

beforeEach(() => {
  vi.restoreAllMocks();
});

function mockFetchOnce(body: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: status < 400, status, json: () => Promise.resolve(body) } as Response),
  );
}

describe("GamesListPage", () => {
  it("renders a row per game with motion and participant count", async () => {
    mockFetchOnce(games);
    render(
      <MemoryRouter>
        <GamesListPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText("THW ban X")).toBeInTheDocument();
    expect(screen.getByText(/2 participants/i)).toBeInTheDocument();
    // "+ New game" entry point is present
    expect(screen.getByRole("link", { name: /new game/i })).toBeInTheDocument();
  });

  it("shows an empty state when there are no games", async () => {
    mockFetchOnce([]);
    render(
      <MemoryRouter>
        <GamesListPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/no games/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/admin/src/pages/GamesListPage.test.tsx`
Expected: FAIL — the stub page renders only "Games".

- [ ] **Step 3: Implement `packages/admin/src/pages/GamesListPage.tsx`**

```tsx
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listGames, type Game } from "../api.js";
import { Spinner } from "../components/Spinner.js";
import { ErrorBanner } from "../components/ErrorBanner.js";

type Status = "" | "scheduled" | "cancelled";

export function GamesListPage() {
  const [games, setGames] = useState<Game[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  useEffect(() => {
    let cancelled = false;
    setGames(null);
    setError(null);
    listGames({ status: status || undefined, from: from || undefined, to: to || undefined })
      .then((g) => !cancelled && setGames(g))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : "Failed to load games"));
    return () => {
      cancelled = true;
    };
  }, [status, from, to]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Games</h1>
        <Link to="/games/new" className="rounded bg-gray-900 px-3 py-2 text-sm text-white">
          + New game
        </Link>
      </div>

      <div className="flex flex-wrap gap-3 text-sm">
        <label className="flex items-center gap-1">
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value as Status)} className="rounded border px-2 py-1">
            <option value="">All</option>
            <option value="scheduled">Scheduled</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </label>
        <label className="flex items-center gap-1">
          From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="rounded border px-2 py-1" />
        </label>
        <label className="flex items-center gap-1">
          To
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="rounded border px-2 py-1" />
        </label>
      </div>

      {error && <ErrorBanner message={error} />}
      {!error && games === null && <Spinner />}
      {games !== null && games.length === 0 && <p className="text-gray-500">No games.</p>}
      {games !== null && games.length > 0 && (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b text-gray-500">
              <th className="py-2">When</th>
              <th>Motion</th>
              <th>Status</th>
              <th>Participants</th>
            </tr>
          </thead>
          <tbody>
            {games.map((g) => (
              <tr key={g.id} className="border-b hover:bg-gray-50">
                <td className="py-2">
                  <Link to={`/games/${g.id}`} className="text-blue-700 hover:underline">
                    {new Date(g.scheduledAt).toLocaleString()}
                  </Link>
                </td>
                <td>{g.motion ?? <span className="text-gray-400">—</span>}</td>
                <td>{g.status}</td>
                <td>{g.participants.length} participants</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run to verify the list test passes**

Run: `npx vitest run packages/admin/src/pages/GamesListPage.test.tsx`
Expected: PASS — 2 tests.

- [ ] **Step 5: Implement `packages/admin/src/pages/NewGamePage.tsx`** (tz-aware datetime, optional motion, multi-select participant picker)

```tsx
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { createGame, listUsers, type UserRow } from "../api.js";
import { Spinner } from "../components/Spinner.js";
import { ErrorBanner } from "../components/ErrorBanner.js";

/** Converts a <input type="datetime-local"> value (local wall time) to ISO 8601 UTC. */
function localInputToIso(local: string): string {
  // `local` is "YYYY-MM-DDTHH:mm" interpreted in the browser's timezone.
  return new Date(local).toISOString();
}

export function NewGamePage() {
  const navigate = useNavigate();
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [when, setWhen] = useState("");
  const [motion, setMotion] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listUsers()
      .then((u) => !cancelled && setUsers(u))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : "Failed to load users"));
    return () => {
      cancelled = true;
    };
  }, []);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!when) {
      setError("Pick a date and time.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const game = await createGame({
        scheduled_at: localInputToIso(when),
        motion: motion.trim() || null,
        participant_user_ids: [...selected],
      });
      navigate(`/games/${game.id}`, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create game");
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="max-w-lg space-y-4">
      <h1 className="text-xl font-semibold">New game</h1>
      {error && <ErrorBanner message={error} />}

      <label className="block text-sm">
        Date &amp; time ({Intl.DateTimeFormat().resolvedOptions().timeZone})
        <input
          type="datetime-local"
          value={when}
          onChange={(e) => setWhen(e.target.value)}
          required
          className="mt-1 block w-full rounded border px-2 py-1"
        />
      </label>

      <label className="block text-sm">
        Motion (optional)
        <textarea
          value={motion}
          onChange={(e) => setMotion(e.target.value)}
          rows={2}
          className="mt-1 block w-full rounded border px-2 py-1"
        />
      </label>

      <fieldset className="space-y-1">
        <legend className="text-sm font-medium">Participants</legend>
        {users === null ? (
          <Spinner />
        ) : users.length === 0 ? (
          <p className="text-sm text-gray-500">No registered users yet.</p>
        ) : (
          <div className="max-h-64 space-y-1 overflow-auto rounded border p-2">
            {users.map((u) => (
              <label key={u.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={selected.has(u.id)} onChange={() => toggle(u.id)} />
                {u.display_name}
                {u.telegram_username && <span className="text-gray-400">@{u.telegram_username}</span>}
                {!u.linked && <span className="text-amber-600">(not linked)</span>}
              </label>
            ))}
          </div>
        )}
      </fieldset>

      <button
        type="submit"
        disabled={submitting}
        className="rounded bg-gray-900 px-4 py-2 text-sm text-white disabled:opacity-50"
      >
        {submitting ? "Creating…" : "Create game"}
      </button>
    </form>
  );
}
```

- [ ] **Step 6: Implement `packages/admin/src/pages/GameDetailPage.tsx`** (summary + edit + cancel + derived timeline)

```tsx
import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { getGame, updateGame, cancelGame, listUsers, type Game, type UserRow } from "../api.js";
import { buildNotificationTimeline } from "../notificationTimeline.js";
import { Spinner } from "../components/Spinner.js";
import { ErrorBanner } from "../components/ErrorBanner.js";

function isoToLocalInput(iso: string): string {
  // Build a "YYYY-MM-DDTHH:mm" string in the browser's local timezone.
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function GameDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [game, setGame] = useState<Game | null>(null);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [when, setWhen] = useState("");
  const [motion, setMotion] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    Promise.all([getGame(id), listUsers()])
      .then(([g, u]) => {
        if (cancelled) return;
        setGame(g);
        setUsers(u);
        setWhen(isoToLocalInput(g.scheduledAt));
        setMotion(g.motion ?? "");
        setSelected(new Set(g.participants.map((p) => p.userId)));
      })
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : "Failed to load game"));
    return () => {
      cancelled = true;
    };
  }, [id]);

  const timeline = useMemo(
    () => (game ? buildNotificationTimeline(new Date(game.scheduledAt)) : []),
    [game],
  );

  if (error) return <ErrorBanner message={error} />;
  if (!game) return <Spinner />;

  function toggle(uid: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  }

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    if (!id) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await updateGame(id, {
        scheduled_at: new Date(when).toISOString(),
        motion: motion.trim() || null,
        participant_user_ids: [...selected],
      });
      setGame(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update game");
    } finally {
      setBusy(false);
    }
  }

  async function onCancel() {
    if (!id || !window.confirm("Cancel this game? Future notifications will be removed.")) return;
    setBusy(true);
    try {
      setGame(await cancelGame(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to cancel game");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Game</h1>
        <span className={`rounded px-2 py-1 text-xs ${game.status === "cancelled" ? "bg-red-100 text-red-700" : "bg-green-100 text-green-700"}`}>
          {game.status}
        </span>
      </div>

      <form onSubmit={onSave} className="max-w-lg space-y-4">
        <label className="block text-sm">
          Date &amp; time ({Intl.DateTimeFormat().resolvedOptions().timeZone})
          <input
            type="datetime-local"
            value={when}
            onChange={(e) => setWhen(e.target.value)}
            disabled={game.status === "cancelled"}
            className="mt-1 block w-full rounded border px-2 py-1"
          />
        </label>
        <label className="block text-sm">
          Motion
          <textarea
            value={motion}
            onChange={(e) => setMotion(e.target.value)}
            rows={2}
            disabled={game.status === "cancelled"}
            className="mt-1 block w-full rounded border px-2 py-1"
          />
        </label>
        <fieldset className="space-y-1">
          <legend className="text-sm font-medium">Participants</legend>
          <div className="max-h-64 space-y-1 overflow-auto rounded border p-2">
            {users.map((u) => (
              <label key={u.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selected.has(u.id)}
                  onChange={() => toggle(u.id)}
                  disabled={game.status === "cancelled"}
                />
                {u.display_name}
                {!u.linked && <span className="text-amber-600">(not linked)</span>}
              </label>
            ))}
          </div>
        </fieldset>
        {game.status !== "cancelled" && (
          <div className="flex gap-2">
            <button type="submit" disabled={busy} className="rounded bg-gray-900 px-4 py-2 text-sm text-white disabled:opacity-50">
              Save changes
            </button>
            <button type="button" onClick={onCancel} disabled={busy} className="rounded border border-red-300 px-4 py-2 text-sm text-red-700 disabled:opacity-50">
              Cancel game
            </button>
          </div>
        )}
      </form>

      <section className="max-w-lg space-y-2">
        <h2 className="text-sm font-medium">Planned notifications</h2>
        <ul className="text-sm">
          {timeline.map((e) => (
            <li key={e.type} className={`flex justify-between border-b py-1 ${e.isPast ? "text-gray-400" : "text-gray-800"}`}>
              <span>{e.label}</span>
              <span>
                {e.fireAt.toLocaleString()} {e.isPast && "(past)"}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
```

- [ ] **Step 7: Run the games-list test + typecheck**

Run: `npx vitest run packages/admin/src/pages/GamesListPage.test.tsx && npm run typecheck -w @debates/admin`
Expected: tests PASS; no type errors.

- [ ] **Step 8: Commit**

```bash
git add packages/admin/src/pages/GamesListPage.tsx packages/admin/src/pages/GamesListPage.test.tsx packages/admin/src/pages/NewGamePage.tsx packages/admin/src/pages/GameDetailPage.tsx
git commit -m "feat(admin): games list, new-game form, and game detail with derived timeline"
```

---

## Task 7: Recordings list + Recording detail pages

**Files:**
- Modify: `packages/admin/src/pages/RecordingsListPage.tsx`
- Modify: `packages/admin/src/pages/RecordingDetailPage.tsx`
- Test: `packages/admin/src/pages/RecordingDetailPage.test.tsx`

- [ ] **Step 1: Implement `packages/admin/src/pages/RecordingsListPage.tsx`** (spec §6 columns: started_at, channel, duration, #speakers, identified count, status)

```tsx
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listRecordings, type RecordingListRow } from "../api.js";
import { Spinner } from "../components/Spinner.js";
import { ErrorBanner } from "../components/ErrorBanner.js";

/** Formats seconds between started/ended as H:MM:SS; "—" when still recording. */
function durationLabel(startedAt: string, endedAt: string | null): string {
  if (!endedAt) return "—";
  const sec = Math.max(0, Math.round((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${h}:${pad(m)}:${pad(s)}`;
}

export function RecordingsListPage() {
  const [rows, setRows] = useState<RecordingListRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listRecordings()
      .then((r) => !cancelled && setRows(r))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : "Failed to load recordings"));
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <ErrorBanner message={error} />;
  if (rows === null) return <Spinner />;

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Recordings</h1>
      {rows.length === 0 ? (
        <p className="text-gray-500">No recordings.</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b text-gray-500">
              <th className="py-2">Started</th>
              <th>Channel</th>
              <th>Duration</th>
              <th>Speakers</th>
              <th>Identified</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b hover:bg-gray-50">
                <td className="py-2">
                  <Link to={`/recordings/${r.id}`} className="text-blue-700 hover:underline">
                    {new Date(r.started_at).toLocaleString()}
                  </Link>
                </td>
                <td>{r.voice_channel_name}</td>
                <td>{durationLabel(r.started_at, r.ended_at)}</td>
                <td>{r.speaker_count}</td>
                <td>{r.identified_count}</td>
                <td>{r.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Write the failing component test for the recording detail (download buttons + zip; fetch mocked)**

`packages/admin/src/pages/RecordingDetailPage.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { RecordingDetailPage } from "./RecordingDetailPage.js";
import type { RecordingDetail } from "../api.js";

const detail: RecordingDetail = {
  id: "s1",
  startedAt: "2026-06-03T19:00:00.000Z",
  endedAt: "2026-06-03T19:30:00.000Z",
  startedByDiscordUserId: "111",
  voiceChannelId: "v1",
  voiceChannelName: "Main",
  guildId: "g1",
  fileDir: "/rec/s1",
  status: "completed",
  files: [
    {
      sessionId: "s1",
      discordUserId: "998877665544332211",
      userId: "u1",
      discordUsername: "alice",
      filePath: "alice_2211.opus",
      durationSec: 412,
      sizeBytes: "10240",
      user: { id: "u1", displayName: "Alice K.", telegramUsername: "alicek" },
    },
    {
      sessionId: "s1",
      discordUserId: "777",
      userId: null,
      discordUsername: "bob",
      filePath: "bob_0777.opus",
      durationSec: 88,
      sizeBytes: "2048",
      user: null,
    },
  ],
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("RecordingDetailPage", () => {
  it("renders a row per speaker with a download link and a Download-all-zip link", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(detail) } as Response),
    );
    render(
      <MemoryRouter initialEntries={["/recordings/s1"]}>
        <Routes>
          <Route path="/recordings/:id" element={<RecordingDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );

    // identified speaker shows display name; unlinked shows discord username
    expect(await screen.findByText("Alice K.")).toBeInTheDocument();
    expect(screen.getByText(/bob/)).toBeInTheDocument();

    // per-speaker download anchors point at the .opus endpoint
    const aliceDl = screen.getByRole("link", { name: /download alice/i });
    expect(aliceDl).toHaveAttribute(
      "href",
      "/api/recordings/sessions/s1/files/998877665544332211.opus",
    );

    // zip + metadata links
    expect(screen.getByRole("link", { name: /download all/i })).toHaveAttribute(
      "href",
      "/api/recordings/sessions/s1/zip",
    );
    expect(screen.getByRole("link", { name: /metadata/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run packages/admin/src/pages/RecordingDetailPage.test.tsx`
Expected: FAIL — the stub renders only "Recording detail".

- [ ] **Step 4: Implement `packages/admin/src/pages/RecordingDetailPage.tsx`** (per-speaker rows, download buttons, zip, metadata JSON link; no in-browser playback)

```tsx
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { getRecording, recordingFileUrl, recordingZipUrl, type RecordingDetail } from "../api.js";
import { Spinner } from "../components/Spinner.js";
import { ErrorBanner } from "../components/ErrorBanner.js";

function durationLabel(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function RecordingDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [rec, setRec] = useState<RecordingDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    getRecording(id)
      .then((r) => !cancelled && setRec(r))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : "Failed to load recording"));
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) return <ErrorBanner message={error} />;
  if (!rec) return <Spinner />;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold">Recording — {rec.voiceChannelName}</h1>
        <p className="text-sm text-gray-500">
          {new Date(rec.startedAt).toLocaleString()} · status {rec.status}
        </p>
      </div>

      <div className="flex gap-3 text-sm">
        <a href={recordingZipUrl(rec.id)} className="rounded bg-gray-900 px-3 py-2 text-white">
          Download all as .zip
        </a>
        {/* _metadata.json is bundled at fileDir root and downloadable via the zip;
            we also expose a direct link by reusing the file endpoint convention. */}
        <a
          href={`/api/recordings/sessions/${rec.id}/files/_metadata.json`}
          className="rounded border px-3 py-2 text-gray-700"
        >
          Metadata JSON
        </a>
      </div>

      {rec.files.length === 0 ? (
        <p className="text-gray-500">No speaker files captured.</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b text-gray-500">
              <th className="py-2">Speaker</th>
              <th>Discord</th>
              <th>Duration</th>
              <th>Download</th>
            </tr>
          </thead>
          <tbody>
            {rec.files.map((f) => {
              const name = f.user?.displayName ?? f.discordUsername;
              return (
                <tr key={f.discordUserId} className="border-b hover:bg-gray-50">
                  <td className="py-2">
                    {name}
                    {!f.userId && <span className="ml-1 text-amber-600">(unlinked)</span>}
                  </td>
                  <td className="text-gray-500">{f.discordUsername}</td>
                  <td>{durationLabel(f.durationSec)}</td>
                  <td>
                    <a
                      href={recordingFileUrl(rec.id, f.discordUserId)}
                      className="text-blue-700 hover:underline"
                      aria-label={`Download ${f.discordUsername}`}
                    >
                      {f.filePath}
                    </a>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
```

> **Metadata link note:** Plan 2 serves single files via `GET /api/recordings/sessions/:id/files/:discord_user_id.opus`, which streams `path.basename(file_path)` from `fileDir`. The `_metadata.json` is reliably included in the **zip**. If a dedicated metadata route is desired, that is a one-line Plan 2 addition (`GET /api/recordings/sessions/:id/metadata`); for Phase 1 the zip is the guaranteed path and the standalone link above is best-effort. **Keep the "Download all as .zip" button as the primary, always-correct path.**

- [ ] **Step 5: Run to verify the detail test passes**

Run: `npx vitest run packages/admin/src/pages/RecordingDetailPage.test.tsx`
Expected: PASS — 1 test.

- [ ] **Step 6: Commit**

```bash
git add packages/admin/src/pages/RecordingsListPage.tsx packages/admin/src/pages/RecordingDetailPage.tsx packages/admin/src/pages/RecordingDetailPage.test.tsx
git commit -m "feat(admin): recordings list and per-speaker detail with download/zip"
```

---

## Task 8: Users page (list + force unlink)

**Files:**
- Modify: `packages/admin/src/pages/UsersPage.tsx`

- [ ] **Step 1: Implement `packages/admin/src/pages/UsersPage.tsx`** (TG handle, linked status, registered_at, Force unlink)

```tsx
import { useEffect, useState } from "react";
import { listUsers, unlinkDiscord, type UserRow } from "../api.js";
import { Spinner } from "../components/Spinner.js";
import { ErrorBanner } from "../components/ErrorBanner.js";

export function UsersPage() {
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listUsers()
      .then((u) => !cancelled && setUsers(u))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : "Failed to load users"));
    return () => {
      cancelled = true;
    };
  }, []);

  async function onUnlink(id: string) {
    if (!window.confirm("Force unlink this user's Discord account?")) return;
    setBusyId(id);
    setError(null);
    try {
      await unlinkDiscord(id);
      setUsers((prev) => (prev ? prev.map((u) => (u.id === id ? { ...u, linked: false } : u)) : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to unlink");
    } finally {
      setBusyId(null);
    }
  }

  if (error) return <ErrorBanner message={error} />;
  if (users === null) return <Spinner />;

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Users</h1>
      {users.length === 0 ? (
        <p className="text-gray-500">No registered users.</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b text-gray-500">
              <th className="py-2">Name</th>
              <th>Telegram</th>
              <th>Linked</th>
              <th>Registered</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-b hover:bg-gray-50">
                <td className="py-2">{u.display_name}</td>
                <td className="text-gray-500">{u.telegram_username ? `@${u.telegram_username}` : "—"}</td>
                <td>{u.linked ? "linked" : <span className="text-amber-600">not linked</span>}</td>
                <td className="text-gray-500">{new Date(u.created_at).toLocaleDateString()}</td>
                <td>
                  {u.linked && (
                    <button
                      onClick={() => onUnlink(u.id)}
                      disabled={busyId === u.id}
                      className="rounded border border-red-300 px-2 py-1 text-xs text-red-700 disabled:opacity-50"
                    >
                      {busyId === u.id ? "…" : "Force unlink"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + run the full admin suite**

Run: `npm run typecheck -w @debates/admin && npx vitest run --root packages/admin`
Expected: no type errors; all admin tests pass (notificationTimeline 5, api 6, GamesListPage 2, RecordingDetailPage 1).

- [ ] **Step 3: Commit**

```bash
git add packages/admin/src/pages/UsersPage.tsx
git commit -m "feat(admin): users list with force-unlink"
```

---

## Task 9: Plan 2 addendum — Express static mount + SPA fallback; build wiring

**Files:**
- Modify: `packages/api/src/app.ts` (Plan 2 addendum)
- Modify: `packages/api/package.json` (build copies/serves the SPA; ensure `public/` ships)
- Modify: root `package.json` (build order so admin builds before api Docker image, optional)
- Modify: `.env.example` (document `VITE_TELEGRAM_BOT_USERNAME` for the admin build)

> **Why this lives here:** the spec (§6, §9) requires Express to serve the built SPA at `/admin/*` with a client-side-routing fallback to `index.html`. Plan 2 builds the API but does **not** add a static mount. This task is the **exact** addendum. If Plan 6 has already added an equivalent mount, reconcile to a single mount and skip the duplicate.

- [ ] **Step 1: Add the static mount + SPA fallback to `packages/api/src/app.ts`**

Plan 2's `createApp()` (after Task 8) ends with the routers, then `notFoundHandler`, then `errorHandler`. Insert the admin static serving **after all `/api/*` routers and before `notFoundHandler`**, so API 404s still return JSON while unknown non-API paths fall back to the SPA.

Add imports at the top of `app.ts`:

```ts
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express"; // already imported in Plan 1; keep a single import
```

> `express` is already imported in Plan 1's `app.ts` as `import express, { type Express } from "express";` — do **not** add a second import; reuse the existing one. `path`/`fileURLToPath` are the only new imports.

Insert this block immediately before `app.use(notFoundHandler);`:

```ts
  // ---- Plan 5 addendum: serve the built admin SPA at /admin/* ----
  // Vite builds packages/admin into packages/api/public/admin (base '/admin/').
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  // dist/app.js -> ../public/admin ; src/app.ts (vitest) -> ../public/admin
  const adminDir = path.resolve(__dirname, "../public/admin");

  app.use("/admin", express.static(adminDir));

  // SPA fallback: any GET under /admin that isn't a real file returns index.html
  // so client-side routes (e.g. /admin/games/:id) load on hard refresh.
  app.get("/admin/*", (_req, res) => {
    res.sendFile(path.join(adminDir, "index.html"));
  });
```

> **Path correctness:** at runtime the compiled file is `packages/api/dist/app.js`, so `../public/admin` resolves to `packages/api/public/admin` (the Vite `outDir`). Under vitest the source is `packages/api/src/app.ts`, so `../public/admin` also resolves to `packages/api/public/admin`. Both are correct because `dist/` and `src/` are siblings under `packages/api/`.

- [ ] **Step 2: Ensure the Docker image ships `public/admin`**

In Plan 1's `packages/api/Dockerfile`, the runtime stage copies `dist` and `prisma` but **not** `public`. Add a copy line in the runtime stage (after the existing `COPY --from=build /app/packages/api/dist ...`):

```dockerfile
COPY --from=build /app/packages/api/public packages/api/public
```

And in the **build stage**, build the admin SPA so `public/admin` exists before the runtime copy. After the existing `RUN npm run build -w @debates/shared && npm run build -w @debates/api`, append the admin build (it writes into `packages/api/public/admin`):

```dockerfile
# Build the admin SPA into packages/api/public/admin (Vite base '/admin/').
ARG VITE_TELEGRAM_BOT_USERNAME
ENV VITE_TELEGRAM_BOT_USERNAME=${VITE_TELEGRAM_BOT_USERNAME}
RUN npm run build -w @debates/admin
```

> The Dockerfile build context is the repo root (Plan 1 Task 8), so `packages/admin` is present. `npm ci` in the build stage already installs all workspaces including `@debates/admin`. Add `COPY packages/admin packages/admin` alongside the existing `COPY packages/shared ...` / `COPY packages/api ...` lines, and add `COPY packages/admin/package.json packages/admin/` next to the other per-package package.json copies so the `npm ci` layer sees it.

- [ ] **Step 3: Pass the bot username to the Docker build (compose)**

In `docker-compose.yml`, the `api` service `build:` block gains an arg so the admin build embeds the widget bot username:

```yaml
  api:
    build:
      context: .
      dockerfile: packages/api/Dockerfile
      args:
        VITE_TELEGRAM_BOT_USERNAME: ${TELEGRAM_BOT_USERNAME}
```

- [ ] **Step 4: Document the admin build env in `.env.example`**

Append under the Telegram section of `.env.example` (the value is read at admin **build** time, embedded into the bundle — it is not a runtime secret):

```bash
# Web admin (Vite build-time): bot username for the Telegram Login Widget.
# Mirrors TELEGRAM_BOT_USERNAME; consumed as VITE_TELEGRAM_BOT_USERNAME by the admin build.
# (docker-compose passes TELEGRAM_BOT_USERNAME through as the build arg.)
```

- [ ] **Step 5: Add a root convenience script to build the admin before the API (local, non-Docker)**

In root `package.json` `scripts`, add:

```json
"build:admin": "npm run build -w @debates/admin",
"build:api": "npm run build -w @debates/api"
```

> For local end-to-end testing without Docker: `npm run build:admin` then start the API (`npm run dev -w @debates/api`) and hit `http://localhost:3000/admin/`. In Docker the Dockerfile (Steps 2–3) does this in one image build.

- [ ] **Step 6: Verify the static mount serves the SPA (local smoke test)**

Run: `npm run build -w @debates/admin`
Expected: `packages/api/public/admin/index.html` exists.

Run (with Plan 1/2 API runnable and `.env` present): `npm run dev -w @debates/api` then `curl -s http://localhost:3000/admin/ | head -n 5`
Expected: HTML containing `<div id="root">` (the SPA shell), not a JSON 404.

Run: `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/does-not-exist`
Expected: `404` with JSON body (API 404s are unaffected by the SPA fallback because the fallback only matches `/admin/*`).

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/app.ts packages/api/Dockerfile packages/api/package.json docker-compose.yml .env.example package.json
git commit -m "feat(api): serve built admin SPA at /admin/* with SPA fallback (Plan 5 addendum)"
```

---

## Self-review against the spec

### §6 web-admin pages → tasks

| Spec §6 path | Page | Task |
|---|---|---|
| `/admin/login` | Telegram Login Widget → `POST /api/admin/auth/telegram` → redirect `/admin/games` | Task 5 |
| `/admin/games` | list, filter by status + date range, "+ New game" | Task 6 (list) |
| `/admin/games/new` | tz-aware datetime, optional motion, multi-select participants from `GET /api/users`, `POST /api/games` | Task 6 (NewGamePage) |
| `/admin/games/:id` | detail + edit (reschedule/motion/participants) + cancel + **derived notification timeline with past entries greyed** | Task 6 (GameDetailPage) + Task 2 (timeline helper) |
| `/admin/recordings` | list: started_at, channel, duration, #speakers, identified count, status | Task 7 (list) |
| `/admin/recordings/:id` | per-speaker download buttons, "Download all as .zip", metadata JSON, **no in-browser playback** | Task 7 (detail) |
| `/admin/users` | TG handle, linked status, registered_at, "Force unlink" → `POST /api/users/:id/unlink-discord` | Task 8 |

### §7 endpoints consumed → api.ts wrappers (Task 3)

`getMe` (`GET /api/admin/me`), `loginWithTelegram` (`POST /api/admin/auth/telegram`), `logout` (`POST /api/admin/auth/logout`), `listGames`/`getGame`/`createGame`/`updateGame`/`cancelGame` (`/api/games*`), `listUsers`/`unlinkDiscord` (`/api/users*`), `listRecordings`/`getRecording` (`/api/recordings/sessions*`), `recordingFileUrl`/`recordingZipUrl` (download anchors for `…/files/:discord_user_id.opus` and `…/zip`). Every §7 **admin** row is covered; bot-only rows (`/api/recordings/sessions` POST, `/api/link/*`) are intentionally not in the SPA.

### §8 login → tasks

Telegram Login Widget embedded (Task 5), payload POSTed to `/api/admin/auth/telegram` with `credentials:'include'` so the httpOnly `debates_session` cookie set by the API is stored and replayed; `RequireAdmin` (Task 4) gates all protected routes via `GET /api/admin/me`, redirecting to `/admin/login` on 401 — matching the cookie/JWT session from Plan 2 Task 7. 403 (not on `ADMIN_TELEGRAM_IDS`) surfaces a distinct allowlist message.

### Type-consistency check (against Plan 2's actual JSON)

- **Recordings list** (`RecordingListRow`): `id`, `started_at`, `ended_at`, `voice_channel_name`, `status`, `speaker_count`, `identified_count` — **exact match** to Plan 2 Task 6 Step 4's hand-mapped object. ✓
- **Recordings detail** (`RecordingDetail`/`RecordingFile`): raw Prisma camelCase (`startedAt`, `voiceChannelName`, `files[].discordUserId`, `files[].filePath`, `files[].durationSec`, `files[].sizeBytes` as string for BigInt, nested `user`) — matches Plan 2 Task 6 Step 4's `findUnique(... include: { files: { include: { user } } })`. ✓
- **Games** (`Game`): raw Prisma camelCase (`scheduledAt`, `participants:[{gameId,userId}]`) for responses; **snake_case** `CreateGameBody`/`UpdateGameBody` (`scheduled_at`, `participant_user_ids`) for requests — matches Plan 2 Task 4's `CreateBody`/`UpdateBody` Zod schemas and `include: { participants: true }`. ✓
- **Users** (`UserRow`): `id`, `telegram_username`, `display_name`, `linked`, `created_at` — exact match to Plan 2 Task 8 Step 6. ✓
- **Admin me** (`AdminMe`): `id`, `display_name`, `telegram_username` — exact match to Plan 2 Task 7 Step 8's `/me`. ✓
- **Login response**: `{ id, display_name }` — matches Plan 2 `/auth/telegram`. ✓
- **Cookie name** `debates_session` and `credentials:'include'` consistent with Plan 2's `SESSION_COOKIE` (httpOnly, set by the API). ✓

### Notification-timeline parity (mirrors API past-offset guard)

`NOTIFICATION_OFFSETS` reproduces Plan 1's `JOB_OFFSETS_MS` (-7d, -1d, -1h, -40m, -30m, -10m) in firing order; `buildNotificationTimeline` flags `fireAt <= now` as `isPast` — the same boundary the API uses to **drop** non-positive-delay jobs (spec §4, Plan 2 Task 2 `delayMs < 0` skip; entries firing exactly now are treated as past in the UI, a conservative superset of the API's `< 0` drop, which is correct for greying). ✓

### Placeholder scan

Every code block is complete and real: full Vite/Tailwind/Vitest/TS configs, the complete `api.ts` with all wrappers and types, the pure timeline module, all seven pages, the widget component, the guard, layout, router, entry, and the exact `app.ts`/Dockerfile/compose addendum. No `TODO`/`TBD`/`...`-elision in implementation code. ✓

### Plan 2 addenda introduced by this plan

1. **Static SPA serve + fallback** in `packages/api/src/app.ts` (Task 9 Step 1): `app.use("/admin", express.static(adminDir))` + `app.get("/admin/*", … sendFile(index.html))`, inserted before `notFoundHandler` so `/api/*` 404s stay JSON.
2. **Dockerfile**: build `@debates/admin` into `packages/api/public/admin` and `COPY` `public` into the runtime stage; new `VITE_TELEGRAM_BOT_USERNAME` build arg.
3. **docker-compose**: pass `TELEGRAM_BOT_USERNAME` as the `VITE_TELEGRAM_BOT_USERNAME` build arg.
4. **`.env.example`**: documents the build-time `VITE_TELEGRAM_BOT_USERNAME` mirror.
5. **(Optional, noted not added)** a dedicated `GET /api/recordings/sessions/:id/metadata` route — the zip remains the guaranteed metadata path; the standalone metadata link is best-effort.

---

**End of Plan 5.** Plan 6 (Deployment) fronts the API (and its `/admin/*` static SPA from this plan) behind nginx on `debates.animeenigma.com`, and must run `@BotFather /setdomain` for the Telegram Login Widget to render on the production host.
