# Parliamentary Debate Helper — Simplified Design (Phase 1)

**Status:** approved 2026-06-03
**Supersedes:** `docs/plans/2026-01-29-debates-helper-design.md` (the original full design) for the scope below. The earlier doc remains as reference for later phases.
**Scope:** Phase 1 ships a working end-to-end loop for scheduling debates, notifying players, and capturing per-speaker voice recordings to disk for manual download. Whisper transcription is **deferred to Phase 1.1**. AI analysis and feedback delivery are explicitly **not in scope** for phase 1 — the admin downloads `.opus` files and uses any external tool they like.

## 1. Motivation and scope

The original design (`docs/plans/2026-01-29-debates-helper-design.md`) specified a full multi-platform system: Discord bot + Discord Activity (React iframe) + Telegram bot + Web admin + AI pipeline + TrueSkill ratings + multi-language i18n + a full game state machine (`scheduled → setup → preparation → debate → ended`) with timed transitions, voice automation, ready checks, motion voting, and team balancing.

That design is too complicated for the actual phase-1 need. This document defines a simplified system that drops roughly 70% of the original components while preserving the parts the user cares about most: Telegram-based registration and notifications, Discord voice recording, and a small web admin for scheduling.

### What this design keeps

- Telegram bot for registration, scheduling notifications, link-code issuance
- Discord bot for `/link` and per-user voice recording (manual `/record start` / `/record stop`)
- Tiny web admin (React SPA served by API) for game scheduling and recording management
- PostgreSQL + Redis
- Single-VPS deployment via docker-compose

### What this design removes

- Discord Activity (React iframe in Discord) — gone
- Game state machine, stage transitions, ready checks, motion voting, team draft — gone
- WebSocket protocol — gone (no real-time client state)
- TrueSkill ratings — gone
- AI analysis (Claude, GPT) integration — gone (admin uses external tools manually)
- i18n / Russian / Japanese — gone (English only for phase 1)
- Per-team Telegram chats — gone (Telegram bots cannot create groups; not worth fighting)
- Pre-game team assignment in the data model — gone (AI infers team membership from transcripts post-hoc, when AI is added in a later phase)
- Auto-recording on schedule — gone (`/record start` is manual)
- Whisper transcription — **deferred to Phase 1.1**

### Phase 1.1 (separate spec later)

- Add `whisper` container (faster-whisper or whisper.cpp behind HTTP wrapper)
- Auto-run transcription when `/record stop` completes
- Add `transcripts` table + transcript view in web admin (per-speaker + combined chronological)
- "Copy as text" button outputting `[HH:MM:SS] alice: ...` format for paste into external LLM tools

## 2. Architecture and processes

Five containers, single `docker-compose up`, single VPS.

| Process | Stack | Purpose |
|---|---|---|
| **`api`** | Node 20 / TS / Express / Prisma / BullMQ | Sole writer to Postgres. Hosts the web admin (React SPA as static files). Runs the in-process scheduler (BullMQ on Redis) for time-based notification jobs and the daily cleanup cron. Owns HTTP endpoints for admin auth, game CRUD, recording session metadata, link-code redemption. |
| **`telegram-bot`** | Node 20 / TS / grammy | Long-polling Telegram bot. Handles `/start` (register), `/code` (request new link code), `/games` (list upcoming). Consumes the `game-events` BullMQ queue for `notify_*` and `nudge_*` jobs and DMs participants. |
| **`discord-bot`** | Node 20 / TS / discord.js / @discordjs/voice | Discord gateway client. Handles `/link <code>`, `/record start`, `/record stop`. Consumes `game-events` queue for `announce_t30` jobs and posts to the configured announce channel. Writes audio files directly to a shared volume. |
| **`postgres`** | postgres:16-alpine | Database. |
| **`redis`** | redis:7-alpine (AOF on) | BullMQ backing store. |

### Why this shape

