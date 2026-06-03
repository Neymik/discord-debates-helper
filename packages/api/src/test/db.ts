import { prisma } from "../prisma.js";

/** Wipes all domain tables. Call in beforeEach for integration tests. */
export async function truncateAll(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE
       recording_files, recording_sessions,
       game_participants, games, link_codes, users
     RESTART IDENTITY CASCADE;`,
  );
}
