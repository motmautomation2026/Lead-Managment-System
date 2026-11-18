import { describe, expect, it } from "vitest";
import { aiStopTask } from "../../src/domain/nextAction.js";
import { executeHandoff, executeStop } from "../../src/services/agentSends.service.js";
import { followUpAiStop, rescheduleAfterMeeting } from "../../src/services/nextAction.service.js";
import { ensureReplyTask } from "../../src/services/whatsapp-inbound.service.js";
import { fakeNextActionDb } from "../helpers/fakeNextActionDb.js";

const liveLead = (lifecycle = "active") => ({ match: "select lifecycle_state, first_name", rows: [{ lifecycle_state: lifecycle, first_name: "Ravi", last_name: "Iyer" }] });
const notLive = { match: "select lifecycle_state, first_name", rows: [] };
// moveToLongTermNurture re-reads the lead (getLeadRowOr404).
const leadRow = { match: "where l.id = $1 and l.workspace_id = $2", rows: [{ id: "lead-1", lifecycle_state: "active" }] };

describe("LL-1 rule 5: AI stop task per reason", () => {
  it("titles", () => {
    expect(aiStopTask("no_response")).toEqual({ title: "AI journey ended without a reply — decide next step", moveToLongTermNurture: true });
    expect(aiStopTask("not_interested").title).toBe("Lead not interested — close or nurture");
    expect(aiStopTask("annoyed").title).toBe("Lead not interested — close or nurture");
    expect(aiStopTask("asked_to_stop", "whatsapp").title).toBe("Lead opted out on WhatsApp — review");
    expect(aiStopTask("asked_to_stop", "email").title).toBe("Lead opted out on email — review");
    expect(aiStopTask("asked_to_stop").title).toBe("Lead opted out — review");
    expect(aiStopTask("not_a_fit")).toEqual({ title: "AI stopped (not a fit) — decide next step", moveToLongTermNurture: false });
  });
});

describe("LL-1 executeStop", () => {
  it("no_response: AI stopped, moved to long-term nurture, owner task + bell", async () => {
    const f = fakeNextActionDb({ ownerId: "owner-1", extra: [liveLead(), leadRow] });
    await executeStop(f.db, "ws-1", "lead-1", "dec-1", "no_response");
    expect(f.updates.some((u) => u.includes("set agent_status"))).toBe(true);
    expect(f.updates.some((u) => u.includes("lifecycle_state = 'long_term_nurture'"))).toBe(true);
    expect(f.tasks).toMatchObject([{ owner_id: "owner-1", title: "AI journey ended without a reply — decide next step", origin: "agent", task_type: "follow_up" }]);
    expect(f.bells).toMatchObject([{ recipients: ["owner-1"], title: "Ravi Iyer: AI journey ended without a reply — decide next step", leadId: "lead-1" }]);
    expect(f.timeline.map((t) => t.title)).toEqual(["AI stopped", "Moved to Long-Term Nurture", "Task Created"]);
  });

  it("already in long-term nurture: no second move, still a task", async () => {
    const f = fakeNextActionDb({ ownerId: "owner-1", extra: [liveLead("long_term_nurture")] });
    await executeStop(f.db, "ws-1", "lead-1", "dec-1", "no_response");
    expect(f.updates.some((u) => u.includes("long_term_nurture"))).toBe(false);
    expect(f.tasks).toHaveLength(1);
  });

  it("DNC / terminal / merged lead: no task, no bell", async () => {
    const f = fakeNextActionDb({ ownerId: "owner-1", extra: [notLive] });
    await executeStop(f.db, "ws-1", "lead-1", "dec-1", "not_a_fit");
    expect(f.tasks).toEqual([]);
    expect(f.bells).toEqual([]);
  });

  it("inactive owner: unowned task, admins' bell", async () => {
    const f = fakeNextActionDb({ ownerId: "owner-1", ownerActive: false, adminIds: ["a1"], extra: [liveLead()] });
    await executeStop(f.db, "ws-1", "lead-1", "dec-1", "not_a_fit");
    expect(f.tasks).toMatchObject([{ owner_id: null, title: "AI stopped (not a fit) — decide next step" }]);
    expect(f.bells).toMatchObject([{ recipients: ["a1"] }]);
  });
});

