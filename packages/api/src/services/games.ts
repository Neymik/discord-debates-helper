import { prisma } from "../prisma.js";
import { enqueueGameJobs, removeGameJobs, rescheduleGameJobs } from "../scheduler/scheduler.js";

export interface CreateGameInput {
  scheduledAt: Date;
  motion: string | null;
  createdById: string;
  participantUserIds: string[];
}

export async function createGame(input: CreateGameInput) {
  const game = await prisma.game.create({
    data: {
      scheduledAt: input.scheduledAt,
      motion: input.motion,
      createdById: input.createdById,
      participants: { create: input.participantUserIds.map((userId) => ({ userId })) },
    },
    include: { participants: true },
  });
  await enqueueGameJobs(game.id, game.scheduledAt);
  return game;
}

export async function listGames(filter: { status?: "scheduled" | "cancelled"; from?: Date; to?: Date }) {
  return prisma.game.findMany({
    where: {
      status: filter.status,
      scheduledAt: { gte: filter.from, lte: filter.to },
    },
    orderBy: { scheduledAt: "asc" },
    include: { participants: true },
  });
}

export async function getGame(id: string) {
  return prisma.game.findUnique({ where: { id }, include: { participants: true } });
}

export interface UpdateGameInput {
  scheduledAt?: Date;
  motion?: string | null;
  participantUserIds?: string[];
}

export async function updateGame(id: string, input: UpdateGameInput) {
  const existing = await prisma.game.findUnique({ where: { id } });
  if (!existing) return null;

  const game = await prisma.$transaction(async (tx) => {
    if (input.participantUserIds) {
      await tx.gameParticipant.deleteMany({ where: { gameId: id } });
      await tx.gameParticipant.createMany({
        data: input.participantUserIds.map((userId) => ({ gameId: id, userId })),
      });
    }
    return tx.game.update({
      where: { id },
      data: { scheduledAt: input.scheduledAt, motion: input.motion },
      include: { participants: true },
    });
  });

  if (input.scheduledAt && input.scheduledAt.getTime() !== existing.scheduledAt.getTime()) {
    await rescheduleGameJobs(id, game.scheduledAt);
  }
  return game;
}

export async function cancelGame(id: string) {
  const existing = await prisma.game.findUnique({ where: { id } });
  if (!existing) return null;
  const game = await prisma.game.update({
    where: { id },
    data: { status: "cancelled", cancelledAt: new Date() },
  });
  await removeGameJobs(id);
  return game;
}
