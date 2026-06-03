import "express-async-errors";
import express, { type Express } from "express";
import { notFoundHandler, errorHandler } from "./middleware/errorHandler.js";
import { gamesRouter } from "./routes/games.js";
import { recordingsRouter } from "./routes/recordings.js";

/** Builds the Express app without binding a port (so tests can use supertest). */
export function createApp(): Express {
  const app = express();
  app.use(express.json());

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use("/api/games", gamesRouter);
  app.use("/api/recordings", recordingsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
