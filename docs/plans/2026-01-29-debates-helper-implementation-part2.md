# Parliamentary Debate Helper - Implementation Plan (Part 2)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

Continuation from Part 1.

---

## Phase 6: API Routes

### Task 11: Auth Routes

**Files:**
- Create: `packages/api/src/routes/auth.ts`
- Create: `packages/api/src/middleware/auth.ts`
- Create: `packages/api/src/services/jwt.ts`
- Modify: `packages/api/src/server.ts`

**Step 1: Create packages/api/src/services/jwt.ts**

```typescript
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

export interface JwtPayload {
  userId: string;
  isAdmin: boolean;
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: '7d' });
}

export function verifyToken(token: string): JwtPayload | null {
  try {
    return jwt.verify(token, config.jwtSecret) as JwtPayload;
  } catch {
    return null;
  }
}
```

**Step 2: Create packages/api/src/middleware/auth.ts**

```typescript
import { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../services/jwt.js';
import { db } from '../db.js';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    isAdmin: boolean;
  };
}

export async function authMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const payload = verifyToken(token);
  if (!payload) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  req.user = { id: payload.userId, isAdmin: payload.isAdmin };
  next();
}

export async function adminMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.user?.isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}
```

**Step 3: Create packages/api/src/routes/auth.ts**

```typescript
import { Router } from 'express';
import { db } from '../db.js';
import { signToken } from '../services/jwt.js';

const router = Router();

// Telegram OAuth callback
router.post('/telegram', async (req, res) => {
  const { telegramId, displayName } = req.body;

  let user = await db.user.findUnique({ where: { telegramId } });

  if (!user) {
    user = await db.user.create({
      data: { telegramId, displayName, language: 'en' },
    });
  }

  const token = signToken({ userId: user.id, isAdmin: user.isAdmin });
  res.json({ token, user });
});

// Discord OAuth (for Activity)
router.post('/discord', async (req, res) => {
  const { code } = req.body;
  // Exchange code for token with Discord API
  // Link Discord account to existing user or return error
  res.json({ message: 'TODO: Implement Discord OAuth' });
});

// Link Discord to Telegram account via code
router.post('/link', async (req, res) => {
  const { linkCode, discordId, discordUsername } = req.body;

  const codeRecord = await db.linkCode.findUnique({
    where: { code: linkCode },
    include: { user: true },
  });

  if (!codeRecord || codeRecord.expiresAt < new Date()) {
    return res.status(400).json({ error: 'Invalid or expired code' });
  }

  const user = await db.user.update({
    where: { id: codeRecord.userId },
    data: { discordId, displayName: discordUsername },
  });

  await db.linkCode.delete({ where: { id: codeRecord.id } });

  const token = signToken({ userId: user.id, isAdmin: user.isAdmin });
  res.json({ token, user });
});

export default router;
```

**Step 4: Update packages/api/src/server.ts**

```typescript
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { connectDb } from './db.js';
import authRoutes from './routes/auth.js';

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.use(helmet());
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/auth', authRoutes);

wss.on('connection', (ws) => {
  console.log('WebSocket client connected');
  ws.on('close', () => console.log('WebSocket client disconnected'));
});

async function start() {
  await connectDb();
  server.listen(config.port, () => {
    console.log(`API server running on port ${config.port}`);
  });
}

start().catch(console.error);
```

**Step 5: Commit**

```bash
git add packages/api/src
git commit -m "feat(api): add auth routes and middleware"
```

---

### Task 12: Game Routes

**Files:**
- Create: `packages/api/src/routes/games.ts`
- Create: `packages/api/src/services/game.ts`
- Modify: `packages/api/src/server.ts`

**Step 1: Create packages/api/src/services/game.ts**

