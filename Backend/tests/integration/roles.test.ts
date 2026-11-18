/**
 * Roles through the real HTTP stack (createApp) against a real database:
 * admins get the whole CRM plus /admin; salespeople get the CRM only.
 * Auth is bypassed by setting req.actor before the app (requireAuth then
 * skips the token check). Skipped unless TEST_DATABASE_URL is set.
 */
import { randomUUID } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addTestMember, createTestWorkspace, deleteCreatedTestWorkspaces } from "../helpers/testWorkspaces.js";
import { Pool } from "pg";
import type { Actor } from "../../src/authMiddleware.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb("roles (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  const authUserIds: string[] = [];
  let admin: Actor;
  let salesperson: Actor;
  let inactiveId: string;
  let actor: Actor;
  let WORKSPACE_ID: string;
  let server: Server;
  let base: string;

  async function newUser(role: "admin" | "salesperson", isActive = true): Promise<Actor> {
    const auth = await pool.query(`insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`, [`roles-${role}-${randomUUID()}@example.com`]);
    authUserIds.push(auth.rows[0].id);
    const profile = await pool.query(
      `update public.profiles set role = $2, is_active = $3 where id = $1 returning id, full_name, email`,
      [auth.rows[0].id, role, isActive],
    );
    return { id: profile.rows[0].id, fullName: profile.rows[0].full_name, email: profile.rows[0].email, isActive, role };
  }

  async function api(as: Actor, method: string, path: string, body?: unknown) {
    actor = as;
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", "X-Workspace-Id": WORKSPACE_ID },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    admin = await newUser("admin");
    salesperson = await newUser("salesperson");
    inactiveId = (await newUser("salesperson", false)).id;
    WORKSPACE_ID = randomUUID();
    await createTestWorkspace(pool, "roles-test", { id: WORKSPACE_ID });
    // E4b: roles are per workspace; both are members of this one with their role.
    await addTestMember(pool, WORKSPACE_ID, admin.id, "admin");
    await addTestMember(pool, WORKSPACE_ID, salesperson.id, "salesperson");

    const { createApp } = await import("../../src/app.js");
    const { requireAdmin, requireAuth, requireCrmUser, requireWorkspace } = await import("../../src/authMiddleware.js");
    const { errorMiddleware } = await import("../../src/errorMiddleware.js");
    const app = express();
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    // The CRM router's chain plus the admin-only guard, as a future admin setting would mount it.
    app.get("/probe/admin-only", requireAuth, requireCrmUser, requireWorkspace, requireAdmin, (req, res) => {
      res.json({ ok: true, workspaceId: req.workspaceId });
    });
    app.use(createApp());
    app.use(errorMiddleware);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await deleteCreatedTestWorkspaces(pool);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const id of authUserIds) {
      await pool.query(`delete from auth.users where id = $1`, [id]).catch((error) => console.warn("[roles] test user cleanup failed:", error));
    }
    await pool.end();
  });

  it("an admin can use CRM routes and /workspaces", async () => {
    expect((await api(admin, "GET", "/api/v1/leads")).status).toBe(200);
    const workspaces = await api(admin, "GET", "/api/v1/workspaces");
    expect(workspaces.status).toBe(200);
    expect(workspaces.body.data.map((w: { id: string }) => w.id)).toContain(WORKSPACE_ID);
  });

  it("attributes an admin's actions in the timeline and the audit log", async () => {
    const created = await api(admin, "POST", "/api/v1/leads", { firstName: "Admin", company: "Roles Co", source: "referral", email: `roles-${randomUUID()}@example.com` });
    expect(created.status).toBe(201);
    const leadId = (created.body.data ?? created.body).id as string;
    const events = await pool.query(`select distinct actor_id, actor_name from public.timeline_events where lead_id = $1 and actor_source = 'manual'`, [leadId]);
    expect(events.rows).toEqual([{ actor_id: admin.id, actor_name: admin.fullName }]);

    // An admin can also be the website-lead default owner (they appear in the owner pickers).
    const saved = await api(admin, "PUT", "/api/v1/connections/website-leads", { defaultOwnerId: admin.id });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ defaultOwnerId: admin.id, ownerAvailable: true });
    const audit = await pool.query(
      `select actor_id, actor_email from public.admin_audit_events where action = 'workspace.default_lead_owner_changed' and target_id = $1`,
      [WORKSPACE_ID],
    );
    expect(audit.rows).toEqual([{ actor_id: admin.id, actor_email: admin.email }]);
  });

  it("a salesperson gets 403 on /admin/users; an admin does not", async () => {
    expect((await api(salesperson, "GET", "/api/v1/admin/users")).status).toBe(403);
    expect((await api(admin, "GET", "/api/v1/admin/users")).status).toBe(200);
  });

  it("the admin-only guard rejects a salesperson and accepts an admin", async () => {
    const denied = await api(salesperson, "GET", "/probe/admin-only");
    expect(denied.status).toBe(403);
    expect(denied.body.error.message).toBe("Administrator access is required.");
    expect(await api(admin, "GET", "/probe/admin-only")).toEqual({ status: 200, body: { ok: true, workspaceId: WORKSPACE_ID } });
  });

  it("/profiles lists active users of both roles with their role, and no inactive users", async () => {
    const res = await api(salesperson, "GET", "/api/v1/profiles");
    expect(res.status).toBe(200);
    const byId = new Map(res.body.data.map((p: { id: string; role: string }) => [p.id, p]));
    expect(byId.get(admin.id)).toMatchObject({ role: "admin", active: true });
    expect(byId.get(salesperson.id)).toMatchObject({ role: "salesperson", active: true });
    expect(byId.has(inactiveId)).toBe(false);
    expect(res.body.data.every((p: { active: boolean }) => p.active)).toBe(true);
  });
});
