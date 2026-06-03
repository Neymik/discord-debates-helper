import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { notFoundHandler, errorHandler } from "./errorHandler.js";

function appWithThrow() {
  const app = express();
  app.get("/boom", () => {
    throw new Error("kaboom");
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
});
