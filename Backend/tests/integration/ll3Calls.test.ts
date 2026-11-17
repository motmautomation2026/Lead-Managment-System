/**
 * LL-3 calls (rules 1–5, 8): the retry ladder, the "We tried calling" WhatsApp queue and its send-time checks,
 * Not interested → Lost, Interested later (restart date), call-outcome workflows auto-start. Nothing is sent (the
 * WhatsApp send is a fake) and nothing calls OpenAI. Skipped unless TEST_DATABASE_URL is set; [test] workspaces only.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { createTestWorkspace, deleteCreatedTestWorkspaces } from "../helpers/testWorkspaces.js";
import { startTestApi, type TestApi } from "../helpers/testApi.js";
import type { Actor } from "../../src/authMiddleware.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const DAY = 86_400_000;

describeIfDb("LL-3 calls (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let api: TestApi;
  let rep: Actor;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
    api = await startTestApi(pool, "ll3-calls");
    rep = await api.newUser("salesperson", { name: "Ravi Kumar" });
  });

  afterAll(async () => {
    await deleteCreatedTestWorkspaces(pool);
    await api.close();
    await pool.end();
  });

  const randomPhone = () => `+9198${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
  async function lead(ws: string, over: { agentStatus?: string; phone?: string | null } = {}) {
    const phone = over.phone === undefined ? randomPhone() : over.phone;
    return (
      await pool.query<{ id: string }>(
        `insert into public.leads (workspace_id, first_name, last_name, company, source, email, phone, phone_e164, owner_id, agent_status)
         values ($1, 'Asha', 'Rao', 'Acme', 'referral', $2, $3, $3, $4, $5) returning id`,
        [ws, `ll3c-${randomUUID()}@example.com`, phone, rep.id, over.agentStatus ?? "none"],
      )
    ).rows[0]!.id;
  }
  const logCall = (ws: string, leadId: string, body: Record<string, unknown>) => api.call(rep, ws, "POST", `/leads/${leadId}/calls`, body);
  const noAnswer = (ws: string, leadId: string) => logCall(ws, leadId, { connected: false, notConnectedReason: "no_answer" });
  const openTasks = async (leadId: string) =>
    (
      await pool.query<{ title: string; task_type: string; marker: string | null; call_attempt: number | null; owner_id: string | null; due_at: Date }>(
        `select title, task_type, marker, call_attempt, owner_id, due_at from public.tasks where lead_id = $1 and status = 'open' order by created_at`,
        [leadId],
      )
    ).rows;
  const triedRows = async (leadId: string) =>
    (await pool.query<{ id: string; status: string; error: string | null; body: string | null }>(`select id, status, error, body from public.tried_calling_messages where lead_id = $1 order by created_at`, [leadId])).rows;

  it("No answer: attempt counter, 'Call attempt N' ladder tasks, one 'tried calling' WhatsApp per day", async () => {
    const ws = await createTestWorkspace(pool, "ll3-calls");
    const id = await lead(ws);
    const first = await noAnswer(ws, id);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.call.attemptNumber).toBe(1);
    expect(first.body.workflowTrigger).toBeUndefined();
    expect(await openTasks(id)).toMatchObject([{ title: "Call attempt 2", task_type: "call", marker: "call_attempt", call_attempt: 2, owner_id: rep.id }]);

    const second = await logCall(ws, id, { connected: false, notConnectedReason: "busy" });
    expect(second.body.call.attemptNumber).toBe(2);
    expect((await openTasks(id)).map((t) => t.title)).toEqual(["Call attempt 3"]);
    const rows = await triedRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("queued");

    // A connected call closes the ladder; the next unanswered call starts again at 1.
    await logCall(ws, id, { connected: true, connectedOutcome: "information_requested" });
    expect((await openTasks(id)).map((t) => t.title)).not.toContain("Call attempt 3");
    expect((await noAnswer(ws, id)).body.call.attemptNumber).toBe(1);
  });

  it("after 5 unanswered calls: no call task; not covered → long-term nurture + 'Decide the next step'", async () => {
    const ws = await createTestWorkspace(pool, "ll3-calls");
    const id = await lead(ws);
    for (let n = 1; n <= 5; n++) expect((await noAnswer(ws, id)).body.call.attemptNumber).toBe(n);
    const open = await openTasks(id);
    expect(open.filter((t) => t.task_type === "call")).toEqual([]);
    expect(open).toMatchObject([{ title: "Decide the next step", marker: "call_ladder_end" }]);
    const l = (await pool.query(`select lifecycle_state from public.leads where id = $1`, [id])).rows[0];
    expect(l.lifecycle_state).toBe("long_term_nurture");
  });

  it("wrong number stops the ladder: 'Fix the phone number', no tried-calling message", async () => {
    const ws = await createTestWorkspace(pool, "ll3-calls");
    const id = await lead(ws);
    await noAnswer(ws, id);
    const res = await logCall(ws, id, { connected: false, notConnectedReason: "wrong_number" });
    expect(res.body.call.attemptNumber).toBeUndefined();
    expect(await openTasks(id)).toMatchObject([{ title: "Fix the phone number", marker: "fix_phone" }]);
  });

  it("the tried-calling message is not queued for an opted-out WhatsApp, a lead without phone, or with the setting off", async () => {
    const ws = await createTestWorkspace(pool, "ll3-calls");
    const optedOut = await lead(ws);
    await pool.query(`insert into public.lead_contact_channels (lead_id, channel, status, reason, updated_by_name) values ($1, 'whatsapp', 'opted_out', 'test', 'Test')`, [optedOut]);
    await noAnswer(ws, optedOut);
    expect(await triedRows(optedOut)).toEqual([]);
    const noPhone = await lead(ws, { phone: null });
    await noAnswer(ws, noPhone);
    expect(await triedRows(noPhone)).toEqual([]);
    await pool.query(`update public.agent_settings set tried_calling_whatsapp_enabled = false where workspace_id = $1`, [ws]);
    const off = await lead(ws);
    await noAnswer(ws, off);
    expect(await triedRows(off)).toEqual([]);
  });

  it("sending: fixed text through the tried_calling source; dropped when reached meanwhile, over the limits or switched off", async () => {
    const { processTriedCallingSend } = await import("../../src/services/triedCalling.service.js");
    const ws = await createTestWorkspace(pool, "ll3-calls");
    const send = vi.fn().mockResolvedValue({ providerMessageId: "fake" });

    const ok = await lead(ws);
    await noAnswer(ws, ok);
    const [row] = await triedRows(ok);
    expect(await processTriedCallingSend(row!.id, { send })).toBe("sent");
    expect(send).toHaveBeenCalledWith(ws, expect.objectContaining({ source: { type: "tried_calling", id: row!.id } }));
    const body = (send.mock.calls[0]![1] as { body: string }).body;
    expect(body).toMatch(/^Hi Asha, this is Ravi from .+\. I tried calling you just now\. When is a good time to talk\? You can also reply here\.$/);
    expect((await triedRows(ok))[0]).toMatchObject({ status: "sent", body });
    const timeline = await pool.query(`select 1 from public.timeline_events where lead_id = $1 and title = 'WhatsApp sent: we tried calling'`, [ok]);
    expect(timeline.rowCount).toBe(1);

    const reached = await lead(ws);
    await noAnswer(ws, reached);
    await logCall(ws, reached, { connected: true, connectedOutcome: "information_requested" });
    expect(await processTriedCallingSend((await triedRows(reached))[0]!.id, { send })).toBe("cancelled");
    expect((await triedRows(reached))[0]!.error).toMatch(/reached meanwhile/);

    const busy = await lead(ws);
    await pool.query(
      `insert into public.tried_calling_messages (workspace_id, lead_id, ist_day, status, sent_at)
       values ($1, $2, current_date - 1, 'sent', now() - interval '1 day'), ($1, $2, current_date - 2, 'sent', now() - interval '2 days')`,
      [ws, busy],
    );
    await noAnswer(ws, busy);
    const queued = (await triedRows(busy)).find((r) => r.status === "queued")!;
    expect(await processTriedCallingSend(queued.id, { send })).toBe("cancelled");
    expect((await triedRows(busy)).find((r) => r.id === queued.id)!.error).toMatch(/2 messages in 7 days/);

    const switchedOff = await lead(ws);
    await noAnswer(ws, switchedOff);
    await pool.query(`update public.agent_settings set tried_calling_whatsapp_enabled = false where workspace_id = $1`, [ws]);
    expect(await processTriedCallingSend((await triedRows(switchedOff))[0]!.id, { send })).toBe("cancelled");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("Not interested → Lost with the reason (competitor name, recovery date), AI stopped, open tasks closed", async () => {
    const ws = await createTestWorkspace(pool, "ll3-calls");
    const id = await lead(ws, { agentStatus: "active" });
    await noAnswer(ws, id);
    expect((await logCall(ws, id, { connected: true, connectedOutcome: "not_interested" })).status).toBe(400);
    const postponed = await logCall(ws, id, { connected: true, connectedOutcome: "not_interested", notInterested: { lossReason: "project_postponed" } });
    expect(postponed.status).toBe(400);
    const res = await logCall(ws, id, {
      connected: true,
      connectedOutcome: "not_interested",
      notes: "Went with Acme",
      notInterested: { lossReason: "competitor_selected", competitorName: "Acme Calls" },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const l = (
      await pool.query(`select lifecycle_state, loss_reason, loss_competitor_name, recover_at, recovered_at, agent_status from public.leads where id = $1`, [id])
    ).rows[0];
    expect(l).toMatchObject({ lifecycle_state: "lost", loss_reason: "competitor_selected", loss_competitor_name: "Acme Calls", recovered_at: null, agent_status: "stopped" });
    expect(l.recover_at.getTime()).toBeGreaterThan(Date.now() + 118 * DAY);
    expect(await openTasks(id)).toEqual([]);
  });

  it("Interested later: restart date required; call-back task 09:30 IST on it; no AI wake-up before it", async () => {
    const ws = await createTestWorkspace(pool, "ll3-calls");
    await pool.query(`update public.agent_settings set mode = 'shadow' where workspace_id = $1`, [ws]);
    const id = await lead(ws, { agentStatus: "active" });
    expect((await logCall(ws, id, { connected: true, connectedOutcome: "interested_later" })).status).toBe(400);
    const res = await logCall(ws, id, { connected: true, connectedOutcome: "interested_later", interestedLater: { restartAt: "2027-02-10", reason: "Budget in Feb" } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const restart = new Date("2027-02-10T09:30:00+05:30");
    expect(await openTasks(id)).toMatchObject([{ title: "Call back — interested later", task_type: "call", marker: "interested_later_callback", due_at: restart }]);
    const wake = (await pool.query(`select due_at from public.agent_wakeups where lead_id = $1 and status = 'pending'`, [id])).rows[0];
    expect(wake.due_at.getTime()).toBeGreaterThanOrEqual(restart.getTime());
  });

  it("call-outcome workflows start by themselves: a run + its first scheduled step, nothing executed in the request", async () => {
    const { createWorkflow, updateDraftSteps, publishVersion, updateWorkflow } = await import("../../src/services/workflows.service.js");
    const { withTransaction } = await import("../../src/db.js");
    const ws = await createTestWorkspace(pool, "ll3-calls");
    const admin = await api.newUser("admin", { name: "LL3 Admin" });
    await api.call(admin, ws, "GET", "/tasks/count");
    const wf = await withTransaction((c) => createWorkflow(c, admin, ws, { name: "Not connected (LL-3)", trigger: "call_not_connected" }));
    await withTransaction((c) => updateDraftSteps(c, ws, wf.id, 1, [{ order: 0, delayDays: 0, action: "create_call_task", config: "Workflow call", enabled: true }]));
    await withTransaction((c) => publishVersion(c, admin, ws, wf.id, 1, "keep_existing"));
    await withTransaction((c) => updateWorkflow(c, ws, wf.id, { status: "active" }));
    const id = await lead(ws);
    const res = await noAnswer(ws, id);
    expect(res.body.workflowTrigger).toBeUndefined();
    const runs = (await pool.query(`select r.status, (select count(*)::int from public.scheduled_actions a where a.workflow_run_id = r.id and a.status = 'pending') as pending from public.workflow_runs r where r.lead_id = $1`, [id])).rows;
    expect(runs).toEqual([{ status: "running", pending: 1 }]);
    expect((await openTasks(id)).map((t) => t.title)).toEqual(["Call attempt 2"]);
  });
});