```typescript
import { db } from '../db.js';
import { redis } from '../redis.js';
import { DEFAULT_FORMAT } from '@debates/shared';

export async function createGame(data: {
  guildId: string;
  guildName: string;
  scheduledAt: Date;
  format?: typeof DEFAULT_FORMAT;
  createdById: string;
}) {
  return db.game.create({
    data: {
      guildId: data.guildId,
      guildName: data.guildName,
      scheduledAt: data.scheduledAt,
      format: data.format || DEFAULT_FORMAT,
      createdById: data.createdById,
    },
  });
}

export async function getGameState(gameId: string) {
  const state = await redis.get(`game:${gameId}:state`);
  return state ? JSON.parse(state) : null;
}

export async function setGameState(gameId: string, state: object) {
  await redis.set(`game:${gameId}:state`, JSON.stringify(state));
}

export async function updateGameStatus(gameId: string, status: string) {
  return db.game.update({
    where: { id: gameId },
    data: { status },
  });
}
```

**Step 2: Create packages/api/src/routes/games.ts**

```typescript
import { Router } from 'express';
import { db } from '../db.js';
import { authMiddleware, adminMiddleware, AuthRequest } from '../middleware/auth.js';
import { createGame, getGameState, setGameState, updateGameStatus } from '../services/game.js';

const router = Router();

// List games (admin)
router.get('/', authMiddleware, adminMiddleware, async (req: AuthRequest, res) => {
  const { status, guildId } = req.query;

  const games = await db.game.findMany({
    where: {
      ...(status && { status: status as string }),
      ...(guildId && { guildId: guildId as string }),
    },
    orderBy: { scheduledAt: 'desc' },
    include: {
      _count: { select: { invitations: true, participants: true } },
    },
  });

  res.json(games);
});

// Get single game
router.get('/:id', authMiddleware, async (req: AuthRequest, res) => {
  const game = await db.game.findUnique({
    where: { id: req.params.id },
    include: {
      motion: true,
      invitations: { include: { user: true } },
      participants: { include: { user: true } },
    },
  });

  if (!game) {
    return res.status(404).json({ error: 'Game not found' });
  }

  const state = await getGameState(game.id);
  res.json({ ...game, liveState: state });
});

// Create game (admin)
router.post('/', authMiddleware, adminMiddleware, async (req: AuthRequest, res) => {
  const { guildId, guildName, scheduledAt, format } = req.body;

  const game = await createGame({
    guildId,
    guildName,
    scheduledAt: new Date(scheduledAt),
    format,
    createdById: req.user!.id,
  });

  res.status(201).json(game);
});

// Update game (admin)
router.patch('/:id', authMiddleware, adminMiddleware, async (req: AuthRequest, res) => {
  const { status, scheduledAt, format, motionId } = req.body;

  const game = await db.game.update({
    where: { id: req.params.id },
    data: {
      ...(status && { status }),
      ...(scheduledAt && { scheduledAt: new Date(scheduledAt) }),
      ...(format && { format }),
      ...(motionId && { motionId }),
    },
  });

  res.json(game);
});

// Pause/Resume game (admin)
router.post('/:id/pause', authMiddleware, adminMiddleware, async (req: AuthRequest, res) => {
  const game = await db.game.findUnique({ where: { id: req.params.id } });

  if (!game) {
    return res.status(404).json({ error: 'Game not found' });
  }

  if (game.pausedAt) {
    // Resume
    const pauseDuration = Math.floor((Date.now() - game.pausedAt.getTime()) / 1000);
    await db.game.update({
      where: { id: game.id },
      data: {
        pausedAt: null,
        totalPauseDuration: game.totalPauseDuration + pauseDuration,
      },
    });
  } else {
    // Pause
    await db.game.update({
      where: { id: game.id },
      data: { pausedAt: new Date() },
    });
  }

  res.json({ paused: !game.pausedAt });
});

// Cancel game (admin)
router.post('/:id/cancel', authMiddleware, adminMiddleware, async (req: AuthRequest, res) => {
  await updateGameStatus(req.params.id, 'cancelled');
  res.json({ status: 'cancelled' });
});

export default router;
```

**Step 3: Update packages/api/src/server.ts to include games routes**

Add import and use:
```typescript
import gameRoutes from './routes/games.js';
// ...
app.use('/api/games', gameRoutes);
```

**Step 4: Commit**

```bash
git add packages/api/src
git commit -m "feat(api): add game routes and services"
```

