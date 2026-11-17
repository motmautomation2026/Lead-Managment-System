/**
 * LL-3 rule 9: proposal valid-until (+ expiring / expired tasks), deal next decision date (required for negotiation,
 * overdue task), the 10-day manager review, Won → onboarding task. Nothing is sent and nothing calls OpenAI.
 * Skipped unless TEST_DATABASE_URL is set; [test] workspaces only.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createTestWorkspace, deleteCreatedTestWorkspaces } from "../helpers/testWorkspaces.js";
import { startTestApi, type TestApi } from "../helpers/testApi.js";
import type { Actor } from "../../src/authMiddleware.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const istDate = (at: Date) => new Date(at.getTime() + 330 * 60_000).toISOString().slice(0, 10);
const plusDays = (days: number) => istDate(new Date(Date.now() + days * 86_400_000));

describeIfDb("LL-3 proposals, deals, won (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let api: TestApi;
  let rep: Actor;
  let admin: Actor;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
    api = await startTestApi(pool, "ll3-deals");
    rep = await api.newUser("salesperson", { name: "Ravi Kumar" });
    admin = await api.newUser("admin", { name: "LL3 Deals Admin" });
  });

  afterAll(async () => {
    await deleteCreatedTestWorkspaces(pool);
    await api.close();
    await pool.end();
  });

  async function workspace() {
    const ws = await createTestWorkspace(pool, "ll3-deals");
    // Both become members (admin → the admins' bell).
    await api.call(admin, ws, "GET", "/tasks/count");
    await api.call(rep, ws, "GET", "/tasks/count");
    return ws;
  }
  async function lead(ws: string) {
    return (
      await pool.query<{ id: string }>(
        `insert into public.leads (workspace_id, first_name, last_name, company, source, email, owner_id)
         values ($1, 'Asha', 'Rao', 'Acme', 'referral', $2, $3) returning id`,
        [ws, `ll3d-${randomUUID()}@example.com`, rep.id],
      )
    ).rows[0]!.id;
  }
  const openTasks = async (leadId: string) =>
    (await pool.query(`select title, marker, owner_id, due_at from public.tasks where lead_id = $1 and status = 'open' order by created_at`, [leadId])).rows;
  const followUps = async (ws: string) => (await import("../../src/services/dealFollowUps.service.js")).runDealFollowUps({ workspaceIds: [ws] });
  async function sentProposal(ws: string, leadId: string) {
    const { createProposal, updateProposalStatus } = await import("../../src/services/proposals.service.js");
    const { withTransaction } = await import("../../src/db.js");
    const p = await withTransaction((c) => createProposal(c, rep, ws, { leadId, title: "Pilot", emailSendStatus: "skipped", whatsappSendStatus: "skipped" }));
    return withTransaction((c) => updateProposalStatus(c, rep, ws, p.id, "sent"));
  }
  async function deal(ws: string, leadId: string) {
    const res = await api.call(rep, ws, "POST", "/deals", { leadId, name: `Pilot ${randomUUID().slice(0, 6)}` });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; name: string };
  }

  it("LL-3b: valid until after sending — owner or admin only, the change on the timeline", async () => {
    const ws = await workspace();
    const id = await lead(ws);
    const p = await sentProposal(ws, id);
    const other = await api.newUser("salesperson", { name: "Other Rep" });
    await api.call(other, ws, "GET", "/tasks/count");
    const denied = await api.call(other, ws, "PATCH", `/proposals/${p.id}`, { validUntil: plusDays(5) });
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    // A plain field edit by another member still works (only the date is guarded).
    expect((await api.call(other, ws, "PATCH", `/proposals/${p.id}`, { notes: "seen" })).status).toBe(200);
    const byAdmin = await api.call(admin, ws, "PATCH", `/proposals/${p.id}`, { validUntil: plusDays(5) });
    expect(byAdmin.status, JSON.stringify(byAdmin.body)).toBe(200);
    expect(byAdmin.body.validUntil).toBe(plusDays(5));
    const rows = (await pool.query(`select detail, actor_id from public.timeline_events where lead_id = $1 and title = 'Proposal valid until changed'`, [id])).rows;
    expect(rows).toEqual([{ detail: `Pilot: ${plusDays(30)} → ${plusDays(5)}`, actor_id: admin.id }]);
  });

  it("proposal valid until = sent + 30 days (editable); expiring and expired tasks once each", async () => {
    const ws = await workspace();
    const id = await lead(ws);
    const p = await sentProposal(ws, id);
    expect(p.validUntil).toBe(plusDays(30));
    const patched = await api.call(rep, ws, "PATCH", `/proposals/${p.id}`, { validUntil: plusDays(1) });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body.validUntil).toBe(plusDays(1));

    expect(await followUps(ws)).toBe(1);
    expect((await openTasks(id)).filter((t) => t.marker === "proposal_expiring")).toMatchObject([{ title: `Proposal expires ${plusDays(1)} — follow up`, owner_id: rep.id }]);
    expect(await followUps(ws)).toBe(0);

    await pool.query(`update public.proposals set valid_until = $2 where id = $1`, [p.id, plusDays(-1)]);
    expect(await followUps(ws)).toBe(1);
    expect((await openTasks(id)).filter((t) => t.marker === "proposal_expired")).toMatchObject([{ title: "Proposal expired — revise or close" }]);
    expect(await followUps(ws)).toBe(0);
  });

  it("moving a deal into negotiation needs a next decision date; a passed date gives the owner one task", async () => {
    const ws = await workspace();
    const id = await lead(ws);
    const d = await deal(ws, id);
    expect((await api.call(rep, ws, "POST", `/deals/${d.id}/stage`, { stage: "negotiation" })).status).toBe(400);
    const moved = await api.call(rep, ws, "POST", `/deals/${d.id}/stage`, { stage: "negotiation", nextDecisionDate: plusDays(5) });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body.nextDecisionDate).toBe(plusDays(5));
    expect(await followUps(ws)).toBe(0);
    await pool.query(`update public.deals set next_decision_date = $2 where id = $1`, [d.id, plusDays(-1)]);
    expect(await followUps(ws)).toBe(1);
    expect((await openTasks(id)).filter((t) => t.marker === "decision_overdue")).toMatchObject([{ title: `Decision date passed: ${d.name}`, owner_id: rep.id }]);
    expect(await followUps(ws)).toBe(0);
  });

  it("manager review after > 10 idle days: unowned task + admins' bell, once per 10 days", async () => {
    const ws = await workspace();
    const id = await lead(ws);
    const d = await deal(ws, id);
    await pool.query(`update public.deals set stage = 'proposal_sent', stage_changed_at = now() - interval '11 days' where id = $1`, [d.id]);
    expect(await followUps(ws)).toBe(1);
    expect((await openTasks(id)).filter((t) => t.marker === "manager_review")).toMatchObject([{ title: `Manager review: ${d.name}`, owner_id: null }]);
    const bells = (await pool.query(`select recipient_id from public.notifications where lead_id = $1 and title = $2`, [id, `Manager review: ${d.name}`])).rows;
    expect(bells).toEqual([{ recipient_id: admin.id }]);
    // LL-3b rule 6: unowned, on every admin's Home (overdue card) and in Tasks with the "Admins (no owner)" filter.
    const home = async (who: Actor) => (await api.call(who, ws, "GET", "/home/summary")).body as { tasks: { overdueTop: { title: string }[] } };
    expect((await home(admin)).tasks.overdueTop.map((t) => t.title)).toContain(`Manager review: ${d.name}`);
    expect((await home(rep)).tasks.overdueTop.map((t) => t.title)).not.toContain(`Manager review: ${d.name}`);
    const listed = await api.call(admin, ws, "GET", `/tasks/list?ownerId=none&q=${encodeURIComponent("Manager review")}`);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect((listed.body as { data: { title: string }[] }).data.map((t) => t.title)).toContain(`Manager review: ${d.name}`);
    expect(await followUps(ws)).toBe(0);
    // Recent activity (a note) keeps a deal out of review.
    const fresh = await deal(ws, await lead(ws));
    await pool.query(`update public.deals set stage = 'negotiation', stage_changed_at = now() - interval '20 days' where id = $1`, [fresh.id]);
    await pool.query(`insert into public.lead_notes (lead_id, body, author_name) select lead_id, 'Spoke today', 'Test' from public.deals where id = $1`, [fresh.id]);
    expect(await followUps(ws)).toBe(0);
  });

  it("Won → 'Onboarding: <deal>' for the owner, due the next working day; it survives the contact being marked Won", async () => {
    const ws = await workspace();
    const id = await lead(ws);
    const d = await deal(ws, id);
    const won = await api.call(rep, ws, "POST", `/deals/${d.id}/stage`, { stage: "won" });
    expect(won.status, JSON.stringify(won.body)).toBe(200);
    expect((await pool.query(`select lifecycle_state from public.leads where id = $1`, [id])).rows[0].lifecycle_state).toBe("won");
    const tasks = await openTasks(id);
    expect(tasks).toMatchObject([{ title: `Onboarding: ${d.name}`, marker: "onboarding", owner_id: rep.id }]);
    expect(tasks[0].due_at.getTime()).toBeGreaterThan(Date.now());

    // Proposal accepted (deal won through the proposal, then the contact won + all open tasks cancelled).
    const id2 = await lead(ws);
    const p = await sentProposal(ws, id2);
    const { updateProposalStatus } = await import("../../src/services/proposals.service.js");
    const { withTransaction } = await import("../../src/db.js");
    await withTransaction((c) => updateProposalStatus(c, rep, ws, p.id, "accepted"));
    expect((await openTasks(id2)).map((t) => t.marker)).toEqual(["onboarding"]);
  });
});
