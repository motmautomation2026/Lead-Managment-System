/**
 * E4b rule 3: the one membership check (requireWorkspace) on every workspace-scoped route, roles per
 * workspace, super-admin everywhere. Real HTTP stack against staging; [test] workspaces only.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { Actor } from "../../src/authMiddleware.js";
import { startTestApi, type TestApi } from "../helpers/testApi.js";
import { addTestMember, createTestWorkspace, deleteCreatedTestWorkspaces, deleteTestWorkspace } from "../helpers/testWorkspaces.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

// One GET per area: contacts, deals, settings, AI, WhatsApp numbers, funnel, knowledge, the directory.
const MEMBER_ROUTES = [
  "/contacts",
  "/deals",
  "/tasks",
  "/connections/email/settings",
  "/agent/stats",
  "/connections/whatsapp/settings",
  "/analytics/funnel",
  "/knowledge/documents",
  "/profiles",
];
const ADMIN_ROUTES = ["/agent/settings", "/assignment-rules"];

describeIfDb("workspace access (E4b, requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let api: TestApi;
  let A: string;
  let B: string;
  let outsider: Actor;
  let mixed: Actor; // admin in A, salesperson in B
  let superAdmin: Actor;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    api = await startTestApi(pool, "ws-access");
    A = await createTestWorkspace(pool, "access-a");
    B = await createTestWorkspace(pool, "access-b");
    // The per-workspace connection rows createWorkspace seeds (the settings routes read them).
    for (const ws of [A, B]) {
      await pool.query(`insert into public.integration_connections (workspace_id, id) values ($1, 'email')`, [ws]);
      await pool.query(`insert into public.whatsapp_connection (workspace_id) values ($1)`, [ws]);
    }
    outsider = await api.newUser("admin", { member: false });
    mixed = await api.newUser("salesperson", { member: false });
    superAdmin = await api.newUser("salesperson", { superAdmin: true });
    await addTestMember(pool, A, mixed.id, "admin");
    await addTestMember(pool, B, mixed.id, "salesperson");
  });

  afterAll(async () => {
    await api?.close();
    await deleteCreatedTestWorkspaces(pool);
    await pool?.end();
  });

  it("a non-member gets 403 on every area, even with a global admin role", async () => {
    for (const path of [...MEMBER_ROUTES, ...ADMIN_ROUTES]) {
      const res = await api.call(outsider, A, "GET", path);
      expect(res.status, path).toBe(403);
      expect(res.body.error.message, path).toBe("You don't have access to this workspace");
    }
  });

  it("an unknown workspace is still 404", async () => {
    expect((await api.call(outsider, randomUUID(), "GET", "/contacts")).status).toBe(404);
  });

  it("roles are per workspace: admin in A, salesperson in B", async () => {
    for (const path of [...MEMBER_ROUTES, ...ADMIN_ROUTES]) expect((await api.call(mixed, A, "GET", path)).status, `A ${path}`).toBe(200);
    for (const path of MEMBER_ROUTES) expect((await api.call(mixed, B, "GET", path)).status, `B ${path}`).toBe(200);
    for (const path of ADMIN_ROUTES) expect((await api.call(mixed, B, "GET", path)).status, `B ${path}`).toBe(403);
  });

  it("a sales member gets 403 on admin routes", async () => {
    const sales = await api.newUser("salesperson");
    for (const path of ADMIN_ROUTES) expect((await api.call(sales, A, "GET", path)).status, path).toBe(403);
    expect((await api.call(sales, A, "GET", "/contacts")).status).toBe(200);
  });

  it("a super-admin opens every workspace as admin without being a member", async () => {
    for (const ws of [A, B]) {
      for (const path of [...MEMBER_ROUTES, ...ADMIN_ROUTES]) expect((await api.call(superAdmin, ws, "GET", path)).status, path).toBe(200);
    }
    const members = await pool.query(`select 1 from public.workspace_members where user_id = $1`, [superAdmin.id]);
    expect(members.rowCount).toBe(0);
  });

  it("/workspaces and /me list only the user's workspaces with their role (super-admin: all)", async () => {
    const list = (await api.call(mixed, A, "GET", "/workspaces")).body.data as { id: string; role: string }[];
    expect(list.filter((w) => w.id === A || w.id === B)).toEqual([
      expect.objectContaining({ id: A, role: "admin" }),
      expect.objectContaining({ id: B, role: "salesperson" }),
    ]);
    expect(list).toHaveLength(2);
    expect((await api.call(outsider, A, "GET", "/workspaces")).body.data).toEqual([]);
    const me = (await api.call(mixed, A, "GET", "/me")).body;
    expect(me.isSuperAdmin).toBe(false);
    expect(me.workspaces.map((w: { id: string }) => w.id)).toEqual([A, B]);
    const all = (await api.call(superAdmin, A, "GET", "/workspaces")).body.data as { id: string; role: string }[];
    expect(all.find((w) => w.id === B)?.role).toBe("admin");
    expect((await api.call(superAdmin, A, "GET", "/me")).body.isSuperAdmin).toBe(true);
  });

  it("the directory lists members (member: true) and non-member owners (member: false)", async () => {
    const owner = await api.newUser("salesperson", { member: false });
    await pool.query(`insert into public.leads (workspace_id, first_name, company, source, email, owner_id) values ($1, 'Kept', 'Acme', 'referral', $3, $2)`, [A, owner.id, `kept-${randomUUID()}@example.com`]);
    const data = (await api.call(mixed, A, "GET", "/profiles")).body.data as { id: string; member: boolean; role: string }[];
    expect(data.find((p) => p.id === mixed.id)).toMatchObject({ member: true, role: "admin" });
    expect(data.find((p) => p.id === owner.id)).toMatchObject({ member: false });
    expect(data.find((p) => p.id === outsider.id)).toBeUndefined();
  });

  it("creating a workspace makes the creator its admin, nobody else (rule 11)", async () => {
    const res = await api.call(mixed, A, "POST", "/workspaces", { name: `[test] access-created ${randomUUID()}` });
    expect(res.status).toBe(201);
    expect(res.body.role).toBe("admin");
    try {
      const rows = await pool.query(`select user_id, role from public.workspace_members where workspace_id = $1`, [res.body.id]);
      expect(rows.rows).toEqual([{ user_id: mixed.id, role: "admin" }]);
      expect((await api.call(superAdmin, res.body.id, "GET", "/contacts")).status).toBe(200);
      expect((await api.call(outsider, res.body.id, "GET", "/contacts")).status).toBe(403);
    } finally {
      await deleteTestWorkspace(pool, res.body.id);
    }
  });

  it("renaming a workspace is super-admin only", async () => {
    expect((await api.call(mixed, A, "PATCH", `/workspaces/${A}`, { name: `[test] access-a ${A}` })).status).toBe(403);
  });

  it("the public open pixel still works without auth or workspace", async () => {
    const res = await fetch(`${api.origin}/t/o/${"a".repeat(32)}.gif`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/gif");
  });
});
