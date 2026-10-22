import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ sendEmail: vi.fn(), recordAdminAudit: vi.fn() }));
vi.mock("../../src/providers/email.provider.js", () => ({ sendEmail: mocks.sendEmail }));
vi.mock("../../src/services/admin-audit.service.js", () => ({ recordAdminAudit: mocks.recordAdminAudit }));
vi.mock("../../src/db.js", () => ({ withTransaction: (fn: (db: unknown) => unknown) => fn({}), pool: {} }));

import { PermanentProviderError, ProviderDeferredError, ProviderTimeoutError, toProviderHttpError } from "../../src/providers/provider-errors.js";
import { connectionsRouter } from "../../src/routes/connections.routes.js";
import { errorMiddleware } from "../../src/errorMiddleware.js";
import { AppError } from "../../src/errors.js";

describe("toProviderHttpError", () => {
  it.each([
    [new PermanentProviderError("Resend rejected the request: API key is invalid"), 400, "provider_rejected", "Email test failed: Resend rejected the request: API key is invalid"],
    [new ProviderDeferredError("Email connection is not configured."), 503, "provider_unavailable", "Email test failed: Email connection is not configured."],
    [new ProviderTimeoutError("Resend request timed out after 15s"), 504, "provider_timeout", "Email test failed: Resend request timed out after 15s"],
    [Object.assign(new Error("connect ECONNREFUSED 10.0.0.9:587"), { code: "ECONNREFUSED" }), 502, "provider_error", "Email test failed: connect ECONNREFUSED 10.0.0.9:587"],
  ])("maps %o to %i", (error, status, code, message) => {
    expect(toProviderHttpError(error, "Email test failed")).toMatchObject({ status, code, message });
  });

  it("leaves database errors and AppErrors for the error middleware", () => {
    const dbError = Object.assign(new Error("db"), { code: "23505" });
    expect(toProviderHttpError(dbError, "x")).toBe(dbError);
    const appError = new AppError(404, "not_found", "Nope.");
    expect(toProviderHttpError(appError, "x")).toBe(appError);
  });
});

describe("POST /connections/email/test", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { id: "u-1", fullName: "Test", email: "t@example.com", isActive: true, role: "salesperson" };
      req.workspaceId = "6d1f3f6e-1234-4abc-8def-0123456789ab";
      next();
    });
    app.use("/connections", connectionsRouter);
    app.use(errorMiddleware);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const test = () =>
    fetch(`${base}/connections/email/test`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to: "a@example.com" }) });

  it.each([
    [new PermanentProviderError("Resend rejected the request: API key is invalid"), 400, "Email test failed: Resend rejected the request: API key is invalid"],
    [new ProviderDeferredError("SMTP is not fully configured."), 503, "Email test failed: SMTP is not fully configured."],
    [new ProviderTimeoutError("The SMTP server did not respond in time: Connection timeout"), 504, "Email test failed: The SMTP server did not respond in time: Connection timeout"],
  ])("returns a clear %#th provider failure and records the failed test", async (error, status, message) => {
    mocks.sendEmail.mockRejectedValueOnce(error);
    mocks.recordAdminAudit.mockClear();
    const res = await test();
    expect(res.status).toBe(status);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(message);
    expect(mocks.recordAdminAudit).toHaveBeenCalledWith(expect.anything(), expect.anything(), "connection.email.test_failed", expect.anything(), expect.anything(), expect.anything());
  });

  it("still returns ok on success", async () => {
    mocks.sendEmail.mockResolvedValueOnce({ providerMessageId: "msg-1" });
    const res = await test();
    expect(await res.json()).toEqual({ ok: true, providerMessageId: "msg-1" });
  });
});
