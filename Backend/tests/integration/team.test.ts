/**
 * E4b rules 9–10: Settings → Team (workspace admins) and the super-admin memberships API. [test] workspaces only.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { Actor } from "../../src/authMiddleware.js";
import { qs, startTestApi, type TestApi } from "../helpers/testApi.js";
import { addTestMember, createTestWorkspace, deleteCreatedTestWorkspaces } from "../helpers/testWorkspaces.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb("team + super-admin memberships (E4b, requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let api: TestApi;
  let ws: string;
  let admin: Actor;
  let rep: Actor;
  let superAdmin: Actor;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    api = await startTestApi(pool, "team");
    ws = await createTestWorkspace(pool, "team");
    admin = await api.newUser("admin", { member: false, name: "Team Admin" });
    rep = await api.newUser("salesperson", { member: false, name: "Team Rep" });
    superAdmin = await api.newUser("salesperson", { superAdmin: true });
    await addTestMember(pool, ws, admin.id, "admin");
  });

  afterAll(async () => {
    await api?.close();
    await deleteCreatedTestWorkspaces(pool);
    await pool?.end();
  });

  const events = async (userId: string) =>
    (await pool.query(`select action, old_role, new_role, actor_id from public.workspace_member_events where workspace_id = $1 and user_id = $2 order by created_at`, [ws, userId])).rows;

  it("an admin adds an existing active user by email, changes the role, and every change is audited", async () => {
    expect((await api.call(admin, ws, "POST", "/team/members", { email: `nobody-${randomUUID()}@example.com`, role: "salesperson" })).status).toBe(404);
    const added = await api.call(admin, ws, "POST", "/team/members", { email: rep.email.toUpperCase(), role: "salesperson" });
    expect(added.status).toBe(201);
    expect(added.body.data.map((m: { userId: string; role: string }) => [m.userId, m.role])).toEqual([
      [admin.id, "admin"],
      [rep.id, "salesperson"],
    ]);
    expect((await api.call(admin, ws, "POST", "/team/members", { email: rep.email, role: "admin" })).status).toBe(409);
    expect((await api.call(admin, ws, "PATCH", `/team/members/${rep.id}`, { role: "admin" })).status).toBe(200);
    expect((await api.call(admin, ws, "PATCH", `/team/members/${rep.id}`, { role: "salesperson" })).status).toBe(200);
    expect(await events(rep.id)).toEqual([
      { action: "added", old_role: null, new_role: "salesperson", actor_id: admin.id },
      { action: "role_changed", old_role: "salesperson", new_role: "admin", actor_id: admin.id },
      { action: "role_changed", old_role: "admin", new_role: "salesperson", actor_id: admin.id },
    ]);
  });

  it("a salesperson member can't manage the team", async () => {
    const asRep = { ...rep, role: "salesperson" as const };
    expect((await api.call(asRep, ws, "GET", "/team/members")).status).toBe(403);
    expect((await api.call(asRep, ws, "DELETE", `/team/members/${admin.id}`)).status).toBe(403);
  });

  it("the last admin can't be demoted or removed", async () => {
    const demote = await api.call(admin, ws, "PATCH", `/team/members/${admin.id}`, { role: "salesperson" });
    expect(demote.status).toBe(409);
    expect(demote.body.error.message).toMatch(/last admin/);
    expect((await api.call(admin, ws, "DELETE", `/team/members/${admin.id}`)).status).toBe(409);
  });

  it("removing is blocked with the counts while the user owns work; allowed after reassigning", async () => {
    const lead = await pool.query<{ id: string }>(
      `insert into public.leads (workspace_id, first_name, company, source, email, owner_id) values ($1, 'Owned', 'Acme', 'referral', $2, $3) returning id`,
      [ws, `owned-${randomUUID()}@example.com`, rep.id],
    );
    await pool.query(
      `insert into public.tasks (workspace_id, lead_id, owner_id, task_type, title, due_at, origin) values ($1, $2, $3, 'follow_up', 'Call back', now(), 'manual')`,
      [ws, lead.rows[0]!.id, rep.id],
    );
    const blocked = await api.call(admin, ws, "DELETE", `/team/members/${rep.id}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toBe("This user still owns 1 active contact(s), 0 open deal(s) and 1 open task(s) in this workspace. Reassign them first.");

    // Reassign with the existing bulk tool, close the task, then removing works.
    expect((await api.call(admin, ws, "POST", "/contacts/bulk", { ids: [lead.rows[0]!.id], action: "assignOwner", ownerId: admin.id })).status).toBe(200);
    await pool.query(`update public.tasks set owner_id = $2 where workspace_id = $1 and owner_id = $3`, [ws, admin.id, rep.id]);
    const removed = await api.call(admin, ws, "DELETE", `/team/members/${rep.id}`);
    expect(removed.status).toBe(200);
    expect(removed.body.data.map((m: { userId: string }) => m.userId)).toEqual([admin.id]);
    expect((await events(rep.id)).at(-1)).toMatchObject({ action: "removed", old_role: "salesperson", new_role: null });
    // The removed user can't open the workspace any more.
    expect((await api.call(rep, ws, "GET", "/contacts")).status).toBe(403);
  });

  it("super-admin: every workspace × user with roles (paged), set and remove memberships; others get 403", async () => {
    expect((await api.call(admin, ws, "GET", "/super-admin/memberships")).status).toBe(403);
    const set = await api.call(superAdmin, ws, "PUT", "/super-admin/memberships", { workspaceId: ws, userId: rep.id, role: "admin" });
    expect(set.status).toBe(200);
    const page = await api.call(superAdmin, ws, "GET", `/super-admin/memberships${qs({ q: "Team Rep", limit: 1 })}`);
    expect(page.status).toBe(200);
    expect(page.body.workspaces.map((w: { id: string }) => w.id)).toContain(ws);
    expect(page.body.data).toHaveLength(1);
    expect(page.body.data[0]).toMatchObject({ id: rep.id, isSuperAdmin: false, roles: { [ws]: "admin" } });
    expect((await api.call(superAdmin, ws, "PUT", "/super-admin/memberships", { workspaceId: ws, userId: rep.id, role: null })).status).toBe(200);
    expect((await pool.query(`select 1 from public.workspace_members where workspace_id = $1 and user_id = $2`, [ws, rep.id])).rowCount).toBe(0);
    expect((await api.call(superAdmin, ws, "GET", "/super-admin/memberships?cursor=bad")).status).toBe(400);
  });
});
