import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: "not_found" });
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ZodError) {
    res.status(400).json({ error: "validation_error", issues: err.issues });
    return;
  }
  console.error("[api] unhandled error:", err);
  res.status(500).json({ error: "internal_error" });
}
