/**
 * C6b through the HTTP stack: GET /runs/list|count and /scheduled-actions/list|count (paging,
 * filters, isolation), GET /workflows in a fixed number of queries (same body as the old N+1
 * code, timed), GET /home/summary (IST days, B38 meeting statuses, my pipeline, AI drafts),
 * proposal `lossReasonStatuses` vs POST /proposals/:id/status, and GET /proposals/:id/document.
 * Skipped unless TEST_DATABASE_URL is set; [test] workspaces only.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { createTestWorkspace, deleteCreatedTestWorkspaces } from "../helpers/testWorkspaces.js";
import { expectConsistentPaging, qs, startTestApi, type TestApi } from "../helpers/testApi.js";
import { withNetworkRetry } from "../helpers/networkRetry.js";
import type { Actor } from "../../src/authMiddleware.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const IST_DAY = `(date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata')`;

/** The pre-C6b listWorkflows (1 + N × (3 + versions) queries), kept here as the reference result. */
async function oldListWorkflows(db: Pool, workspaceId: string) {
  const workflows = await db.query(`select * from public.workflows where workspace_id = $1 order by updated_at desc`, [workspaceId]);
  const out = [];
  for (const row of workflows.rows) {
    const versionRows = await db.query(`select * from public.workflow_versions where workflow_id = $1 order by version_number asc`, [row.id]);
    const versions = [];
    for (const v of versionRows.rows) {
      const steps = await db.query(`select * from public.workflow_steps where workflow_version_id = $1 order by step_order asc`, [v.id]);
      versions.push({
        version: v.version_number,
        status: v.status,
        createdBy: v.created_by_name ?? "-",
        createdAt: v.created_at.toISOString(),
        publishedAt: v.published_at?.toISOString(),
        steps: steps.rows.map((s) => ({
          id: s.id,
          order: s.step_order,
          delayDays: s.delay_days,
          action: s.action,
          templateId: s.template_id ?? undefined,
          config: s.config ?? undefined,
          enabled: s.is_enabled,
        })),
      });
    }
    const active = await db.query(`select count(*)::text as count from public.workflow_runs where workflow_id = $1 and status in ('running','waiting','paused')`, [row.id]);
    const failed = await db.query(`select count(*)::text as count from public.workflow_runs where workflow_id = $1 and status = 'failed'`, [row.id]);
    const published = versions.find((v) => v.status === "published");
    out.push({
      id: row.id,
      name: row.name,
      description: row.description ?? "",
      trigger: row.trigger,
      status: row.status,
      currentVersion: published?.version ?? versions.at(-1)?.version ?? 0,
      activeLeads: Number(active.rows[0].count),
      failures: Number(failed.rows[0].count),
      ownerId: row.owner_id ?? undefined,
      updatedAt: row.updated_at.toISOString(),
      versions,
    });
  }
  // JSON round trip, like the HTTP body (drops undefined).
  return JSON.parse(JSON.stringify(out));
}

