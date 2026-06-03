import type { Request, Response, NextFunction } from "express";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      adminUserId?: string;
    }
  }
}

/**
 * Admin guard. Real cookie/JWT verification is added in Task 7 (verifySession).
 * In tests (NODE_ENV==='test') it trusts the `x-test-admin-id` header so router
 * tests don't need a full login round-trip.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (process.env.NODE_ENV === "test") {
    const id = req.header("x-test-admin-id");
    if (id) {
      req.adminUserId = id;
      return next();
    }
  }
  // Replaced/extended by real session verification in Task 7.
  if (req.adminUserId) return next();
  res.status(401).json({ error: "unauthorized" });
}
