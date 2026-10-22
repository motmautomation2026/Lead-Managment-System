/**
 * Do Not Contact can only be left through reactivateFromDnc (audit B5).
 * Runs against a REAL database with every migration (including 020) applied.
 * Skipped unless TEST_DATABASE_URL is set; commits rows in a fresh workspace
 * per run.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import type { Actor } from "../../src/authMiddleware.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const DNC_REASON = "Asked not to be contacted (integration test)";
const REFUSAL = { status: 409, code: "do_not_contact", message: "This lead is Do Not Contact. Reactivate it with a reason first." };

describeIfDb("Do Not Contact exit guard (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let actor: Actor;
  let authUserId: string | undefined;
  let WORKSPACE_ID: string;

  async function inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async function newLead(firstName: string) {
    const { createLead } = await import("../../src/services/leads.service.js");
    return inTransaction((client) =>
      createLead(client, actor, WORKSPACE_ID, { firstName, company: `${firstName} Pvt Ltd`, source: "referral", email: `${firstName.toLowerCase()}-${randomUUID()}@example.com` }),
    );
  }

  async function markDnc(leadId: string) {
    const { markDnc } = await import("../../src/services/leads.service.js");
    await inTransaction((client) => markDnc(client, actor, WORKSPACE_ID, leadId, { reason: DNC_REASON }));
  }

  async function dncState(leadId: string) {
    const lead = await pool.query(`select lifecycle_state, dnc_reason from public.leads where id = $1`, [leadId]);
    const events = await pool.query(`select action from public.dnc_events where lead_id = $1 order by created_at`, [leadId]);
    return { ...lead.rows[0], events: events.rows.map((row) => row.action as string) };
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    const auth = await pool.query(`insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`, [`dnc-exit-${randomUUID()}@example.com`]);
    authUserId = auth.rows[0].id as string;
    const profile = await pool.query(`select id, full_name, email from public.profiles where id = $1`, [authUserId]);
    actor = { id: profile.rows[0].id, fullName: profile.rows[0].full_name, email: profile.rows[0].email, isActive: true, role: "salesperson" };
    WORKSPACE_ID = randomUUID();
    await pool.query(`insert into public.workspaces (id, name, slug) values ($1, $2, $2)`, [WORKSPACE_ID, `dnc-exit-test-${WORKSPACE_ID}`]);
  });

  afterAll(async () => {
    if (authUserId) {
      await pool.query(`delete from auth.users where id = $1`, [authUserId]).catch((error) => console.warn("[dncExit] test user cleanup failed:", error));
    }
    await pool.end();
  });

  it.each([
    ["won", "markWon"],
    ["lost", "markLost"],
    ["discarded", "markDiscarded"],
    ["long-term nurture", "moveToLongTermNurture"],
    ["merged (as source)", "mergeLead"],
  ] as const)("refuses moving a DNC lead to %s and leaves its suppression intact", async (_label, fn) => {
    const leads = await import("../../src/services/leads.service.js");
    const lead = await newLead("Dina");
    const target = await newLead("Tara");
    await markDnc(lead.id);
    const before = await dncState(lead.id);
    expect(before).toEqual({ lifecycle_state: "do_not_contact", dnc_reason: DNC_REASON, events: ["suppressed"] });

    const attempt = inTransaction((client) => {
      switch (fn) {
        case "markWon":
          return leads.markWon(client, actor, WORKSPACE_ID, lead.id);
        case "markLost":
          return leads.markLost(client, actor, WORKSPACE_ID, lead.id, "price_budget");
        case "markDiscarded":
          return leads.markDiscarded(client, actor, WORKSPACE_ID, lead.id);
        case "moveToLongTermNurture":
          return leads.moveToLongTermNurture(client, actor, WORKSPACE_ID, lead.id);
        case "mergeLead":
          return leads.mergeLead(client, actor, WORKSPACE_ID, lead.id, target.id);
      }
    });
    await expect(attempt).rejects.toMatchObject(REFUSAL);
    expect(await dncState(lead.id)).toEqual(before);
  });

  it("refuses a Won meeting outcome for a DNC lead and leaves the meeting untouched", async () => {
    const { scheduleMeeting, recordMeetingOutcome } = await import("../../src/services/meetings.service.js");
    const lead = await newLead("Mira");
    const meeting = await inTransaction((client) =>
      scheduleMeeting(client, actor, WORKSPACE_ID, { leadId: lead.id, title: "Discovery", at: "2030-03-01T04:30:00.000Z", durationMin: 30 }),
    );
    await markDnc(lead.id);
    const before = await dncState(lead.id);

    await expect(inTransaction((client) => recordMeetingOutcome(client, actor, WORKSPACE_ID, meeting.id, "won", "closing"))).rejects.toMatchObject(REFUSAL);

    const row = await pool.query(`select status, outcome from public.meetings where id = $1`, [meeting.id]);
    expect(row.rows[0].status).not.toBe("completed");
    expect(row.rows[0].outcome).toBeNull();
    expect(await dncState(lead.id)).toEqual(before);
  });

  it("refuses accepting a proposal for a DNC lead and leaves the proposal status unchanged", async () => {
    const { createProposal, updateProposalStatus } = await import("../../src/services/proposals.service.js");
    const lead = await newLead("Pia");
    const proposal = await inTransaction((client) => createProposal(client, actor, WORKSPACE_ID, { leadId: lead.id, title: "Pia proposal", amount: 50000 }));
    await markDnc(lead.id);
    const statusBefore = (await pool.query(`select status from public.proposals where id = $1`, [proposal.id])).rows[0].status;

    await expect(inTransaction((client) => updateProposalStatus(client, actor, WORKSPACE_ID, proposal.id, "accepted"))).rejects.toMatchObject(REFUSAL);

    expect((await pool.query(`select status from public.proposals where id = $1`, [proposal.id])).rows[0].status).toBe(statusBefore);
    expect((await dncState(lead.id)).lifecycle_state).toBe("do_not_contact");
  });

  it("still allows reactivateFromDnc and records a 'reactivated' event", async () => {
    const { reactivateFromDnc } = await import("../../src/services/leads.service.js");
    const lead = await newLead("Rhea");
    await markDnc(lead.id);

    const reactivated = await inTransaction((client) => reactivateFromDnc(client, actor, WORKSPACE_ID, lead.id, "Customer asked to resume contact"));
    expect(reactivated.lifecycle_state).toBe("active");

    const events = await pool.query(`select action, reason from public.dnc_events where lead_id = $1 order by created_at`, [lead.id]);
    expect(events.rows).toEqual([
      { action: "suppressed", reason: DNC_REASON },
      { action: "reactivated", reason: "Customer asked to resume contact" },
    ]);
  });

  it("the database trigger rejects a direct update from DNC to won", async () => {
    const lead = await newLead("Sana");
    await markDnc(lead.id);

    await expect(pool.query(`update public.leads set lifecycle_state = 'won' where id = $1`, [lead.id])).rejects.toMatchObject({ code: "23514" });
    expect((await dncState(lead.id)).lifecycle_state).toBe("do_not_contact");
  });
});
