-- CreateEnum
CREATE TYPE "GameStatus" AS ENUM ('scheduled', 'cancelled');

-- CreateEnum
CREATE TYPE "RecordingStatus" AS ENUM ('recording', 'completed', 'failed');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "telegram_user_id" BIGINT NOT NULL,
    "telegram_username" TEXT,
    "discord_user_id" TEXT,
    "display_name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "link_codes" (
    "code" TEXT NOT NULL,
    "telegram_user_id" BIGINT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),

    CONSTRAINT "link_codes_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "games" (
    "id" UUID NOT NULL,
    "scheduled_at" TIMESTAMPTZ(6) NOT NULL,
    "motion" TEXT,
    "status" "GameStatus" NOT NULL DEFAULT 'scheduled',
    "created_by" UUID NOT NULL,
    "cancelled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "games_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_participants" (
    "game_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,

    CONSTRAINT "game_participants_pkey" PRIMARY KEY ("game_id","user_id")
);

-- CreateTable
CREATE TABLE "recording_sessions" (
    "id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(6),
    "started_by_discord_user_id" TEXT NOT NULL,
    "voice_channel_id" TEXT NOT NULL,
    "voice_channel_name" TEXT NOT NULL,
    "guild_id" TEXT NOT NULL,
    "file_dir" TEXT NOT NULL,
    "status" "RecordingStatus" NOT NULL DEFAULT 'recording',

    CONSTRAINT "recording_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recording_files" (
    "session_id" UUID NOT NULL,
    "discord_user_id" TEXT NOT NULL,
    "user_id" UUID,
    "discord_username" TEXT NOT NULL,
    "file_path" TEXT NOT NULL,
    "duration_sec" INTEGER NOT NULL,
    "size_bytes" BIGINT NOT NULL,

    CONSTRAINT "recording_files_pkey" PRIMARY KEY ("session_id","discord_user_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_telegram_user_id_key" ON "users"("telegram_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_discord_user_id_key" ON "users"("discord_user_id");

-- AddForeignKey
ALTER TABLE "link_codes" ADD CONSTRAINT "link_codes_telegram_user_id_fkey" FOREIGN KEY ("telegram_user_id") REFERENCES "users"("telegram_user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "games" ADD CONSTRAINT "games_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_participants" ADD CONSTRAINT "game_participants_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_participants" ADD CONSTRAINT "game_participants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recording_files" ADD CONSTRAINT "recording_files_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "recording_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recording_files" ADD CONSTRAINT "recording_files_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
