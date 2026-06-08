# Parliamentary Debate Helper - Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a multi-platform Parliamentary Debate system with Discord Activity, Telegram Bot, and Web Admin panel.

**Architecture:** Monorepo with 6 packages (shared, api, discord-bot, telegram-bot, activity, admin). PostgreSQL for persistence, Redis for real-time state. All services communicate through the central API via REST/WebSocket.

**Tech Stack:** TypeScript, Node.js, Express, WebSocket, Prisma, discord.js, grammy, React, Vite, BullMQ, Docker

---

## Phase 1: Project Foundation

### Task 1: Initialize Monorepo

**Files:**
- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `.gitignore`
- Create: `.env.example`

**Step 1: Create root package.json**

```json
{
  "name": "discord-debates-helper",
  "private": true,
  "workspaces": [
    "packages/*"
  ],
  "scripts": {
    "build": "npm run build --workspaces --if-present",
    "dev": "echo 'Run dev in specific workspace'",
    "lint": "eslint packages/*/src --ext .ts,.tsx",
    "typecheck": "tsc --build"
  },
  "devDependencies": {
    "@types/node": "^20.11.0",
    "typescript": "^5.3.3",
    "eslint": "^8.56.0",
    "@typescript-eslint/eslint-plugin": "^6.19.0",
    "@typescript-eslint/parser": "^6.19.0"
  }
}
```

**Step 2: Create tsconfig.base.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "src"
  }
}
```

**Step 3: Create .gitignore**

```
node_modules/
dist/
.env
*.log
.DS_Store
recordings/
```

**Step 4: Create .env.example**

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
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/debates
REDIS_URL=redis://localhost:6379

# Security
JWT_SECRET=change-this-secret

# Admin Bootstrap
ADMIN_INITIAL_TELEGRAM_ID=
```

**Step 5: Create package directories**

Run: `mkdir -p packages/{shared,api,discord-bot,telegram-bot,activity,admin}/src`

**Step 6: Commit**

```bash
git add -A
git commit -m "chore: initialize monorepo structure"
```

---

### Task 2: Setup Shared Package

**Files:**
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/index.ts`
- Create: `packages/shared/src/types/index.ts`
- Create: `packages/shared/src/types/user.ts`
- Create: `packages/shared/src/types/game.ts`
- Create: `packages/shared/src/types/motion.ts`

**Step 1: Create packages/shared/package.json**

```json
{
  "name": "@debates/shared",
  "version": "1.0.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch"
  },
  "dependencies": {
    "zod": "^3.22.4"
  }
}
```

**Step 2: Create packages/shared/tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

**Step 3: Create packages/shared/src/types/user.ts**

```typescript
import { z } from 'zod';

export const Language = z.enum(['en', 'ru', 'ja']);
export type Language = z.infer<typeof Language>;

export const UserSchema = z.object({
  id: z.string().uuid(),
  discordId: z.string().nullable(),
  telegramId: z.string(),
  displayName: z.string(),
  language: Language,
  isAdmin: z.boolean().default(false),
  rating: z.number().default(1500),
  ratingMu: z.number().default(25),
  ratingSigma: z.number().default(8.333),
  categoryRanks: z.object({
    argument: z.number(),
    rebuttal: z.number(),
    evidence: z.number(),
    clarity: z.number(),
    teamwork: z.number(),
  }).nullable(),
  gamesPlayed: z.number().default(0),
  createdAt: z.date(),
});

export type User = z.infer<typeof UserSchema>;

export const CreateUserSchema = UserSchema.pick({
  telegramId: true,
  displayName: true,
  language: true,
});

export type CreateUser = z.infer<typeof CreateUserSchema>;
```

**Step 4: Create packages/shared/src/types/game.ts**

```typescript
import { z } from 'zod';

export const GameStatus = z.enum([
  'scheduled',
  'setup',
  'preparation',
  'debate',
  'ended',
  'cancelled',
]);
export type GameStatus = z.infer<typeof GameStatus>;

export const Team = z.enum(['government', 'opposition']);
export type Team = z.infer<typeof Team>;

export const GameFormatSchema = z.object({
  teamCount: z.number().min(2).max(4).default(2),
  playersPerTeam: z.number().min(1).max(4).default(3),
  speechDurationSeconds: z.number().default(300),
  prepTimeSeconds: z.number().default(900),
  poiEnabled: z.boolean().default(true),
  poiDurationSeconds: z.number().default(15),
});
export type GameFormat = z.infer<typeof GameFormatSchema>;

