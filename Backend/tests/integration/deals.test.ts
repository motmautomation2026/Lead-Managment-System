/**
 * CRM v2 deals (B3b): automatic creation/attachment on meetings and proposals,
 * event-driven stage moves, contact ↔ deal sync, manual moves and the backfill sweeper.
 * Skipped unless TEST_DATABASE_URL is set; commits rows in fresh [test] workspaces only.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createTestWorkspace, deleteCreatedTestWorkspaces } from "../helpers/testWorkspaces.js";
import type { Actor } from "../../src/authMiddleware.js";
import type { DealStage, MeetingOutcome, ProposalStatus } from "../../src/domain/enums.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb("deals (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let actor: Actor;
  let authUserId: string;
  let ws: string;
  let leads: typeof import("../../src/services/leads.service.js");
  let meetings: typeof import("../../src/services/meetings.service.js");
  let proposals: typeof import("../../src/services/proposals.service.js");
  let deals: typeof import("../../src/services/deals.service.js");
  let calls: typeof import("../../src/services/calls.service.js");
  let withTransaction: typeof import("../../src/db.js").withTransaction;

  const tx = <T>(fn: (client: import("pg").PoolClient) => Promise<T>) => withTransaction(fn);

  async function contact(extra: Record<string, unknown> = {}, workspaceId = ws) {
    return tx((c) =>
      leads.createLead(c, actor, workspaceId, {
        firstName: "Deal",
        lastName: "Tester",
        company: "Orbit Labs",
        email: `deal-${randomUUID()}@example.com`,
        source: "referral",
        serviceInterest: "SEO",
        ownerId: actor.id,
        ...extra,
      }),
    );
  }

  const book = (leadId: string, dealId?: string, workspaceId = ws) =>
    tx((c) => meetings.scheduleMeeting(c, actor, workspaceId, { leadId, title: "Intro", at: new Date(Date.now() + 86_400_000).toISOString(), dealId }));
  const propose = (leadId: string, amount?: number, workspaceId = ws) =>
    tx((c) => proposals.createProposal(c, actor, workspaceId, { leadId, title: "Proposal", amount }));
  const outcome = (meetingId: string, value: MeetingOutcome) => tx((c) => meetings.recordMeetingOutcome(c, actor, ws, meetingId, value));
  const proposalStatus = (id: string, status: ProposalStatus, lossReason?: "price_budget" | "no_response") =>
    tx((c) => proposals.updateProposalStatus(c, actor, ws, id, status, { lossReason }));

  async function dealsOf(leadId: string) {
    return (
      await pool.query<{ id: string; name: string; stage: DealStage; amount: string | null; currency: string; company_id: string | null; owner_id: string | null; source: string; loss_reason: string | null; loss_notes: string | null; closed_at: Date | null; service_interest: string | null }>(
        `select * from public.deals where lead_id = $1 order by created_at, id`,
        [leadId],
      )
    ).rows;
  }
  const dealIdOf = async (table: "meetings" | "proposals", id: string) =>
    (await pool.query<{ deal_id: string | null }>(`select deal_id from public.${table} where id = $1`, [id])).rows[0]!.deal_id;
  const leadRow = async (id: string) =>
    (await pool.query<{ lifecycle_state: string; pipeline_stage: string; agent_status: string; company_id: string | null; updated_at: Date }>(`select * from public.leads where id = $1`, [id])).rows[0]!;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
    const auth = await pool.query(`insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`, [`deals-${randomUUID()}@example.com`]);
    authUserId = auth.rows[0].id;
    const profile = await pool.query(`update public.profiles set full_name = 'Deals Rep' where id = $1 returning id, full_name, email`, [authUserId]);
    actor = { id: profile.rows[0].id, fullName: profile.rows[0].full_name, email: profile.rows[0].email, isActive: true, role: "salesperson" };
    leads = await import("../../src/services/leads.service.js");
    meetings = await import("../../src/services/meetings.service.js");
    proposals = await import("../../src/services/proposals.service.js");
    deals = await import("../../src/services/deals.service.js");
    calls = await import("../../src/services/calls.service.js");
    ({ withTransaction } = await import("../../src/db.js"));
    ws = await createTestWorkspace(pool, "deals");
  });

  afterAll(async () => {
    await deleteCreatedTestWorkspaces(pool);
    await pool.query(`delete from auth.users where id = $1`, [authUserId]).catch((error: Error) => console.warn(`[deals] test user not deleted: ${error.message}`));
    await pool.end();
  });

  it("booking a meeting creates a deal at meeting_scheduled; a second meeting attaches to it", async () => {
    const lead = await contact();
    const first = await book(lead.id);
    const [deal, ...rest] = await dealsOf(lead.id);
    expect(rest).toHaveLength(0);
    expect(deal).toMatchObject({ name: "Orbit Labs – SEO", stage: "meeting_scheduled", source: "meeting", owner_id: actor.id, currency: "INR", service_interest: "SEO", closed_at: null });
    expect(deal!.company_id).toBe((await leadRow(lead.id)).company_id);
    expect(deal!.company_id).not.toBeNull();
    expect(await dealIdOf("meetings", first.id)).toBe(deal!.id);
    const timeline = await pool.query(`select title from public.timeline_events where related_deal_id = $1`, [deal!.id]);
    expect(timeline.rows.map((r) => r.title)).toContain("Deal created");

    const second = await book(lead.id);
    expect(await dealsOf(lead.id)).toHaveLength(1);
    expect(await dealIdOf("meetings", second.id)).toBe(deal!.id);
  });

  it("a meeting with another contact's dealId is rejected (4xx) and nothing is saved", async () => {
    const owner = await contact();
    await book(owner.id);
    const [otherDeal] = await dealsOf(owner.id);
    const lead = await contact();
    await expect(book(lead.id, otherDeal!.id)).rejects.toMatchObject({ status: 400 });
    expect((await pool.query(`select count(*)::int as n from public.meetings where lead_id = $1`, [lead.id])).rows[0].n).toBe(0);

    const explicit = await book(owner.id, otherDeal!.id);
    expect(await dealIdOf("meetings", explicit.id)).toBe(otherDeal!.id);
  });

  it("a placeholder company names the deal after the contact", async () => {
    const lead = await contact({ company: "Not provided", serviceInterest: undefined });
    await book(lead.id);
    expect((await dealsOf(lead.id))[0]!.name).toBe("Deal Tester – New opportunity");
  });

  it("a proposal attaches to the open deal (amount copied when empty, moved forward); with none it creates one", async () => {
    const lead = await contact();
    await book(lead.id);
    const proposal = await propose(lead.id, 250000);
    const [deal, ...rest] = await dealsOf(lead.id);
    expect(rest).toHaveLength(0);
    expect(deal).toMatchObject({ stage: "proposal_preparation", amount: "250000.00" });
    expect(await dealIdOf("proposals", proposal.id)).toBe(deal!.id);

    await propose(lead.id, 999);
    expect((await dealsOf(lead.id))[0]!.amount).toBe("250000.00");

    const fresh = await contact();
    const own = await propose(fresh.id, 1200);
    const [created] = await dealsOf(fresh.id);
    expect(created).toMatchObject({ stage: "proposal_preparation", source: "proposal", amount: "1200.00" });
    expect(await dealIdOf("proposals", own.id)).toBe(created!.id);
  });

  it("meeting outcomes move the linked deal per the mapping", async () => {
    const table: [MeetingOutcome, DealStage][] = [
      ["highly_interested", "proposal_preparation"],
      ["proposal_required", "proposal_preparation"],
      ["needs_more_information", "meeting_follow_up"],
      ["follow_up_required", "meeting_follow_up"],
      ["needs_internal_discussion", "meeting_follow_up"],
      ["second_meeting", "meeting_scheduled"],
      ["no_proposal_required", "meeting_scheduled"],
      ["won", "won"],
      ["not_interested", "lost"],
    ];
    for (const [value, expected] of table) {
      const lead = await contact();
      const meeting = await book(lead.id);
      await outcome(meeting.id, value);
      const [deal] = await dealsOf(lead.id);
      expect([value, deal!.stage]).toEqual([value, expected]);
      if (expected === "lost") expect(deal).toMatchObject({ loss_reason: "other", loss_notes: "Meeting outcome: not interested" });
    }
  });

  it("second_meeting and revision_requested may move back; other events never do", async () => {
    const lead = await contact();
    const meeting = await book(lead.id);
    const proposal = await propose(lead.id, 100);
    await proposalStatus(proposal.id, "sent");
    expect((await dealsOf(lead.id))[0]!.stage).toBe("proposal_sent");
    await outcome(meeting.id, "proposal_required");
    expect((await dealsOf(lead.id))[0]!.stage).toBe("proposal_sent");
    await outcome(meeting.id, "second_meeting");
    expect((await dealsOf(lead.id))[0]!.stage).toBe("meeting_scheduled");

    const other = await contact();
    const p = await propose(other.id, 100);
    await proposalStatus(p.id, "sent");
    await proposalStatus(p.id, "revision_requested");
    expect((await dealsOf(other.id))[0]!.stage).toBe("proposal_preparation");
  });

  it("proposal statuses with no deal mapping leave the deal unchanged", async () => {
    for (const status of ["uploaded", "ready_to_send", "revised", "withdrawn"] as const) {
      const lead = await contact();
      const p = await propose(lead.id, 100);
      await proposalStatus(p.id, status);
      expect([status, (await dealsOf(lead.id))[0]!.stage]).toEqual([status, "proposal_preparation"]);
    }
  });

  it("accepted → deal won with the proposal amount; the contact is won exactly as before", async () => {
    const lead = await contact();
    await book(lead.id);
    const p = await propose(lead.id, 50000);
    await proposalStatus(p.id, "sent");
    await pool.query(`update public.deals set amount = 1 where lead_id = $1`, [lead.id]);
    await proposalStatus(p.id, "accepted");
    const [deal] = await dealsOf(lead.id);
    expect(deal).toMatchObject({ stage: "won", amount: "50000.00" });
    expect(deal!.closed_at).not.toBeNull();
    expect((await leadRow(lead.id)).lifecycle_state).toBe("won");
    const openTasks = await pool.query(`select count(*)::int as n from public.tasks where lead_id = $1 and status = 'open'`, [lead.id]);
    expect(openTasks.rows[0].n).toBe(0);
  });

  it("rejected / expired → deal lost with the proposal's reason; the contact goes to long-term nurture as today", async () => {
    for (const [status, reason] of [["rejected", "price_budget"], ["expired", "no_response"]] as const) {
      const lead = await contact();
      const p = await propose(lead.id, 100);
      await proposalStatus(p.id, "sent");
      await proposalStatus(p.id, status, reason);
      const [deal] = await dealsOf(lead.id);
      expect(deal).toMatchObject({ stage: "lost", loss_reason: reason });
      expect(deal!.closed_at).not.toBeNull();
      expect(await leadRow(lead.id)).toMatchObject({ lifecycle_state: "long_term_nurture", pipeline_stage: "proposal_decision_pending" });
    }
  });

  /** One won deal (created directly) + one open deal from a meeting. */
  async function contactWithWonAndOpenDeal() {
    const lead = await contact();
    const won = await tx((c) => deals.createDeal(c, actor, ws, { leadId: lead.id, source: "manual", stage: "won" }));
    await book(lead.id);
    const open = (await dealsOf(lead.id)).find((d) => d.id !== won.id)!;
    return { lead, wonId: won.id, openId: open.id };
  }

  it("contact lost / discarded / DNC (button and call) / merged → open deals lost, won deals untouched", async () => {
    const target = await contact();
    const closers: [string, (leadId: string) => Promise<unknown>][] = [
      ["lost", (id) => tx((c) => leads.markLost(c, actor, ws, id, "no_urgency"))],
      ["discarded", (id) => tx((c) => leads.markDiscarded(c, actor, ws, id, "test"))],
      ["do not contact", (id) => tx((c) => leads.markDnc(c, actor, ws, id, { reason: "asked" }))],
      ["do not contact", (id) => tx((c) => calls.logCall(c, actor, ws, id, { connected: true, connectedOutcome: "do_not_contact" }))],
      ["merged", (id) => tx((c) => leads.mergeLead(c, actor, ws, id, target.id))],
    ];
    for (const [state, close] of closers) {
      const { lead, wonId, openId } = await contactWithWonAndOpenDeal();
      await close(lead.id);
      const rows = await dealsOf(lead.id);
      expect(rows.find((d) => d.id === openId)).toMatchObject({ stage: "lost", loss_reason: "other", loss_notes: `Contact ${state}` });
      expect(rows.find((d) => d.id === wonId)).toMatchObject({ stage: "won", loss_reason: null });
    }
  });

  it("the old Won button wins the deal only when there is exactly one open deal", async () => {
    const one = await contact();
    await book(one.id);
    await tx((c) => leads.markWon(c, actor, ws, one.id, undefined, true));
    expect((await dealsOf(one.id)).map((d) => d.stage)).toEqual(["won"]);

    const two = await contact();
    await book(two.id);
    await tx((c) => deals.createDeal(c, actor, ws, { leadId: two.id, source: "manual" }));
    await tx((c) => leads.markWon(c, actor, ws, two.id, undefined, true));
    expect((await leadRow(two.id)).lifecycle_state).toBe("won");
    expect((await dealsOf(two.id)).map((d) => d.stage).sort()).toEqual(["meeting_scheduled", "qualified"]);
  });

  it("manual move to won with no other open deal wins the contact (triggers fire); manual lost leaves it; reopen clears closed_at", async () => {
    const { createWorkflow, updateDraftSteps, publishVersion, updateWorkflow } = await import("../../src/services/workflows.service.js");
    const { enrollLeadInWorkflow } = await import("../../src/services/runs.service.js");
    const lead = await contact();
    await book(lead.id);
    const workflow = await tx((c) => createWorkflow(c, actor, ws, { name: `B3b ${randomUUID()}`, trigger: "manual_enrollment" }));
    await tx((c) => updateDraftSteps(c, ws, workflow.id, 1, [{ order: 0, delayDays: 1, action: "create_call_task", config: "Call back", enabled: true }]));
    await tx((c) => publishVersion(c, actor, ws, workflow.id, 1, "keep_existing"));
    await tx((c) => updateWorkflow(c, ws, workflow.id, { status: "active" }));
    const run = await tx((c) => enrollLeadInWorkflow(c, ws, lead.id, workflow.id, "B3b test"));
    await pool.query(`update public.leads set agent_status = 'active', agent_status_reason = 'admin_enroll' where id = $1`, [lead.id]);

    const [deal] = await dealsOf(lead.id);
    await tx((c) => deals.moveDealStage(c, actor, ws, deal!.id, "won", { manual: true }));
    const after = await leadRow(lead.id);
    expect(after).toMatchObject({ lifecycle_state: "won", agent_status: "stopped" });
    expect((await pool.query(`select status from public.workflow_runs where id = $1`, [run!.id])).rows[0].status).toBe("cancelled");

    const keep = await contact();
    await book(keep.id);
    const [lostDeal] = await dealsOf(keep.id);
    await expect(tx((c) => deals.moveDealStage(c, actor, ws, lostDeal!.id, "lost", { manual: true }))).rejects.toMatchObject({ status: 400 });
    await tx((c) => deals.moveDealStage(c, actor, ws, lostDeal!.id, "lost", { manual: true, lossReason: "competitor_selected", lossNotes: "Went elsewhere" }));
    expect((await dealsOf(keep.id))[0]).toMatchObject({ stage: "lost", loss_reason: "competitor_selected", loss_notes: "Went elsewhere" });
    expect((await leadRow(keep.id)).lifecycle_state).toBe("active");

    await tx((c) => deals.moveDealStage(c, actor, ws, lostDeal!.id, "negotiation", { manual: true }));
    expect((await dealsOf(keep.id))[0]).toMatchObject({ stage: "negotiation", closed_at: null, loss_reason: null, loss_notes: null });
  });

  it("a deal error in scheduleMeeting never blocks the meeting; the sweeper attaches it later", async () => {
    const sweepWs = await createTestWorkspace(pool, "deals-sweep");
    const lead = await contact({}, sweepWs);
    // Forces every deal insert to fail inside this one transaction only (the constraint never commits).
    const meeting = await tx(async (c) => {
      await c.query(`alter table public.deals add constraint deals_b3b_test_fail check (false) not valid`);
      const created = await meetings.scheduleMeeting(c, actor, sweepWs, { leadId: lead.id, title: "Intro", at: new Date(Date.now() + 86_400_000).toISOString() });
      await c.query(`alter table public.deals drop constraint deals_b3b_test_fail`);
      return created;
    });
    expect(await dealIdOf("meetings", meeting.id)).toBeNull();
    expect(await dealsOf(lead.id)).toHaveLength(0);

    const counts = await deals.runDealSweep({ workspaceId: sweepWs });
    expect(counts).toMatchObject({ processed: 1, created: 1, attachedMeetings: 1, failed: 0 });
    const [deal] = await dealsOf(lead.id);
    expect(deal).toMatchObject({ stage: "meeting_scheduled", source: "backfill" });
    expect(await dealIdOf("meetings", meeting.id)).toBe(deal!.id);
  });

  it("backfill: one deal per contact with the right stage and amount; a second run does nothing", async () => {
    const bw = await createTestWorkspace(pool, "deals-backfill");
    const sent = await contact({}, bw);
    const m1 = await book(sent.id, undefined, bw);
    await tx((c) => meetings.recordMeetingOutcome(c, actor, bw, m1.id, "proposal_required"));
    const p1 = await propose(sent.id, 75000, bw);
    await tx((c) => proposals.updateProposalStatus(c, actor, bw, p1.id, "sent"));

    const rejected = await contact({}, bw);
    const p2 = await propose(rejected.id, 300, bw);
    await tx((c) => proposals.updateProposalStatus(c, actor, bw, p2.id, "rejected", { lossReason: "price_budget" }));

    const won = await contact({}, bw);
    await book(won.id, undefined, bw);
    await tx((c) => leads.markWon(c, actor, bw, won.id));

    const untouched = await contact({}, bw);

    // Make it look like pre-B3b data.
    await pool.query(`update public.meetings set deal_id = null where workspace_id = $1`, [bw]);
    await pool.query(`update public.proposals set deal_id = null where workspace_id = $1`, [bw]);
    await pool.query(`delete from public.deals where workspace_id = $1`, [bw]);
    await pool.query(`update public.workspaces set crm_deals_backfilled_at = null where id = $1`, [bw]);

    const counts = await deals.runDealSweep({ workspaceId: bw });
    expect(counts).toMatchObject({ processed: 3, created: 3, attachedMeetings: 2, attachedProposals: 2, failed: 0, workspacesCompleted: 1 });

    expect(await dealsOf(sent.id)).toMatchObject([{ stage: "proposal_sent", amount: "75000.00", source: "backfill" }]);
    expect(await dealsOf(rejected.id)).toMatchObject([{ stage: "lost", loss_reason: "price_budget", amount: "300.00" }]);
    const [wonDeal] = await dealsOf(won.id);
    expect(wonDeal).toMatchObject({ stage: "won" });
    expect(wonDeal!.closed_at!.getTime()).toBe((await leadRow(won.id)).updated_at.getTime());
    expect(await dealsOf(untouched.id)).toHaveLength(0);
    for (const table of ["meetings", "proposals"]) {
      const left = await pool.query(`select count(*)::int as n from public.${table} where workspace_id = $1 and deal_id is null`, [bw]);
      expect(left.rows[0].n).toBe(0);
    }
    const flag = await pool.query(`select crm_deals_backfilled_at from public.workspaces where id = $1`, [bw]);
    expect(flag.rows[0].crm_deals_backfilled_at).not.toBeNull();

    expect(await deals.runDealSweep({ workspaceId: bw })).toMatchObject({ processed: 0, created: 0, failed: 0, workspacesCompleted: 0 });

    // The worker switch is on unless exactly "false".
    const { loadWorkerEnv } = await import("../../src/workerEnv.js");
    expect(loadWorkerEnv({}).CRM_DEAL_SWEEP_ENABLED).toBe(true);
    expect(loadWorkerEnv({ CRM_DEAL_SWEEP_ENABLED: "FALSE" }).CRM_DEAL_SWEEP_ENABLED).toBe(true);
    expect(loadWorkerEnv({ CRM_DEAL_SWEEP_ENABLED: "false" }).CRM_DEAL_SWEEP_ENABLED).toBe(false);
  });
});
