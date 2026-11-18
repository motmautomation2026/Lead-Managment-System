import { describe, expect, it } from "vitest";
import {
  createResponsibleTask,
  LEAD_FACTS_SQL,
  sendSweepBells,
  SWEEP_CANDIDATES_SQL,
  SWEEP_COUNTS_SQL,
  sweepLead,
} from "../../src/services/nextAction.service.js";
import { llSweepDatabaseProblem, parseLlSweepArgs } from "../../scripts/ll-sweep.js";
import { fakeNextActionDb } from "../helpers/fakeNextActionDb.js";

const now = new Date("2026-11-16T06:00:00Z");
const facts = (over: Record<string, unknown> = {}) => ({
  match: "for update of l",
  rows: [
    {
      id: "lead-1",
      workspace_id: "ws-1",
      lifecycle_state: "active",
      automation_mode: "manual",
      agent_status: "none",
      agent_touch_count: 0,
      max_touches_total: 8,
      ai_live: false,
      open_tasks: 0,
      future_meeting: false,
      workflow_step_pending: false,
      ...over,
    },
  ],
});

describe("LL-1 sweepLead (per-lead re-check + task)", () => {
  it("active lead with nothing → 'Decide the next step' due now for the owner, timeline row, no bell yet (batched)", async () => {
    const f = fakeNextActionDb({ ownerId: "owner-1", extra: [facts()] });
    const done = await sweepLead(f.db, "lead-1", now);
    expect(done).toEqual({ workspaceId: "ws-1", taskId: "task-1", notify: ["owner-1"], title: "Decide the next step" });
    expect(f.tasks).toMatchObject([{ owner_id: "owner-1", title: "Decide the next step", task_type: "follow_up", due_at: now.toISOString() }]);
    expect(f.timeline.map((t) => t.title)).toEqual(["Task Created", "No next action — task created"]);
    expect(f.bells).toEqual([]);
  });

  it("long-term nurture → 'Plan re-engagement' re_engage +45 d", async () => {
    const f = fakeNextActionDb({ ownerId: "owner-1", extra: [facts({ lifecycle_state: "long_term_nurture" })] });
    await sweepLead(f.db, "lead-1", now);
    expect(f.tasks).toMatchObject([{ task_type: "re_engage", title: "Plan re-engagement", due_at: "2026-12-31T06:00:00.000Z" }]);
  });

  it("unowned or inactive owner → unowned task, admins to notify", async () => {
    for (const state of [{ ownerId: null }, { ownerId: "owner-1", ownerActive: false }]) {
      const f = fakeNextActionDb({ ...state, adminIds: ["a1", "a2"], extra: [facts()] });
      const done = await sweepLead(f.db, "lead-1", now);
      expect(done?.notify).toEqual(["a1", "a2"]);
      expect(f.tasks[0]!.owner_id).toBeNull();
    }
  });

  it("re-check wins: an open task, a future meeting, a pending workflow step, a live AI with touches, DNC / lost, merged → nothing", async () => {
    for (const over of [
      { open_tasks: 1 },
      { future_meeting: true },
      { automation_mode: "active", workflow_step_pending: true },
      { agent_status: "active", ai_live: true, agent_touch_count: 3 },
      { lifecycle_state: "do_not_contact" },
      { lifecycle_state: "lost" },
    ]) {
      const f = fakeNextActionDb({ ownerId: "owner-1", extra: [facts(over)] });
      expect(await sweepLead(f.db, "lead-1", now)).toBeNull();
      expect(f.tasks).toEqual([]);
    }
    const gone = fakeNextActionDb({ ownerId: "owner-1", extra: [{ match: "for update of l", rows: [] }] });
    expect(await sweepLead(gone.db, "lead-1", now)).toBeNull();
  });

  it("AI stopped / out of touches / workflow on a manual lead → task", async () => {
    for (const over of [{ agent_status: "stopped", ai_live: true }, { agent_status: "active", ai_live: true, agent_touch_count: 8 }, { workflow_step_pending: true }]) {
      const f = fakeNextActionDb({ ownerId: "owner-1", extra: [facts(over)] });
      expect(await sweepLead(f.db, "lead-1", now)).not.toBeNull();
    }
  });
});