export const GameSchema = z.object({
  id: z.string().uuid(),
  guildId: z.string(),
  guildName: z.string(),
  status: GameStatus,
  format: GameFormatSchema,
  motionId: z.string().uuid().nullable(),
  motionText: z.string().nullable(),
  mainChannelId: z.string().nullable(),
  govChannelId: z.string().nullable(),
  oppChannelId: z.string().nullable(),
  scheduledAt: z.date(),
  startedAt: z.date().nullable(),
  endedAt: z.date().nullable(),
  pausedAt: z.date().nullable(),
  totalPauseDuration: z.number().default(0),
  summaryComment: z.string().nullable(),
  createdById: z.string().uuid(),
  createdAt: z.date(),
});

export type Game = z.infer<typeof GameSchema>;

export const InvitationStatus = z.enum(['pending', 'confirmed', 'declined']);
export type InvitationStatus = z.infer<typeof InvitationStatus>;

export const GameInvitationSchema = z.object({
  id: z.string().uuid(),
  gameId: z.string().uuid(),
  userId: z.string().uuid(),
  status: InvitationStatus,
  invitedAt: z.date(),
  respondedAt: z.date().nullable(),
});
export type GameInvitation = z.infer<typeof GameInvitationSchema>;

export const GameParticipantSchema = z.object({
  id: z.string().uuid(),
  gameId: z.string().uuid(),
  userId: z.string().uuid(),
  team: Team,
  speakingOrder: z.array(z.number()),
  speechRecordings: z.array(z.object({
    order: z.number(),
    audioUrl: z.string(),
    transcription: z.string().nullable(),
  })),
  aiAnalysis: z.object({
    rank: z.number(),
    relativeScore: z.number(),
    categories: z.object({
      argument: z.number(),
      rebuttal: z.number(),
      evidence: z.number(),
      clarity: z.number(),
      teamwork: z.number(),
    }),
    analysis: z.string(),
  }).nullable(),
  aiFeedback: z.string().nullable(),
});
export type GameParticipant = z.infer<typeof GameParticipantSchema>;
```

**Step 5: Create packages/shared/src/types/motion.ts**

```typescript
import { z } from 'zod';

export const MotionSource = z.enum(['ai_generated', 'admin_created']);
export type MotionSource = z.infer<typeof MotionSource>;

export const MotionSchema = z.object({
  id: z.string().uuid(),
  text: z.object({
    en: z.string(),
    ru: z.string(),
    ja: z.string(),
  }),
  category: z.string(),
  source: MotionSource,
  approved: z.boolean().default(false),
  usedCount: z.number().default(0),
  createdAt: z.date(),
});

export type Motion = z.infer<typeof MotionSchema>;
```

**Step 6: Create packages/shared/src/types/index.ts**

```typescript
export * from './user.js';
export * from './game.js';
export * from './motion.js';
```

**Step 7: Create packages/shared/src/index.ts**

```typescript
export * from './types/index.js';
```

**Step 8: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): add core type definitions"
```

---

### Task 3: Setup Shared Constants and i18n

**Files:**
- Create: `packages/shared/src/constants/index.ts`
- Create: `packages/shared/src/constants/game.ts`
- Create: `packages/shared/src/constants/rating.ts`
- Create: `packages/shared/src/i18n/en.ts`
- Create: `packages/shared/src/i18n/ru.ts`
- Create: `packages/shared/src/i18n/ja.ts`
- Create: `packages/shared/src/i18n/index.ts`
- Modify: `packages/shared/src/index.ts`

**Step 1: Create packages/shared/src/constants/game.ts**

```typescript
export const DEFAULT_FORMAT = {
  teamCount: 2,
  playersPerTeam: 3,
  speechDurationSeconds: 300,
  prepTimeSeconds: 900,
  poiEnabled: true,
  poiDurationSeconds: 15,
} as const;

export const GAME_STAGES = ['scheduled', 'setup', 'preparation', 'debate', 'ended', 'cancelled'] as const;

export const WSS_SPEAKING_ORDER = [
  { team: 'government', role: 'Prime Minister' },
  { team: 'opposition', role: 'Opposition Leader' },
  { team: 'government', role: 'Deputy Prime Minister' },
  { team: 'opposition', role: 'Deputy Opposition Leader' },
  { team: 'government', role: 'Government Whip' },
  { team: 'opposition', role: 'Opposition Whip' },
] as const;
```