---

### Task 13: Motion Routes

**Files:**
- Create: `packages/api/src/routes/motions.ts`
- Create: `packages/api/src/services/ai.ts`

**Step 1: Create packages/api/src/services/ai.ts**

```typescript
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { config } from '../config.js';

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });
const openai = new OpenAI({ apiKey: config.openai.apiKey });

export async function generateMotions(count: number, category: string): Promise<Array<{ en: string; ru: string; ja: string }>> {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: `Generate ${count} debate motions for the category "${category}".
      Each motion should be a controversial statement that can be argued for or against.
      Return as JSON array with objects containing "en", "ru", "ja" keys for each language.
      Example: [{"en": "This house believes...", "ru": "Эта палата считает...", "ja": "本院は...と考える"}]
      Only return the JSON array, no other text.`,
    }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  return JSON.parse(text);
}

export async function transcribeAudio(audioBuffer: Buffer): Promise<string> {
  const response = await openai.audio.transcriptions.create({
    file: new File([audioBuffer], 'audio.wav', { type: 'audio/wav' }),
    model: 'whisper-1',
  });

  return response.text;
}

export async function analyzeDebate(transcripts: Array<{ userId: string; team: string; text: string }>, motion: string) {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    messages: [{
      role: 'user',
      content: `Analyze this parliamentary debate. Motion: "${motion}"

Transcripts:
${transcripts.map(t => `[${t.team}] Player ${t.userId}: ${t.text}`).join('\n\n')}

Score each speaker relatively within this game (1 = best, N = worst) on:
- argument: strength of arguments
- rebuttal: effectiveness of rebuttals
- evidence: use of evidence/examples
- clarity: speaking clarity
- teamwork: team coordination

Return JSON:
{
  "winner": "government" or "opposition",
  "speakers": [
    {
      "userId": "...",
      "rank": 1,
      "relativeScore": 95,
      "categories": { "argument": 1, "rebuttal": 2, ... },
      "analysis": "Brief analysis..."
    }
  ],
  "gameSummary": "Overall game summary..."
}`,
    }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  return JSON.parse(text);
}

export async function generateFeedback(analysis: string, language: string): Promise<string> {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{
      role: 'system',
      content: `Generate encouraging, constructive feedback for a debate participant.
      Write in ${language === 'ru' ? 'Russian' : language === 'ja' ? 'Japanese' : 'English'}.
      Be positive but also provide specific areas for improvement.`,
    }, {
      role: 'user',
      content: `Based on this analysis, write personalized feedback:\n${analysis}`,
    }],
  });

  return response.choices[0].message.content || '';
}
```

**Step 2: Create packages/api/src/routes/motions.ts**

```typescript
import { Router } from 'express';
import { db } from '../db.js';
import { authMiddleware, adminMiddleware, AuthRequest } from '../middleware/auth.js';
import { generateMotions } from '../services/ai.js';

const router = Router();

// List motions
router.get('/', authMiddleware, async (req: AuthRequest, res) => {
  const { category, approved } = req.query;

  const motions = await db.motion.findMany({
    where: {
      ...(category && { category: category as string }),
      ...(approved !== undefined && { approved: approved === 'true' }),
    },
    orderBy: { createdAt: 'desc' },
  });

  res.json(motions);
});

// Get random motions for voting
router.get('/random', authMiddleware, async (req: AuthRequest, res) => {
  const count = parseInt(req.query.count as string) || 5;

  const motions = await db.motion.findMany({
    where: { approved: true },
    orderBy: { usedCount: 'asc' },
    take: count * 3,
  });

  // Shuffle and take count
  const shuffled = motions.sort(() => Math.random() - 0.5).slice(0, count);
  res.json(shuffled);
});

// Generate motions with AI (admin)
router.post('/generate', authMiddleware, adminMiddleware, async (req: AuthRequest, res) => {
  const { count = 5, category } = req.body;

  const generated = await generateMotions(count, category);

  const motions = await db.motion.createMany({
    data: generated.map(text => ({
      text,
      category,
      source: 'ai_generated',
      approved: false,
    })),
  });

  res.json({ created: motions.count });
});

// Create motion manually (admin)
router.post('/', authMiddleware, adminMiddleware, async (req: AuthRequest, res) => {
  const { text, category } = req.body;

  const motion = await db.motion.create({
    data: {
      text,
      category,
      source: 'admin_created',
      approved: true,
    },
  });

  res.status(201).json(motion);
});

// Approve/unapprove motion (admin)
router.patch('/:id/approve', authMiddleware, adminMiddleware, async (req: AuthRequest, res) => {
  const { approved } = req.body;

  const motion = await db.motion.update({
    where: { id: req.params.id },
    data: { approved },
  });

  res.json(motion);
});

// Update motion (admin)
router.patch('/:id', authMiddleware, adminMiddleware, async (req: AuthRequest, res) => {
  const { text, category } = req.body;

  const motion = await db.motion.update({
    where: { id: req.params.id },
    data: { text, category },
  });

  res.json(motion);
});

// Delete motion (admin)
router.delete('/:id', authMiddleware, adminMiddleware, async (req: AuthRequest, res) => {
  await db.motion.delete({ where: { id: req.params.id } });
  res.status(204).send();
});

export default router;
```

