-- CreateIndex
CREATE INDEX "game_participants_user_id_idx" ON "game_participants"("user_id");

-- CreateIndex
CREATE INDEX "games_created_by_idx" ON "games"("created_by");

-- CreateIndex
CREATE INDEX "recording_files_user_id_idx" ON "recording_files"("user_id");