**Step 2: Create packages/shared/src/constants/rating.ts**

```typescript
export const RATING_CONFIG = {
  trueskillMu: 25.0,
  trueskillSigma: 8.333,
  trueskillBeta: 4.166,
  trueskillTau: 0.083,
  displayFormula: 'mu - 3 * sigma',
  categoryWeights: {
    argument: 1.0,
    rebuttal: 1.0,
    evidence: 1.0,
    clarity: 1.0,
    teamwork: 1.0,
  },
  winBonus: 1.2,
  rankInfluence: 0.5,
} as const;

export const INITIAL_RATING = 1500;
```

**Step 3: Create packages/shared/src/constants/index.ts**

```typescript
export * from './game.js';
export * from './rating.js';
```

**Step 4: Create packages/shared/src/i18n/en.ts**

```typescript
export const en = {
  common: {
    government: 'Government',
    opposition: 'Opposition',
    ready: 'Ready',
    cancel: 'Cancel',
    confirm: 'Confirm',
    save: 'Save',
  },
  telegram: {
    welcome: 'Welcome to Parliamentary Debate Helper!',
    chooseLanguage: 'Please choose your language:',
    linkCode: 'Your link code: {{code}}\n\nEnter this code in the Discord Activity to connect your account.',
    linked: 'Discord account @{{username}} linked successfully!',
    gameInvite: 'You\'re invited to a debate!\n\nDate: {{date}}\nMotion category: {{category}}\nFormat: {{format}}',
    reminder: 'Reminder: Debate in {{timeUntil}}\n\nConfirmed players: {{confirmed}}/{{total}}',
    imIn: "I'm in",
    cantMakeIt: "Can't make it",
    feedback: 'Your debate feedback:\n\n{{feedback}}\n\nRating: {{oldRating}} → {{newRating}} ({{diff}})',
  },
  activity: {
    setup: {
      title: 'Debate Setup',
      waitingForPlayers: 'Waiting for players...',
      voteForMotion: 'Vote for a motion:',
      teamPreview: 'Team Preview',
      clickReady: 'Click Ready when prepared',
    },
    preparation: {
      title: 'Preparation',
      yourTeam: 'Your team: {{team}}',
      motion: 'Motion: {{motion}}',
      speakingOrder: 'Speaking Order',
      timeRemaining: 'Time remaining: {{time}}',
    },
    debate: {
      title: 'Debate',
      nowSpeaking: 'Now Speaking',
      upNext: 'Up Next',
      requestPoi: 'Request POI',
      poiRequested: 'POI Requested',
    },
    results: {
      title: 'Results',
      winner: 'Winner: {{team}}',
      aiSummary: 'AI Summary',
      feedbackSent: 'Personal feedback sent to your Telegram!',
      playAgain: 'Play Again',
    },
  },
  admin: {
    dashboard: 'Dashboard',
    games: 'Games',
    motions: 'Motions',
    users: 'Users',
    settings: 'Settings',
  },
};

export type Translations = typeof en;
```

**Step 5: Create packages/shared/src/i18n/ru.ts**