**Step 3: Update packages/api/src/server.ts**

Add import and use:
```typescript
import motionRoutes from './routes/motions.js';
// ...
app.use('/api/motions', motionRoutes);
```

**Step 4: Add AI SDK dependencies to packages/api/package.json**

```json
"@anthropic-ai/sdk": "^0.17.0",
"openai": "^4.26.0"
```

**Step 5: Commit**

```bash
git add packages/api
git commit -m "feat(api): add motion routes and AI services"
```

---

### Task 14: Invitation Routes

**Files:**
- Create: `packages/api/src/routes/invitations.ts`
- Create: `packages/api/src/services/notifications.ts`

**Step 1: Create packages/api/src/services/notifications.ts**

```typescript
import { redis } from '../redis.js';

export interface NotificationPayload {
  type: 'game_invite' | 'reminder' | 'custom' | 'feedback';
  userId: string;
  data: Record<string, unknown>;
}

export async function queueNotification(payload: NotificationPayload) {
  await redis.lpush('notifications:queue', JSON.stringify(payload));
}

export async function queueBulkNotifications(payloads: NotificationPayload[]) {
  const pipeline = redis.pipeline();
  for (const payload of payloads) {
    pipeline.lpush('notifications:queue', JSON.stringify(payload));
  }
  await pipeline.exec();
}
```

**Step 2: Create packages/api/src/routes/invitations.ts**