- The API is the only writer to Postgres. Bots are dumb actuators that receive commands (via BullMQ or Discord/Telegram events) and report results via HTTP back to the API.
- The scheduler runs in-process in the API. Phase 1 doesn't need a separate worker process — jobs are cheap (send a Telegram DM, post a Discord message).
- Bots are stateless beyond Discord/Telegram session state and are restartable at any time.
- No WebSocket server, no Activity iframe, no real-time client connections.
- Recordings are written to disk directly by the Discord bot via a Docker volume shared with the API container — no multipart file uploads over HTTP.

## 3. Data model

Six tables. Audio files live on disk; rows hold metadata and paths.

```sql
users
├── id                        uuid          PRIMARY KEY
├── telegram_user_id          bigint        UNIQUE NOT NULL
├── telegram_username         text          NULL
├── discord_user_id           text          UNIQUE NULL          -- set after successful /link
├── display_name              text          NOT NULL
├── created_at                timestamptz   NOT NULL
└── updated_at                timestamptz   NOT NULL

link_codes
├── code                      text          PRIMARY KEY            -- e.g. "LINK-7F2X"
├── telegram_user_id          bigint        NOT NULL REFERENCES users(telegram_user_id)
├── expires_at                timestamptz   NOT NULL                -- 24h from issue
└── used_at                   timestamptz   NULL

games
├── id                        uuid          PRIMARY KEY
├── scheduled_at              timestamptz   NOT NULL
├── motion                    text          NULL                    -- admin-entered, optional
├── status                    enum          NOT NULL                -- 'scheduled' | 'cancelled'
├── created_by                uuid          NOT NULL REFERENCES users(id)
├── cancelled_at              timestamptz   NULL
├── created_at                timestamptz   NOT NULL
└── updated_at                timestamptz   NOT NULL

game_participants
├── game_id                   uuid          NOT NULL REFERENCES games(id)
├── user_id                   uuid          NOT NULL REFERENCES users(id)
└── PRIMARY KEY (game_id, user_id)

recording_sessions                           -- independent of games in phase 1
├── id                        uuid          PRIMARY KEY
├── started_at                timestamptz   NOT NULL
├── ended_at                  timestamptz   NULL
├── started_by_discord_user_id text         NOT NULL
├── voice_channel_id          text          NOT NULL
├── voice_channel_name        text          NOT NULL                -- snapshot at start time
├── guild_id                  text          NOT NULL
├── file_dir                  text          NOT NULL                -- /var/lib/debates/recordings/<…>
└── status                    enum          NOT NULL                -- 'recording' | 'completed' | 'failed'

recording_files
├── session_id                uuid          NOT NULL REFERENCES recording_sessions(id)
├── discord_user_id           text          NOT NULL
├── user_id                   uuid          NULL REFERENCES users(id)   -- resolved if linked
├── discord_username          text          NOT NULL                     -- snapshot at record time
├── file_path                 text          NOT NULL                     -- relative to session.file_dir
├── duration_sec              integer       NOT NULL
├── size_bytes                bigint        NOT NULL
├── segments                  jsonb         NOT NULL DEFAULT '[]'        -- per-burst speaking timeline (see §5)
└── PRIMARY KEY (session_id, discord_user_id)
```

### Design notes

- Admin allowlist is in `.env` (`ADMIN_TELEGRAM_IDS=…`) — no DB table for it.
- `games.status` has only two values in phase 1: `scheduled` and `cancelled`. Past games stay `scheduled` (the timestamp tells you they happened); admin can filter by `scheduled_at < now()` in the web admin.
- **Games and recordings are not linked in the database in phase 1.** Admin matches them mentally by timestamp + voice channel. Phase 1.1 may add a `game_id` FK to `recording_sessions` if needed.
- No `teams`, no `motions` master table (motion is a text column on the game), no `invitations` separate from participants (closed roster — admin picks participants directly), no `feedback` table, no `transcripts` table, no `ratings` table.
- **One-active-session-per-guild is enforced in the database**, not just in bot logic: a partial unique index `CREATE UNIQUE INDEX one_active_recording_per_guild ON recording_sessions (guild_id) WHERE status = 'recording';`. `POST /api/recordings/sessions` relies on this — a concurrent second `/record start` in the same guild fails the insert, and the API returns `409 Conflict` which the bot surfaces as *"a recording is already active in this server."* The `reap_stuck_sessions` cron (§4) ensures a crashed session eventually releases the guild.

