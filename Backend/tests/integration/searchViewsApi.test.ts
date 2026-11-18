/**
 * CRM v2 global search and saved views (B4) through the HTTP stack: top 5 per object,
 * best match first, merged rows excluded, literal q; saved views validated by the list
 * schemas, ownership rules, the 30 limit; workspace isolation.
 * Skipped unless TEST_DATABASE_URL is set; [test] workspaces only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createTestWorkspace, deleteCreatedTestWorkspaces } from "../helpers/testWorkspaces.js";
import { qs, startTestApi, type TestApi } from "../helpers/testApi.js";
import type { Actor } from "../../src/authMiddleware.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb("search + saved views API (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let api: TestApi;
  let admin: Actor;
  let rep: Actor;
  let rep2: Actor;
  let ws: string;
  let otherWs: string;
  let withTransaction: typeof import("../../src/db.js").withTransaction;
  let leads: typeof import("../../src/services/leads.service.js");
  let deals: typeof import("../../src/services/deals.service.js");

  const call = (as: Actor, method: string, path: string, body?: unknown, workspace = ws) => api.call(as, workspace, method, path, body);
  const contact = (workspace: string, firstName: string, company: string, email: string) =>
    withTransaction(async (client) => (await leads.createLead(client, rep, workspace, { firstName, lastName: "Sharma", company, email, source: "referral", ownerId: rep.id })).id);

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
    api = await startTestApi(pool, "search-views");
    admin = await api.newUser("admin");
    rep = await api.newUser("salesperson");
    rep2 = await api.newUser("salesperson");
    ({ withTransaction } = await import("../../src/db.js"));
    leads = await import("../../src/services/leads.service.js");
    deals = await import("../../src/services/deals.service.js");
    ws = await createTestWorkspace(pool, "search-views");
    otherWs = await createTestWorkspace(pool, "search-views-other");
  });

  afterAll(async () => {
    await deleteCreatedTestWorkspaces(pool);
    await api.close();
    await pool.end();
  });

  it("search: top 5 per object, best match first, merged excluded, literal q, workspace-scoped", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push(await contact(ws, `Priya${i}`, `Sharma Textiles ${i}`, `p${i}@sharmatex${i}.example.com`));
    const exact = await contact(ws, "Exact", "Sharma Textiles", "e@sharmatextiles.example.com");
    const merged = await contact(ws, "Merged", "Zeta Sharma", "m@zeta.example.com");
    await withTransaction((client) => leads.mergeLead(client, rep, ws, merged, exact, "dupe"));
    await withTransaction((client) => deals.createDeal(client, rep, ws, { leadId: exact, source: "manual", name: "Sharma 100% expansion" }));
    await contact(otherWs, "Foreign", "Sharma Foreign", "f@sharmaforeign.example.com");

    const res = await call(rep, "GET", `/search${qs({ q: "Sharma Textiles" })}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.contacts).toHaveLength(5);
    expect(res.body.contacts[0]).toMatchObject({ id: exact, company: "Sharma Textiles", lifecycle: "active" });
    expect(res.body.companies).toHaveLength(5);
    expect(res.body.companies[0]).toMatchObject({ name: "Sharma Textiles", domain: "sharmatextiles.example.com" });
    expect(res.body.deals).toEqual([expect.objectContaining({ name: "Sharma 100% expansion", stage: "qualified", company: expect.objectContaining({ name: "Sharma Textiles" }) })]);

    expect((await call(rep, "GET", `/search${qs({ q: "Merged" })}`)).body.contacts).toEqual([]);
    const zeta = (await pool.query(`select company_id from public.leads where id = $1`, [merged])).rows[0].company_id;
    const target = (await pool.query(`select company_id from public.leads where id = $1`, [exact])).rows[0].company_id;
    await withTransaction((client) => import("../../src/services/companies.service.js").then((m) => m.mergeCompanies(client, admin, ws, target, zeta)));
    expect((await call(rep, "GET", `/search${qs({ q: "Zeta" })}`)).body.companies).toEqual([]);
    expect((await call(rep, "GET", `/search${qs({ q: "Foreign" })}`)).body).toEqual({ contacts: [], companies: [], deals: [] });
    expect((await call(rep, "GET", `/search${qs({ q: "100%" })}`)).body.deals).toHaveLength(1);
    expect(await call(rep, "GET", `/search${qs({ q: "%%" })}`).then((r) => r.body)).toEqual({ contacts: [], companies: [], deals: [] });
    expect((await call(rep, "GET", `/search${qs({ q: "s_arma" })}`)).body.contacts).toEqual([]);
    expect((await call(rep, "GET", `/search${qs({ q: "s" })}`)).status).toBe(400);
    expect((await call(rep, "GET", `/search`)).status).toBe(400);
    expect((await call(rep, "GET", `/search${qs({ q: "sharma" })}`, undefined, otherWs)).body.contacts.map((c: { name: string }) => c.name)).toEqual(["Foreign Sharma"]);
  });

  it("saved views: filters/sort/columns validated by the list schemas", async () => {
    const ok = await call(rep, "POST", "/saved-views", { object: "contacts", name: "My new", filters: { ownerId: "me", leadStatus: ["new"], hasOpenDeal: "false" }, sort: "name:asc", columns: ["name", "email"] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body).toMatchObject({ object: "contacts", name: "My new", filters: { ownerId: "me", leadStatus: ["new"], hasOpenDeal: "false" }, sort: "name:asc", columns: ["name", "email"], isShared: false, isMine: true });
    // The stored filters work as the list endpoint's query.
    expect((await call(rep, "GET", `/contacts${qs(ok.body.filters)}`)).status).toBe(200);
    expect((await call(rep, "POST", "/saved-views", { object: "deals", name: "Won", filters: { status: "won", amountMin: "10" }, sort: "amount:desc" })).status).toBe(201);
    for (const bad of [
      { object: "contacts", name: "x", filters: { foo: "1" } },
      { object: "contacts", name: "x", filters: { hasOpenDeal: true } },
      { object: "contacts", name: "x", filters: { q: "a" } },
      { object: "contacts", name: "x", sort: "email:asc" },
      { object: "contacts", name: "x", columns: ["nope"] },
      { object: "contacts", name: "x", columns: ["name", "name"] },
      { object: "companies", name: "x", filters: { stage: "won" } },
      { object: "deals", name: "x", sort: "contactCount:asc" },
      { object: "invoices", name: "x" },
      { object: "contacts", name: " " },
    ]) {
      expect((await call(rep, "POST", "/saved-views", bad)).status, JSON.stringify(bad)).toBe(400);
    }
    const patchBad = await call(rep, "PATCH", `/saved-views/${ok.body.id}`, { filters: { companyId: "not-a-uuid" } });
    expect(patchBad.status).toBe(400);
  });

  it("saved views: own + shared listed; owner edits, admins may edit/delete shared, others can't", async () => {
    const shared = (await call(rep, "POST", "/saved-views", { object: "companies", name: "Shared", isShared: true })).body;
    const privateView = (await call(rep, "POST", "/saved-views", { object: "companies", name: "Private" })).body;
    const mine = (await call(rep2, "POST", "/saved-views", { object: "companies", name: "Rep2" })).body;

    const listed = await call(rep2, "GET", `/saved-views${qs({ object: "companies" })}`);
    expect(listed.body.data.map((v: { name: string }) => v.name).sort()).toEqual(["Rep2", "Shared"]);
    expect(listed.body.data.find((v: { name: string }) => v.name === "Shared").isMine).toBe(false);
    expect((await call(rep2, "GET", `/saved-views`)).status).toBe(400);

    expect((await call(rep2, "PATCH", `/saved-views/${shared.id}`, { name: "Hijack" })).status).toBe(403);
    expect((await call(rep2, "DELETE", `/saved-views/${shared.id}`)).status).toBe(403);
    expect((await call(rep2, "PATCH", `/saved-views/${privateView.id}`, { name: "x" })).status).toBe(404);
    expect((await call(admin, "PATCH", `/saved-views/${privateView.id}`, { name: "x" })).status).toBe(404);
    expect((await call(rep2, "PATCH", `/saved-views/${mine.id}`, { name: "Rep2 renamed", position: 3 })).body).toMatchObject({ name: "Rep2 renamed", position: 3 });

    const byAdmin = await call(admin, "PATCH", `/saved-views/${shared.id}`, { name: "Shared (admin)", isShared: false });
    expect(byAdmin.status).toBe(200);
    expect(byAdmin.body).toMatchObject({ name: "Shared (admin)", isShared: false, isMine: false });
    expect((await call(rep, "PATCH", `/saved-views/${shared.id}`, { isShared: true })).status).toBe(200);
    expect((await call(admin, "DELETE", `/saved-views/${shared.id}`)).status).toBe(204);
    expect((await call(rep, "DELETE", `/saved-views/${privateView.id}`)).status).toBe(204);
    expect((await call(rep, "GET", `/saved-views${qs({ object: "companies" })}`)).body.data).toEqual([]);
  });

  it("saved views: at most 30 per user per object; workspace isolation", async () => {
    await pool.query(
      `insert into public.saved_views (workspace_id, owner_id, object, name) select $1, $2, 'deals', 'v' || g from generate_series(1, 29) g`,
      [ws, rep2.id],
    );
    expect((await call(rep2, "POST", "/saved-views", { object: "deals", name: "30th" })).status).toBe(201);
    const over = await call(rep2, "POST", "/saved-views", { object: "deals", name: "31st" });
    expect(over.status).toBe(409);
    expect((await call(rep2, "POST", "/saved-views", { object: "contacts", name: "other object" })).status).toBe(201);
    expect((await call(rep, "POST", "/saved-views", { object: "deals", name: "other user" })).status).toBe(201);

    const foreign = (await call(rep, "POST", "/saved-views", { object: "deals", name: "Foreign shared", isShared: true }, otherWs)).body;
    expect((await call(rep, "GET", `/saved-views${qs({ object: "deals" })}`)).body.data.map((v: { id: string }) => v.id)).not.toContain(foreign.id);
    expect((await call(admin, "PATCH", `/saved-views/${foreign.id}`, { name: "x" })).status).toBe(404);
    expect((await call(admin, "DELETE", `/saved-views/${foreign.id}`)).status).toBe(404);
  });
});
