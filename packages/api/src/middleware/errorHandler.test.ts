import "express-async-errors";
import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { z } from "zod";
import { notFoundHandler, errorHandler } from "./errorHandler.js";

function appWithThrow() {
  const app = express();
  app.get("/boom", () => {
    throw new Error("kaboom");
  });
  app.get("/zod", async () => {
    z.object({ n: z.number() }).parse({ n: "no" });
  });
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

describe("errorHandler", () => {
  it("returns 404 JSON for unknown routes", async () => {
    const res = await request(appWithThrow()).get("/nope");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
  });

  it("returns 500 JSON when a handler throws", async () => {
    const res = await request(appWithThrow()).get("/boom");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "internal_error" });
  });

  it("returns 400 for a thrown ZodError", async () => {
    const res = await request(appWithThrow()).get("/zod");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
    expect(Array.isArray(res.body.issues)).toBe(true);
  });
});
