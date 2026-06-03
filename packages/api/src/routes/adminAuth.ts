import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { buildConfig } from "../config.js";
import { verifyTelegramLogin } from "../auth/telegramLogin.js";
import { signSession, verifySession, SESSION_COOKIE } from "../auth/session.js";
import { loadEnv } from "@debates/shared";

const config = buildConfig();
const env = loadEnv();

export const adminAuthRouter = Router();

adminAuthRouter.post("/auth/telegram", async (req, res) => {
  const payload = z.record(z.string()).parse(req.body);
  let user;
  try {
    user = verifyTelegramLogin(payload, env.TELEGRAM_BOT_TOKEN);
  } catch {
    return res.status(401).json({ error: "invalid_login" });
  }
  if (!config.adminTelegramIds.includes(user.id)) {
    return res.status(403).json({ error: "not_admin" });
  }
  const displayName = [user.first_name, user.last_name].filter(Boolean).join(" ") || user.username || "Admin";
  const dbUser = await prisma.user.upsert({
    where: { telegramUserId: user.id },
    create: { telegramUserId: user.id, telegramUsername: user.username ?? null, displayName },
    update: { telegramUsername: user.username ?? null },
  });
  const token = await signSession(dbUser.id, config.jwtSecret);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 7 * 24 * 3600 * 1000,
  });
  res.json({ id: dbUser.id, display_name: dbUser.displayName });
});

adminAuthRouter.post("/auth/logout", (_req, res) => {
  res.clearCookie(SESSION_COOKIE);
  res.json({ ok: true });
});

adminAuthRouter.get("/me", async (req, res) => {
  const token = (req as typeof req & { cookies?: Record<string, string> }).cookies?.[SESSION_COOKIE];
  if (!token) return res.status(401).json({ error: "unauthorized" });
  try {
    const userId = await verifySession(token, config.jwtSecret);
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(401).json({ error: "unauthorized" });
    res.json({ id: user.id, display_name: user.displayName, telegram_username: user.telegramUsername });
  } catch {
    res.status(401).json({ error: "unauthorized" });
  }
});
