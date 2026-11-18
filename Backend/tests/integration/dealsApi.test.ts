/**
 * CRM v2 deals API (B4) through the HTTP stack: paging for every sort (incl. NULL amounts
 * and close dates), filters, board + column paging, create/edit/stage rules, isolation.
 * Skipped unless TEST_DATABASE_URL is set; [test] workspaces only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createTestWorkspace, deleteCreatedTestWorkspaces } from "../helpers/testWorkspaces.js";
import { expectConsistentPaging, qs, startTestApi, type TestApi } from "../helpers/testApi.js";
import type { Actor } from "../../src/authMiddleware.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const STAGES = ["qualified", "meeting_scheduled", "meeting_follow_up", "proposal_preparation", "proposal_sent", "negotiation", "won", "lost"];

describeIfDb("deals API (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let api: TestApi;
  let admin: Actor;
  let rep: Actor;
  let inactive: Actor;
  let ws: string;
  let otherWs: string;
  let contactA: string;
  let contactB: string;
  let otherContact: string;
  let otherDeal: string;
  let companyA: string;
  const deals: Record<string, string> = {};
  let withTransaction: typeof import("../../src/db.js").withTransaction;
  let leads: typeof import("../../src/services/leads.service.js");
  let dealService: typeof import("../../src/services/deals.service.js");

  const call = (method: string, path: string, body?: unknown, as: Actor = rep, workspace = ws) => api.call(as, workspace, method, path, body);
  const listIds = async (params: Parameters<typeof qs>[0]) => {
    const res = await call("GET", `/deals${qs({ ...params, limit: 100 })}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return (res.body.data as { id: string }[]).map((r) => r.id).sort();
  };
  const keys = (...names: string[]) => names.map((n) => deals[n]!).sort();
  const contact = (workspace: string, company: string, email: string, ownerId = rep.id) =>
    withTransaction(async (client) => (await leads.createLead(client, rep, workspace, { firstName: "Deal", lastName: company, company, email, source: "referral", ownerId })).id);

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
    api = await startTestApi(pool, "deals-api");
    admin = await api.newUser("admin", { name: "Admin Deals" });
    rep = await api.newUser("salesperson", { name: "Rep Deals" });
    inactive = await api.newUser("salesperson", { isActive: false });
    ({ withTransaction } = await import("../../src/db.js"));
    leads = await import("../../src/services/leads.service.js");
    dealService = await import("../../src/services/deals.service.js");
    ws = await createTestWorkspace(pool, "deals-api");
    otherWs = await createTestWorkspace(pool, "deals-api-other");
    contactA = await contact(ws, "Acme Deals", "a@acmedeals.example.com");
    contactB = await contact(ws, "Bolt 50% Deals", "b@boltdeals.example.com", admin.id);
    companyA = (await pool.query(`select company_id from public.leads where id = $1`, [contactA])).rows[0].company_id;
    otherContact = await contact(otherWs, "Other Deals", "o@otherdeals.example.com");
    otherDeal = (await call("POST", "/deals", { leadId: otherContact, name: "Foreign deal" }, rep, otherWs)).body.id;

    // 16 deals: NULL and equal amounts / close dates, two transactions (equal updated_at inside one).
    const specs: [string, string, Record<string, unknown>][] = [
      ["a1", contactA, { amount: 100, expectedCloseDate: "2026-11-01" }],
      ["a2", contactA, { amount: 100, expectedCloseDate: "2026-11-01" }],
      ["a3", contactA, { amount: null, expectedCloseDate: null }],
      ["a4", contactA, { amount: 2500.5, expectedCloseDate: null, stage: "proposal_sent" }],
      ["a5", contactA, { amount: null, expectedCloseDate: "2026-12-15", stage: "negotiation" }],
      ["a6", contactA, { amount: 0, expectedCloseDate: "2027-01-01", stage: "won" }],
      ["a7", contactA, { amount: null, expectedCloseDate: null, stage: "lost", lossReason: "price_budget" }],
      ["a8", contactA, { amount: 50 }],
    ];
    const specsB: typeof specs = [
      ["b1", contactB, { amount: null, name: "under_score deal" }],
      ["b2", contactB, { amount: 999, expectedCloseDate: "2026-10-30", stage: "meeting_scheduled" }],
      ["b3", contactB, { amount: null, expectedCloseDate: "2026-10-30" }],
      ["b4", contactB, { amount: 100, stage: "lost", lossReason: "other" }],
      ["b5", contactB, { amount: null }],
      ["b6", contactB, { amount: 75, expectedCloseDate: null, stage: "proposal_preparation" }],
      ["b7", contactB, { amount: null, expectedCloseDate: "2026-11-01" }],
      ["b8", contactB, { amount: 100, expectedCloseDate: null }],
    ];
    for (const batch of [specs, specsB]) {
      await withTransaction(async (client) => {
        for (const [key, leadId, input] of batch) {
          deals[key] = (await dealService.createDeal(client, rep, ws, { leadId, source: "manual", name: `Deal ${key}`, ...input } as never)).id;
        }
      });
    }
  });

  afterAll(async () => {
    await deleteCreatedTestWorkspaces(pool);
    await api.close();
    await pool.end();
  });

  it("pages consistently for every sort in both directions (NULLs last), status=all; count matches", async () => {
    const get = (q: string) => call("GET", `/deals${q}`);
    const total = (await get(`/count${qs({ status: "all" })}`)).body.count;
    expect(total).toBe(16);
    for (const field of ["updatedAt", "createdAt", "amount", "expectedCloseDate", "name"]) {
      for (const dir of ["asc", "desc"]) {
        const ids = await expectConsistentPaging(get, { sort: `${field}:${dir}`, status: "all" }, 3);
        expect(ids.length).toBe(total);
        // NULLs come last in both directions.
        const nulls = { amount: keys("a3", "a5", "a7", "b1", "b3", "b5", "b7"), expectedCloseDate: keys("a3", "a4", "a7", "a8", "b1", "b4", "b5", "b6", "b8") }[field];
        if (nulls) expect(ids.slice(-nulls.length).sort()).toEqual(nulls);
      }
    }
    const first = await get(qs({ status: "all", sort: "amount:asc", limit: 3 }));
    expect(first.body.data.map((r: { amount: number }) => r.amount)).toEqual([0, 50, 75]);
    expect(Object.keys(first.body.data[0]).sort()).toEqual(
      ["id", "name", "stage", "amount", "currency", "expectedCloseDate", "owner", "company", "contact", "source", "closedAt", "createdAt", "updatedAt"].sort(),
    );
    expect(first.body.data[0]).toMatchObject({ id: deals.a6, stage: "won", currency: "INR", expectedCloseDate: "2027-01-01", source: "manual", contact: { id: contactA, name: "Deal Acme Deals" } });
    expect(first.body.data[0].company).toEqual({ id: companyA, name: "Acme Deals" });
  }, 180_000);

  it("filters: status default open, stage, owner, company, contact, amount and date ranges, literal q", async () => {
    expect(await listIds({})).toEqual(keys("a1", "a2", "a3", "a4", "a5", "a8", "b1", "b2", "b3", "b5", "b6", "b7", "b8"));
    expect(await listIds({ status: "won" })).toEqual(keys("a6"));
    expect(await listIds({ status: "lost" })).toEqual(keys("a7", "b4"));
    expect(await listIds({ stage: ["won", "negotiation"] })).toEqual(keys("a5", "a6"));
    expect(await listIds({ stage: "won", status: "open" })).toEqual([]);
    expect(await listIds({ ownerId: "me", status: "all" })).toEqual(keys("a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"));
    expect(await listIds({ ownerId: admin.id, status: "all" })).toHaveLength(8);
    expect(await listIds({ ownerId: "none" })).toEqual([]);
    expect(await listIds({ companyId: companyA })).toEqual(keys("a1", "a2", "a3", "a4", "a5", "a8"));
    expect(await listIds({ leadId: contactB, status: "lost" })).toEqual(keys("b4"));
    expect(await listIds({ amountMin: "100", amountMax: "999", status: "all" })).toEqual(keys("a1", "a2", "b2", "b4", "b8"));
    expect(await listIds({ amountMin: "1000.5" })).toEqual(keys("a4"));
    expect(await listIds({ expectedCloseFrom: "2026-10-30", expectedCloseTo: "2026-11-01" })).toEqual(keys("a1", "a2", "b2", "b3", "b7"));
    expect(await listIds({ createdFrom: "2000-01-01T00:00:00Z", createdTo: "2000-01-02T00:00:00Z" })).toEqual([]);
    expect(await listIds({ q: "50%", status: "all" })).toHaveLength(8); // company name match
    expect(await listIds({ q: "r_s" })).toEqual(keys("b1")); // "under_score deal" — `_` literal
    expect(await listIds({ q: "Deal_a" })).toEqual([]);
    expect(await listIds({ q: "acme deals" })).toHaveLength(6);
    for (const bad of [{ amountMin: "-1" }, { amountMin: "abc" }, { expectedCloseFrom: "2026-13" }, { status: "closed" }, { stage: "done" }, { sort: "stage:asc" }]) {
      expect((await call("GET", `/deals${qs(bad)}`)).status).toBe(400);
    }
    expect((await call("GET", `/deals/count${qs({ status: "lost" })}`)).body).toEqual({ count: 2 });
  });

  it("board: every stage in order with count, INR total, first 20 and column paging", async () => {
    const boardWs = await createTestWorkspace(pool, "deals-api-board");
    const lead = await contact(boardWs, "Board Co", "x@boardco.example.com");
    await withTransaction(async (client) => {
      for (let i = 0; i < 23; i++) await dealService.createDeal(client, rep, boardWs, { leadId: lead, source: "manual", name: `Q${i}`, amount: i % 2 ? 10 : null });
      await dealService.createDeal(client, rep, boardWs, { leadId: lead, source: "manual", name: "Sent", stage: "proposal_sent", amount: 7 });
    });
    const res = await call("GET", "/deals/board", undefined, rep, boardWs);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.map((c: { stage: string }) => c.stage)).toEqual(STAGES);
    const qualified = res.body.data[0];
    expect(qualified).toMatchObject({ count: 23, amountTotal: 110 });
    expect(qualified.items).toHaveLength(20);
    expect(qualified.nextCursor).toEqual(expect.any(String));
    expect(res.body.data[4]).toMatchObject({ stage: "proposal_sent", count: 1, amountTotal: 7, nextCursor: null });
    expect(res.body.data[6]).toEqual({ stage: "won", count: 0, amountTotal: 0, items: [], nextCursor: null });
    const more = await call("GET", `/deals${qs({ stage: "qualified", sort: "updatedAt:desc", cursor: qualified.nextCursor })}`, undefined, rep, boardWs);
    expect(more.status).toBe(200);
    expect(more.body.data).toHaveLength(3);
    const all = [...qualified.items, ...more.body.data].map((d: { id: string }) => d.id);
    expect(new Set(all).size).toBe(23);
    expect((await call("GET", `/deals/board${qs({ stage: "qualified" })}`, undefined, rep, boardWs)).status).toBe(400);
    expect((await call("GET", `/deals/board${qs({ q: "Q1" })}`, undefined, rep, boardWs)).body.data[0].count).toBe(11);
  });

  it("create: manual deal for a contact; lost needs a reason; INR only; other workspace's contact 404", async () => {
    const res = await call("POST", "/deals", { leadId: contactA, amount: 12345.67, expectedCloseDate: "2027-03-31" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ stage: "qualified", source: "manual", amount: 12345.67, currency: "INR", expectedCloseDate: "2027-03-31", company: { id: companyA }, meetings: [], proposals: [] });
    expect(res.body.name).toContain("Acme Deals");
    expect(res.body.owner).toEqual({ id: rep.id, name: "Rep Deals" });
    expect((await call("POST", "/deals", { leadId: contactA, stage: "lost" })).status).toBe(400);
    expect((await call("POST", "/deals", { leadId: contactA, currency: "USD" })).status).toBe(400);
    expect((await call("POST", "/deals", { leadId: otherContact })).status).toBe(404);
    expect((await call("POST", "/deals", {})).status).toBe(400);
  });

  it("create with ownerId (C5): omitted = contact's owner, an active user, null; inactive/unknown 400; other workspace untouched", async () => {
    const owner = async (body: Record<string, unknown>) => {
      const res = await call("POST", "/deals", { leadId: contactB, ...body });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body.owner;
    };
    expect(await owner({})).toEqual({ id: admin.id, name: "Admin Deals" });
    expect(await owner({ ownerId: rep.id })).toEqual({ id: rep.id, name: "Rep Deals" });
    expect(await owner({ ownerId: null })).toBeNull();
    const before = (await pool.query(`select count(*)::int as n from public.deals where workspace_id = $1`, [ws])).rows[0].n;
    for (const ownerId of [inactive.id, "00000000-0000-4000-8000-000000000000"]) {
      const res = await call("POST", "/deals", { leadId: contactB, ownerId });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain("active member");
    }
    expect((await call("POST", "/deals", { leadId: contactB, ownerId: "me" })).status).toBe(400);
    expect((await pool.query(`select count(*)::int as n from public.deals where workspace_id = $1`, [ws])).rows[0].n).toBe(before);
    const foreign = await pool.query(`select owner_id from public.deals where id = $1`, [otherDeal]);
    expect(foreign.rows[0].owner_id).toBe(rep.id);
  });

  it("PATCH: fields; stage → 400 with a hint; non-INR → 400; owner must be active; company must be in the workspace", async () => {
    const id = deals.a8!;
    const res = await call("PATCH", `/deals/${id}`, { name: "Renamed deal", amount: null, expectedCloseDate: "2027-02-02", ownerId: admin.id, companyId: null });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ name: "Renamed deal", amount: null, expectedCloseDate: "2027-02-02", owner: { id: admin.id }, company: null });
    const stage = await call("PATCH", `/deals/${id}`, { stage: "won" });
    expect(stage.status).toBe(400);
    expect(stage.body.error.message).toContain("/stage");
    expect((await call("PATCH", `/deals/${id}`, { currency: "USD" })).status).toBe(400);
    expect((await call("PATCH", `/deals/${id}`, { ownerId: inactive.id })).status).toBe(400);
    const otherCompany = (await pool.query(`select company_id from public.leads where id = $1`, [otherContact])).rows[0].company_id;
    expect((await call("PATCH", `/deals/${id}`, { companyId: otherCompany })).status).toBe(404);
    expect((await call("PATCH", `/deals/${id}`, { companyId: companyA })).body.company).toEqual({ id: companyA, name: "Acme Deals" });
    expect((await call("PATCH", `/deals/${id}`, { amount: -1 })).status).toBe(400);
  });

  it("stage moves: lost needs a reason, same stage 409, won with no other open deal wins the contact", async () => {
    const solo = await contact(ws, "Solo Co", "s@soloco.example.com");
    const deal = (await call("POST", "/deals", { leadId: solo })).body.id;
    expect((await call("POST", `/deals/${deal}/stage`, { stage: "lost" })).status).toBe(400);
    expect((await call("POST", `/deals/${deal}/stage`, { stage: "qualified" })).status).toBe(409);
    const moved = await call("POST", `/deals/${deal}/stage`, { stage: "negotiation", nextDecisionDate: "2030-01-15" });
    expect(moved.body).toMatchObject({ stage: "negotiation", closedAt: null });
    const lost = await call("POST", `/deals/${deal}/stage`, { stage: "lost", lossReason: "price_budget", lossNotes: "too high" });
    expect(lost.body).toMatchObject({ stage: "lost", lossReason: "price_budget", lossNotes: "too high" });
    expect(lost.body.closedAt).toEqual(expect.any(String));
    expect((await pool.query(`select lifecycle_state from public.leads where id = $1`, [solo])).rows[0].lifecycle_state).toBe("active");
    const won = await call("POST", `/deals/${deal}/stage`, { stage: "won" });
    expect(won.body).toMatchObject({ stage: "won", lossReason: null });
    expect((await pool.query(`select lifecycle_state from public.leads where id = $1`, [solo])).rows[0].lifecycle_state).toBe("won");
    expect((await call("POST", `/deals/${deal}/stage`, { stage: "done" })).status).toBe(400);
  });

  it("detail lists linked meetings and proposals; company deals; workspace isolation", async () => {
    const detail = await call("GET", `/deals/${deals.a1}`);
    expect(detail.body).toMatchObject({ id: deals.a1, contact: { id: contactA, email: "a@acmedeals.example.com" }, meetings: [], proposals: [] });
    const companyDeals = await call("GET", `/companies/${companyA}/deals${qs({ status: "all", limit: 100 })}`);
    expect(companyDeals.status).toBe(200);
    expect(companyDeals.body.data.length).toBeGreaterThanOrEqual(8);
    expect(companyDeals.body.data.map((d: { id: string }) => d.id)).not.toContain(deals.b1);

    expect(await listIds({ status: "all" })).not.toContain(otherDeal);
    expect(await listIds({ q: "Foreign", status: "all" })).toEqual([]);
    expect((await call("GET", `/deals/${otherDeal}`)).status).toBe(404);
    expect((await call("PATCH", `/deals/${otherDeal}`, { name: "x" })).status).toBe(404);
    expect((await call("POST", `/deals/${otherDeal}/stage`, { stage: "negotiation", nextDecisionDate: "2030-01-15" })).status).toBe(404);
    expect((await call("GET", "/deals/count", undefined, rep, otherWs)).body).toEqual({ count: 1 });
    const board = (await call("GET", "/deals/board", undefined, rep, otherWs)).body.data;
    expect(board[0]).toMatchObject({ stage: "qualified", count: 1 });
  });
});
