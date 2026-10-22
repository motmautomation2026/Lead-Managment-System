/**
 * Proposal and meeting WhatsApp queues: stuck 'sending' rows are reclaimed
 * (audit B19) without double-sending.
 * Skipped unless TEST_DATABASE_URL is set; commits rows in a fresh workspace
 * per run. The claim queries are global, so each claim runs in a transaction
 * that is rolled back and never touches other workspaces' rows.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool, type PoolClient } from "pg";
import type { Actor } from "../../src/authMiddleware.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const sendWhatsApp = vi.hoisted(() => vi.fn());
vi.mock("../../src/providers/whatsapp.provider.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/providers/whatsapp.provider.js")>()),
  sendWhatsApp,
}));

describeIfDb("proposal and meeting WhatsApp queues (requires TEST_DATABASE_URL)", () => {
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

  /** Runs a claim and returns what it would claim for our rows, then rolls it back. */
  async function claimRolledBack<T extends { id: string }>(claim: (client: PoolClient, limit: number) => Promise<T[]>, ids: string[]) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const claimed = await claim(client, 1000);
      return claimed.filter((row) => ids.includes(row.id));
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  }

  async function newLead() {
    const { createLead } = await import("../../src/services/leads.service.js");
    return inTransaction((client) =>
      createLead(client, actor, WORKSPACE_ID, {
        firstName: "Wes",
        company: "Wes Pvt Ltd",
        source: "referral",
        email: `wes-${randomUUID()}@example.com`,
        phone: `+9198${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`,
      }),
    );
  }

  async function newProposal(status: "sending", nextAttemptAt: string | null) {
    const { createProposal } = await import("../../src/services/proposals.service.js");
    const lead = await newLead();
    const proposal = await inTransaction((client) =>
      // Never 'queued' here: a live staging worker would claim it first.
      createProposal(client, actor, WORKSPACE_ID, { leadId: lead.id, title: "Queue proposal", whatsappSendStatus: "skipped" }),
    );
    await pool.query(`update public.proposals set whatsapp_send_status = $2, whatsapp_next_attempt_at = $3 where id = $1`, [proposal.id, status, nextAttemptAt]);
    return proposal.id;
  }

  async function newMeeting(status: "sending", nextAttemptAt: string | null) {
    const { scheduleMeeting } = await import("../../src/services/meetings.service.js");
    const lead = await newLead();
    const meeting = await inTransaction((client) =>
      scheduleMeeting(client, actor, WORKSPACE_ID, { leadId: lead.id, title: "Queue meeting", at: new Date(Date.now() + 86_400_000).toISOString(), durationMin: 30 }),
    );
    await pool.query(`update public.meetings set notify_whatsapp_status = $2, notify_whatsapp_next_attempt_at = $3 where id = $1`, [meeting.id, status, nextAttemptAt]);
    return meeting.id;
  }

  async function markOutboundSent(column: "proposal_id" | "meeting_id", id: string) {
    await pool.query(
      `insert into public.whatsapp_outbound_messages (workspace_id, ${column}, message_id, remote_jid, status, sent_at)
       values ($1, $2, $3, '919800000000@s.whatsapp.net', 'sent', now())`,
      [WORKSPACE_ID, id, `TEST-${randomUUID()}`],
    );
  }

  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    const auth = await pool.query(`insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`, [`wa-queue-${randomUUID()}@example.com`]);
    authUserId = auth.rows[0].id as string;
    const profile = await pool.query(`select id, full_name, email from public.profiles where id = $1`, [authUserId]);
    actor = { id: profile.rows[0].id, fullName: profile.rows[0].full_name, email: profile.rows[0].email, isActive: true, role: "salesperson" };
    WORKSPACE_ID = randomUUID();
    await pool.query(`insert into public.workspaces (id, name, slug) values ($1, $2, $2)`, [WORKSPACE_ID, `wa-queue-test-${WORKSPACE_ID}`]);
  });

  beforeEach(() => {
    sendWhatsApp.mockReset();
    sendWhatsApp.mockRejectedValue(new Error("sendWhatsApp must not be called in this test"));
  });

  afterAll(async () => {
    if (authUserId) {
      await pool.query(`delete from auth.users where id = $1`, [authUserId]).catch((error) => console.warn("[whatsappQueue] test user cleanup failed:", error));
    }
    await pool.end();
  });

  describe("reclaim of stuck 'sending' rows (B19)", () => {
    it("reclaims a proposal stuck in 'sending' past its lease, but not one still within it", async () => {
      const { claimQueuedProposalWhatsappSends } = await import("../../src/services/proposalSending.service.js");
      const stuck = await newProposal("sending", ago(1));
      const legacyStuck = await newProposal("sending", null);
      const inFlight = await newProposal("sending", ago(-10));

      const claimed = await claimRolledBack(claimQueuedProposalWhatsappSends, [stuck, legacyStuck, inFlight]);
      expect(claimed.map((row) => row.id).sort()).toEqual([stuck, legacyStuck].sort());
      for (const row of claimed) {
        expect(row.whatsapp_send_status).toBe("sending");
        expect(row.whatsapp_next_attempt_at!.getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
      }
    });

    it("reclaims a meeting notification stuck in 'sending' past its lease, but not one still within it", async () => {
      const { claimQueuedMeetingWhatsappSends } = await import("../../src/services/meetingScheduledNotification.service.js");
      const stuck = await newMeeting("sending", ago(1));
      const legacyStuck = await newMeeting("sending", null);
      const inFlight = await newMeeting("sending", ago(-10));

      const claimed = await claimRolledBack(claimQueuedMeetingWhatsappSends, [stuck, legacyStuck, inFlight]);
      expect(claimed.map((row) => row.id).sort()).toEqual([stuck, legacyStuck].sort());
      for (const row of claimed) expect(row.notify_whatsapp_next_attempt_at!.getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
    });

    it("marks a reclaimed proposal 'sent' without re-sending when its outbound message already went out", async () => {
      const { getProposalRowOr404 } = await import("../../src/services/proposals.service.js");
      const { processQueuedProposalWhatsappSend } = await import("../../src/services/proposalSending.service.js");
      const id = await newProposal("sending", ago(1));
      await markOutboundSent("proposal_id", id);

      await processQueuedProposalWhatsappSend(await getProposalRowOr404(pool, WORKSPACE_ID, id));

      expect(sendWhatsApp).not.toHaveBeenCalled();
      const row = await getProposalRowOr404(pool, WORKSPACE_ID, id);
      expect(row.whatsapp_send_status).toBe("sent");
      expect(row.whatsapp_sent_at).not.toBeNull();
      expect(row.status).toBe("sent");
    });

    it("marks a reclaimed meeting notification 'sent' without re-sending when its outbound message already went out", async () => {
      const { processQueuedMeetingWhatsappSend } = await import("../../src/services/meetingScheduledNotification.service.js");
      const id = await newMeeting("sending", ago(1));
      await markOutboundSent("meeting_id", id);
      const meeting = (await pool.query(`select * from public.meetings where id = $1`, [id])).rows[0];

      await processQueuedMeetingWhatsappSend(meeting);

      expect(sendWhatsApp).not.toHaveBeenCalled();
      const row = (await pool.query(`select notify_whatsapp_status, notify_whatsapp_sent_at from public.meetings where id = $1`, [id])).rows[0];
      expect(row.notify_whatsapp_status).toBe("sent");
      expect(row.notify_whatsapp_sent_at).not.toBeNull();
    });
  });
});
