import { Router } from "express";
import { z } from "zod";
import { requireAdmin } from "../auth/requireAdmin.js";
import * as games from "../services/games.js";

const CreateBody = z.object({
  scheduled_at: z.string().datetime(),
  motion: z.string().max(2000).nullish(),
  participant_user_ids: z.array(z.string().uuid()).default([]),
});

const UpdateBody = z.object({
  scheduled_at: z.string().datetime().optional(),
  motion: z.string().max(2000).nullish(),
  participant_user_ids: z.array(z.string().uuid()).optional(),
});

const ListQuery = z.object({
  status: z.enum(["scheduled", "cancelled"]).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export const gamesRouter = Router();
gamesRouter.use(requireAdmin);

gamesRouter.get("/", async (req, res) => {
  const q = ListQuery.parse(req.query);
  res.json(
    await games.listGames({
      status: q.status,
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
    }),
  );
});

gamesRouter.post("/", async (req, res) => {
  const body = CreateBody.parse(req.body);
  const game = await games.createGame({
    scheduledAt: new Date(body.scheduled_at),
    motion: body.motion ?? null,
    createdById: req.adminUserId!,
    participantUserIds: body.participant_user_ids,
  });
  res.status(201).json(game);
});

gamesRouter.get("/:id", async (req, res) => {
  const game = await games.getGame(req.params.id);
  if (!game) return res.status(404).json({ error: "not_found" });
  res.json(game);
});

gamesRouter.patch("/:id", async (req, res) => {
  const body = UpdateBody.parse(req.body);
  const game = await games.updateGame(req.params.id, {
    scheduledAt: body.scheduled_at ? new Date(body.scheduled_at) : undefined,
    motion: body.motion === undefined ? undefined : body.motion ?? null,
    participantUserIds: body.participant_user_ids,
  });
  if (!game) return res.status(404).json({ error: "not_found" });
  res.json(game);
});

gamesRouter.post("/:id/cancel", async (req, res) => {
  const game = await games.cancelGame(req.params.id);
  if (!game) return res.status(404).json({ error: "not_found" });
  res.json(game);
});
