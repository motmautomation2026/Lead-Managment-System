/**
 * Error responses through the real HTTP stack (createApp) against a real
 * database: Postgres errors become clear 4xx (audit B24, B14, B6).
 * Auth is bypassed by setting req.actor before the app (requireAuth then
 * skips the token check); everything after that is the production pipeline.
 * Skipped unless TEST_DATABASE_URL is set; commits rows in a fresh workspace
 * per run.
 */
import { randomUUID } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { Actor } from "../../src/authMiddleware.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb("HTTP error responses (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let actor: Actor;
  let authUserId: string | undefined;
  let WORKSPACE_ID: string;
  let server: Server;
  let base: string;

  /** Calls the API as the test actor in the test workspace; `headers` can override X-Workspace-Id. */
  async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: { "Content-Type": "application/json", "X-Workspace-Id": WORKSPACE_ID, ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : undefined };
  }

  async function newLead() {
    const res = await api("POST", "/leads", { firstName: "Err", company: "Err Pvt Ltd", source: "referral", email: `err-${randomUUID()}@example.com` });
    expect(res.status).toBe(201);
    return (res.body.data ?? res.body) as { id: string };
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    const auth = await pool.query(`insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`, [`errors-${randomUUID()}@example.com`]);
    authUserId = auth.rows[0].id as string;
    const profile = await pool.query(`select id, full_name, email from public.profiles where id = $1`, [authUserId]);
    actor = { id: profile.rows[0].id, fullName: profile.rows[0].full_name, email: profile.rows[0].email, isActive: true, role: "salesperson" };
    WORKSPACE_ID = randomUUID();
    await pool.query(`insert into public.workspaces (id, name, slug) values ($1, $2, $2)`, [WORKSPACE_ID, `errors-test-${WORKSPACE_ID}`]);

    const { createApp } = await import("../../src/app.js");
    const app = express();
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use(createApp());
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (authUserId) {
      await pool.query(`delete from auth.users where id = $1`, [authUserId]).catch((error) => console.warn("[errorResponses] test user cleanup failed:", error));
    }
    await pool.end();
  });

  it("moving a lead to Objection Nurture without a type is a 400 with the human message", async () => {
    const lead = await newLead();
    const res = await api("PATCH", `/leads/${lead.id}`, { pipelineStage: "objection_nurture" });
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({
      code: "invalid_input",
      message: "Choose an objection type before moving a lead to Objection Nurture.",
      details: { constraint: "leads_objection_stage_has_type" },
    });
  });

  it("a malformed id is a 400, not a 500", async () => {
    const res = await api("GET", "/leads/not-a-uuid");
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({ code: "invalid_input", message: "Invalid lead id." });
  });

  it("a malformed X-Workspace-Id is a 400", async () => {
    const res = await api("GET", "/leads", undefined, { "X-Workspace-Id": "123" });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe("Invalid workspace id.");
  });

  it("an unknown owner is a 400 naming the owner, not a 500", async () => {
    const lead = await newLead();
    const res = await api("PATCH", `/leads/${lead.id}`, { ownerId: randomUUID() });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe("The selected owner doesn't exist.");
  });
});