```typescript
import type { Translations } from './en.js';

export const ru: Translations = {
  common: {
    government: 'Правительство',
    opposition: 'Оппозиция',
    ready: 'Готов',
    cancel: 'Отмена',
    confirm: 'Подтвердить',
    save: 'Сохранить',
  },
  telegram: {
    welcome: 'Добро пожаловать в Parliamentary Debate Helper!',
    chooseLanguage: 'Пожалуйста, выберите язык:',
    linkCode: 'Ваш код привязки: {{code}}\n\nВведите этот код в Discord Activity для подключения аккаунта.',
    linked: 'Аккаунт Discord @{{username}} успешно привязан!',
    gameInvite: 'Вы приглашены на дебаты!\n\nДата: {{date}}\nКатегория темы: {{category}}\nФормат: {{format}}',
    reminder: 'Напоминание: Дебаты через {{timeUntil}}\n\nПодтвердили участие: {{confirmed}}/{{total}}',
    imIn: 'Я участвую',
    cantMakeIt: 'Не смогу',
    feedback: 'Ваш отзыв по дебатам:\n\n{{feedback}}\n\nРейтинг: {{oldRating}} → {{newRating}} ({{diff}})',
  },
  activity: {
    setup: {
      title: 'Подготовка к дебатам',
      waitingForPlayers: 'Ожидание игроков...',
      voteForMotion: 'Проголосуйте за тему:',
      teamPreview: 'Предварительный состав команд',
      clickReady: 'Нажмите Готов когда будете готовы',
    },
    preparation: {
      title: 'Подготовка',
      yourTeam: 'Ваша команда: {{team}}',
      motion: 'Тема: {{motion}}',
      speakingOrder: 'Порядок выступлений',
      timeRemaining: 'Осталось времени: {{time}}',
    },
    debate: {
      title: 'Дебаты',
      nowSpeaking: 'Сейчас выступает',
      upNext: 'Следующий',
      requestPoi: 'Запросить POI',
      poiRequested: 'POI запрошен',
    },
    results: {
      title: 'Результаты',
      winner: 'Победитель: {{team}}',
      aiSummary: 'Итоги от ИИ',
      feedbackSent: 'Персональный отзыв отправлен в Telegram!',
      playAgain: 'Играть снова',
    },
  },
  admin: {
    dashboard: 'Панель управления',
    games: 'Игры',
    motions: 'Темы',
    users: 'Пользователи',
    settings: 'Настройки',
  },
};
```

**Step 6: Create packages/shared/src/i18n/ja.ts**

```typescript
import type { Translations } from './en.js';

export const ja: Translations = {
  common: {
    government: '政府',
    opposition: '野党',
    ready: '準備完了',
    cancel: 'キャンセル',
    confirm: '確認',
    save: '保存',
  },
  telegram: {
    welcome: 'Parliamentary Debate Helperへようこそ！',
    chooseLanguage: '言語を選択してください：',
    linkCode: 'リンクコード: {{code}}\n\nDiscord Activityでこのコードを入力してアカウントを接続してください。',
    linked: 'Discordアカウント @{{username}} が正常にリンクされました！',
    gameInvite: 'ディベートに招待されました！\n\n日時: {{date}}\nカテゴリー: {{category}}\n形式: {{format}}',
    reminder: 'リマインダー: ディベートまで{{timeUntil}}\n\n参加確認: {{confirmed}}/{{total}}',
    imIn: '参加します',
    cantMakeIt: '参加できません',
    feedback: 'ディベートのフィードバック:\n\n{{feedback}}\n\nレーティング: {{oldRating}} → {{newRating}} ({{diff}})',
  },
  activity: {
    setup: {
      title: 'ディベート設定',
      waitingForPlayers: 'プレイヤーを待っています...',
      voteForMotion: '議題に投票してください：',
      teamPreview: 'チームプレビュー',
      clickReady: '準備ができたら準備完了をクリック',
    },
    preparation: {
      title: '準備',
      yourTeam: 'あなたのチーム: {{team}}',
      motion: '議題: {{motion}}',
      speakingOrder: 'スピーチ順',
      timeRemaining: '残り時間: {{time}}',
    },
    debate: {
      title: 'ディベート',
      nowSpeaking: '現在のスピーカー',
      upNext: '次のスピーカー',
      requestPoi: 'POIリクエスト',
      poiRequested: 'POIリクエスト済み',
    },
    results: {
      title: '結果',
      winner: '勝者: {{team}}',
      aiSummary: 'AIサマリー',
      feedbackSent: '個人フィードバックをTelegramに送信しました！',
      playAgain: 'もう一度プレイ',
    },
  },
  admin: {
    dashboard: 'ダッシュボード',
    games: 'ゲーム',
    motions: '議題',
    users: 'ユーザー',
    settings: '設定',
  },
};
```

**Step 7: Create packages/shared/src/i18n/index.ts**

```typescript
import { en } from './en.js';
import { ru } from './ru.js';
import { ja } from './ja.js';
import type { Language } from '../types/user.js';

export const translations = { en, ru, ja } as const;

export function t(lang: Language, key: string, params?: Record<string, string | number>): string {
  const keys = key.split('.');
  let value: unknown = translations[lang];

  for (const k of keys) {
    if (value && typeof value === 'object' && k in value) {
      value = (value as Record<string, unknown>)[k];
    } else {
      return key;
    }
  }

  if (typeof value !== 'string') return key;

  if (params) {
    return value.replace(/\{\{(\w+)\}\}/g, (_, k) => String(params[k] ?? `{{${k}}}`));
  }

  return value;
}

export type { Translations } from './en.js';
```