```typescript
import { Router } from 'express';
import { db } from '../db.js';
import { authMiddleware, adminMiddleware, AuthRequest } from '../middleware/auth.js';
import { queueNotification, queueBulkNotifications } from '../services/notifications.js';

const router = Router();

// Get invitations for a game
router.get('/game/:gameId', authMiddleware, async (req: AuthRequest, res) => {
  const invitations = await db.gameInvitation.findMany({
    where: { gameId: req.params.gameId },
    include: { user: true },
  });

  res.json(invitations);
});

// Invite users to game (admin)
router.post('/game/:gameId/invite', authMiddleware, adminMiddleware, async (req: AuthRequest, res) => {
  const { userIds } = req.body;
  const gameId = req.params.gameId;

  const game = await db.game.findUnique({ where: { id: gameId } });
  if (!game) {
    return res.status(404).json({ error: 'Game not found' });
  }

  // Create invitations
  await db.gameInvitation.createMany({
    data: userIds.map((userId: string) => ({ gameId, userId })),
    skipDuplicates: true,
  });

  // Queue notifications
  const notifications = userIds.map((userId: string) => ({
    type: 'game_invite' as const,
    userId,
    data: { gameId, scheduledAt: game.scheduledAt },
  }));
  await queueBulkNotifications(notifications);

  res.json({ invited: userIds.length });
});

// Respond to invitation (player)
router.post('/:id/respond', authMiddleware, async (req: AuthRequest, res) => {
  const { status } = req.body; // 'confirmed' or 'declined'

  const invitation = await db.gameInvitation.findUnique({
    where: { id: req.params.id },
  });

  if (!invitation || invitation.userId !== req.user!.id) {
    return res.status(404).json({ error: 'Invitation not found' });
  }

  const updated = await db.gameInvitation.update({
    where: { id: req.params.id },
    data: { status, respondedAt: new Date() },
  });

  res.json(updated);
});

// Send custom message to game participants (admin)
router.post('/game/:gameId/message', authMiddleware, adminMiddleware, async (req: AuthRequest, res) => {
  const { subject, message, targetStatus, targetUserId } = req.body;
  const gameId = req.params.gameId;

  let invitations;
  if (targetUserId) {
    invitations = await db.gameInvitation.findMany({
      where: { gameId, userId: targetUserId },
      include: { user: true },
    });
  } else {
    invitations = await db.gameInvitation.findMany({
      where: {
        gameId,
        ...(targetStatus && { status: targetStatus }),
      },
      include: { user: true },
    });
  }

  // Log message
  await db.gameMessage.create({
    data: {
      gameId,
      subject,
      message,
      sentTo: targetUserId || targetStatus || 'all',
    },
  });

  // Queue notifications
  const notifications = invitations.map(inv => ({
    type: 'custom' as const,
    userId: inv.userId,
    data: { subject, message, gameId },
  }));
  await queueBulkNotifications(notifications);

  res.json({ sent: invitations.length });
});

// Send reminder now (admin)
router.post('/game/:gameId/remind', authMiddleware, adminMiddleware, async (req: AuthRequest, res) => {
  const { targetStatus = 'confirmed' } = req.body;
  const gameId = req.params.gameId;

  const game = await db.game.findUnique({ where: { id: gameId } });
  if (!game) {
    return res.status(404).json({ error: 'Game not found' });
  }

  const invitations = await db.gameInvitation.findMany({
    where: { gameId, status: targetStatus },
  });

  const notifications = invitations.map(inv => ({
    type: 'reminder' as const,
    userId: inv.userId,
    data: { gameId, scheduledAt: game.scheduledAt },
  }));
  await queueBulkNotifications(notifications);

  res.json({ reminded: invitations.length });
});

export default router;
```

**Step 3: Update packages/api/src/server.ts**

Add import and use:
```typescript
import invitationRoutes from './routes/invitations.js';
// ...
app.use('/api/invitations', invitationRoutes);
```

**Step 4: Commit**

```bash
git add packages/api/src
git commit -m "feat(api): add invitation routes and notification service"
```

---

### Task 15: User Routes

**Files:**
- Create: `packages/api/src/routes/users.ts`

**Step 1: Create packages/api/src/routes/users.ts**

```typescript
import { Router } from 'express';
import { db } from '../db.js';
import { authMiddleware, adminMiddleware, AuthRequest } from '../middleware/auth.js';

const router = Router();

// Get current user
router.get('/me', authMiddleware, async (req: AuthRequest, res) => {
  const user = await db.user.findUnique({
    where: { id: req.user!.id },
  });

  res.json(user);
});

// Update current user
router.patch('/me', authMiddleware, async (req: AuthRequest, res) => {
  const { displayName, language } = req.body;

  const user = await db.user.update({
    where: { id: req.user!.id },
    data: {
      ...(displayName && { displayName }),
      ...(language && { language }),
    },
  });

  res.json(user);
});

// List users (admin)
router.get('/', authMiddleware, adminMiddleware, async (req: AuthRequest, res) => {
  const { search } = req.query;

  const users = await db.user.findMany({
    where: search ? {
      OR: [
        { displayName: { contains: search as string, mode: 'insensitive' } },
        { discordId: { contains: search as string } },
        { telegramId: { contains: search as string } },
      ],
    } : undefined,
    orderBy: { rating: 'desc' },
  });

  res.json(users);
});

// Get user by ID (admin)
router.get('/:id', authMiddleware, adminMiddleware, async (req: AuthRequest, res) => {
  const user = await db.user.findUnique({
    where: { id: req.params.id },
    include: {
      participations: {
        include: { game: true },
        orderBy: { game: { scheduledAt: 'desc' } },
        take: 20,
      },
    },
  });

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  res.json(user);
});

// Toggle admin status (admin)
router.patch('/:id/admin', authMiddleware, adminMiddleware, async (req: AuthRequest, res) => {
  const { isAdmin } = req.body;

  const user = await db.user.update({
    where: { id: req.params.id },
    data: { isAdmin },
  });

  res.json(user);
});

export default router;
```

