import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";
import { requireBotToken } from "./botAuth.js";

function mockRes() {
  const res = {} as Response;
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

describe("requireBotToken", () => {
  const mw = requireBotToken("secret-token-value");

  it("calls next() when the Bearer token matches", () => {
    const req = { headers: { authorization: "Bearer secret-token-value" } } as Request;
    const res = mockRes();
    const next = vi.fn();
    mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("returns 401 when the header is missing", () => {
    const req = { headers: {} } as Request;
    const res = mockRes();
    const next = vi.fn();
    mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when the token does not match", () => {
    const req = { headers: { authorization: "Bearer wrong" } } as Request;
    const res = mockRes();
    const next = vi.fn();
    mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});

describe("requireBotToken misconfiguration & robustness", () => {
  it("throws at construction when the expected token is empty", () => {
    expect(() => requireBotToken("")).toThrow();
  });

  it("returns 401 when the authorization header is an array", () => {
    const mw = requireBotToken("secret-token-value");
    const req = { headers: { authorization: ["Bearer secret-token-value"] } } as unknown as Request;
    const res = mockRes();
    const next = vi.fn();
    mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