**Step 8: Update packages/shared/src/index.ts**

```typescript
export * from './types/index.js';
export * from './constants/index.js';
export * from './i18n/index.js';
```

**Step 9: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): add constants and i18n translations"
```

---

### Task 4: Setup Docker Compose

**Files:**
- Create: `docker-compose.yml`
- Create: `docker-compose.dev.yml`

**Step 1: Create docker-compose.yml**

```yaml
version: '3.8'

services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: debates
    volumes:
      - postgres_data:/var/lib/postgresql/data
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    volumes:
      - redis_data:/data
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 5

volumes:
  postgres_data:
  redis_data:
```

**Step 2: Create docker-compose.dev.yml**

```yaml
version: '3.8'

services:
  postgres:
    extends:
      file: docker-compose.yml
      service: postgres

  redis:
    extends:
      file: docker-compose.yml
      service: redis
```

**Step 3: Commit**

```bash
git add docker-compose.yml docker-compose.dev.yml
git commit -m "chore: add docker-compose for postgres and redis"
```

---

## Phase 2: API Server

### Task 5: Setup API Package with Prisma

**Files:**
- Create: `packages/api/package.json`
- Create: `packages/api/tsconfig.json`
- Create: `packages/api/prisma/schema.prisma`

**Step 1: Create packages/api/package.json**

```json
{
  "name": "@debates/api",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "build": "tsc",
    "dev": "tsx watch src/server.ts",
    "start": "node dist/server.js",
    "db:generate": "prisma generate",
    "db:migrate": "prisma migrate dev",
    "db:push": "prisma db push",
    "db:studio": "prisma studio"
  },
  "dependencies": {
    "@debates/shared": "*",
    "@prisma/client": "^5.9.0",
    "express": "^4.18.2",
    "ws": "^8.16.0",
    "cors": "^2.8.5",
    "helmet": "^7.1.0",
    "jsonwebtoken": "^9.0.2",
    "bullmq": "^5.1.0",
    "ioredis": "^5.3.2",
    "zod": "^3.22.4",
    "dotenv": "^16.4.0"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/ws": "^8.5.10",
    "@types/cors": "^2.8.17",
    "@types/jsonwebtoken": "^9.0.5",
    "prisma": "^5.9.0",
    "tsx": "^4.7.0"
  }
}
```

**Step 2: Create packages/api/tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

**Step 3: Create packages/api/prisma/schema.prisma**

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id            String    @id @default(uuid())
  discordId     String?   @unique
  telegramId    String    @unique
  displayName   String
  language      String    @default("en")
  isAdmin       Boolean   @default(false)
  rating        Float     @default(1500)
  ratingMu      Float     @default(25)
  ratingSigma   Float     @default(8.333)
  categoryRanks Json?
  gamesPlayed   Int       @default(0)
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt

  createdGames     Game[]            @relation("GameCreator")
  invitations      GameInvitation[]
  participations   GameParticipant[]
  linkCodes        LinkCode[]
}

model Game {
  id                 String    @id @default(uuid())
  guildId            String
  guildName          String
  status             String    @default("scheduled")
  format             Json
  motionId           String?
  motionText         String?
  mainChannelId      String?
  govChannelId       String?
  oppChannelId       String?
  scheduledAt        DateTime
  startedAt          DateTime?
  endedAt            DateTime?
  pausedAt           DateTime?
  totalPauseDuration Int       @default(0)
  summaryComment     String?
  reminderSchedule   Json      @default("[10080, 1440, 60]")
  remindersSent      Json      @default("[]")
  createdById        String
  createdAt          DateTime  @default(now())
  updatedAt          DateTime  @updatedAt

  createdBy    User              @relation("GameCreator", fields: [createdById], references: [id])
  motion       Motion?           @relation(fields: [motionId], references: [id])
  invitations  GameInvitation[]
  participants GameParticipant[]
  messages     GameMessage[]

  @@index([guildId])
  @@index([status])
  @@index([scheduledAt])
}

model GameInvitation {
  id          String    @id @default(uuid())
  gameId      String
  userId      String
  status      String    @default("pending")
  invitedAt   DateTime  @default(now())
  respondedAt DateTime?

  game Game @relation(fields: [gameId], references: [id], onDelete: Cascade)
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([gameId, userId])
}

model GameParticipant {
  id               String  @id @default(uuid())
  gameId           String
  userId           String
  team             String
  speakingOrder    Json    @default("[]")
  speechRecordings Json    @default("[]")
  aiAnalysis       Json?
  aiFeedback       String?

  game Game @relation(fields: [gameId], references: [id], onDelete: Cascade)
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([gameId, userId])
}

model GameMessage {
  id        String   @id @default(uuid())
  gameId    String
  subject   String
  message   String
  sentTo    String
  sentAt    DateTime @default(now())

  game Game @relation(fields: [gameId], references: [id], onDelete: Cascade)
}

model Motion {
  id        String   @id @default(uuid())
  text      Json
  category  String
  source    String   @default("admin_created")
  approved  Boolean  @default(false)
  usedCount Int      @default(0)
  createdAt DateTime @default(now())

  games Game[]

  @@index([category])
  @@index([approved])
}

model LinkCode {
  id        String   @id @default(uuid())
  code      String   @unique
  userId    String
  expiresAt DateTime
  createdAt DateTime @default(now())

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([code])
  @@index([expiresAt])
}

model Settings {
  key   String @id
  value Json
}
```

