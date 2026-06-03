CREATE UNIQUE INDEX "one_active_recording_per_guild"
  ON "recording_sessions" ("guild_id")
  WHERE "status" = 'recording';
