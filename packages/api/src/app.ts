import express, { type Express } from "express";
import { notFoundHandler, errorHandler } from "./middleware/errorHandler.js";

/** Builds the Express app without binding a port (so tests can use supertest). */
export function createApp(): Express {
  const app = express();
  app.use(express.json());

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Domain routers are mounted here in Plan 2.

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
