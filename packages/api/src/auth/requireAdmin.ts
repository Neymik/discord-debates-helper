import type { Request, Response, NextFunction } from "express";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      adminUserId?: string;
    }
  }
}

import { buildConfig } from "../config.js";
import { SESSION_COOKIE, verifySession } from "./session.js";

const config = buildConfig();

export async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (process.env.NODE_ENV === "test") {
    const id = req.header("x-test-admin-id");
    if (id) {
      req.adminUserId = id;
      return next();
    }
  }
  const token = (req as Request & { cookies?: Record<string, string> }).cookies?.[SESSION_COOKIE];
  if (!token) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  try {
    req.adminUserId = await verifySession(token, config.jwtSecret);
    next();
  } catch {
    res.status(401).json({ error: "unauthorized" });
  }
}