**Step 2: Update packages/api/src/server.ts**

Add import and use:
```typescript
import userRoutes from './routes/users.js';
// ...
app.use('/api/users', userRoutes);
```

**Step 3: Commit**

```bash
git add packages/api/src
git commit -m "feat(api): add user routes"
```

---

## Phase 7: Discord Bot Features

### Task 16: Channel Management

**Files:**
- Create: `packages/discord-bot/src/channels/manager.ts`
- Create: `packages/discord-bot/src/channels/permissions.ts`

**Step 1: Create packages/discord-bot/src/channels/permissions.ts**

```typescript
import { PermissionFlagsBits, VoiceChannel, GuildMember } from 'discord.js';

export async function setSpectatorMode(channel: VoiceChannel, spectatorIds: string[]) {
  for (const memberId of spectatorIds) {
    await channel.permissionOverwrites.edit(memberId, {
      Speak: false,
      Stream: false,
    });
  }
}

export async function muteAllExcept(channel: VoiceChannel, speakerId: string) {
  for (const [, member] of channel.members) {
    if (member.id === speakerId) {
      await member.voice.setMute(false);
    } else {
      await member.voice.setMute(true);
    }
  }
}

export async function unmuteAll(channel: VoiceChannel) {
  for (const [, member] of channel.members) {
    await member.voice.setMute(false);
  }
}

export async function setTeamChannelPermissions(
  channel: VoiceChannel,
  teamMemberIds: string[],
  guildId: string
) {
  // Deny everyone
  await channel.permissionOverwrites.edit(guildId, {
    Connect: false,
    ViewChannel: false,
  });

  // Allow team members
  for (const memberId of teamMemberIds) {
    await channel.permissionOverwrites.edit(memberId, {
      Connect: true,
      ViewChannel: true,
      Speak: true,
    });
  }
}
```

**Step 2: Create packages/discord-bot/src/channels/manager.ts**

```typescript
import { Client, ChannelType, VoiceChannel, CategoryChannel } from 'discord.js';

export class ChannelManager {
  constructor(private client: Client) {}

  async createDebateChannel(guildId: string, name: string, categoryId?: string): Promise<VoiceChannel> {
    const guild = await this.client.guilds.fetch(guildId);

    const channel = await guild.channels.create({
      name,
      type: ChannelType.GuildVoice,
      parent: categoryId,
    });

    return channel as VoiceChannel;
  }

  async createTeamChannels(guildId: string, categoryId?: string): Promise<{ gov: VoiceChannel; opp: VoiceChannel }> {
    const guild = await this.client.guilds.fetch(guildId);

    const gov = await guild.channels.create({
      name: 'Government Prep',
      type: ChannelType.GuildVoice,
      parent: categoryId,
    });

    const opp = await guild.channels.create({
      name: 'Opposition Prep',
      type: ChannelType.GuildVoice,
      parent: categoryId,
    });

    return { gov: gov as VoiceChannel, opp: opp as VoiceChannel };
  }

  async deleteChannel(channelId: string) {
    const channel = await this.client.channels.fetch(channelId);
    if (channel) {
      await channel.delete();
    }
  }

  async setChannelStatus(channelId: string, status: string) {
    const channel = await this.client.channels.fetch(channelId);
    if (channel && channel.isVoiceBased()) {
      // Note: Voice channel status is set via channel.setStatus() in newer discord.js
      // For now, we'll update the channel name as fallback
      await (channel as VoiceChannel).setName(status.slice(0, 100));
    }
  }

  async moveMembers(fromChannelId: string, toChannelId: string, memberIds: string[]) {
    const toChannel = await this.client.channels.fetch(toChannelId) as VoiceChannel;

    for (const memberId of memberIds) {
      const member = toChannel.guild.members.cache.get(memberId);
      if (member?.voice.channel) {
        await member.voice.setChannel(toChannel);
      }
    }
  }
}
```

