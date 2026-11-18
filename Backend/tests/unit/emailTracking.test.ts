import type { AddressInfo } from "node:net";
import express from "express";
import { describe, expect, it, vi } from "vitest";
import {
  createRateLimiter,
  isTrackedSource,
  newOpenToken,
  OPEN_TOKEN_RE,
  parsePublicApiBaseUrl,
  TRANSPARENT_GIF,
  withOpenPixel,
} from "../../src/domain/emailTracking.js";
import { createTrackingRouter } from "../../src/routes/tracking.routes.js";

describe("E3b-2b open tracking (domain)", () => {
  it("tokens: 128 random bits, URL-safe, unique; the format check rejects anything else", () => {
    const tokens = new Set(Array.from({ length: 200 }, newOpenToken));
    expect(tokens.size).toBe(200);
    for (const t of tokens) expect(t).toMatch(OPEN_TOKEN_RE);
    for (const bad of ["", "abc", `${newOpenToken()}x`, "a".repeat(21) + "/", "../../etc/passwd.....", "a".repeat(21) + "="]) expect(OPEN_TOKEN_RE.test(bad)).toBe(false);
  });

  it("only AI agent and workflow emails are tracked", () => {
    expect(["agent", "scheduled_action"].every((s) => isTrackedSource(s as never))).toBe(true);
    expect(["reply_draft", "proposal", "meeting", "test"].some((s) => isTrackedSource(s as never))).toBe(false);
  });

  it("the pixel goes at the end of the HTML (before </body> when present), nothing else changes", () => {
    const img = '<img src="https://api.example.com/t/o/TOKEN.gif" width="1" height="1" alt="" style="display:block;border:0">';
    expect(withOpenPixel("<p>Hi</p>", "https://api.example.com", "TOKEN")).toBe(`<p>Hi</p>${img}`);
    expect(withOpenPixel("<html><body><p>Hi</p></BODY></html>", "https://api.example.com", "TOKEN")).toBe(`<html><body><p>Hi</p>${img}</BODY></html>`);
  });

  it("PUBLIC_API_BASE_URL: missing = off, malformed = startup error, https in production, no trailing slash", () => {
    expect(parsePublicApiBaseUrl(undefined, "production")).toBeUndefined();
    expect(parsePublicApiBaseUrl("  ", "production")).toBeUndefined();
    expect(parsePublicApiBaseUrl("https://api.example.com/", "production")).toBe("https://api.example.com");
    expect(parsePublicApiBaseUrl("http://localhost:8787", "development")).toBe("http://localhost:8787");
    expect(() => parsePublicApiBaseUrl("http://api.example.com", "production")).toThrow(/https in production/);
    expect(() => parsePublicApiBaseUrl("api.example.com", "development")).toThrow(/full URL/);
    expect(() => parsePublicApiBaseUrl("ftp://api.example.com", "development")).toThrow(/https/);
    expect(() => parsePublicApiBaseUrl("https://api.example.com/?x=1", "development")).toThrow(/query/);
  });

  it("the rate limiter allows `limit` per key per window", () => {
    let t = 0;
    const allowed = createRateLimiter(2, 60_000, () => t);
    expect([allowed("a"), allowed("a"), allowed("a"), allowed("b")]).toEqual([true, true, false, true]);
    t = 60_000;
    expect(allowed("a")).toBe(true);
  });
});

describe("E3b-2b GET /t/o/:token.gif (public, no database here)", () => {
  async function server(record: (token: string) => Promise<void>) {
    const app = express();
    app.use(createTrackingRouter(record));
    const s = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const l = app.listen(0, "127.0.0.1", () => resolve(l));
    });
    const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    return { get: (path: string) => fetch(`${base}${path}`), close: () => new Promise<void>((r) => s.close(() => r())) };
  }
  const expectGif = async (res: Response) => {
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/gif");
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(Buffer.from(await res.arrayBuffer()).equals(TRANSPARENT_GIF)).toBe(true);
  };

  it("always the same GIF; a malformed token never reaches the database; a valid one is recorded once per request", async () => {
    const record = vi.fn(async () => undefined);
    const s = await server(record);
    try {
      for (const path of ["/t/o/abc.gif", "/t/o/%27%3Bdrop.gif", `/t/o/${newOpenToken()}.png`, `/t/o/${newOpenToken()}`]) await expectGif(await s.get(path));
      expect(record).not.toHaveBeenCalled();
      const token = newOpenToken();
      await expectGif(await s.get(`/t/o/${token}.gif`));
      expect(record).toHaveBeenCalledWith(token);
    } finally {
      await s.close();
    }
  });

  it("a recording error still returns the GIF; over 60 requests a minute from one IP still get the GIF but record nothing", async () => {
    const record = vi.fn(async () => {
      throw Object.assign(new Error("db down"), { code: "ECONNREFUSED" });
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const s = await server(record);
    try {
      for (let i = 0; i < 61; i++) await expectGif(await s.get(`/t/o/${newOpenToken()}.gif`));
      expect(record).toHaveBeenCalledTimes(60);
    } finally {
      await s.close();
      errors.mockRestore();
    }
  });
});