## 4. Schedule and jobs

One BullMQ queue, `game-events`, on Redis. The API enqueues jobs when a game is created (or rescheduled). The bots consume the job types they each own.

### Jobs enqueued at game creation

| Job | Fires at | Owner | Action |
|---|---|---|---|
| `notify_week_before` | `scheduled_at − 7d` | Telegram bot | DM every participant: *"Debate next week: {motion}. {date} at {time}."* |
| `notify_day_before` | `scheduled_at − 1d` | Telegram bot | Same template, "tomorrow." |
| `notify_hour_before` | `scheduled_at − 1h` | Telegram bot | Same template, "in 1 hour." For each unlinked participant, the worker first calls `POST /api/link/issue` to mint a fresh `link_codes` row (24h expiry) and appends link-code instructions to that participant's DM. Linked participants receive the plain reminder only. |
| `nudge_unlinked_40m` | `scheduled_at − 40m` | Telegram bot | DM **only unlinked** participants. Worker mints a fresh link code per recipient (same `POST /api/link/issue`) and DMs: *"Debate in 40 min — you still haven't linked Discord. Code: LINK-XXXX. In Discord, run `/link LINK-XXXX`."* Previously-issued codes remain valid until their 24h expiry; the user sees the most recent one. |
| `announce_t30` | `scheduled_at − 30m` | Discord bot | Post in `DEBATE_ANNOUNCE_CHANNEL_ID`: *"Debate in 30 min: {motion}. Participants: @alice @bob @carol @dan."* Unlinked participants listed as `<telegram_username> (not linked)`. |
| `notify_t10` | `scheduled_at − 10m` | Telegram bot | DM every participant: *"Starting in 10 min — please be in the voice channel."* |

### Past-offset guard (applies to creation and rescheduling)

Each job is enqueued with a **deterministic BullMQ `jobId` of `game:{id}:{type}`** and a delay of `fireAt − now`. **Any job whose `fireAt` is already ≤ now is skipped, not enqueued** — BullMQ treats a non-positive delay as "run immediately," so without this guard a game scheduled fewer than 7 days out would instantly DM every participant *"Debate next week."* Short-notice scheduling is the common case, so this guard is mandatory. Example: a game created 2 days out enqueues only `notify_day_before`, `notify_hour_before`, `nudge_unlinked_40m`, `announce_t30`, and `notify_t10`; `notify_week_before` is dropped.

### Reconciliation on boot (Redis is not the source of truth)

The delayed jobs live only in Redis, but they are **fully derivable from `games.scheduled_at`**. On API startup (and as an hourly safety cron), the scheduler **reconciles**: for every game with `status='scheduled'` and `scheduled_at > now`, it computes the expected job set and enqueues any that are missing (idempotent via the deterministic `jobId` — re-adding an existing job is a no-op). This means a wiped or corrupted Redis volume self-heals on the next boot instead of silently dropping all notifications. Because of this, Redis AOF does **not** need backup (see §9).

### Rescheduling

When admin changes `scheduled_at`, all unfired jobs for the game are removed by `jobId = game:{id}:{type}` and re-enqueued at the new offsets, applying the past-offset guard above. Already-fired jobs stay fired.

### Cancellation

When admin cancels, all unfired jobs are removed. No "game cancelled" catch-up notification in phase 1 (admin tells players manually).

### Cron jobs (in API)