**Step 4: Commit**

```bash
git add packages/api
git commit -m "feat(api): initialize api package with prisma schema"
```

---

### Task 6: Create API Server Foundation

**Files:**
- Create: `packages/api/src/server.ts`
- Create: `packages/api/src/config.ts`
- Create: `packages/api/src/db.ts`
- Create: `packages/api/src/redis.ts`

**Step 1: Create packages/api/src/config.ts**

```typescript
import 'dotenv/config';

export const config = {
  port: parseInt(process.env.PORT || '3000'),
  databaseUrl: process.env.DATABASE_URL!,
  redisUrl: process.env.REDIS_URL!,
  jwtSecret: process.env.JWT_SECRET!,
  discord: {
    botToken: process.env.DISCORD_BOT_TOKEN!,
    clientId: process.env.DISCORD_CLIENT_ID!,
    clientSecret: process.env.DISCORD_CLIENT_SECRET!,
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN!,
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY!,
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY!,
  },
} as const;
```

**Step 2: Create packages/api/src/db.ts**

```typescript
import { PrismaClient } from '@prisma/client';

export const db = new PrismaClient();

export async function connectDb() {
  await db.$connect();
  console.log('Database connected');
}

export async function disconnectDb() {
  await db.$disconnect();
  console.log('Database disconnected');
}
```

**Step 3: Create packages/api/src/redis.ts**

```typescript
import Redis from 'ioredis';
import { config } from './config.js';

export const redis = new Redis(config.redisUrl);

redis.on('connect', () => {
  console.log('Redis connected');
});

redis.on('error', (err) => {
  console.error('Redis error:', err);
});
```

**Step 4: Create packages/api/src/server.ts**

```typescript
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { connectDb } from './db.js';
import { redis } from './redis.js';

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.use(helmet());
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

wss.on('connection', (ws) => {
  console.log('WebSocket client connected');

  ws.on('message', (data) => {
    console.log('Received:', data.toString());
  });

  ws.on('close', () => {
    console.log('WebSocket client disconnected');
  });
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
git commit -m "feat(api): add server foundation with express and websocket"
```

---

## Phase 3: Discord Bot

### Task 7: Setup Discord Bot Package

**Files:**
- Create: `packages/discord-bot/package.json`
- Create: `packages/discord-bot/tsconfig.json`
- Create: `packages/discord-bot/src/bot.ts`
- Create: `packages/discord-bot/src/config.ts`

**Step 1: Create packages/discord-bot/package.json**

```json
{
  "name": "@debates/discord-bot",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "build": "tsc",
    "dev": "tsx watch src/bot.ts",
    "start": "node dist/bot.js"
  },
  "dependencies": {
    "@debates/shared": "*",
    "discord.js": "^14.14.1",
    "@discordjs/voice": "^0.16.1",
    "@discordjs/opus": "^0.9.0",
    "prism-media": "^1.3.5",
    "sodium-native": "^4.0.4",
    "ioredis": "^5.3.2",
    "dotenv": "^16.4.0"
  },
  "devDependencies": {
    "tsx": "^4.7.0"
  }
}
```

**Step 2: Create packages/discord-bot/tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

**Step 3: Create packages/discord-bot/src/config.ts**