**Step 3: Commit**

```bash
git add packages/discord-bot/src
git commit -m "feat(discord-bot): add channel management"
```

---

### Task 17: Voice Recording

**Files:**
- Create: `packages/discord-bot/src/voice/recorder.ts`
- Create: `packages/discord-bot/src/voice/connection.ts`

**Step 1: Create packages/discord-bot/src/voice/connection.ts**

```typescript
import {
  joinVoiceChannel,
  VoiceConnection,
  VoiceConnectionStatus,
  entersState,
} from '@discordjs/voice';
import { VoiceChannel } from 'discord.js';

export async function connectToVoice(channel: VoiceChannel): Promise<VoiceConnection> {
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: true,
  });

  await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  return connection;
}

export function disconnectFromVoice(connection: VoiceConnection) {
  connection.destroy();
}
```

**Step 2: Create packages/discord-bot/src/voice/recorder.ts**

```typescript
import { VoiceConnection, EndBehaviorType } from '@discordjs/voice';
import { createWriteStream, mkdirSync } from 'fs';
import { pipeline } from 'stream/promises';
import { OpusEncoder } from '@discordjs/opus';
import prism from 'prism-media';
import { join } from 'path';

export class VoiceRecorder {
  private recordings: Map<string, NodeJS.WritableStream> = new Map();

  constructor(private recordingsDir: string) {
    mkdirSync(recordingsDir, { recursive: true });
  }

  startRecording(connection: VoiceConnection, userId: string, gameId: string): string {
    const receiver = connection.receiver;
    const filename = `${gameId}_${userId}_${Date.now()}.pcm`;
    const filepath = join(this.recordingsDir, filename);

    const opusStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.Manual },
    });

    const decoder = new prism.opus.Decoder({
      rate: 48000,
      channels: 2,
      frameSize: 960,
    });

    const writeStream = createWriteStream(filepath);

    opusStream.pipe(decoder).pipe(writeStream);

    this.recordings.set(userId, writeStream);

    return filepath;
  }

  stopRecording(userId: string) {
    const stream = this.recordings.get(userId);
    if (stream) {
      stream.end();
      this.recordings.delete(userId);
    }
  }

  stopAllRecordings() {
    for (const [userId] of this.recordings) {
      this.stopRecording(userId);
    }
  }
}
```

**Step 3: Commit**

```bash
git add packages/discord-bot/src
git commit -m "feat(discord-bot): add voice recording"
```

---

## Phase 8-12: Remaining Implementation

The remaining phases follow the same pattern:

- **Phase 8**: Telegram bot handlers (registration, callbacks, notification processor)
- **Phase 9**: Activity screens (Setup, Preparation, Debate, Results components)
- **Phase 10**: Admin pages (Dashboard, Games, Motions, Users, Settings)
- **Phase 11**: WebSocket game state synchronization
- **Phase 12**: Deployment (nginx config, Dockerfile, SSL setup)

Each task follows the same structure:
1. Create files with exact paths
2. Write code with full implementation
3. Run tests to verify
4. Commit with descriptive message

---

## Quick Reference: Run Commands

```bash
# Start infrastructure
docker-compose up -d

# Install all dependencies
npm install

# Generate Prisma client
npm run db:generate --workspace=packages/api

# Run migrations
npm run db:migrate --workspace=packages/api

# Start all services (separate terminals)
npm run dev --workspace=packages/api
npm run dev --workspace=packages/discord-bot
npm run dev --workspace=packages/telegram-bot
npm run dev --workspace=packages/activity
npm run dev --workspace=packages/admin
```

## Discord Activity Testing

```bash
# Start tunnel for HTTPS
cloudflared tunnel --url http://localhost:5173
```

Then update Discord Developer Portal with the tunnel URL.