describeIfDb("automation lists, workflows list, home summary, proposal flags + document (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let api: TestApi;
  let admin: Actor;
  let rep: Actor;
  let ws: string;
  let otherWs: string;
  let contactA: string;
  let contactB: string;
  let otherContact: string;
  const workflows: string[] = [];
  const runs: Record<string, string> = {};
  let otherRun: string;
  let withTransaction: <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;
  let leads: typeof import("../../src/services/leads.service.js");
  let wf: typeof import("../../src/services/workflows.service.js");
  let runsService: typeof import("../../src/services/runs.service.js");

  const call = (method: string, path: string, body?: unknown, as: Actor = rep, workspace = ws) => api.call(as, workspace, method, path, body);
  const ids = async (path: string, params: Parameters<typeof qs>[0], workspace = ws) => {
    const res = await call("GET", `${path}${qs({ ...params, limit: 100 })}`, undefined, rep, workspace);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return (res.body.data as { id: string }[]).map((r) => r.id).sort();
  };
  const count = async (path: string, params: Parameters<typeof qs>[0]) => {
    const res = await call("GET", `${path}${qs(params)}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.count as number;
  };
  const contact = (workspace: string, first: string, company: string, ownerId: string) =>
    withTransaction(async (client) => (await leads.createLead(client, rep, workspace, { firstName: first, lastName: "Auto", company, email: `${first.toLowerCase()}-${randomUUID()}@example.com`, source: "referral", ownerId })).id);

  /** A manual-enrollment workflow with `steps` create-task steps (delay 2 days so nothing is due), published and active. */
  const workflow = async (workspace: string, name: string, steps = 2, draft = false) => {
    const created = await withTransaction((client) => wf.createWorkflow(client, admin, workspace, { name, trigger: "manual_enrollment" }));
    const stepInput = Array.from({ length: steps }, (_, i) => ({ order: i, delayDays: 2 + i, action: "create_follow_up_task" as const, config: `Step ${i}`, enabled: true }));
    await withTransaction((client) => wf.updateDraftSteps(client, workspace, created.id, 1, stepInput));
    await withTransaction((client) => wf.publishVersion(client, admin, workspace, created.id, 1, "keep_existing"));
    await withTransaction((client) => wf.updateWorkflow(client, workspace, created.id, { status: "active" }));
    if (draft) {
      await withTransaction((client) => wf.createDraft(client, admin, workspace, created.id));
      await withTransaction((client) => wf.updateDraftSteps(client, workspace, created.id, 2, [...stepInput, { order: steps, delayDays: 9, action: "stop_workflow" as const, config: "Done", enabled: true }]));
    }
    return created.id;
  };
  const enroll = async (workspace: string, lead: string, workflowId: string) =>
    (await withTransaction((client) => runsService.enrollLeadInWorkflow(client, workspace, lead, workflowId, "C6b test")))!.id;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
    api = await startTestApi(pool, "c6b-lists");
    admin = await api.newUser("admin", { name: "Admin Auto" });
    rep = await api.newUser("salesperson", { name: "Rep Auto" });
    ({ withTransaction } = await import("../../src/db.js"));
    leads = await import("../../src/services/leads.service.js");
    wf = await import("../../src/services/workflows.service.js");
    runsService = await import("../../src/services/runs.service.js");
    ws = await createTestWorkspace(pool, "c6b-lists");
    otherWs = await createTestWorkspace(pool, "c6b-lists-other");
    contactA = await contact(ws, "Anika", "Anika Works", rep.id);
    contactB = await contact(ws, "Bilal", "Bilal Works", admin.id);
    otherContact = await contact(otherWs, "Omar", "Omar Works", rep.id);

    workflows.push(await workflow(ws, "Nurture C6b", 2, true), await workflow(ws, "Follow-up C6b", 3));
    runs.a1 = await enroll(ws, contactA, workflows[0]!);
    runs.b1 = await enroll(ws, contactB, workflows[0]!);
    runs.a2 = await enroll(ws, contactA, workflows[1]!);
    runs.b2 = await enroll(ws, contactB, workflows[1]!);
    await call("POST", `/runs/${runs.b2}/pause`, {});
    await pool.query(`update public.workflow_runs set status = 'failed', last_error = 'Boom' where id = $1`, [runs.a2]);
    // Distinct start times so the default sort is deterministic.
    for (const [i, id] of [runs.a1, runs.b1, runs.a2, runs.b2].entries()) {
      await pool.query(`update public.workflow_runs set started_at = now() - make_interval(hours => $2) where id = $1`, [id, 10 - i]);
    }
    otherRun = await enroll(otherWs, otherContact, await workflow(otherWs, "Other C6b", 1));
  });

  afterAll(async () => {
    await deleteCreatedTestWorkspaces(pool);
    await api?.close();
    await pool?.end();
  });

  describe("runs list", () => {
    it("pages with limit 3 without gaps or duplicates (newest start first by default)", async () => {
      const seen = await expectConsistentPaging((q) => call("GET", `/runs/list${q}`), {}, 3);
      expect(seen).toEqual([runs.b2, runs.a2, runs.b1, runs.a1]);
      await expectConsistentPaging((q) => call("GET", `/runs/list${q}`), { sort: "startedAt:asc" }, 3);
    });

    it("rows carry contact, workflow, version and the current step's action", async () => {
      const res = await call("GET", `/runs/list?contactId=${contactA}&workflowId=${workflows[0]}`);
      const [row] = res.body.data;
      expect(row.id).toBe(runs.a1);
      expect(row.contact).toEqual({ id: contactA, name: "Anika Auto" });
      expect(row.workflow).toEqual({ id: workflows[0], name: "Nurture C6b" });
      expect(row.version).toBe(1);
      expect(row.currentStepAction).toBe("create_follow_up_task");
    });

    it("filters by workflow, status, contact, start range and q; counts match; isolated per workspace", async () => {
      expect(await ids("/runs/list", { workflowId: workflows[1] })).toEqual([runs.a2, runs.b2].sort());
      expect(await ids("/runs/list", { status: ["failed", "paused"] })).toEqual([runs.a2, runs.b2].sort());
      expect(await ids("/runs/list", { contactId: contactB })).toEqual([runs.b1, runs.b2].sort());
      expect(await ids("/runs/list", { q: "bilal" })).toEqual([runs.b1, runs.b2].sort());
      expect(await ids("/runs/list", { q: "bilal auto" })).toEqual([runs.b1, runs.b2].sort());
      const from = new Date(Date.now() - 8.5 * 3_600_000).toISOString();
      expect(await ids("/runs/list", { startedFrom: from })).toEqual([runs.a2, runs.b2].sort());
      expect(await count("/runs/count", { status: "failed" })).toBe(1);
      expect(await count("/runs/count", {})).toBe(4);
      expect(await ids("/runs/list", {})).not.toContain(otherRun);
      expect(await ids("/runs/list", { contactId: otherContact })).toEqual([]);
    });

    it("rejects unknown params, bad sorts, bad cursors and sort on /count; keeps the old GET /runs shape", async () => {
      for (const query of ["?foo=1", "?sort=status:asc", "?cursor=nope", "?status=nope"]) expect((await call("GET", `/runs/list${query}`)).status).toBe(400);
      expect((await call("GET", "/runs/count?sort=startedAt:asc")).status).toBe(400);
      const old = await call("GET", `/runs?leadId=${contactA}`);
      expect(old.status).toBe(200);
      expect(old.body.nextCursor).toBeUndefined();
      expect(old.body.data).toHaveLength(2);
    });
  });

  describe("scheduled actions list", () => {
    it("pages with limit 3, filters by status / run / workflow / contact / due range / q, isolated", async () => {
      // One pending first step per run; add a cancelled second step per run (unique per run + step) to page through.
      await pool.query(
        `insert into public.scheduled_actions (workspace_id, lead_id, workflow_run_id, workflow_step_id, action_type, scheduled_for, status, cancelled_at)
         select a.workspace_id, a.lead_id, a.workflow_run_id, s.id, s.action, a.scheduled_for + interval '1 day', 'cancelled', now()
           from public.scheduled_actions a
           join public.workflow_runs r on r.id = a.workflow_run_id
           join public.workflow_steps s on s.workflow_version_id = r.workflow_version_id and s.step_order = 1
          where a.workspace_id = $1`,
        [ws],
      );
      const seen = await expectConsistentPaging((q) => call("GET", `/scheduled-actions/list${q}`), {}, 3);
      expect(seen).toHaveLength(8);
      await expectConsistentPaging((q) => call("GET", `/scheduled-actions/list${q}`), { sort: "scheduledFor:desc" }, 3);

      const runA1 = await call("GET", `/scheduled-actions/list?runId=${runs.a1}`);
      expect(runA1.body.data).toHaveLength(2);
      expect(runA1.body.data[0]).toMatchObject({ workflowRunId: runs.a1, contact: { id: contactA, name: "Anika Auto" }, workflow: { id: workflows[0], name: "Nurture C6b" }, stepOrder: 0 });
      expect(await count("/scheduled-actions/count", { status: "cancelled" })).toBe(4);
      expect(await count("/scheduled-actions/count", { workflowId: workflows[1], status: ["pending", "paused"] })).toBe(2);
      expect(await count("/scheduled-actions/count", { contactId: contactB })).toBe(4);
      expect(await count("/scheduled-actions/count", { q: "anika" })).toBe(4);
      const soon = new Date(Date.now() + 2.5 * 86_400_000).toISOString();
      expect(await count("/scheduled-actions/count", { dueTo: soon })).toBe(4);
      expect(await count("/scheduled-actions/count", { dueFrom: soon })).toBe(4);
      expect(await ids("/scheduled-actions/list", { contactId: otherContact })).toEqual([]);
      expect((await call("GET", "/scheduled-actions/list", undefined, rep, otherWs)).body.data).toHaveLength(1);
      for (const query of ["?foo=1", "?sort=status:asc", "?cursor=nope"]) expect((await call("GET", `/scheduled-actions/list${query}`)).status).toBe(400);
      const old = await call("GET", `/scheduled-actions?leadId=${contactA}`);
      expect(old.status).toBe(200);
      expect(old.body.data).toHaveLength(4);
    });
  });

  describe("workflows list", () => {
    it("returns exactly the old N+1 result, in far fewer queries (timed)", async () => {
      for (let i = 0; i < 18; i++) workflows.push(await workflow(ws, `Bulk C6b ${i}`, 4, i % 2 === 0));
      const res = await call("GET", "/workflows");
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual(await oldListWorkflows(pool, ws));
      expect(res.body.data).toHaveLength(20);

      const { listWorkflows } = await import("../../src/services/workflows.service.js");
      const time = async (fn: () => Promise<unknown>) => {
        await fn();
        const started = performance.now();
        for (let i = 0; i < 3; i++) await fn();
        return Math.round((performance.now() - started) / 3);
      };
      const before = await time(() => oldListWorkflows(pool, ws));
      const after = await time(() => listWorkflows(pool, ws));
      process.stderr.write(`[C6b] listWorkflows, 20 workflows / 29 versions: old N+1 ${before} ms → batched ${after} ms
`);
      expect(after).toBeLessThan(before);
    }, 120_000); // seeds 18 workflows and times both versions: slow on the staging pooler
  });

  describe("home summary", () => {
    it("counts my day, pipeline, proposals and AI drafts (IST days, B38 meeting statuses)", async () => {
      const home = await createTestWorkspace(pool, "c6b-home");
      const mine = await contact(home, "Hema", "Hema Works", rep.id);
      const theirs = await contact(home, "Ivan", "Ivan Works", admin.id);
      const lostOne = await contact(home, "Jaya", "Jaya Works", rep.id);
      await pool.query(`delete from public.tasks where workspace_id = $1`, [home]);
      const task = (lead: string, owner: string, dueSql: string, status = "open") =>
        pool.query(
          `insert into public.tasks (workspace_id, lead_id, owner_id, task_type, title, due_at, status, completed_at)
           select workspace_id, id, $2, 'follow_up', 'Home task', ${dueSql}, $3::public.task_status, case when $3::text = 'completed' then now() end
             from public.leads where id = $1`,
          [lead, owner, status],
        );
      await task(mine, rep.id, `now() - interval '2 days'`);
      await task(mine, rep.id, `${IST_DAY} + interval '23 hours 59 minutes'`);
      await task(mine, rep.id, `${IST_DAY} + interval '1 day 1 minute'`);
      await task(mine, rep.id, `now() - interval '1 day'`, "completed");
      await task(theirs, admin.id, `now() - interval '1 day'`);
      const meeting = (lead: string, owner: string, atSql: string, status: string, outcome: string | null = null) =>
        pool.query(
          `insert into public.meetings (workspace_id, lead_id, owner_id, title, scheduled_at, status, outcome)
           select workspace_id, id, $2, 'Home meeting', ${atSql}, $3, $4 from public.leads where id = $1`,
          [lead, owner, status, outcome],
        );
      const lateToday = `${IST_DAY} + interval '23 hours 58 minutes'`;
      for (const status of ["scheduled", "confirmed", "rescheduled", "cancelled", "no_show", "failed"]) await meeting(mine, rep.id, lateToday, status);
      await meeting(mine, rep.id, lateToday, "completed", "proposal_required");
      await meeting(mine, rep.id, `${IST_DAY} + interval '1 day 1 minute'`, "scheduled");
      await meeting(theirs, admin.id, lateToday, "scheduled");
      await meeting(mine, rep.id, `now() - interval '2 days'`, "confirmed");
      await meeting(mine, rep.id, `now() - interval '2 days'`, "no_show");

      const deal = async (lead: string, stage: string, amount: number) => (await call("POST", "/deals", { leadId: lead, stage, amount }, rep, home)).body.id as string;
      await deal(mine, "qualified", 1000);
      await deal(mine, "proposal_sent", 2500);
      await deal(theirs, "qualified", 7000);
      const lost = await deal(lostOne, "negotiation", 9000);
      expect((await call("POST", `/deals/${lost}/stage`, { stage: "lost", lossReason: "price_budget" }, rep, home)).status).toBe(200);

      const proposal = (lead: string, owner: string, status: string) =>
        pool.query(
          `insert into public.proposals (workspace_id, lead_id, owner_id, title, status, sent_at)
           select workspace_id, id, $2, 'Home proposal', $3, case when $4 then now() end from public.leads where id = $1`,
          [lead, owner, status, status === "sent"],
        );
      await proposal(mine, rep.id, "sent");
      await proposal(mine, rep.id, "draft");
      await proposal(theirs, admin.id, "sent");

      const res = await call("GET", "/home/summary", undefined, rep, home);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const body = res.body;
      expect(body.tasks.overdue).toBe(1);
      expect(body.tasks.dueToday).toBe(1);
      expect(body.tasks.next).toHaveLength(3);
      expect(body.tasks.next[0].contact).toEqual({ id: mine, name: "Hema Auto" });
      expect(body.meetings.todayCount).toBe(3);
      expect(body.meetings.today.map((m: { status: string }) => m.status).sort()).toEqual(["confirmed", "rescheduled", "scheduled"]);
      expect(body.meetings.needsOutcome).toBe(1);
      expect(body.deals.openCount).toBe(2);
      expect(body.deals.openAmount).toBe(3500);
      expect(body.deals.stages.map((s: { stage: string }) => s.stage)).not.toContain("won");
      expect(body.deals.stages.find((s: { stage: string }) => s.stage === "proposal_sent")).toEqual({ stage: "proposal_sent", count: 1, amountTotal: 2500 });
      expect(body.proposals.awaitingDecision).toBe(1);
      expect(body.ai).toBeNull();

      // The counts are the lists the Home links open.
      expect(body.tasks.overdue).toBe((await call("GET", `/tasks/count${qs({ ownerId: "me", due: "overdue" })}`, undefined, rep, home)).body.count);

      await pool.query(`update public.agent_settings set mode = 'shadow' where workspace_id = $1`, [home]);
      await pool.query(
        `insert into public.agent_decisions (workspace_id, lead_id, mode, action, reasoning, outcome, rating)
         values ($1, $2, 'shadow', 'wait', 'Because.', 'draft', null), ($1, $2, 'shadow', 'wait', 'Because.', 'draft', 'good'),
                ($1, $2, 'shadow', 'wait', 'Because.', 'failed', null)`,
        [home, mine],
      );
      const shadow = await call("GET", "/home/summary", undefined, rep, home);
      expect(shadow.body.ai).toEqual({ mode: "shadow", draftsToReview: 1 });
    });

    it("B38: the old dashboard no longer counts meetings that did not happen", async () => {
      const dash = await createTestWorkspace(pool, "c6b-dash");
      const lead = await contact(dash, "Kiran", "Kiran Works", rep.id);
      for (const status of ["scheduled", "cancelled", "no_show", "failed"]) {
        await pool.query(
          `insert into public.meetings (workspace_id, lead_id, owner_id, title, scheduled_at, status)
           select workspace_id, id, $2, 'Dash', ${IST_DAY} + interval '23 hours 58 minutes', $3 from public.leads where id = $1`,
          [lead, rep.id, status],
        );
      }
      const res = await call("GET", "/dashboard/summary", undefined, rep, dash);
      expect(res.body.meetingsToday).toBe(1);
      expect(res.body.pipelineFunnel.find((s: { label: string }) => s.label === "Meetings").value).toBe(1);
      await pool.query(`update public.meetings set status = 'cancelled' where workspace_id = $1`, [dash]);
      const after = await call("GET", "/dashboard/summary", undefined, rep, dash);
      expect(after.body.meetingsToday).toBe(0);
      expect(after.body.pipelineFunnel.find((s: { label: string }) => s.label === "Meetings").value).toBe(0);
    });
  });

  describe("proposals", () => {
    const proposal = async (lead: string, status: string, path: string | null = null) =>
      (
        await pool.query(
          `insert into public.proposals (workspace_id, lead_id, owner_id, title, status, sent_at, document_storage_path, document_file_name)
           select workspace_id, id, $2, 'C6b proposal', $3, now(), $4, $5 from public.leads where id = $1 returning id`,
          [lead, rep.id, status, path, path ? "quote.pdf" : null],
        )
      ).rows[0].id as string;

    it("lossReasonStatuses on list rows match what POST /proposals/:id/status enforces", async () => {
      const sent = await proposal(contactA, "sent");
      const accepted = await proposal(contactA, "accepted");
      const res = await call("GET", `/proposals/list?contactId=${contactA}`);
      const rows = res.body.data as { id: string; allowedNextStatuses: string[]; lossReasonStatuses: string[] }[];
      const row = rows.find((r) => r.id === sent)!;
      expect(row.lossReasonStatuses).toEqual(["rejected", "expired"]);
      expect(rows.find((r) => r.id === accepted)!.lossReasonStatuses).toEqual([]);
      for (const status of row.lossReasonStatuses) {
        expect((await call("POST", `/proposals/${sent}/status`, { status })).status).toBe(400);
      }
      // A status without the flag goes through without a reason.
      expect(row.allowedNextStatuses).toContain("revision_requested");
      expect((await call("POST", `/proposals/${sent}/status`, { status: "revision_requested" })).status).toBe(200);
    });

    it("GET /proposals/:id/document: a 5-minute signed URL for its own workspace; 404 elsewhere or without a file", async () => {
      const { supabaseAdmin } = await import("../../src/supabaseAdmin.js");
      const path = `${contactA}/${randomUUID()}-quote.pdf`;
      await withNetworkRetry(async () => {
        const { error } = await supabaseAdmin.storage.from("proposal-documents").upload(path, Buffer.from("%PDF-1.4 test"), { contentType: "application/pdf", upsert: true });
        if (error) throw new Error(`upload failed: ${error.message}`);
      });
      const withFile = await proposal(contactA, "sent", path);
      const noFile = await proposal(contactA, "sent");

      const res = await call("GET", `/proposals/${withFile}/document`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.fileName).toBe("quote.pdf");
      expect(res.body.url).toContain("token=");
      expect(new Date(res.body.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(300_000);
      const download = await fetch(res.body.url);
      expect(download.status).toBe(200);
      expect(await download.text()).toBe("%PDF-1.4 test");

      expect((await call("GET", `/proposals/${withFile}/document`, undefined, rep, otherWs)).status).toBe(404);
      expect((await call("GET", `/proposals/${noFile}/document`)).status).toBe(404);
      expect((await call("GET", `/proposals/${randomUUID()}/document`)).status).toBe(404);
      expect((await call("GET", `/proposals/not-a-uuid/document`)).status).toBe(400);
    });
  });
});