```typescript
import 'dotenv/config';

export const config = {
  token: process.env.DISCORD_BOT_TOKEN!,
  clientId: process.env.DISCORD_CLIENT_ID!,
  redisUrl: process.env.REDIS_URL!,
  apiUrl: process.env.API_URL || 'http://localhost:3000',
} as const;
```

**Step 4: Create packages/discord-bot/src/bot.ts**

```typescript
import { Client, GatewayIntentBits, Events } from 'discord.js';
import { config } from './config.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ],
});

client.once(Events.ClientReady, (c) => {
  console.log(`Discord bot ready! Logged in as ${c.user.tag}`);
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  console.log(`Voice state update: ${newState.member?.displayName}`);
});

client.login(config.token);
```

**Step 5: Commit**

```bash
git add packages/discord-bot
git commit -m "feat(discord-bot): initialize discord bot package"
```

---

## Phase 4: Telegram Bot

### Task 8: Setup Telegram Bot Package

**Files:**
- Create: `packages/telegram-bot/package.json`
- Create: `packages/telegram-bot/tsconfig.json`
- Create: `packages/telegram-bot/src/bot.ts`
- Create: `packages/telegram-bot/src/config.ts`

**Step 1: Create packages/telegram-bot/package.json**

```json
{
  "name": "@debates/telegram-bot",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "build": "tsc",
    "dev": "tsx watch src/bot.ts",
    "start": "node dist/bot.js"
  },
  "dependencies": {
    "@debates/shared": "*",
    "grammy": "^1.21.1",
    "ioredis": "^5.3.2",
    "dotenv": "^16.4.0"
  },
  "devDependencies": {
    "tsx": "^4.7.0"
  }
}
```

**Step 2: Create packages/telegram-bot/tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

**Step 3: Create packages/telegram-bot/src/config.ts**

```typescript
import 'dotenv/config';

export const config = {
  token: process.env.TELEGRAM_BOT_TOKEN!,
  redisUrl: process.env.REDIS_URL!,
  apiUrl: process.env.API_URL || 'http://localhost:3000',
} as const;
```

**Step 4: Create packages/telegram-bot/src/bot.ts**

```typescript
import { Bot, InlineKeyboard } from 'grammy';
import { config } from './config.js';
import { t, Language } from '@debates/shared';

const bot = new Bot(config.token);

bot.command('start', async (ctx) => {
  const keyboard = new InlineKeyboard()
    .text('English', 'lang:en')
    .text('Русский', 'lang:ru')
    .text('日本語', 'lang:ja');

  await ctx.reply(t('en', 'telegram.welcome') + '\n\n' + t('en', 'telegram.chooseLanguage'), {
    reply_markup: keyboard,
  });
});

bot.callbackQuery(/^lang:(.+)$/, async (ctx) => {
  const lang = ctx.match[1] as Language;
  const code = Math.random().toString(36).substring(2, 8).toUpperCase();

  await ctx.answerCallbackQuery();
  await ctx.reply(t(lang, 'telegram.linkCode', { code }));
});

bot.command('stats', async (ctx) => {
  await ctx.reply('Stats command - TODO');
});

bot.command('upcoming', async (ctx) => {
  await ctx.reply('Upcoming games - TODO');
});

bot.start();
console.log('Telegram bot started');
```

**Step 5: Commit**

```bash
git add packages/telegram-bot
git commit -m "feat(telegram-bot): initialize telegram bot package"
```

---

## Phase 5: Frontend Applications

### Task 9: Setup Discord Activity Package

**Files:**
- Create: `packages/activity/package.json`
- Create: `packages/activity/tsconfig.json`
- Create: `packages/activity/vite.config.ts`
- Create: `packages/activity/index.html`
- Create: `packages/activity/src/main.tsx`
- Create: `packages/activity/src/App.tsx`

**Step 1: Create packages/activity/package.json**

```json
{
  "name": "@debates/activity",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@debates/shared": "*",
    "@discord/embedded-app-sdk": "^1.2.0",
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "react-i18next": "^14.0.1",
    "i18next": "^23.7.16"
  },
  "devDependencies": {
    "@types/react": "^18.2.48",
    "@types/react-dom": "^18.2.18",
    "@vitejs/plugin-react": "^4.2.1",
    "vite": "^5.0.12",
    "typescript": "^5.3.3"
  }
}
```

