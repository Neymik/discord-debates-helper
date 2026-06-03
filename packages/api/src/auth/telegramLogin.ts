import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export interface TelegramLoginUser {
  id: bigint;
  first_name: string;
  last_name?: string;
  username?: string;
}

const MAX_AGE_SEC = 24 * 3600;

/** Verifies a Telegram Login Widget payload per Telegram's published formula. */
export function verifyTelegramLogin(
  payload: Record<string, string>,
  botToken: string,
  nowSec = Math.floor(Date.now() / 1000),
): TelegramLoginUser {
  const { hash, ...data } = payload;
  if (!hash) throw new Error("missing signature");

  const checkString = Object.keys(data).sort().map((k) => `${k}=${data[k]}`).join("\n");
  const secret = createHash("sha256").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(checkString).digest("hex");

  const a = Buffer.from(hash);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error("invalid signature");

  const authDate = Number(data.auth_date);
  if (!Number.isFinite(authDate) || nowSec - authDate > MAX_AGE_SEC) {
    throw new Error("login expired");
  }

  if (!data.id) throw new Error("invalid signature");

  return {
    id: BigInt(data.id),
    first_name: data.first_name ?? "",
    last_name: data.last_name,
    username: data.username,
  };
}
