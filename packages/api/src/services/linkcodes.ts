import { randomInt } from "node:crypto";
import { prisma } from "../prisma.js";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous 0/O/1/I
const EXPIRY_MS = 24 * 3600 * 1000;

export function generateCode(): string {
  let suffix = "";
  for (let i = 0; i < 4; i++) suffix += ALPHABET[randomInt(ALPHABET.length)];
  return `LINK-${suffix}`;
}

export async function issueCode(telegramUserId: bigint): Promise<{ code: string; expires_at: Date }> {
  const code = generateCode();
  const expiresAt = new Date(Date.now() + EXPIRY_MS);
  await prisma.linkCode.create({ data: { code, telegramUserId, expiresAt } });
  return { code, expires_at: expiresAt };
}

export async function redeemCode(
  code: string,
  discordUserId: string,
  _discordUsername: string,
): Promise<{ telegram_user_id: number; display_name: string } | null> {
  return prisma.$transaction(async (tx) => {
    const row = await tx.linkCode.findUnique({ where: { code } });
    if (!row || row.usedAt || row.expiresAt < new Date()) return null;

    await tx.linkCode.update({ where: { code }, data: { usedAt: new Date() } });
    const user = await tx.user.update({
      where: { telegramUserId: row.telegramUserId },
      data: { discordUserId },
    });
    return { telegram_user_id: Number(user.telegramUserId), display_name: user.displayName };
  });
}