**Step 2: Create packages/activity/tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src"]
}
```

**Step 3: Create packages/activity/vite.config.ts**

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    hmr: {
      clientPort: 443,
    },
  },
});
```

**Step 4: Create packages/activity/index.html**

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Debate Helper</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

**Step 5: Create packages/activity/src/main.tsx**

```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

**Step 6: Create packages/activity/src/App.tsx**

```tsx
import { useEffect, useState } from 'react';
import { DiscordSDK } from '@discord/embedded-app-sdk';

const discordSdk = new DiscordSDK(import.meta.env.VITE_DISCORD_CLIENT_ID);

function App() {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<{ username: string } | null>(null);

  useEffect(() => {
    async function setup() {
      await discordSdk.ready();

      const { code } = await discordSdk.commands.authorize({
        client_id: import.meta.env.VITE_DISCORD_CLIENT_ID,
        response_type: 'code',
        state: '',
        prompt: 'none',
        scope: ['identify', 'guilds'],
      });

      const response = await fetch('/api/auth/discord', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });

      const { user } = await response.json();
      setUser(user);
      setReady(true);
    }

    setup();
  }, []);

  if (!ready) {
    return <div>Loading...</div>;
  }

  return (
    <div>
      <h1>Debate Helper</h1>
      <p>Welcome, {user?.username}!</p>
    </div>
  );
}

export default App;
```

**Step 7: Commit**

```bash
git add packages/activity
git commit -m "feat(activity): initialize discord activity package"
```

---

### Task 10: Setup Web Admin Package

**Files:**
- Create: `packages/admin/package.json`
- Create: `packages/admin/tsconfig.json`
- Create: `packages/admin/vite.config.ts`
- Create: `packages/admin/index.html`
- Create: `packages/admin/src/main.tsx`
- Create: `packages/admin/src/App.tsx`

**Step 1: Create packages/admin/package.json**

```json
{
  "name": "@debates/admin",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@debates/shared": "*",
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "react-router-dom": "^6.21.3",
    "@tanstack/react-query": "^5.17.19"
  },
  "devDependencies": {
    "@types/react": "^18.2.48",
    "@types/react-dom": "^18.2.18",
    "@vitejs/plugin-react": "^4.2.1",
    "vite": "^5.0.12",
    "typescript": "^5.3.3"
  }
}
```

**Step 2: Create packages/admin/tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src"]
}
```

**Step 3: Create packages/admin/vite.config.ts**

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
});
```

**Step 4: Create packages/admin/index.html**

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Debate Admin</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

**Step 5: Create packages/admin/src/main.tsx**

```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';

const queryClient = new QueryClient();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
);
```

**Step 6: Create packages/admin/src/App.tsx**

```tsx
import { Routes, Route, Link } from 'react-router-dom';

function Dashboard() {
  return <div><h2>Dashboard</h2><p>Welcome to Debate Admin</p></div>;
}

function Games() {
  return <div><h2>Games</h2><p>Game management - TODO</p></div>;
}

function Motions() {
  return <div><h2>Motions</h2><p>Motion management - TODO</p></div>;
}

function Users() {
  return <div><h2>Users</h2><p>User management - TODO</p></div>;
}

function App() {
  return (
    <div>
      <nav>
        <Link to="/">Dashboard</Link> |{' '}
        <Link to="/games">Games</Link> |{' '}
        <Link to="/motions">Motions</Link> |{' '}
        <Link to="/users">Users</Link>
      </nav>
      <hr />
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/games" element={<Games />} />
        <Route path="/motions" element={<Motions />} />
        <Route path="/users" element={<Users />} />
      </Routes>
    </div>
  );
}

export default App;
```

**Step 7: Commit**

```bash
git add packages/admin
git commit -m "feat(admin): initialize web admin package"
```

---

## Phase 6: Core Features (Continued in Part 2)

The implementation continues with:
- Task 11-15: API routes (auth, games, motions, users, invitations)
- Task 16-20: Discord bot features (channel management, voice recording, muting)
- Task 21-25: Telegram bot features (registration, notifications, feedback)
- Task 26-35: Activity screens (setup, preparation, debate, results)
- Task 36-40: Admin pages (dashboard, games, motions, users, settings)
- Task 41-45: AI integration (Whisper, Claude, GPT)
- Task 46-50: Deployment (nginx, Docker, SSL)

See `2026-01-29-debates-helper-implementation-part2.md` for continuation.
