/**
 * E3b-2b rules 15–18: the hot-score sweeper, its marks, the list sorts and the target-industry
 * setting. The sweeper runs scoped to the [test] workspace. Skipped unless TEST_DATABASE_URL is set.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createTestWorkspace, deleteCreatedTestWorkspaces } from "../helpers/testWorkspaces.js";
import { startTestApi, type TestApi } from "../helpers/testApi.js";
import type { Actor } from "../../src/authMiddleware.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const ENQUIRY = "We are a steel trader in Pune and want to reach new buyers in Gujarat and Maharashtra for our products this year";

describeIfDb("E3b-2b hot-lead score (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let api: TestApi;
  let admin: Actor;
  let ws: string;

  async function lead(first: string, extra: { email?: string; industry?: string; revenue?: string } = {}) {
    return (
      await pool.query(
        `insert into public.leads (workspace_id, first_name, company, source, email, industry, revenue_range, owner_id)
         values ($1, $2, 'Acme Steel', 'website', $3, $4, $5, $6) returning id`,
        [ws, first, extra.email ?? `${first.toLowerCase()}-${randomUUID().slice(0, 8)}@acmesteel.in`, extra.industry ?? null, extra.revenue ?? null, admin.id],
      )
    ).rows[0].id as string;
  }
  const sweep = async () => {
    const { runLeadScoreSweep } = await import("../../src/services/leadScore.service.js");
    return runLeadScoreSweep({ workspaceId: ws });
  };
  const scoreOf = async (id: string) =>
    (await pool.query(`select hot_score, hot_band, hot_reasons, hot_score_dirty, updated_at from public.leads where id = $1`, [id])).rows[0];

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
    api = await startTestApi(pool, "lead-score");
    admin = await api.newUser("admin", { name: "Score Admin" });
    ws = await createTestWorkspace(pool, "lead-score");
  });

  afterAll(async () => {
    await deleteCreatedTestWorkspaces(pool);
    await api.close();
    await pool.end();
  });

  it("target industries: an admin saves them (lower case, de-duplicated); other workspaces start empty", async () => {
    expect((await api.call(admin, ws, "GET", "/agent/settings")).body.targetIndustryKeywords).toEqual([]);
    const saved = await api.call(admin, ws, "PUT", "/agent/settings", { targetIndustryKeywords: ["Steel", " steel ", "EPC", ""] });
    expect(saved.status).toBe(200);
    expect(saved.body.targetIndustryKeywords).toEqual(["steel", "epc"]);
  });

  it("a positive reply makes the lead Hot after the sweeper's next tick; a score-only update keeps updated_at", async () => {
    const asha = await lead("Asha", { industry: "Steel trading", revenue: "50-100 Cr" });
    await pool.query(
      `insert into public.timeline_events (lead_id, event_kind, title, actor_name, actor_source, metadata) values ($1, 'system', 'Website form submission', 'Website', 'system', $2)`,
      [asha, { rawMessage: ENQUIRY }],
    );
    const before = await scoreOf(asha);
    expect(before).toMatchObject({ hot_score: null, hot_score_dirty: true });
    expect(await sweep()).toBeGreaterThanOrEqual(1);
    // enquiry 15 + fit 25 = 40.
    const warm = await scoreOf(asha);
    expect(warm).toMatchObject({ hot_score: 40, hot_band: "warm", hot_score_dirty: false });
    expect(warm.hot_reasons).toEqual(["enquiry", "enquiry_detailed", "enquiry_need", "corporate_email", "company", "target_industry", "revenue"]);
    expect(warm.updated_at).toEqual(before.updated_at);

    // The positive reply marks the lead (no recompute in the request path) …
    const messageId = `score-${randomUUID()}`;
    await pool.query(
      `insert into public.whatsapp_inbound_events (message_id, workspace_id, sender_jid, sender_phone_e164, message_type, received_at, disposition, match_count, lead_id)
       values ($1, $2, '919000000002@s.whatsapp.net', '+919000000002', 'conversation', now(), 'matched', 1, $3)`,
      [messageId, ws, asha],
    );
    const { applyReplyLabel } = await import("../../src/services/replyLabels.service.js");
    await applyReplyLabel(pool, { workspaceId: ws, leadId: asha, messageId, label: "positive", source: "ai", status: "done" });
    expect(await scoreOf(asha)).toMatchObject({ hot_score: 40, hot_score_dirty: true });
    // … and the next sweep makes it Hot.
    await sweep();
    expect(await scoreOf(asha)).toMatchObject({ hot_score: 65, hot_band: "hot", hot_score_dirty: false });
    expect((await scoreOf(asha)).hot_reasons).toContain("replied_positive");
    // Nothing marked, nothing older than 24 h: the next tick does nothing.
    expect(await sweep()).toBe(0);
  });

  it("Contacts sort by score (NULLs last) with the band and reasons; Tasks 'Hottest first'; the contact record shows them", async () => {
    const cold = await lead("Ravi", { email: "ravi@gmail.com" });
    await sweep();
    const unscored = await lead("Meera");
    const list = await api.call(admin, ws, "GET", "/contacts?sort=hotScore:desc&limit=10");
    expect(list.status).toBe(200);
    const rows = list.body.data as { id: string; hotScore: number | null; hotBand: string | null; hotReasons: string[] | null }[];
    expect(rows.map((r) => r.hotScore)).toEqual([65, 5, null]);
    expect(rows[1]).toMatchObject({ id: cold, hotBand: "cold", hotReasons: ["company"] });
    expect(rows[2]!.id).toBe(unscored);
    // Keyset paging keeps the order across pages.
    const page1 = await api.call(admin, ws, "GET", "/contacts?sort=hotScore:desc&limit=2");
    const page2 = await api.call(admin, ws, "GET", `/contacts?sort=hotScore:desc&limit=2&cursor=${page1.body.nextCursor}`);
    expect([...page1.body.data, ...page2.body.data].map((r: { id: string }) => r.id)).toEqual(rows.map((r) => r.id));

    const record = await api.call(admin, ws, "GET", `/contacts/${rows[0]!.id}`);
    expect(record.body).toMatchObject({ hotScore: 65, hotBand: "hot", hotReasons: expect.arrayContaining(["replied_positive"]) });

    for (const [leadId, title] of [[cold, "Cold task"], [rows[0]!.id, "Hot task"], [unscored, "New task"]] as const) {
      await pool.query(`insert into public.tasks (workspace_id, lead_id, owner_id, task_type, title, due_at) values ($1, $2, $3, 'follow_up', $4, now())`, [ws, leadId, admin.id, title]);
    }
    const tasks = await api.call(admin, ws, "GET", "/tasks/list?sort=hotScore:desc");
    expect(tasks.status).toBe(200);
    expect(tasks.body.data.map((t: { title: string }) => t.title)).toEqual(["Hot task", "Cold task", "New task"]);
  });
});
