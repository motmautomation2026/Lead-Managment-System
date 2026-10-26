/**
 * C4 deal API additions through the HTTP stack: GET /deals/:id/timeline (paging, kind filter incl.
 * the new `proposals` group, linked meetings/proposals, isolation), the single-query board (same
 * data as the per-stage list endpoints), and POST /deals/:id/stage `contactAction`.
 * Skipped unless TEST_DATABASE_URL is set; [test] workspaces only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createTestWorkspace, deleteCreatedTestWorkspaces } from "../helpers/testWorkspaces.js";
import { expectConsistentPaging, qs, startTestApi, type JsonBody, type TestApi } from "../helpers/testApi.js";
import type { Actor } from "../../src/authMiddleware.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const STAGES = ["qualified", "meeting_scheduled", "meeting_follow_up", "proposal_preparation", "proposal_sent", "negotiation", "won", "lost"];

describeIfDb("deals C4 API (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let api: TestApi;
  let rep: Actor;
  let admin: Actor;
  let ws: string;
  let otherWs: string;
  let withTransaction: typeof import("../../src/db.js").withTransaction;
  let leads: typeof import("../../src/services/leads.service.js");
  let meetings: typeof import("../../src/services/meetings.service.js");
  let proposals: typeof import("../../src/services/proposals.service.js");
  let dealService: typeof import("../../src/services/deals.service.js");
  let timeline: typeof import("../../src/services/timeline.service.js");

  const call = (method: string, path: string, body?: unknown, workspace = ws, as: Actor = rep) => api.call(as, workspace, method, path, body);
  const contact = (company: string, workspace = ws, ownerId = rep.id) =>
    withTransaction(async (client) => (await leads.createLead(client, rep, workspace, { firstName: "Cee", lastName: company, company, email: `${company.replace(/\W/g, "").toLowerCase()}@c4-${company.length}.example.com`, source: "referral", ownerId })).id);
  const lifecycle = async (leadId: string) =>
    (await pool.query<{ lifecycle_state: string; loss_reason: string | null; loss_notes: string | null }>(`select lifecycle_state, loss_reason, loss_notes from public.leads where id = $1`, [leadId])).rows[0]!;
  const stageOf = async (dealId: string) => (await pool.query<{ stage: string }>(`select stage from public.deals where id = $1`, [dealId])).rows[0]!.stage;
  const timelineTitles = async (leadId: string) =>
    (await pool.query<{ title: string; detail: string | null }>(`select title, detail from public.timeline_events where lead_id = $1 order by occurred_at, id`, [leadId])).rows;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
    api = await startTestApi(pool, "deals-c4");
    rep = await api.newUser("salesperson", { name: "Rep C4" });
    admin = await api.newUser("admin", { name: "Admin C4" });
    ({ withTransaction } = await import("../../src/db.js"));
    leads = await import("../../src/services/leads.service.js");
    meetings = await import("../../src/services/meetings.service.js");
    proposals = await import("../../src/services/proposals.service.js");
    dealService = await import("../../src/services/deals.service.js");
    timeline = await import("../../src/services/timeline.service.js");
    ws = await createTestWorkspace(pool, "deals-c4");
    otherWs = await createTestWorkspace(pool, "deals-c4-other");
  });

  afterAll(async () => {
    await deleteCreatedTestWorkspaces(pool);
    await api.close();
    await pool.end();
  });

  describe("GET /deals/:id/timeline", () => {
    let leadId: string;
    let dealId: string;
    let otherDealId: string;

    beforeAll(async () => {
      leadId = await contact("Feed Deal Co");
      dealId = (await call("POST", "/deals", { leadId, name: "Feed deal" })).body.id;
      otherDealId = (await call("POST", "/deals", { leadId, name: "Other feed deal" })).body.id;
      const at = new Date(Date.now() + 86_400_000).toISOString();
      const meeting = await withTransaction((c) => meetings.scheduleMeeting(c, rep, ws, { leadId, title: "Linked intro", at, dealId }));
      await withTransaction((c) => meetings.recordMeetingOutcome(c, rep, ws, meeting.id, "proposal_required"));
      const proposal = await withTransaction((c) => proposals.createProposal(c, rep, ws, { leadId, title: "Linked proposal", amount: 5000 }));
      // createProposal attaches to the newest open deal: point it at ours explicitly for the test.
      await pool.query(`update public.proposals set deal_id = $2 where id = $1`, [proposal.id, dealId]);
      await withTransaction((c) => proposals.updateProposalStatus(c, rep, ws, proposal.id, "sent", {}));
      await withTransaction((c) => meetings.scheduleMeeting(c, rep, ws, { leadId, title: "Other deal intro", at, dealId: otherDealId }));
      await timeline.addTimelineEvent(pool, { leadId, kind: "note", title: "Plain contact note", actorName: "Rep", actorSource: "manual" });
      // Ties on occurred_at must break on id.
      await pool.query(`update public.timeline_events set occurred_at = '2026-01-01T00:00:00Z' where lead_id = $1 and title in ('Meeting Scheduled', 'Proposal Created', 'Plain contact note')`, [leadId]);
    });

    it("pages with limit 3 (no gaps or duplicates): deal rows + linked meeting/proposal rows, each with the contact", async () => {
      const seen = await expectConsistentPaging((q) => call("GET", `/deals/${dealId}/timeline${q}`), {}, 3);
      const expected = (
        await pool.query<{ id: string }>(
          `select t.id from public.timeline_events t
            where t.related_deal_id = $1
               or t.related_meeting_id in (select id from public.meetings where deal_id = $1)
               or t.related_proposal_id in (select id from public.proposals where deal_id = $1)
            order by t.occurred_at desc, t.id desc`,
          [dealId],
        )
      ).rows.map((r) => r.id);
      expect(seen).toEqual(expected);
      const rows = (await call("GET", `/deals/${dealId}/timeline${qs({ limit: 100 })}`)).body.data as JsonBody[];
      const titles = rows.map((r) => r.title as string);
      expect(titles).toEqual(expect.arrayContaining(["Deal created", "Meeting Scheduled", "Meeting Completed", "Proposal Created", "Proposal sent"]));
      expect(titles).not.toContain("Plain contact note");
      expect(rows.filter((r) => r.title === "Meeting Scheduled")).toHaveLength(1); // not the other deal's meeting
      expect(rows.every((r) => r.relatedDealId !== otherDealId)).toBe(true);
      for (const r of rows) expect(r.contact).toEqual({ id: leadId, name: "Cee Feed Deal Co" });
    });

    it("kind filter: proposals are their own group (deal, contact feeds); deal stage rows are deals", async () => {
      const kind = async (path: string, k: string | string[]) => ((await call("GET", `${path}${qs({ kind: k, limit: 100 })}`)).body.data as JsonBody[]).map((r) => r.title as string).sort();
      expect(await kind(`/deals/${dealId}/timeline`, "proposals")).toEqual(["Proposal Created", "Proposal sent"]);
      expect(await kind(`/deals/${dealId}/timeline`, "meetings")).toEqual(["Meeting Completed", "Meeting Scheduled"]);
      const dealRows = await kind(`/deals/${dealId}/timeline`, "deals");
      expect(dealRows).toContain("Deal created");
      expect(dealRows.some((t) => t.startsWith("Deal stage changed"))).toBe(true);
      expect(await kind(`/contacts/${leadId}/timeline`, "proposals")).toEqual(["Proposal Created", "Proposal sent"]);
      expect(await kind(`/contacts/${leadId}/timeline`, ["meetings", "notes"])).toEqual(["Meeting Completed", "Meeting Scheduled", "Meeting Scheduled", "Plain contact note"]);
      expect((await call("GET", `/deals/${dealId}/timeline${qs({ kind: "bogus" })}`)).status).toBe(400);
      expect((await call("GET", `/deals/${dealId}/timeline${qs({ sort: "at:asc" })}`)).status).toBe(400);
    });

    it("isolation: another workspace's deal is 404; a missing deal is 404", async () => {
      const foreignLead = await contact("Foreign C4 Co", otherWs);
      const foreignDeal = (await call("POST", "/deals", { leadId: foreignLead }, otherWs)).body.id;
      expect((await call("GET", `/deals/${foreignDeal}/timeline`)).status).toBe(404);
      expect((await call("GET", `/deals/${foreignDeal}/timeline`, undefined, otherWs)).status).toBe(200);
      expect((await call("GET", `/deals/00000000-0000-4000-8000-000000000000/timeline`)).status).toBe(404);
    });
  });

  it("board (one query) returns exactly what the per-stage list endpoints return: all 8 stages, counts, totals, items, cursors", async () => {
    const boardWs = await createTestWorkspace(pool, "deals-c4-board");
    const a = await contact("Alpha Board Co", boardWs);
    const b = await contact("Beta Board Co", boardWs, admin.id);
    await withTransaction(async (client) => {
      for (let i = 0; i < 23; i++) await dealService.createDeal(client, rep, boardWs, { leadId: i % 3 ? a : b, source: "manual", name: `Q${i}`, amount: i % 2 ? 10.5 : null });
      const more: [string, Record<string, unknown>][] = [
        ["meeting_scheduled", { amount: 100 }],
        ["meeting_follow_up", { amount: null }],
        ["proposal_preparation", { amount: 2500.5 }],
        ["proposal_sent", { amount: 7 }],
        ["negotiation", { amount: 1 }],
        ["won", { amount: 900 }],
        ["won", { amount: null }],
        ["lost", { amount: 50, lossReason: "price_budget" }],
      ];
      for (const [stage, extra] of more) await dealService.createDeal(client, rep, boardWs, { leadId: b, source: "manual", name: `S ${stage}`, stage, ...extra } as never);
    });
    // Different updated_at for some rows (ordering inside a stage is updated_at desc, id desc).
    await pool.query(`update public.deals set updated_at = now() + interval '1 minute' where workspace_id = $1 and name in ('Q3', 'Q4', 'S won')`, [boardWs]);

    for (const filters of [{}, { status: "all" }, { status: "all", ownerId: "me" }, { status: "won" }, { q: "Q1" }, { status: "all", amountMin: "8" }]) {
      const board = await call("GET", `/deals/board${qs(filters)}`, undefined, boardWs);
      expect(board.status, JSON.stringify(board.body)).toBe(200);
      expect(board.body.data.map((c: { stage: string }) => c.stage)).toEqual(STAGES);
      for (const [i, stage] of STAGES.entries()) {
        const params = { ...filters, status: (filters as { status?: string }).status ?? "open", stage };
        const count = (await call("GET", `/deals/count${qs(params)}`, undefined, boardWs)).body.count as number;
        const page = (await call("GET", `/deals${qs({ ...params, sort: "updatedAt:desc", limit: 20 })}`, undefined, boardWs)).body;
        const all = (await call("GET", `/deals${qs({ ...params, limit: 100 })}`, undefined, boardWs)).body.data as { amount: number | null }[];
        const amountTotal = all.reduce((sum, d) => sum + (d.amount ?? 0), 0);
        expect(board.body.data[i], `${JSON.stringify(filters)} ${stage}`).toEqual({ stage, count, amountTotal, items: page.data, nextCursor: page.nextCursor });
      }
    }
    const open = (await call("GET", "/deals/board", undefined, boardWs)).body.data;
    expect(open[0]).toMatchObject({ stage: "qualified", count: 23, amountTotal: 115.5 });
    expect(open[0].items).toHaveLength(20);
    expect(open[0].items.slice(0, 2).map((d: { name: string }) => d.name).sort()).toEqual(["Q3", "Q4"]);
    expect(open[6]).toEqual({ stage: "won", count: 0, amountTotal: 0, items: [], nextCursor: null });
    const more = await call("GET", `/deals${qs({ stage: "qualified", sort: "updatedAt:desc", cursor: open[0].nextCursor })}`, undefined, boardWs);
    expect(more.body.data).toHaveLength(3);
    expect(new Set([...open[0].items, ...more.body.data].map((d: { id: string }) => d.id)).size).toBe(23);
    expect((await call("GET", `/deals/board${qs({ stage: "won" })}`, undefined, boardWs)).status).toBe(400);
  });

  describe("POST /deals/:id/stage contactAction", () => {
    it("keep (default and explicit): the contact stays active", async () => {
      const leadId = await contact("Keep Co");
      const d1 = (await call("POST", "/deals", { leadId })).body.id;
      const d2 = (await call("POST", "/deals", { leadId })).body.id;
      expect((await call("POST", `/deals/${d1}/stage`, { stage: "lost", lossReason: "no_response", contactAction: "keep" })).status).toBe(200);
      expect((await call("POST", `/deals/${d2}/stage`, { stage: "lost", lossReason: "no_response" })).status).toBe(200);
      expect((await lifecycle(leadId)).lifecycle_state).toBe("active");
    });

    it("long_term_nurture: contact parked with the deal as the reason; its other open deal stays open", async () => {
      const leadId = await contact("Nurture Co");
      const d1 = (await call("POST", "/deals", { leadId, name: "Nurture deal" })).body.id;
      const d2 = (await call("POST", "/deals", { leadId })).body.id;
      const res = await call("POST", `/deals/${d1}/stage`, { stage: "lost", lossReason: "project_postponed", lossNotes: "next year", contactAction: "long_term_nurture" });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ stage: "lost", lossReason: "project_postponed", lossNotes: "next year", contact: { id: leadId, lifecycle: "long_term_nurture" } });
      expect((await lifecycle(leadId)).lifecycle_state).toBe("long_term_nurture");
      expect(await stageOf(d2)).toBe("qualified");
      expect(await timelineTitles(leadId)).toContainEqual({ title: "Moved to Long-Term Nurture", detail: "Deal lost: Nurture deal" });
    });

    it("lost: contact lost with the deal's reason and notes; its other open deals close as lost (existing rule)", async () => {
      const leadId = await contact("Lost Co");
      const d1 = (await call("POST", "/deals", { leadId })).body.id;
      const d2 = (await call("POST", "/deals", { leadId })).body.id;
      const res = await call("POST", `/deals/${d1}/stage`, { stage: "lost", lossReason: "price_budget", lossNotes: "too pricey", contactAction: "lost" });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await lifecycle(leadId)).toEqual({ lifecycle_state: "lost", loss_reason: "price_budget", loss_notes: "too pricey" });
      expect(await stageOf(d1)).toBe("lost");
      expect(await stageOf(d2)).toBe("lost");
      const other = (await pool.query(`select loss_reason, loss_notes from public.deals where id = $1`, [d2])).rows[0];
      expect(other).toEqual({ loss_reason: "other", loss_notes: "Contact lost" });
      expect((await timelineTitles(leadId)).map((t) => t.title)).toContain("Lost");
    });

    it("invalid combinations are 400; a DNC contact fails the whole move (deal unchanged)", async () => {
      const leadId = await contact("Invalid Co");
      const deal = (await call("POST", "/deals", { leadId })).body.id;
      for (const body of [
        { stage: "negotiation", contactAction: "keep" },
        { stage: "won", contactAction: "lost" },
        { stage: "lost", lossReason: "other", contactAction: "archive" },
        { stage: "lost", contactAction: "lost" },
      ]) {
        expect((await call("POST", `/deals/${deal}/stage`, body)).status, JSON.stringify(body)).toBe(400);
      }
      expect(await stageOf(deal)).toBe("qualified");

      const dnc = await contact("Dnc Co");
      await withTransaction((c) => leads.markDnc(c, rep, ws, dnc, { reason: "asked" }));
      const dncDeal = (await call("POST", "/deals", { leadId: dnc })).body.id;
      const res = await call("POST", `/deals/${dncDeal}/stage`, { stage: "lost", lossReason: "other", contactAction: "lost" });
      expect(res.status).toBe(409);
      expect(await stageOf(dncDeal)).toBe("qualified");
      expect((await lifecycle(dnc)).lifecycle_state).toBe("do_not_contact");
    });
  });
});