- `cleanup_old_recordings` (daily): for each `recording_sessions` row with `status IN ('completed', 'failed')` and `ended_at < now() − 30 days` (using `started_at` as the fallback when `ended_at` is NULL), delete the directory at `file_dir` and drop the `recording_sessions` and `recording_files` rows. **Both `completed` and `failed` are included** so abandoned-session directories don't leak disk indefinitely.
- `reap_stuck_sessions` (every 15 min): for each `recording_sessions` row with `status = 'recording'` and `started_at < now() − (MAX_SESSION_HOURS + 1h)`, set `status = 'failed'` and `ended_at = now()`. This catches sessions orphaned by a Discord-bot crash (the bot never sent `/complete`), so they become eligible for `cleanup_old_recordings` instead of pinning `guild_id` forever (see the concurrency guard in §5).
- `reconcile_jobs` (hourly): the boot-time reconciliation described in §4, run on a schedule as a safety net.

## 5. Recording flow (phase 1)

Recording is **fully independent of games** in phase 1. `/record start` does not look up a game. Files are saved to a stable location with metadata so the admin can find them.

### `/record start`

1. Bot reads invoker's voice state. If they're not in any voice channel → reply *"join a voice channel first."*
2. Bot calls `POST /api/recordings/sessions` with `{ started_by_discord_user_id, voice_channel_id, voice_channel_name, guild_id }`. If the API returns `409 Conflict` (the partial unique index in §3 already has an active `recording` row for this guild) → reply *"a recording is already active in this server."* and do not join voice.
3. API creates `recording_sessions` row with `status=recording`, computes
   `file_dir = /var/lib/debates/recordings/<YYYY-MM-DDTHH-mm-ss>_<sanitized_channel_name>_<sessionId>/`
   and creates the directory.
4. Bot joins the voice channel. For every user already speaking, and any user who later speaks, opens a per-user PCM stream via `@discordjs/voice` (`receiver.subscribe(userId, { end: { behavior: Manual } })`).
5. Each stream is piped through an Opus encoder to
   `${file_dir}/<sanitized_discord_username>_<last4_of_discord_id>.opus`.
   File is created lazily on first audio.
6. Bot replies in the originating text channel:
   *"🔴 Recording started in **#{voice_channel_name}**. By staying in voice, all participants consent to being recorded for personal feedback purposes (30-day retention). Session ID: `<sessionId>`. Run `/record stop` when done."*
   The recording notice is mandatory (see §11). If the reply send fails for any reason, the bot must stop the recording immediately and report the failure.

### `/record stop`

1. Bot ends all per-user streams, closes the voice connection.
2. For each non-empty `.opus` file, bot calls
   `POST /api/recordings/sessions/{id}/files`
   with `{ discord_user_id, discord_username, file_path, duration_sec, size_bytes, segments }`.
   *(File bytes already on disk via the shared Docker volume — no upload of bytes.)*
3. API writes `recording_files` rows. Resolves `discord_user_id → user_id` via `users` (NULL if unlinked).
4. API calls `POST /api/recordings/sessions/{id}/complete`.
5. API writes `_metadata.json` into `file_dir`:
   ```json
   {
     "session_id": "...",
     "started_at": "2026-06-03T19:00:00Z",
     "ended_at": "2026-06-03T19:48:12Z",
     "voice_channel": { "id": "...", "name": "Main" },
     "files": [
       {
         "discord_user_id": "998877665544332211",
         "discord_username": "alice",
         "telegram_user_id": 123456,
         "display_name": "Alice K.",
         "file": "alice_2211.opus",
         "duration_sec": 412,
         "segments": [
           { "wall_ms": 0, "audio_offset_ms": 0, "duration_ms": 7200 },
           { "wall_ms": 15400, "audio_offset_ms": 7200, "duration_ms": 3100 }
         ]
       }
     ]
   }
   ```
   **Speaking timeline (`segments`).** Each speaker's `.opus` file is *compacted* — Discord
   only emits Opus packets while that person is talking, so silence gaps are dropped and a
   file's internal clock measures talk-time, not wall-clock. To reconstruct cross-speaker turn
   order (*"who spoke after whom"*) the bot records one entry per contiguous speaking burst:
   `wall_ms` is the burst's start offset from `started_at`; `audio_offset_ms` is where that
   burst sits inside the compacted file; `duration_ms` is the burst's wall-clock length. A
   transcription pipeline maps each Whisper segment's file-relative time `t` to wall-clock via
   `wall_ms + (t − audio_offset_ms)` for the burst that contains `t`, then merges all speakers
   and sorts by wall-clock. Attribution alone needs no timeline (one file per speaker); the
   timeline is what makes a single globally-ordered transcript possible.
