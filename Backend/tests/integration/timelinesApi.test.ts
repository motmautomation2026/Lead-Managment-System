/**
 * Paginated timelines (C3): GET /contacts/:id/timeline and GET /companies/:id/timeline
 * through the HTTP stack: keyset paging (limit 3, ties on occurred_at), kind filter,
 * the company feed's membership (own contacts + its deals; merged contacts out), isolation.
 * Skipped unless TEST_DATABASE_URL is set; [test] workspaces only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createTestWorkspace, deleteCreatedTestWorkspaces } from "../helpers/testWorkspaces.js";
import { expectConsistentPaging, qs, startTestApi, type TestApi } from "../helpers/testApi.js";
import type { Actor } from "../../src/authMiddleware.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb("paginated timelines (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let api: TestApi;
  let rep: Actor;
  let ws: string;
  let otherWs: string;
  let companyId: string;
  let otherCompanyId: string;
  const ids: Record<string, string> = {};
  let withTransaction: typeof import("../../src/db.js").withTransaction;
  let leads: typeof import("../../src/services/leads.service.js");
  let timeline: typeof import("../../src/services/timeline.service.js");

  const call = (path: string, workspace = ws) => api.call(rep, workspace, "GET", path);
  const contact = (key: string, company: string, workspace = ws) =>
    withTransaction(async (client) => {
      const row = await leads.createLead(client, rep, workspace, { firstName: key, lastName: "Feed", company, email: `${key}@feed-${key}.example.com`, source: "referral", ownerId: rep.id });
      ids[key] = row.id;
      return row.id;
    });
  const event = (leadId: string, kind: string, title: string, extra: { actorName?: string; relatedDealId?: string } = {}) =>
    timeline.addTimelineEvent(pool, { leadId, kind, title, actorName: extra.actorName ?? "Rep", actorSource: "manual", relatedDealId: extra.relatedDealId ?? null });
  const titles = async (path: string) => {
    const res = await call(path);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return (res.body.data as { title: string }[]).map((r) => r.title);
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
    api = await startTestApi(pool, "timelines-api");
    rep = await api.newUser("salesperson", { name: "Rep Timelines" });
    ({ withTransaction } = await import("../../src/db.js"));
    leads = await import("../../src/services/leads.service.js");
    timeline = await import("../../src/services/timeline.service.js");
    ws = await createTestWorkspace(pool, "timelines-api");
    otherWs = await createTestWorkspace(pool, "timelines-api-other");

    companyId = (await api.call(rep, ws, "POST", "/companies", { name: "Feed Corp" })).body.id;
    otherCompanyId = (await api.call(rep, otherWs, "POST", "/companies", { name: "Feed Corp" })).body.id;
    await contact("a", "Feed Corp");
    await contact("b", "Feed Corp");
    await contact("m", "Feed Corp");
    await contact("c", "Elsewhere Ltd");
    await contact("x", "Feed Corp", otherWs);
    for (const key of ["a", "b", "m"]) {
      expect((await pool.query(`select company_id from public.leads where id = $1`, [ids[key]])).rows[0].company_id).toBe(companyId);
    }

    for (const [kind, title] of [["note", "A note"], ["call", "A call"], ["meeting", "A meeting"], ["task", "A task"], ["stage", "A stage"], ["whatsapp", "A message"]]) {
      await event(ids.a!, kind!, title!);
    }
    await event(ids.b!, "note", "B note");
    await event(ids.b!, "automation", "B AI", { actorName: "AI Agent" });
    await event(ids.m!, "note", "M note (merged)");
    await event(ids.c!, "note", "C note (other company)");
    await event(ids.x!, "note", "X note (other workspace)");
    // A deal of Feed Corp whose contact belongs elsewhere: its events are in the company feed.
    const deal = await pool.query<{ id: string }>(
      `insert into public.deals (workspace_id, name, lead_id, company_id, stage, source) values ($1, 'Feed deal', $2, $3, 'qualified', 'manual') returning id`,
      [ws, ids.c, companyId],
    );
    await event(ids.c!, "system", "C deal event", { relatedDealId: deal.rows[0]!.id });
    await withTransaction((client) => leads.mergeLead(client, rep, ws, ids.m!, ids.b!, "dupe"));
    // Ties: several rows share occurred_at, so paging must break them on id.
    await pool.query(`update public.timeline_events set occurred_at = '2026-01-01T00:00:00Z' where lead_id = $1 and title in ('A note', 'A call', 'A meeting', 'A task')`, [ids.a]);
  });

  afterAll(async () => {
    await deleteCreatedTestWorkspaces(pool);
    await api.close();
    await pool.end();
  });

  it("pages a contact's timeline with limit 3: newest first, no gaps or duplicates", async () => {
    const seen = await expectConsistentPaging((q) => call(`/contacts/${ids.a}/timeline${q}`), {}, 3);
    const all = (await pool.query<{ id: string }>(`select id from public.timeline_events where lead_id = $1 order by occurred_at desc, id desc`, [ids.a])).rows.map((r) => r.id);
    expect(seen).toEqual(all);
    expect(seen.length).toBeGreaterThan(6);
    const first = (await call(`/contacts/${ids.a}/timeline${qs({ limit: 1 })}`)).body.data[0];
    expect(first).toMatchObject({ leadId: ids.a, title: expect.any(String), at: expect.any(String) });
  });

  it("filters by activity type (repeatable kind)", async () => {
    expect(await titles(`/contacts/${ids.a}/timeline${qs({ kind: "notes" })}`)).toEqual(["A note"]);
    expect((await titles(`/contacts/${ids.a}/timeline${qs({ kind: ["calls", "messages"] })}`)).sort()).toEqual(["A call", "A message"]);
    expect(await titles(`/contacts/${ids.a}/timeline${qs({ kind: "meetings" })}`)).toEqual(["A meeting"]);
    expect(await titles(`/contacts/${ids.a}/timeline${qs({ kind: "system" })}`)).toContain("A stage");
    expect(await titles(`/companies/${companyId}/timeline${qs({ kind: "ai" })}`)).toEqual(["B AI"]);
    expect(await titles(`/companies/${companyId}/timeline${qs({ kind: "deals" })}`)).toEqual(["C deal event"]);
    expect((await call(`/contacts/${ids.a}/timeline${qs({ kind: "bogus" })}`)).status).toBe(400);
    expect((await call(`/contacts/${ids.a}/timeline${qs({ sort: "at:asc" })}`)).status).toBe(400);
    expect((await call(`/contacts/${ids.a}/timeline${qs({ cursor: "nope" })}`)).status).toBe(400);
  });

  it("company feed: its contacts and deals only, merged contacts excluded, each row names the contact", async () => {
    const seen = await expectConsistentPaging((q) => call(`/companies/${companyId}/timeline${q}`), {}, 3);
    const res = await call(`/companies/${companyId}/timeline${qs({ limit: 100 })}`);
    const rows = res.body.data as { id: string; title: string; leadId: string; contact: { id: string; name: string } }[];
    expect(rows.map((r) => r.id)).toEqual(seen);
    const got = rows.map((r) => r.title);
    expect(got).toEqual(expect.arrayContaining(["A note", "A message", "B note", "B AI", "C deal event"]));
    expect(got).not.toContain("M note (merged)");
    expect(got).not.toContain("C note (other company)");
    expect(got).not.toContain("X note (other workspace)");
    expect(new Set(rows.map((r) => r.leadId))).toEqual(new Set([ids.a, ids.b, ids.c]));
    for (const r of rows) expect(r.contact.id).toBe(r.leadId);
    expect(rows.find((r) => r.title === "C deal event")!.contact).toEqual({ id: ids.c, name: "c Feed" });
  });

  it("isolation: other workspaces' contacts and companies are 404; the old timeline is unchanged", async () => {
    expect((await call(`/contacts/${ids.x}/timeline`)).status).toBe(404);
    expect((await call(`/companies/${otherCompanyId}/timeline`)).status).toBe(404);
    expect((await call(`/companies/${otherCompanyId}/timeline`, otherWs)).body.data.map((r: { title: string }) => r.title)).toContain("X note (other workspace)");
    const old = await call(`/leads/${ids.a}/timeline`);
    expect(old.status).toBe(200);
    expect(old.body.nextCursor).toBeUndefined();
    const at = (old.body.data as { at: string }[]).map((r) => r.at);
    expect(at).toEqual([...at].sort());
  });
});