describe("LL-1 followUpAiStop from a reply label", () => {
  it("open reply task → nothing (it already is the next action)", async () => {
    const f = fakeNextActionDb({ ownerId: "owner-1", extra: [liveLead(), { match: "select 1 from public.tasks where lead_id = $1 and status = 'open' and (title", rows: [{ "?column?": 1 }] }] });
    expect(await followUpAiStop(f.db, "ws-1", "lead-1", "not_interested", { skipIfReplyTask: true })).toBeNull();
    expect(f.queries.find((q) => q.sql.includes("and (title = $2"))!.params[2]).toBe(true);
  });

  it("no reply task (e.g. email unsubscribe) → task; no second bell after the opt-out bell", async () => {
    const f = fakeNextActionDb({ ownerId: "owner-1", extra: [liveLead()] });
    await followUpAiStop(f.db, "ws-1", "lead-1", "asked_to_stop", { channel: "email", skipIfReplyTask: true, bell: false });
    expect(f.tasks).toMatchObject([{ title: "Lead opted out on email — review" }]);
    expect(f.bells).toEqual([]);
  });
});

describe("LL-1 executeHandoff", () => {
  const name = { match: "as name from public.leads", rows: [{ name: "Asha Rao" }] };

  it("unassigned lead: unowned handoff task + admins' bell (LL-2: also emailed)", async () => {
    const f = fakeNextActionDb({ ownerId: null, adminIds: ["a1", "a2"], extra: [name] });
    await executeHandoff(f.db, "ws-1", "lead-1", "dec-1", "Wants a price");
    expect(f.tasks).toMatchObject([{ owner_id: null, title: "AI handed off — please follow up", origin: "agent" }]);
    expect(f.bells).toMatchObject([{ recipients: ["a1", "a2"], title: "Asha Rao: AI handed off — please follow up" }]);
    expect(f.queries.find((q) => q.sql.includes("insert into public.notifications"))!.params[7]).toBe("pending");
  });

  it("owned lead: owner task + the owner's bell (LL-2 rule 3: AI handed off is an urgent alert)", async () => {
    const f = fakeNextActionDb({ ownerId: "owner-1", extra: [name] });
    await executeHandoff(f.db, "ws-1", "lead-1", "dec-1", "Wants a price");
    expect(f.tasks).toMatchObject([{ owner_id: "owner-1" }]);
    expect(f.bells).toMatchObject([{ recipients: ["owner-1"], title: "Asha Rao: AI handed off — please follow up" }]);
  });
});

describe("LL-1 ensureReplyTask (any lead)", () => {
  it("unassigned lead: unowned reply task with origin agent (the 2-hour escalation covers it), no extra bell", async () => {
    const f = fakeNextActionDb({ ownerId: null });
    await ensureReplyTask(f.db, "ws-1", "lead-1", "Lead replied on WhatsApp — respond today");
    expect(f.tasks).toMatchObject([{ owner_id: null, origin: "agent", title: "Lead replied on WhatsApp — respond today" }]);
    expect(f.bells).toEqual([]);
  });

  it("an open reply task already → nothing", async () => {
    const f = fakeNextActionDb({ ownerId: "owner-1", extra: [{ match: "origin = 'agent' and status = 'open' and title = any", rows: [{ "?column?": 1 }] }] });
    await ensureReplyTask(f.db, "ws-1", "lead-1", "Lead replied by email — respond today");
    expect(f.tasks).toEqual([]);
  });
});

describe("LL-1 rescheduleAfterMeeting", () => {
  const now = new Date("2026-11-16T06:00:00Z");
  it("no-show: 'Reschedule the meeting' schedule_meeting +1 d for the meeting's owner", async () => {
    const f = fakeNextActionDb({ ownerId: "rep-2", extra: [liveLead()] });
    await rescheduleAfterMeeting(f.db, "ws-1", "lead-1", { id: "m-1", ownerId: "rep-2" }, now);
    expect(f.tasks).toMatchObject([{ owner_id: "rep-2", task_type: "schedule_meeting", title: "Reschedule the meeting", due_at: "2026-11-17T06:00:00.000Z" }]);
    expect(f.queries.find((q) => q.sql.includes("as admin_ids"))!.params).toEqual(["ws-1", "lead-1", "rep-2"]);
  });

  it("another future meeting (or the task already open) → nothing; DNC / terminal lead → nothing", async () => {
    const blocked = fakeNextActionDb({ ownerId: "rep-2", extra: [liveLead(), { match: "union all", rows: [{ "?column?": 1 }] }] });
    expect(await rescheduleAfterMeeting(blocked.db, "ws-1", "lead-1", { id: "m-1", ownerId: null }, now)).toBeNull();
    const dnc = fakeNextActionDb({ ownerId: "rep-2", extra: [notLive] });
    expect(await rescheduleAfterMeeting(dnc.db, "ws-1", "lead-1", { id: "m-1", ownerId: null }, now)).toBeNull();
    expect([...blocked.tasks, ...dnc.tasks]).toEqual([]);
  });
});
