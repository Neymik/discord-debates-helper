import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Guards bot-only endpoints by comparing the Bearer token to `expected`. */
export function requireBotToken(expected: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization ?? "";
    const prefix = "Bearer ";
    if (!header.startsWith(prefix) || !safeEqual(header.slice(prefix.length), expected)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}
