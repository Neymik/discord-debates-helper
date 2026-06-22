# Parliamentary Debate Helper Bot

A multi-platform system for organizing and running Parliamentary Debate games with AI-powered analysis and feedback.

## What is Parliamentary Debate?

Parliamentary Debate is a competitive debating game where participants take roles of members of parliament and argue over a given motion.

- Players are divided into teams: **Government** (supports the motion) and **Opposition** (challenges it)
- Speakers deliver structured speeches in turns, present arguments, rebut opposing points, and answer questions
- AI judges determine the winner based on argument quality, logical coherence, persuasion, and teamwork

## System Components

| Component | Purpose |
|-----------|---------|
| **Discord Bot** | Channel management, voice recording, muting/moving players |
| **Discord Activity** | Interactive game UI embedded in Discord |
| **Telegram Bot** | Registration, notifications, personal AI feedback |
| **Web Admin** | Game scheduling, topic management, monitoring |

## Running it (Docker, one-click)

The whole stack — Postgres, Redis, API, Discord bot, and the transcription worker — runs from Docker Compose.

```bash
cp .env.example .env     # fill in DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, POSTGRES_PASSWORD, the *_API_TOKEN secrets
make up                  # == docker compose up -d --build
```

After the first `make up`, the project appears in **Docker Desktop → Compose**; the **▶ Start** button there is the one-click start thereafter. Boot order is enforced by healthchecks: `postgres → redis → api` (runs `prisma migrate deploy`) `→ discord-bot` + `transcriber-worker`.

**Recordings on disk.** All services bind-mount one host directory, `RECORDINGS_PATH` (default `./records`). Set it to an **absolute path** in `.env` so it always resolves to the same folder regardless of where you launch Compose:

```
RECORDINGS_PATH=/Users/you/Documents/discord-debates-helper/records
```

Per-speaker `.ogg`, `_metadata.json`, and `_transcript.*` for every session land there.

**Transcription.** Stop a recording with `/record stop transcribe:true` and the bot drops a marker the always-on `transcriber-worker` picks up — the transcript appears in the session folder a few minutes later (large-v3, Russian, sequential, memory-capped). Re-transcribe any session manually with `make transcribe SESSION=<dir-name>`.

**Crash resilience.** The bot writes crash-safe sidecars as it records and finalizes any session orphaned by a crash on its next start (Compose's `restart: unless-stopped` makes this automatic); `docker stop` triggers a graceful finalize within a 30s grace period.

**Notes.**
- Don't also run the host `.claude/launch-bot.cjs` while the `discord-bot` container is up — two gateway connections on one token cause duplicate command handling.
- On a ~5.8 GB Docker VM, large-v3 can OOM; raise **Docker Desktop → Resources → Memory to ~8 GB** for reliable transcription. The worker is capped at 4 GB and checkpoints partial transcripts, so an OOM only costs a retry.
- `make down` stops everything (volumes, including Postgres data and the model cache, are kept).

## Game Flow

### Stage 1: Setup

1. Admin schedules a game in the web panel
2. At scheduled time, bot creates a voice channel
3. Players join the voice channel - Activity launches automatically
4. Players vote on a topic (motion) from available options
5. System balances teams based on player ratings
6. All players click "Ready" to proceed

### Stage 2: Preparation

1. Bot creates temporary team channels (Government & Opposition)
2. Players are moved to their team's channel
3. Teams discuss strategy and choose speaking order
4. Preparation timer counts down (duration set by admin)

### Stage 3: Main Debate

1. All players return to the main debate channel
2. Speakers take turns according to the speaking order
3. Only the current speaker is unmuted
4. Bot records each speech for AI analysis
5. POI (Points of Information) can be requested if enabled

**Default Speaking Order (World Schools Style):**
```
Gov Speaker 1 → Opp Speaker 1 → Gov Speaker 2 → Opp Speaker 2 → Gov Speaker 3 → Opp Speaker 3
```

### Stage 4: Ending

1. AI transcribes all speeches (OpenAI Whisper)
2. AI analyzes debate quality (Claude)
3. AI generates personalized feedback (GPT)
4. Results displayed in Activity
5. Personal feedback sent via Telegram
6. Ratings updated using TrueSkill algorithm

## Features

### For Players

- **Multi-language support**: English, Russian, Japanese
- **Rating system**: TrueSkill-based competitive ratings
- **Personal feedback**: AI-generated improvement suggestions after each game
- **Game notifications**: Telegram reminders for upcoming debates

### For Admins

- **Game scheduling**: Plan debates weeks/months in advance
- **Player invitations**: Pre-register players, track confirmations
- **Topic management**: AI-generated or custom debate motions
- **Live monitoring**: Real-time game status in web panel
- **Flexible formats**: Configure team sizes, speech durations, rules

## Tech Stack

- **Backend**: TypeScript, Node.js, Express, WebSocket
- **Database**: PostgreSQL, Redis
- **Discord**: discord.js, Embedded App SDK
- **Telegram**: grammy
- **Frontend**: React, Vite
- **AI**: OpenAI Whisper, Claude, GPT

## Quick Start

### Prerequisites

- Node.js 20+
- Docker & Docker Compose
- Discord Developer Application
- Telegram Bot Token
- OpenAI API Key
- Anthropic API Key

### Development Setup

```bash
# Clone repository
git clone https://github.com/your-username/discord-debates-helper.git
cd discord-debates-helper

# Install dependencies
npm install

# Start databases
docker-compose up -d postgres redis

# Copy environment file
cp .env.example .env
# Edit .env with your API keys

# Run database migrations
npm run db:migrate --workspace=packages/api

# Start all services (separate terminals)
npm run dev --workspace=packages/api
npm run dev --workspace=packages/discord-bot
npm run dev --workspace=packages/telegram-bot
npm run dev --workspace=packages/activity
npm run dev --workspace=packages/admin
```

### Discord Activity Local Testing

Discord Activities require HTTPS. Use cloudflared for local development:

```bash
cloudflared tunnel --url http://localhost:5173
```

## Project Structure

```
discord-debates-helper/
├── packages/
│   ├── shared/          # Shared types, i18n, validation
│   ├── api/             # Central API server
│   ├── discord-bot/     # Discord bot service
│   ├── telegram-bot/    # Telegram bot service
│   ├── activity/        # Discord Activity (React)
│   └── admin/           # Web admin panel (React)
├── deploy/              # Deployment configs
├── docs/
│   └── plans/           # Design documents
├── docker-compose.yml
└── package.json
```

## Environment Variables

```bash
# Discord
DISCORD_BOT_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=

# Telegram
TELEGRAM_BOT_TOKEN=

# AI Services
OPENAI_API_KEY=
ANTHROPIC_API_KEY=

# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/debates
REDIS_URL=redis://localhost:6379

# Security
JWT_SECRET=your-secret-key
```

## Deployment

The system is designed to run on a single VPS:

- **Domain**: debates.animeenigma.ru (admin), activity.debates.animeenigma.ru (Discord Activity)
- **Minimum specs**: 4 CPU cores, 8GB RAM, 100GB SSD

See [deployment documentation](docs/plans/2026-01-29-debates-helper-design.md) for details.

## License

MIT