6. API sets `recording_sessions.status = completed`, `ended_at = now()`.
7. Bot replies in the originating text channel:
   *"Recorded {N} speakers, {total_duration}. See admin panel for download."*

### Failure modes

- **Bot crashes mid-recording.** Partial `.opus` files remain in `file_dir` on the shared volume; the `recording_sessions` row stays at `status='recording'`. The bot does **not** attempt recovery on restart in phase 1. Instead, the API's `reap_stuck_sessions` cron (§4) flips the row to `failed` after `MAX_SESSION_HOURS + 1h`, which both releases the per-guild concurrency lock and makes the directory eligible for `cleanup_old_recordings`. The partial files are discarded, not salvaged. (Phase 1.1+ may add a salvage flow that registers the partial files instead.)
- **API unreachable on `/record start`.** Bot replies *"backend not reachable, try again."* Recording does not begin.
- **API unreachable on `/record stop`.** Bot retries metadata write with exponential backoff up to 1 hour. Files remain on disk in `file_dir`, recoverable manually.
- **Voice channel empty for >2 min after `/record start`.** No-op (per-user streams open on demand; nothing is written if nobody speaks).

### Hard caps

- Max session duration: **4 hours** (configurable via `MAX_SESSION_HOURS`). Auto-stop at the cap with a warning posted to chat at the 3h45m mark.
- Max concurrent sessions per guild: **1**.

### Audio format

- 48 kHz mono Opus per speaker. Smaller than WAV, lossless enough for any downstream transcription.

## 6. Web admin

React SPA built in `packages/admin`, output copied into `packages/api/public/admin/`, served by Express at `/admin/*`. One image, one process for both API and frontend.

| Path | Page | Purpose |
|---|---|---|
| `/admin/login` | Login | Telegram Login Widget. Backend verifies HMAC signature, issues session cookie. |
| `/admin/games` | Games list | Upcoming + past games. Filter by status (scheduled/cancelled) and date range. "+ New game" button. |
| `/admin/games/new` | New game | Date/time picker (timezone-aware), motion (optional text), participant picker (multi-select from registered users). Submit → POST `/api/games`. |
| `/admin/games/:id` | Game detail | Read-only summary + edit (reschedule, change motion, change participants) + cancel. Shows planned notification timeline derived from `scheduled_at`. |
| `/admin/recordings` | Recordings list | All sessions sorted by `started_at` desc. Columns: started_at, voice channel, duration, # speakers, identified speakers (count linked), status. |
| `/admin/recordings/:id` | Session detail | Per-speaker rows with download buttons. "Download all as .zip" button. Metadata JSON download. |
| `/admin/users` | Users list | Registered users with TG handle, Discord link status (linked / not linked), registered_at. Manual "Force unlink" action for support. |

No playback in the browser in phase 1 — `.opus` downloads only.

## 7. API surface

