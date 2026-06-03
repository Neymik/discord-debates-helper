import { Router } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { requireAdmin } from "../auth/requireAdmin.js";

export const usersRouter = Router();
usersRouter.use(requireAdmin);

usersRouter.get("/", async (_req, res) => {
  const users = await prisma.user.findMany({ orderBy: { createdAt: "desc" } });
  res.json(
    users.map((u) => ({
      id: u.id,
      telegram_username: u.telegramUsername,
      display_name: u.displayName,
      linked: u.discordUserId !== null,
      created_at: u.createdAt,
    })),
  );
});

usersRouter.post<{ id: string }>("/:id/unlink-discord", async (req, res) => {
  const user = await prisma.user
    .update({ where: { id: req.params.id }, data: { discordUserId: null } })
    .catch((e: unknown) => {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") return null;
      throw e;
    });
  if (!user) return res.status(404).json({ error: "not_found" });
  res.json({ id: user.id, linked: false });
});
