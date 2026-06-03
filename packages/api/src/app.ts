import "express-async-errors";
import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import { notFoundHandler, errorHandler } from "./middleware/errorHandler.js";
import { gamesRouter } from "./routes/games.js";
import { recordingsRouter } from "./routes/recordings.js";
import { adminAuthRouter } from "./routes/adminAuth.js";
import { linkRouter } from "./routes/link.js";
import { usersRouter } from "./routes/users.js";

/** Builds the Express app without binding a port (so tests can use supertest). */
export function createApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use("/api/admin", adminAuthRouter);
  app.use("/api/games", gamesRouter);
  app.use("/api/recordings", recordingsRouter);
  app.use("/api/link", linkRouter);
  app.use("/api/users", usersRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