describe("LL-1 batched sweep bells", () => {
  it("one bell per person per workspace: '3 leads need a next step', linking to the filtered task list", async () => {
    const f = fakeNextActionDb({ ownerId: null });
    const n = await sendSweepBells(f.db, [
      { workspaceId: "ws-1", notify: ["o1"], title: "Decide the next step" },
      { workspaceId: "ws-1", notify: ["o1"], title: "Decide the next step" },
      { workspaceId: "ws-1", notify: ["o1"], title: "Decide the next step" },
      { workspaceId: "ws-1", notify: ["a1"], title: "Decide the next step" },
      { workspaceId: "ws-1", notify: ["a1"], title: "Plan re-engagement" },
    ]);
    expect(n).toBe(2);
    expect(f.bells).toEqual([
      { workspaceId: "ws-1", recipients: ["o1"], title: "3 leads need a next step", leadId: null, href: "/tasks?status=open&q=Decide%20the%20next%20step" },
      { workspaceId: "ws-1", recipients: ["a1"], title: "2 leads need a next step", leadId: null, href: "/tasks?status=open" },
    ]);
  });

  it("nothing created → no bell", async () => {
    const f = fakeNextActionDb({ ownerId: null });
    expect(await sendSweepBells(f.db, [])).toBe(0);
    expect(f.bells).toEqual([]);
  });
});

describe("LL-1 createResponsibleTask (rule 1)", () => {
  it("owner responsible → owned task, bell to the owner", async () => {
    const f = fakeNextActionDb({ ownerId: "owner-1" });
    await createResponsibleTask(f.db, "ws-1", "lead-1", { type: "follow_up", title: "X", dueAt: now }, { title: "Bell" });
    expect(f.tasks[0]!.owner_id).toBe("owner-1");
    expect(f.bells).toMatchObject([{ recipients: ["owner-1"], title: "Bell", leadId: "lead-1", href: "/contacts/lead-1" }]);
  });

  it("owner not a member → unowned task, admins' bell even without one given", async () => {
    const f = fakeNextActionDb({ ownerId: "owner-1", ownerMember: false, adminIds: ["a1"] });
    await createResponsibleTask(f.db, "ws-1", "lead-1", { type: "follow_up", title: "X", dueAt: now });
    expect(f.tasks[0]!.owner_id).toBeNull();
    expect(f.bells).toMatchObject([{ recipients: ["a1"], title: "Unassigned contact needs: X" }]);
  });

  it("owner responsible and no bell given → no bell", async () => {
    const f = fakeNextActionDb({ ownerId: "owner-1" });
    await createResponsibleTask(f.db, "ws-1", "lead-1", { type: "follow_up", title: "X", dueAt: now });
    expect(f.bells).toEqual([]);
  });
});

describe("LL-1 sweep SQL (shape only; INT-1 runs it)", () => {
  it("candidates are fair per workspace and mirror rule 2 + the rollout guard", () => {
    expect(SWEEP_CANDIDATES_SQL).toContain("row_number() over (partition by l.workspace_id");
    expect(SWEEP_CANDIDATES_SQL).toContain("c.rn <= $4");
    expect(SWEEP_CANDIDATES_SQL).toContain("limit $5");
    for (const sql of [SWEEP_CANDIDATES_SQL, SWEEP_COUNTS_SQL]) {
      expect(sql).toContain("l.lifecycle_state in ('active', 'long_term_nurture') and l.merged_into_lead_id is null");
      expect(sql).toContain("coalesce($3::timestamptz, s.next_action_sweep_since)");
    }
    expect(LEAD_FACTS_SQL).toContain("for update of l");
  });
});

describe("LL-1 ll:sweep CLI", () => {
  it("parses --dry-run, --workspace (repeatable) and --since", () => {
    expect(parseLlSweepArgs(["--dry-run"])).toEqual({ dryRun: true });
    const ws = "6f1c2c1e-0000-4000-8000-000000000001";
    expect(parseLlSweepArgs(["--dry-run", "--workspace", ws, "--since", "2026-11-01"])).toEqual({ dryRun: true, workspaceIds: [ws], since: new Date("2026-11-01") });
    expect(parseLlSweepArgs([])).toEqual({ dryRun: false });
  });

  it("refuses bad input", () => {
    expect(parseLlSweepArgs(["--workspace", "nope"])).toMatch(/uuid/);
    expect(parseLlSweepArgs(["--since", "soon"])).toMatch(/date/);
    expect(parseLlSweepArgs(["--since"])).toMatch(/Usage/);
    expect(parseLlSweepArgs(["--confirm"])).toMatch(/Unknown option/);
  });

  it("dry run is read-only (allowed anywhere); a real sweep is staging only, never production", () => {
    const prod = "postgres://x@db.jorxltfwboabyjiydyhu.supabase.co/postgres";
    const staging = "postgres://x@db.arejsxqjhzotmngrobhm.supabase.co/postgres";
    expect(llSweepDatabaseProblem(prod, { dryRun: true })).toBeNull();
    expect(llSweepDatabaseProblem(prod, { dryRun: false })).toMatch(/never runs against production/);
    expect(llSweepDatabaseProblem("postgres://other", { dryRun: false })).toMatch(/not the staging project/);
    expect(llSweepDatabaseProblem(staging, { dryRun: false })).toBeNull();
    expect(llSweepDatabaseProblem(undefined, { dryRun: true })).toMatch(/not set/);
  });
});
