import express, { Router } from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const poolQuery = vi.hoisted(() => vi.fn());
vi.mock("../../src/db.js", () => ({ pool: { query: poolQuery } }));

import { z } from "zod";
import { isUuid, parseQuery, queryBoolean, uuidParam } from "../../src/validation/parse.js";
import { requireWorkspace } from "../../src/authMiddleware.js";
import { errorMiddleware } from "../../src/errorMiddleware.js";

const ID = "6d1f3f6e-1234-4abc-8def-0123456789ab";

describe("isUuid", () => {
  it.each([
    [ID, true],
    ["00000000-0000-0000-0000-000000000001", true], // the seeded MOTM workspace id
    ["not-a-uuid", false],
    ["6d1f3f6e12344abc8def0123456789ab", false],
    [`${ID}'; drop table leads; --`, false],
    ["", false],
    [undefined, false],
  ])("%s → %s", (value, expected) => {
    expect(isUuid(value)).toBe(expected);
  });
});

describe("uuid route params and the workspace header", () => {
  let server: Server;
  let base: string;
  const handler = vi.fn((_req: express.Request, res: express.Response) => res.json({ ok: true }));

  beforeAll(async () => {
    const templates = Router();
    templates.param("id", uuidParam("template"));
    templates.param("attachmentId", uuidParam("attachment"));
    templates.delete("/:id/attachments/:attachmentId", handler);

    const app = express();
    app.use("/templates", templates);
    app.get(
      "/ws",
      (req, _res, next) => {
        req.actor = { id: ID, fullName: "U", email: "u@example.com", isActive: true, role: "admin" };
        next();
      },
      requireWorkspace,
      (req, res) => res.json({ workspaceId: req.workspaceId, role: req.actor!.role }),
    );
    app.use(errorMiddleware);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it.each([
    [`/templates/nope/attachments/${ID}`, "Invalid template id."],
    [`/templates/${ID}/attachments/nope`, "Invalid attachment id."],
  ])("rejects %s with 400 before the handler runs", async (path, message) => {
    handler.mockClear();
    const res = await fetch(`${base}${path}`, { method: "DELETE" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: "invalid_input", message } });
    expect(handler).not.toHaveBeenCalled();
  });

  it("lets well-formed ids through", async () => {
    const res = await fetch(`${base}/templates/${ID}/attachments/${ID}`, { method: "DELETE" });
    expect(res.status).toBe(200);
  });

  it("rejects a malformed X-Workspace-Id with 400 without querying the database", async () => {
    poolQuery.mockClear();
    const res = await fetch(`${base}/ws`, { headers: { "X-Workspace-Id": "workspace-1" } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe("Invalid workspace id.");
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it("still looks up a well-formed X-Workspace-Id; the role becomes the membership role (E4b)", async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ id: ID, role: "salesperson" }] });
    const res = await fetch(`${base}/ws`, { headers: { "X-Workspace-Id": ID } });
    expect(await res.json()).toEqual({ workspaceId: ID, role: "salesperson" });
  });

  it("E4b: a non-member gets 403, whatever the global role", async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ id: ID, role: null }] });
    const res = await fetch(`${base}/ws`, { headers: { "X-Workspace-Id": ID } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe("You don't have access to this workspace");
  });
});

describe("queryBoolean (B14)", () => {
  it.each([
    ["true", true],
    ["1", true],
    ["false", false],
    ["0", false],
  ])("parses %s as %s", (value, expected) => {
    expect(queryBoolean.parse(value)).toBe(expected);
  });

  it.each(["yes", "FALSE", "", "2", "no"])("rejects %j with a 400", (value) => {
    expect(() => parseQuery(z.object({ force: queryBoolean.optional() }), { force: value })).toThrow(
      expect.objectContaining({ status: 400, code: "invalid_input" }),
    );
  });

  it("treats an absent value as undefined", () => {
    expect(z.object({ force: queryBoolean.optional() }).parse({})).toEqual({});
  });
});