Express, all JSON unless noted. All admin endpoints require a valid session cookie; all bot endpoints require a static service token in `Authorization: Bearer …`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/admin/auth/telegram` | none | Verify Telegram Login Widget HMAC, issue session cookie. |
| `POST` | `/api/admin/auth/logout` | admin | Clear session. |
| `GET`  | `/api/admin/me` | admin | Return current admin's user info. |
| `GET`  | `/api/games` | admin | List games (query: status, from, to). |
| `POST` | `/api/games` | admin | Create. Enqueues all notification jobs. |
| `GET`  | `/api/games/:id` | admin | Detail. |
| `PATCH`| `/api/games/:id` | admin | Update (scheduled_at, motion, participants). Re-enqueues jobs if `scheduled_at` changed. |
| `POST` | `/api/games/:id/cancel` | admin | Cancel. Removes future jobs. |
| `GET`  | `/api/users` | admin | List registered users. |
| `POST` | `/api/users/:id/unlink-discord` | admin | Support escape hatch. |
| `GET`  | `/api/recordings/sessions` | admin | List. |
| `GET`  | `/api/recordings/sessions/:id` | admin | Detail. |
| `GET`  | `/api/recordings/sessions/:id/files/:discord_user_id.opus` | admin | Stream a single audio file as `audio/ogg`. |
| `GET`  | `/api/recordings/sessions/:id/zip` | admin | Stream the whole session as a zip. |
| `POST` | `/api/recordings/sessions` | discord-bot | Create session. |
| `POST` | `/api/recordings/sessions/:id/files` | discord-bot | Register one file's metadata. |
| `POST` | `/api/recordings/sessions/:id/complete` | discord-bot | Finalize (writes `_metadata.json`, marks `completed`). |
| `POST` | `/api/link/issue` | telegram-bot | Issue a new link code for a TG user. Returns `{ code, expires_at }`. |
| `POST` | `/api/link/redeem` | discord-bot | Redeem a code: `{ code, discord_user_id, discord_username }`. Returns `{ telegram_user_id, display_name }` or 404. |

Inter-process notification delivery uses the BullMQ queue, not HTTP endpoints — the bots pull `notify_*` / `nudge_*` / `announce_*` jobs from `game-events` directly.

## 8. Authentication and authorization

### Admin (web)

- **Login mechanism:** Telegram Login Widget. Admin clicks "Log in with Telegram" → Telegram redirects with HMAC-signed user data → backend verifies signature against `TELEGRAM_BOT_TOKEN` per Telegram's published formula → checks user ID is in `ADMIN_TELEGRAM_IDS` allowlist → looks up the `users` row by `telegram_user_id`; if none exists, auto-creates one from the widget data (`telegram_user_id`, `telegram_username`, `display_name = first_name [+ last_name]`) → issues HTTP-only session cookie (signed JWT, 7-day TTL, refreshed on activity). The admin does **not** need to first `/start` the Telegram bot.
- **Adding/revoking admins:** edit `ADMIN_TELEGRAM_IDS=…` in `.env` and restart the API. (Removing an ID does not delete the user row, only revokes access.)
- **Why this works:** every admin already has a Telegram account (since they registered as players via the bot), there's no password to manage, and revocation is one line in config.

### Bot ↔ API

- **`DISCORD_BOT_API_TOKEN`** — 32+ random bytes, generated once via `openssl rand -hex 32`. Used by the Discord bot to call recording-session endpoints. Scoped: this token can only hit endpoints tagged `discord-bot`.
- **`TELEGRAM_BOT_API_TOKEN`** — same shape. Used by the Telegram bot for `/api/link/issue`. Scoped: only `telegram-bot` endpoints.
- Both checked by middleware that compares `Authorization: Bearer …` against the configured value.

### Player authentication

- **Telegram:** identity is the `telegram_user_id` sent by Telegram with every update; no separate auth.
- **Discord:** identity is the `discord_user_id` from Discord's interaction payload; no separate auth. The `/link` flow ties this ID to a Telegram user via a one-time code (see §5 link redemption).

## 9. Deployment

### Host

- **Server:** `ZenithOfVastness` (SSH: `ssh ZenithOfVastness`)
- **Project path on host:** `/data/tooronkaich/`
- **Public domain:** `debates.animeenigma.com` (single domain — no separate admin / activity subdomain since we cut Activity)
- **Reverse proxy:** nginx on the host terminates TLS, proxies all of `/` to `api:3000`. Routing inside Express:
  - `/admin/*` → static SPA
  - `/api/*` → JSON API
- **Minimum VPS:** 2 vCPU / 4 GB RAM / 50 GB SSD. Whisper in Phase 1.1 will need 4 vCPU / 8 GB RAM or a separate Whisper host.

### docker-compose.yml (sketch)

```yaml
services:
  postgres:
    image: postgres:16-alpine
    volumes: [pgdata:/var/lib/postgresql/data]
    env_file: .env
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    volumes: [redisdata:/data]
    command: redis-server --appendonly yes
    restart: unless-stopped

  api:
    build: ./packages/api
    depends_on: [postgres, redis]
    volumes:
      - recordings:/var/lib/debates/recordings
    env_file: .env
    ports: ["127.0.0.1:3000:3000"]
    restart: unless-stopped

  discord-bot:
    build: ./packages/discord-bot
    depends_on: [api, redis]
    volumes:
      - recordings:/var/lib/debates/recordings        # same volume as api
    env_file: .env
    restart: unless-stopped

  telegram-bot:
    build: ./packages/telegram-bot
    depends_on: [api, redis]
    env_file: .env
    restart: unless-stopped

volumes:
  pgdata:
  redisdata:
  recordings:        # bind-mount target on host: /data/tooronkaich/recordings/
```

### Repository layout

```
discord-debates-helper/
├── packages/
│   ├── shared/           # Zod schemas, env helpers, constants
│   ├── api/              # Express + Prisma + BullMQ scheduler
│   │   └── public/admin/ # built React SPA (copied here by admin's build step)
│   ├── admin/            # React (Vite) — SPA source
│   ├── discord-bot/      # discord.js + @discordjs/voice
│   └── telegram-bot/     # grammy
├── deploy/
│   ├── nginx.conf
│   └── README.md         # one-page VPS bootstrap
├── docker-compose.yml
├── docs/superpowers/specs/
│   └── 2026-06-03-debates-helper-simplified-design.md   # this document
├── .env.example
└── package.json          # npm workspaces
```

### Environment variables

Single `.env` at repo root, loaded by docker-compose via `env_file`. **Never committed.** Concrete values from the user are noted alongside placeholders below; secrets are `<set-in-env>`.

```bash
# Postgres
POSTGRES_USER=debates
POSTGRES_PASSWORD=<set-in-env>
POSTGRES_DB=debates
DATABASE_URL=postgresql://debates:<set-in-env>@postgres:5432/debates

# Redis
REDIS_URL=redis://redis:6379

# API
JWT_SECRET=<set-in-env>                                # openssl rand -hex 32
PUBLIC_URL=https://debates.animeenigma.com
ADMIN_TELEGRAM_IDS=898912046                            # comma-separated allowlist

# Bot ↔ API service tokens
DISCORD_BOT_API_TOKEN=<set-in-env>                      # openssl rand -hex 32
TELEGRAM_BOT_API_TOKEN=<set-in-env>                     # openssl rand -hex 32

# Discord
DISCORD_BOT_TOKEN=<set-in-env>                          # from Developer Portal → Bot tab
DISCORD_CLIENT_ID=1511558875571159201
DEBATE_ANNOUNCE_CHANNEL_ID=607662041561563167
DEBATE_FALLBACK_CHANNEL_ID=607662041561563167           # same as announce for phase 1
MAX_SESSION_HOURS=4

# Telegram
TELEGRAM_BOT_TOKEN=<set-in-env>                         # from @BotFather
TELEGRAM_BOT_USERNAME=tooronkaich_bot                   # without @, used for Login Widget
```

### Storage paths on host

- Audio recordings (bind-mounted into both `api` and `discord-bot` containers):
  `/data/tooronkaich/recordings/`
- Postgres data: in `pgdata` Docker volume
- Redis AOF: in `redisdata` Docker volume

### Backups

- **Postgres:** nightly `pg_dump` to `/data/tooronkaich/backups/` via a cron entry on the host; keep last 14.
- **Recordings:** considered ephemeral (30-day retention by `cleanup_old_recordings`); no backup. If a recording matters long-term, the admin downloads and stores it themselves.
- **Redis AOF:** not backed up. The `game-events` jobs are derived from `games.scheduled_at`, and the API's boot-time + hourly `reconcile_jobs` (§4) re-enqueues any missing jobs for future games. A lost Redis volume therefore self-heals on the next API start rather than silently dropping notifications — this reconciliation is what makes skipping the backup safe.

## 10. Discord-specific setup

### Application

- Created at https://discord.com/developers/applications
- Name: `tooronkaich`
- Client ID: `1511558875571159201`

### Bot user

- Username: `tooronkaich`
- **Privileged Gateway Intents:** all three (Members, Presence, Message Content) are **disabled** — we don't need them.
- **Public Bot:** disabled (so only the owner can invite it to servers).

### Gateway intents requested by the bot at connect time

- `Guilds`
- `GuildVoiceStates`
- `GuildMessages`

(None of these are privileged.)

### Permissions in the invite URL

Bitfield `36768768`:
- View Channels (1024)
- Send Messages (2048)
- Read Message History (65536)
- Connect (1048576)
- Speak (2097152)
- Use Voice Activity (33554432)

Plus OAuth2 scopes: `bot` and `applications.commands`.

### Slash commands registered at startup

| Command | Args | Action |
|---|---|---|
| `/link <code>` | string | Redeem a link code, tie the invoking Discord user to a Telegram user. |
| `/record start` | none | Start a recording session in the invoker's current voice channel. |
| `/record stop` | none | Stop the current recording session. |

Slash commands are registered guild-scoped at startup (faster propagation than global registration during development).

## 11. Privacy, consent, and legal

Recording voice in Discord without participant consent is both ethically problematic and a gray area under Discord's ToS depending on jurisdiction.

**Required practice for phase 1:**

- Post and pin a notice in the debates voice channel(s):
  *"By joining voice during a scheduled debate, you consent to being recorded for personal feedback purposes. Recordings are retained for 30 days then deleted automatically. Contact the admin to opt out."*
- On `/record start`, the bot's chat reply must include a one-line recording-active notice that's visible to anyone in the text channel.
- Phase 1 retention is hard-coded to 30 days via `cleanup_old_recordings`. Do not increase this without re-evaluating consent.

These are operational requirements, not just suggestions.

## 12. Out of scope (explicit non-goals for phase 1)

To prevent scope creep — these are deliberately not in phase 1:

- Whisper transcription (Phase 1.1)
- Any LLM API integration (Claude, GPT, etc.) — admin uses external tools manually
- Player feedback delivery — admin sends feedback outside the system
- TrueSkill ratings and per-player rating history
- Multi-language UI / bot strings (English only)
- Discord Activity / iframe / Embedded App SDK
- RSVP / open invitations / player draft — admin closed-picks the roster
- Pre-game team assignment in the data model
- Speaking-order automation, muting, channel-moving — players run the debate themselves
- WebSocket / real-time client updates
- Per-team Telegram chats
- Multi-tenancy / per-club isolation — single deployment, single club

## 13. Open questions deferred to implementation

These are not architectural decisions; they will be resolved during implementation:

- Exact Telegram message copy (notification templates) — English templates to be drafted in implementation plan.
- Sanitization rules for channel names and Discord usernames in file paths — pick a conservative regex during implementation (`[A-Za-z0-9_-]`).
- Whether to use Prisma migrations or `prisma db push` for phase 1 (recommendation: migrations from day one).
- Exact React component library (recommendation: shadcn/ui or plain TailwindCSS — the admin is small enough that either works).

---

**Next step after spec approval:** invoke the writing-plans skill to produce an implementation plan covering monorepo bootstrap, shared package, API skeleton, Discord bot, Telegram bot, web admin, and deployment scripts, broken into reviewable increments.
