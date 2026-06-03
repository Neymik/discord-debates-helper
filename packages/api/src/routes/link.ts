import { Router } from "express";
import { IssueLinkBody, RedeemLinkBody } from "@debates/shared";
import { requireBotToken } from "../middleware/botAuth.js";
import { buildConfig } from "../config.js";
import { issueCode, redeemCode } from "../services/linkcodes.js";

const config = buildConfig();
export const linkRouter = Router();

// Telegram bot mints codes for unlinked participants.
linkRouter.post("/issue", requireBotToken(config.telegramBotApiToken), async (req, res) => {
  const body = IssueLinkBody.parse(req.body);
  const result = await issueCode(body.telegram_user_id);
  res.status(201).json(result);
});

// Discord bot redeems on /link.
linkRouter.post("/redeem", requireBotToken(config.discordBotApiToken), async (req, res) => {
  const body = RedeemLinkBody.parse(req.body);
  const result = await redeemCode(body.code, body.discord_user_id, body.discord_username);
  if (!result) return res.status(404).json({ error: "invalid_or_expired_code" });
  res.json(result);
});
