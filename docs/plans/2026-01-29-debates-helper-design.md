# Parliamentary Debate Helper Bot - Design Document

## Overview

A multi-platform system for organizing and running Parliamentary Debate games with AI-powered judging and feedback.

**Components:**
- Discord Bot - Channel management, voice recording, user control
- Discord Activity - Interactive game UI (iframe in Discord)
- Telegram Bot - Registration, notifications, personal feedback
- Web Admin - Game scheduling, topic management, monitoring

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         VPS Server                               │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │ Discord Bot │  │Telegram Bot │  │      API Server         │  │
│  │ (discord.js)│  │   (grammy)  │  │ (Express + WebSocket)   │  │
│  └──────┬──────┘  └──────┬──────┘  └───────────┬─────────────┘  │
│         │                │                      │                │
│         └────────────────┴──────────┬───────────┘                │
│                                     │                            │
│  ┌──────────────┐  ┌───────────────┴────────────┐               │
│  │    Redis     │  │        PostgreSQL          │               │
│  │ (game state) │  │  (users, games, ratings)   │               │
│  └──────────────┘  └────────────────────────────┘               │
└─────────────────────────────────────────────────────────────────┘
         │                    │
         ▼                    ▼
┌─────────────────┐  ┌─────────────────┐
│ Discord Activity│  │   Web Admin     │
│ (React iframe)  │  │ (React SPA)     │
└─────────────────┘  └─────────────────┘
```

## Tech Stack

- **Language:** TypeScript/Node.js (all services)
- **Database:** PostgreSQL (persistent data)
- **Cache/State:** Redis (real-time game state, pub/sub)
- **Discord Bot:** discord.js
- **Telegram Bot:** grammy
- **Activity Frontend:** React + Vite
- **Admin Frontend:** React + Vite
- **API:** Express + WebSocket (ws)
- **ORM:** Prisma
- **Job Queue:** BullMQ
- **AI Services:**
  - OpenAI Whisper (speech-to-text)
  - Claude (debate analysis/judging)
  - GPT (personalized feedback)

## Data Models

### User
```
User
├── id
├── discordId (unique, nullable until linked)
├── telegramId (unique, required - primary auth)
├── displayName
├── language (ru | ja | en)
├── isAdmin (boolean, default false)
├── rating (display value: μ - 3σ)
├── ratingMu (TrueSkill μ)
├── ratingSigma (TrueSkill σ)
├── categoryRanks (jsonb: rolling avg of argument, rebuttal, evidence, clarity, teamwork)
├── gamesPlayed
├── createdAt
```

### Game
```
Game
├── id
├── guildId (Discord server ID - mandatory)
├── guildName (cached for display)
├── status (scheduled | setup | preparation | debate | ended | cancelled)
├── format (jsonb: teamCount, playersPerTeam, speechDurations, prepTime, poiEnabled)
├── motionId (chosen topic)
├── motionText (cached, denormalized for history)
├── mainChannelId
├── govChannelId (temporary, cleared after game)
├── oppChannelId (temporary, cleared after game)
├── scheduledAt
├── startedAt, endedAt
├── pausedAt (nullable, for admin pause tracking)
├── totalPauseDuration (seconds)
├── summaryComment (AI-generated game summary text)
├── createdBy (admin user)
├── createdAt
```

### GameParticipant
```
GameParticipant
├── gameId
├── userId
├── team (government | opposition)
├── speakingOrder (jsonb int array: positions in the speech sequence; a player may appear more than once for uneven teams)
├── speechRecordings (jsonb array: [{order, audioUrl, transcription}])
├── aiAnalysis (jsonb: rank, relativeScore, categories, analysis)
├── aiFeedback (text sent to Telegram)
```

### GameInvitation
```
GameInvitation
├── gameId
├── userId
├── status (pending | confirmed | declined)
├── invitedAt
├── respondedAt
```

### Motion (Topic)
```
Motion
├── id
├── text (jsonb: {en, ru, ja})
├── category
├── source (ai_generated | admin_created)
├── approved (boolean)
├── usedCount
```

### Redis Keys
```
game:{id}:state    - Current stage, timer, connected players
game:{id}:votes    - Topic voting in progress
game:{id}:ready    - Players who clicked Ready
```

## Game Flow

### Stage 1: Setup
1. Admin schedules game in web panel (time, format, guild)
2. Bot creates MainDebatesChannel (voice) at scheduled time
3. Bot sets channel status: "Debate Setup - Waiting for players"
4. Players join voice channel → Activity launches automatically
5. Activity shows: connected players, topic voting, Ready buttons
6. Topic voting: 3-5 motions from pool, real-time vote count displayed
7. Motion with majority wins (or random if tied)
8. System divides teams by rating (balance total team ratings)
9. Handles uneven players (e.g., 2v3 - assigns double-speaker)
10. All players click Ready → Stage 2 begins

### Stage 2: Preparation
1. Bot creates GovChannel and OppChannel (voice, temporary)
2. Bot sets permissions: only team members can join their channel
3. Bot moves players to respective team channels
4. Activity shows: chosen motion, teammates, timer (admin-configured)
5. Players select preferred speaking order (drag-drop or claim slots)
6. System auto-assigns unclaimed slots
7. Timer ends (or admin advances) → Stage 3 begins

### Stage 3: Main Debate
1. Bot moves all players back to MainDebatesChannel
2. Bot sets channel status: "Debate in Progress - [Motion]"
3. Bot mutes all except current speaker
4. Speaking order follows WSS pattern (or custom): Gov1 → Opp1 → Gov2 → Opp2 → Gov3 → Opp3
5. For each speaker:
   - Bot unmutes speaker, starts recording
   - Activity shows countdown timer for speech duration
   - Bot records audio stream to file
   - Timer ends → Bot mutes speaker, stops recording
   - Next speaker auto-starts (or admin can pause)
6. POI (Points of Information) if enabled:
   - Players tap button in Activity to request POI
   - Current speaker sees notification, can accept/decline
   - Accepted: questioner unmuted for 15 seconds
7. All speeches complete → Stage 4 begins

### Stage 4: Ending
1. Bot uploads recordings → Whisper transcription (async)
2. Claude analyzes all transcripts (relative scoring within game)
3. TrueSkill updates ratings based on results and individual ranks
4. GPT generates personalized feedback per player (localized)
5. Telegram bot sends personal feedback to each player (private)
6. Activity shows: winner, team scores, individual ratings, game summary
7. Bot cleans up: deletes temp channels, resets channel status

## Game Format Configuration

Default: World Schools Style (WSS)

Configurable parameters:
- Number of teams (2-4)
- Players per team (1-4)
- Speech duration per role
- Preparation time
- POI allowed (yes/no)

Flexible player handling: if uneven (e.g., 5 players for 3v3), one player speaks twice.

## Discord Activity UI

### Setup Screen
- Motion voting panel (3-5 options, live vote count)
- Connected players list with ratings
- Teams preview (auto-balanced)
- Ready button (shows X/Y ready)

### Preparation Screen
- Motion display with team assignment (FOR/AGAINST)
- Speaking order selector (drag-drop)
- Prep time countdown
- Teammate list

### Debate Screen
- Current speaker highlight
- Speech timer with progress bar
- POI request button (for opposing team)
- Speaking queue
- Admin panel (pause, skip, end game)

### Results Screen
- Winner announcement
- Team scores
- Individual rankings with rating changes
- AI summary
- Link to Telegram for personal feedback

## Web Admin Panel

### Pages

| Page | Features |
|------|----------|
| Dashboard | Active games (live status), upcoming scheduled, recent completed |
| Games | List all games, filter by status/date/guild. Create/schedule new game |
| Game Detail | Live view: current stage, players, timer. Controls: pause/resume/cancel. Post-game: transcripts, AI analysis, recordings. Invitations tab. Communications tab. |
| Motions | Topic pool. Generate with AI (set count, category). Edit/approve/delete. Usage stats |
| Users | List all users, search. View profile: rating history, games played. Toggle isAdmin |
| Formats | Create/edit game format presets (WSS default, custom variations) |
| Settings | API keys, default reminder schedule, rating parameters, notification templates |

### Game Invitations & Communications

**Invitation Flow:**
1. Admin creates game (scheduled for future date)
2. Admin adds users to invite list
3. Admin clicks "Send Invitations" → immediate Telegram message
4. System schedules automatic reminders (configurable: 7 days, 1 day, 1 hour before)

**Reminder Messages Include:**
- Game date/time
- Motion category
- Confirmed player count
- Response buttons: [I'm in] [Can't make it]

**Custom Messages:**
- Send to: all invited / confirmed only / specific player
- Message composer with optional response buttons
- Use cases: rescheduling, announcements, follow-ups
- Message history logged per game

## Telegram Bot

### Registration Flow
1. User starts bot: /start
2. Bot asks language preference (EN/RU/JA)
3. Bot provides link code
4. User enters code in Discord Activity
5. Accounts linked

### Commands
- `/start` - Registration flow
- `/language` - Change language preference
- `/stats` - View your rating and game history
- `/upcoming` - List scheduled games
- `/link` - Get new link code

### Notifications
| Event | Message |
|-------|---------|
| Game invitation | Immediate when admin invites |
| Reminders | 7 days, 1 day, 1 hour before (configurable) |
| Personal feedback | After game ends (localized AI feedback) |
| Rating milestone | When reaching rating thresholds |
| Admin custom message | Any time from admin panel |

## AI Integration

### Speech Processing Pipeline
1. Recording saved (WAV/OGG)
2. Job queue picks up transcription
3. OpenAI Whisper transcribes (with language hint)
4. Transcript stored in database
5. After all speeches: trigger analysis

### Claude Analysis
Input:
- Motion text
- All transcripts with speaker labels and teams
- Scoring rubric

Output (relative scoring within game):
```json
{
  "winner": "opposition",
  "speakers": [
    {
      "userId": "...",
      "rank": 1,
      "relativeScore": 95,
      "categories": {
        "argument": 1,
        "rebuttal": 2,
        "evidence": 1,
        "clarity": 1,
        "teamwork": 3
      },
      "analysis": "..."
    }
  ],
  "gameSummary": "..."
}
```

### GPT Feedback
- Per player, in their preferred language
- Encouraging, constructive tone
- Based on Claude's analysis

### TrueSkill Rating

Rating config (tunable in admin settings):
```
trueskillMu: 25.0           # initial skill estimate
trueskillSigma: 8.333       # initial uncertainty
trueskillBeta: 4.166        # skill chain length
trueskillTau: 0.083         # dynamics factor
displayFormula: "mu - 3 * sigma"
categoryWeights: { argument, rebuttal, evidence, clarity, teamwork }
winBonus: 1.2
rankInfluence: 0.5
```

All parameters adjustable without code changes.

## Internationalization

Supported languages: English, Russian, Japanese

Localized:
- Activity UI
- Telegram messages
- AI feedback
- Motion texts

Implementation: react-i18next for frontends, i18n JSON files in shared package

## Security

### Authentication
| Component | Method |
|-----------|--------|
| Activity | Discord OAuth via Embedded SDK |
| Telegram Bot | Telegram user ID |
| Web Admin | Telegram OAuth → check isAdmin |
| API | JWT tokens (short-lived + refresh) |

### Authorization
- Activity actions: verify user is participant
- Admin actions: verify isAdmin flag
- Bot commands: validate ID matches stored user

### Error Handling
- Voice recording fails → notify admin, allow manual re-record
- AI service down → queue for retry
- Player disconnects → admin can pause, rejoin grace period
- WebSocket disconnect → auto-reconnect, sync from Redis

### Data Privacy
- Voice recordings: auto-delete after 30 days
- Transcripts: retained for history, anonymizable on request

## Deployment

### Domain Configuration
```
debates.animeenigma.ru           → admin (React SPA)
debates.animeenigma.ru/api       → api server
debates.animeenigma.ru/ws        → WebSocket
activity.debates.animeenigma.ru  → Discord Activity
```

### VPS Requirements
- CPU: 4 cores
- RAM: 8GB
- Storage: 100GB SSD
- Bandwidth: unmetered

### Docker Services
- postgres (PostgreSQL 16)
- redis (Redis 7)
- api (Express + WebSocket)
- discord-bot (discord.js)
- telegram-bot (grammy)
- worker (BullMQ jobs)
- nginx (reverse proxy, SSL)

### Environment Variables
```
DISCORD_BOT_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=
TELEGRAM_BOT_TOKEN=
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
DATABASE_URL=
REDIS_URL=
JWT_SECRET=
ADMIN_INITIAL_TELEGRAM_ID=
```

## Project Structure

```
discord-debates-helper/
├── README.md
├── docker-compose.yml
├── package.json                 # monorepo root
├── packages/
│   ├── shared/                  # types, i18n, validation
│   ├── api/                     # Express + WebSocket server
│   ├── discord-bot/             # discord.js bot
│   ├── telegram-bot/            # grammy bot
│   ├── activity/                # React (Discord Activity)
│   └── admin/                   # React (Web Admin)
└── deploy/
    ├── nginx.conf
    └── Dockerfile
```

## Development

### Local Setup
```bash
docker-compose up postgres redis
npm run dev --workspace=packages/api
npm run dev --workspace=packages/discord-bot
npm run dev --workspace=packages/telegram-bot
npm run dev --workspace=packages/activity
npm run dev --workspace=packages/admin
```

### Discord Activity Testing
Use cloudflared tunnel for HTTPS:
```bash
cloudflared tunnel --url http://localhost:5173
```

### Testing Strategy
- Unit: rating calculations, game state transitions
- Integration: API endpoints, bot commands
- E2E: Activity flow with mock Discord SDK
