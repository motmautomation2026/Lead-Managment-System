/**
 * UX-1: Settings lists are keyset pages — team members, user accounts, email and WhatsApp safety events.
 * [test] workspaces only.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { Actor } from "../../src/authMiddleware.js";
import { qs, startTestApi, type TestApi } from "../helpers/testApi.js";
import { addTestMember, createTestWorkspace, deleteCreatedTestWorkspaces } from "../helpers/testWorkspaces.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

type Row = Record<string, unknown>;

describeIfDb("Settings lists are paginated (UX-1, requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let api: TestApi;
  let ws: string;
  let admin: Actor;
  let rep: Actor;
  const tag = randomUUID().slice(0, 8);

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    api = await startTestApi(pool, "settings-lists");
    ws = await createTestWorkspace(pool, "settings-lists");
    admin = await api.newUser("admin", { member: false, name: `Aardvark ${tag}` });
    rep = await api.newUser("salesperson", { member: false, name: `Zebra ${tag}` });
    const third = await api.newUser("salesperson", { member: false, name: `Moose ${tag}` });
    await addTestMember(pool, ws, admin.id, "admin");
    await addTestMember(pool, ws, rep.id, "salesperson");
    await addTestMember(pool, ws, third.id, "salesperson");
  });

  afterAll(async () => {
    await api?.close();
    await deleteCreatedTestWorkspaces(pool);
    await pool?.end();
  });

  /** Every page of `path` (limit 2), following nextCursor. */
  async function allPages(as: Actor, path: string, params: Record<string, string> = {}) {
    const rows: Row[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const res = await api.call(as, ws, "GET", `${path}${qs({ ...params, limit: 2, cursor })}`);
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeLessThanOrEqual(2);
      rows.push(...res.body.data);
      cursor = res.body.nextCursor ?? undefined;
      pages++;
    } while (cursor && pages < 50);
    return { rows, pages };
  }

  it("team members: pages by name, q filters by name or email; salespeople get 403", async () => {
    const { rows, pages } = await allPages(admin, "/team/members");
    expect(pages).toBe(2);
    expect(rows.map((r) => r.name)).toEqual([`Aardvark ${tag}`, `Moose ${tag}`, `Zebra ${tag}`]);
    expect(rows[0]).toMatchObject({ userId: admin.id, role: "admin", active: true });
    const found = await api.call(admin, ws, "GET", `/team/members${qs({ q: rep.email })}`);
    expect(found.body.data.map((r: Row) => r.userId)).toEqual([rep.id]);
    expect((await api.call(admin, ws, "GET", `/team/members${qs({ cursor: "nope" })}`)).status).toBe(400);
    expect((await api.call(rep, ws, "GET", "/team/members")).status).toBe(403);
  });

  it("user accounts: newest first in pages, q finds one", async () => {
    const first = await api.call(admin, ws, "GET", `/admin/users${qs({ limit: 1 })}`);
    expect(first.status).toBe(200);
    expect(first.body.data).toHaveLength(1);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await api.call(admin, ws, "GET", `/admin/users${qs({ limit: 1, cursor: first.body.nextCursor })}`);
    expect(second.body.data[0].id).not.toBe(first.body.data[0].id);
    expect(Date.parse(second.body.data[0].createdAt)).toBeLessThanOrEqual(Date.parse(first.body.data[0].createdAt));
    const found = await api.call(admin, ws, "GET", `/admin/users${qs({ q: `Zebra ${tag}` })}`);
    expect(found.body).toEqual({
      data: [expect.objectContaining({ id: rep.id, name: `Zebra ${tag}`, email: rep.email, active: true })],
      nextCursor: null,
    });
    expect((await api.call(rep, ws, "GET", "/admin/users")).status).toBe(403);
  });

  it("email and WhatsApp safety events: the whole history, newest first, for every member", async () => {
    for (const [table, kind] of [
      ["email_safety_events", "send_failed"],
      ["whatsapp_safety_events", "send_failed"],
    ] as const) {
      await pool.query(
        `insert into public.${table} (workspace_id, kind, detail, created_at)
         select $1, $2, 'event ' || g, now() - (g || ' minutes')::interval from generate_series(1, 3) g`,
        [ws, kind],
      );
    }
    for (const path of ["/connections/email/safety-events", "/connections/whatsapp/safety-events"]) {
      const { rows, pages } = await allPages(rep, path);
      expect(pages).toBe(2);
      expect(rows.map((r) => r.detail)).toEqual(["event 1", "event 2", "event 3"]);
      expect(rows[0]).toMatchObject({ kind: "send_failed", at: expect.any(String) });
    }
    const wa = await api.call(rep, ws, "GET", "/connections/whatsapp/safety-events");
    expect(wa.body.data[0]).toHaveProperty("numberLabel", null);
  });
});
