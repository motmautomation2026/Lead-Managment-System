/**
 * CRM v2 contacts API (B4) through the HTTP stack: paging for every sort, filters,
 * literal search (and the old /leads search), workspace isolation, detail, bulk.
 * Skipped unless TEST_DATABASE_URL is set; [test] workspaces only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createTestWorkspace, deleteCreatedTestWorkspaces } from "../helpers/testWorkspaces.js";
import { expectConsistentPaging, qs, startTestApi, type TestApi } from "../helpers/testApi.js";
import type { Actor } from "../../src/authMiddleware.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb("contacts API (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let api: TestApi;
  let admin: Actor;
  let rep: Actor;
  let inactive: Actor;
  let ws: string;
  let otherWs: string;
  let otherContactId: string;
  const ids: Record<string, string> = {};
  let withTransaction: typeof import("../../src/db.js").withTransaction;
  let leads: typeof import("../../src/services/leads.service.js");
  let deals: typeof import("../../src/services/deals.service.js");

  const get = (query: string, as: Actor = rep) => api.call(as, ws, "GET", `/contacts${query}`);
  const listIds = async (params: Parameters<typeof qs>[0], as: Actor = rep) => {
    const res = await get(qs({ ...params, limit: 100 }), as);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return (res.body.data as { id: string }[]).map((r) => r.id);
  };
  const create = (workspaceId: string, key: string, input: Record<string, unknown>) =>
    withTransaction(async (client) => {
      const row = await leads.createLead(client, rep, workspaceId, { firstName: key, company: "Acme", source: "referral", ownerId: rep.id, phone: undefined, ...input } as never);
      ids[key] = row.id;
      return row.id;
    });

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
    api = await startTestApi(pool, "contacts-api");
    admin = await api.newUser("admin", { name: "Admin Contacts" });
    rep = await api.newUser("salesperson", { name: "Rep Contacts" });
    inactive = await api.newUser("salesperson", { isActive: false });
    ({ withTransaction } = await import("../../src/db.js"));
    leads = await import("../../src/services/leads.service.js");
    deals = await import("../../src/services/deals.service.js");
    ws = await createTestWorkspace(pool, "contacts-api");
    otherWs = await createTestWorkspace(pool, "contacts-api-other");

    // 16 contacts: varied names, companies, owners, sources; a few equal sort values (ties break by id).
    const companies = ["Acme", "Bolt Motors", "Zeta Labs", "50% Off Store", "under_score Ltd", "Acme"];
    for (let i = 0; i < 16; i++) {
      await create(ws, `c${i}`, {
        firstName: i % 5 === 0 ? "Same" : `First${i}`,
        lastName: i % 4 === 0 ? "Tie" : `Last${String.fromCharCode(65 + i)}`,
        company: companies[i % companies.length],
        email: `c${i}@${companies[i % companies.length]!.toLowerCase().replace(/[^a-z]/g, "")}.example.com`,
        source: i % 2 ? "referral" : "website",
        ownerId: i % 3 === 0 ? admin.id : rep.id,
      });
    }
    // Unowned, won, merged-out and a long-term nurture contact.
    await pool.query(`update public.leads set owner_id = null where id = $1`, [ids.c1]);
    await pool.query(`update public.leads set lifecycle_state = 'won' where id = $1`, [ids.c2]);
    await pool.query(`update public.leads set lifecycle_state = 'long_term_nurture' where id = $1`, [ids.c3]);
    await withTransaction((client) => leads.mergeLead(client, rep, ws, ids.c4!, ids.c5!, "dupe"));
    // Equal created_at for a tie group, spread last_activity_at.
    await pool.query(`update public.leads set created_at = '2026-01-01T00:00:00Z' where id = any($1)`, [[ids.c6, ids.c7, ids.c8]]);
    await pool.query(`update public.leads set last_activity_at = '2026-03-01T00:00:00Z' where id = any($1)`, [[ids.c9, ids.c10]]);
    await pool.query(`update public.leads set agent_status = 'paused' where id = $1`, [ids.c11]);
    // Open deals for c12 (two: newest updated wins) and c13 (closed only).
    // Separate transactions: updated_at is now() (trigger), the same within one transaction.
    await withTransaction((client) => deals.createDeal(client, rep, ws, { leadId: ids.c12!, source: "manual", name: "Older deal" }));
    await withTransaction((client) => deals.createDeal(client, rep, ws, { leadId: ids.c12!, source: "manual", name: "Newer deal", amount: 1500 }));
    await withTransaction((client) => deals.createDeal(client, rep, ws, { leadId: ids.c13!, source: "manual", stage: "lost", lossReason: "other" }));

    otherContactId = await create(otherWs, "other", { company: "Acme", email: "other@acme.example.com" });
  });

  afterAll(async () => {
    await deleteCreatedTestWorkspaces(pool);
    await api.close();
    await pool.end();
  });

  it("pages consistently for every sort in both directions; count matches", async () => {
    const defaultIds = await listIds({});
    const count = await get(`/count`);
    expect(count.body).toEqual({ count: defaultIds.length });
    // default lifecycle = active + long-term nurture: not won (c2), not merged (c4)
    expect(defaultIds).not.toContain(ids.c2);
    expect(defaultIds).not.toContain(ids.c4);
    expect(defaultIds).toContain(ids.c3);
    for (const field of ["createdAt", "lastActivityAt", "updatedAt", "name", "company"]) {
      for (const dir of ["asc", "desc"]) {
        const paged = await expectConsistentPaging((q) => get(q), { sort: `${field}:${dir}`, lifecycle: "all" });
        expect(paged.length).toBe((await get(qs({ lifecycle: "all" }).replace("?", "/count?"))).body.count);
      }
    }
  }, 120_000);

  it("returns the ContactListItem shape with company, owner, the newest open deal and next action", async () => {
    const res = await get(qs({ q: "First12" }));
    expect(res.body.data).toHaveLength(1);
    const row = res.body.data[0];
    expect(Object.keys(row).sort()).toEqual(
      ["id", "name", "firstName", "lastName", "email", "phone", "jobTitle", "source", "company", "owner", "leadStatus", "lifecycle", "openDeal", "agentStatus", "nextAction", "lastActivityAt", "createdAt"].sort(),
    );
    expect(row.name).toBe(`First12 Tie`);
    expect(row.source).toBe("website");
    expect(row.company).toMatchObject({ name: "Acme" });
    expect(row.owner).toEqual({ id: admin.id, name: "Admin Contacts" });
    expect(row.openDeal).toMatchObject({ name: "Newer deal", stage: "qualified", amount: 1500, currency: "INR" });
    const lostOnly = (await get(qs({ q: "First13" }))).body.data[0];
    expect(lostOnly.openDeal).toBeNull();
  });

  it("filters: owner me/none/ids, leadStatus, lifecycle, source, company, agentStatus, hasOpenDeal, ranges", async () => {
    const mine = await listIds({ ownerId: "me" });
    expect(mine).toContain(ids.c7);
    expect(mine).not.toContain(ids.c0);
    expect(await listIds({ ownerId: "none" })).toEqual([ids.c1]);
    expect((await listIds({ ownerId: ["none", admin.id] })).sort()).toEqual([1, 0, 3, 6, 9, 12, 15].map((i) => ids[`c${i}`]).sort());
    expect(await listIds({ lifecycle: "won" })).toEqual([ids.c2]);
    expect(await listIds({ lifecycle: "merged" })).toEqual([ids.c4]);
    expect(await listIds({ lifecycle: "all" })).not.toContain(ids.c4);
    expect((await listIds({ leadStatus: ["new", "contact_attempted"] })).length).toBeGreaterThan(0);
    expect(await listIds({ leadStatus: "negotiation" })).toEqual([]);
    for (const id of await listIds({ source: "website" })) expect([0, 2, 4, 6, 8, 10, 12, 14].map((i) => ids[`c${i}`])).toContain(id);
    const companyId = (await pool.query(`select company_id from public.leads where id = $1`, [ids.c1])).rows[0].company_id;
    expect((await listIds({ companyId })).sort()).toEqual([ids.c1, ids.c7, ids.c13].sort());
    expect(await listIds({ agentStatus: "paused" })).toEqual([ids.c11]);
    expect(await listIds({ hasOpenDeal: "true" })).toEqual([ids.c12]);
    expect(await listIds({ hasOpenDeal: "false" })).not.toContain(ids.c12);
    expect((await listIds({ createdFrom: "2025-12-31T00:00:00Z", createdTo: "2026-01-01T00:00:00Z" })).sort()).toEqual([ids.c6, ids.c7, ids.c8].sort());
    expect((await listIds({ lastActivityTo: "2026-03-01T00:00:00+00:00" })).sort()).toEqual([ids.c9, ids.c10].sort());
    expect((await get(qs({ ownerId: "me", count: 1 }))).status).toBe(400);
  });

  it("q treats % and _ literally, and so does the old /leads search", async () => {
    expect((await listIds({ q: "50%" })).sort()).toEqual([ids.c3, ids.c9, ids.c15].sort());
    expect(await listIds({ q: "Bolt_Motors" })).toEqual([]);
    expect((await listIds({ q: "under_score" })).length).toBeGreaterThan(0);
    expect(await listIds({ q: "%%" })).toEqual([]);
    expect((await get(qs({ q: "a" }))).status).toBe(400);
    const old = await api.call(rep, ws, "GET", `/leads${qs({ search: "%" })}`);
    expect(old.status).toBe(200);
    expect(old.body.data.length).toBe(3);
    expect(old.body.data.every((l: { company: string }) => l.company.includes("%"))).toBe(true);
    expect((await api.call(rep, ws, "GET", `/leads${qs({ search: "_" })}`)).body.data.every((l: { company: string }) => l.company.includes("_"))).toBe(true);
  });

  it("q matches the full name (first then last) in /contacts, /search and the old /leads search; escaped, workspace-scoped", async () => {
    expect(await listIds({ q: "First13 LastN" })).toEqual([ids.c13]);
    expect(await listIds({ q: "same tie" })).toEqual([ids.c0]);
    expect(await listIds({ q: "LastN First13" })).toEqual([]); // reverse order is not supported
    expect(await listIds({ q: "First13_LastN" })).toEqual([]);
    expect(await listIds({ q: "First13%LastN" })).toEqual([]);
    expect((await get(`/count${qs({ q: "First13 LastN" })}`)).body.count).toBe(1);
    const search = await api.call(rep, ws, "GET", `/search${qs({ q: "First13 LastN" })}`);
    expect(search.body.contacts.map((c: { id: string }) => c.id)).toEqual([ids.c13]);
    expect((await api.call(rep, ws, "GET", `/search${qs({ q: "First13_LastN" })}`)).body.contacts).toEqual([]);
    const old = await api.call(rep, ws, "GET", `/leads${qs({ search: "First13 LastN" })}`);
    expect(old.body.data.map((l: { id: string }) => l.id)).toEqual([ids.c13]);
    expect((await api.call(rep, ws, "GET", `/leads${qs({ search: "First13_LastN" })}`)).body.data).toEqual([]);
    expect((await api.call(rep, otherWs, "GET", `/contacts${qs({ q: "First13 LastN" })}`)).body.data).toEqual([]);
    expect((await api.call(rep, otherWs, "GET", `/search${qs({ q: "First13 LastN" })}`)).body.contacts).toEqual([]);
  });

  it("rejects bad sort, cursor and unknown params with 400", async () => {
    expect((await get(qs({ sort: "email:asc" }))).status).toBe(400);
    expect((await get(qs({ cursor: "garbage" }))).status).toBe(400);
    const first = await get(qs({ limit: 2, sort: "name:asc" }));
    expect((await get(qs({ limit: 2, sort: "name:desc", cursor: first.body.nextCursor }))).status).toBe(400);
    expect((await get(qs({ limit: 101 }))).status).toBe(400);
    expect((await get(qs({ hasOpenDeal: "1" }))).status).toBe(400);
    expect((await get(`/count${qs({ sort: "name:asc" })}`)).status).toBe(400);
  });

  it("detail: the Lead DTO plus company and deals", async () => {
    const res = await get(`/${ids.c12}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: ids.c12, firstName: "First12", companyText: "Acme", company: { name: "Acme", domain: "acme.example.com" } });
    expect(res.body.deals.map((d: { name: string }) => d.name)).toEqual(["Newer deal", "Older deal"]);
    expect(res.body.deals[0]).toMatchObject({ amount: 1500, currency: "INR", closedAt: null });
    expect((await get(`/not-a-uuid`)).status).toBe(400);
  });

  it("workspace isolation: another workspace's contact is never listed, counted or shown", async () => {
    expect(await listIds({ lifecycle: "all", q: "other" })).toEqual([]);
    expect((await listIds({ lifecycle: "all" }))).not.toContain(otherContactId);
    expect((await get(`/${otherContactId}`)).status).toBe(404);
    const otherCount = (await api.call(rep, otherWs, "GET", `/contacts/count`)).body.count;
    expect(otherCount).toBe(1);
  });

  it("bulk assignOwner: mixed results, inactive owner rejected", async () => {
    const res = await api.call(rep, ws, "POST", "/contacts/bulk", { action: "assignOwner", ownerId: admin.id, ids: [ids.c14, otherContactId, ids.c15] });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      { id: ids.c14, ok: true },
      { id: otherContactId, ok: false, error: "Contact not found." },
      { id: ids.c15, ok: true },
    ]);
    const owners = await pool.query(`select id, owner_id from public.leads where id = any($1)`, [[ids.c14, ids.c15, otherContactId]]);
    for (const row of owners.rows) expect(row.owner_id).toBe(row.id === otherContactId ? rep.id : admin.id);
    expect((await api.call(rep, ws, "POST", "/contacts/bulk", { action: "assignOwner", ownerId: inactive.id, ids: [ids.c14] })).status).toBe(400);
    expect((await api.call(rep, ws, "POST", "/contacts/bulk", { action: "assignOwner", ids: [ids.c14] })).status).toBe(400);
    expect((await api.call(rep, ws, "POST", "/contacts/bulk", { action: "assignOwner", ownerId: admin.id, ids: [] })).status).toBe(400);
  });

  it("bulk enrollAi is admin-only and reports per contact", async () => {
    expect((await api.call(rep, ws, "POST", "/contacts/bulk", { action: "enrollAi", ids: [ids.c0] })).status).toBe(403);
    const res = await api.call(admin, ws, "POST", "/contacts/bulk", { action: "enrollAi", ids: [ids.c0, ids.c2, otherContactId] });
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toEqual({ id: ids.c0, ok: true });
    expect(res.body.data[1]).toMatchObject({ id: ids.c2, ok: false });
    expect(res.body.data[2]).toEqual({ id: otherContactId, ok: false, error: "Contact not found." });
  });
});
