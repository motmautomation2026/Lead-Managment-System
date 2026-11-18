import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Production mode: the 500 message must be generic and logging is on.
vi.mock("../../src/env.js", () => ({ env: { NODE_ENV: "production" } }));

import { errorMiddleware, requestIdMiddleware } from "../../src/errorMiddleware.js";
import { ValidationError } from "../../src/errors.js";

describe("request ids on errors", () => {
  let server: Server;
  let base: string;
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

  beforeAll(async () => {
    const app = express();
    app.use(requestIdMiddleware);
    app.get("/boom", () => {
      throw new Error("connect ECONNREFUSED 10.0.0.5:5432 password=hunter2");
    });
    app.get("/invalid", () => {
      throw new ValidationError("Bad input.");
    });
    app.get("/db", () => {
      throw Object.assign(new Error("new row violates check constraint"), { code: "23514", constraint: "leads_has_contact_channel" });
    });
    app.use(errorMiddleware);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("returns a generic 500 with the request id in the header, details and message, and logs the full error", async () => {
    consoleError.mockClear();
    const res = await fetch(`${base}/boom`);
    const body = (await res.json()) as { error: { code: string; message: string; details: { requestId: string } } };
    const requestId = res.headers.get("x-request-id")!;

    expect(res.status).toBe(500);
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.error).toEqual({ code: "internal_error", message: `Something went wrong. Reference: ${requestId}`, details: { requestId } });
    expect(JSON.stringify(body)).not.toContain("hunter2");

    expect(consoleError).toHaveBeenCalledOnce();
    const [line, err] = consoleError.mock.calls[0]!;
    expect(line).toContain(requestId);
    expect(line).toContain("GET /boom");
    expect((err as Error).stack).toContain("ECONNREFUSED");
  });

  it("reuses a well-formed incoming X-Request-Id", async () => {
    const res = await fetch(`${base}/boom`, { headers: { "X-Request-Id": "edge-abc.123" } });
    expect(res.headers.get("x-request-id")).toBe("edge-abc.123");
    expect(((await res.json()) as { error: { details: { requestId: string } } }).error.details.requestId).toBe("edge-abc.123");
  });

  it("replaces a malformed incoming X-Request-Id instead of logging it", async () => {
    const res = await fetch(`${base}/boom`, { headers: { "X-Request-Id": "bad id\twith spaces" } });
    expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("leaves 4xx bodies unchanged, but still sends the header", async () => {
    consoleError.mockClear();
    const res = await fetch(`${base}/invalid`);
    expect(res.status).toBe(400);
    expect(res.headers.get("x-request-id")).toBeTruthy();
    expect(await res.json()).toEqual({ error: { code: "invalid_input", message: "Bad input." } });
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("maps database errors through dbErrorMessages instead of a 500", async () => {
    const res = await fetch(`${base}/db`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe("A lead needs an email address or a phone number.");
  });
});
