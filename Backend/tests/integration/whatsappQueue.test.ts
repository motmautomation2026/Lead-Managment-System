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
import { ProviderDeferredError } from "../../src/providers/provider-errors.js";

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

  /**
   * Puts our rows into the given states and runs a claim in ONE transaction,
   * then rolls it back: other workers polling the same database never see
   * these states, so they cannot claim the rows first.
   */
  async function claimRolledBack<T extends { id: string }>(
    table: "proposals" | "meetings",
    states: { id: string; nextAttemptAt: string | null }[],
    claim: (client: PoolClient, limit: number) => Promise<T[]>,
  ) {
    const [status, next] = table === "proposals" ? ["whatsapp_send_status", "whatsapp_next_attempt_at"] : ["notify_whatsapp_status", "notify_whatsapp_next_attempt_at"];
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const state of states) {
        await client.query(`update public.${table} set ${status} = 'sending', ${next} = $2 where id = $1`, [state.id, state.nextAttemptAt]);
      }
      const claimed = await claim(client, 1000);
      return claimed.filter((row) => states.some((state) => state.id === row.id));
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

  async function newProposal(status: "sending" | "skipped", nextAttemptAt: string | null) {
    const { createProposal } = await import("../../src/services/proposals.service.js");
    const lead = await newLead();
    const proposal = await inTransaction((client) =>
      // Never 'queued' here: a live staging worker would claim it first.
      createProposal(client, actor, WORKSPACE_ID, { leadId: lead.id, title: "Queue proposal", whatsappSendStatus: "skipped" }),
    );
    await pool.query(`update public.proposals set whatsapp_send_status = $2, whatsapp_next_attempt_at = $3 where id = $1`, [proposal.id, status, nextAttemptAt]);
    return proposal.id;
  }

  async function newMeeting(status: "sending" | "skipped", nextAttemptAt: string | null) {
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

  /** A claimed proposal that can reach sendWhatsApp: WhatsApp template and document set. */
  async function sendableProposal(createdHoursAgo = 0) {
    const id = await newProposal("sending", ago(-10));
    await pool.query(
      `update public.proposals
          set whatsapp_template_id = $2, document_storage_path = 'test/proposal.pdf', document_file_name = 'proposal.pdf',
              document_mime_type = 'application/pdf', created_at = now() - make_interval(hours => $3)
        where id = $1`,
      [id, whatsappTemplateId, createdHoursAgo],
    );
    const { getProposalRowOr404 } = await import("../../src/services/proposals.service.js");
    return getProposalRowOr404(pool, WORKSPACE_ID, id);
  }

  /** A claimed meeting notification that can reach sendWhatsApp (the workspace has a default WhatsApp template). */
  async function sendableMeeting(minutesUntilMeeting: number) {
    const id = await newMeeting("sending", ago(-10));
    const result = await pool.query(`update public.meetings set scheduled_at = now() + make_interval(mins => $2) where id = $1 returning *`, [
      id,
      minutesUntilMeeting,
    ]);
    return result.rows[0];
  }

  async function proposalSendState(id: string) {
    return (await pool.query(`select whatsapp_send_status, whatsapp_send_error, whatsapp_attempt_count, whatsapp_next_attempt_at from public.proposals where id = $1`, [id])).rows[0];
  }

  async function meetingSendState(id: string) {
    return (await pool.query(`select notify_whatsapp_status, notify_whatsapp_error, notify_whatsapp_attempt_count, notify_whatsapp_next_attempt_at from public.meetings where id = $1`, [id])).rows[0];
  }

  let whatsappTemplateId: string;

  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    const auth = await pool.query(`insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`, [`wa-queue-${randomUUID()}@example.com`]);
    authUserId = auth.rows[0].id as string;
    const profile = await pool.query(`select id, full_name, email from public.profiles where id = $1`, [authUserId]);
    actor = { id: profile.rows[0].id, fullName: profile.rows[0].full_name, email: profile.rows[0].email, isActive: true, role: "salesperson" };
    WORKSPACE_ID = randomUUID();
    await pool.query(`insert into public.workspaces (id, name, slug) values ($1, $2, $2)`, [WORKSPACE_ID, `wa-queue-test-${WORKSPACE_ID}`]);
    const template = await pool.query(
      `insert into public.message_templates (workspace_id, name, channel, body, is_default_meeting_scheduled_whatsapp)
       values ($1, 'Queue test WhatsApp', 'whatsapp', 'Hello {{lead.first_name}}', true) returning id`,
      [WORKSPACE_ID],
    );
    whatsappTemplateId = template.rows[0].id as string;
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
      const [stuck, legacyStuck, inFlight] = [await newProposal("skipped", null), await newProposal("skipped", null), await newProposal("skipped", null)];

      const claimed = await claimRolledBack(
        "proposals",
        [
          { id: stuck, nextAttemptAt: ago(1) },
          { id: legacyStuck, nextAttemptAt: null },
          { id: inFlight, nextAttemptAt: ago(-10) },
        ],
        claimQueuedProposalWhatsappSends,
      );
      expect(claimed.map((row) => row.id).sort()).toEqual([stuck, legacyStuck].sort());
      for (const row of claimed) {
        expect(row.whatsapp_send_status).toBe("sending");
        expect(row.whatsapp_next_attempt_at!.getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
      }
    });

    it("reclaims a meeting notification stuck in 'sending' past its lease, but not one still within it", async () => {
      const { claimQueuedMeetingWhatsappSends } = await import("../../src/services/meetingScheduledNotification.service.js");
      const [stuck, legacyStuck, inFlight] = [await newMeeting("skipped", null), await newMeeting("skipped", null), await newMeeting("skipped", null)];

      const claimed = await claimRolledBack(
        "meetings",
        [
          { id: stuck, nextAttemptAt: ago(1) },
          { id: legacyStuck, nextAttemptAt: null },
          { id: inFlight, nextAttemptAt: ago(-10) },
        ],
        claimQueuedMeetingWhatsappSends,
      );
      expect(claimed.map((row) => row.id).sort()).toEqual([stuck, legacyStuck].sort());
      for (const row of claimed) expect(row.notify_whatsapp_next_attempt_at!.getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
    });

    it("marks a reclaimed proposal 'sent' without re-sending when its outbound message already went out", async () => {
      const { getProposalRowOr404 } = await import("../../src/services/proposals.service.js");
      const { processQueuedProposalWhatsappSend } = await import("../../src/services/proposalSending.service.js");
      const id = await newProposal("sending", ago(-10));
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
      const id = await newMeeting("sending", ago(-10));
      await markOutboundSent("meeting_id", id);
      const meeting = (await pool.query(`select * from public.meetings where id = $1`, [id])).rows[0];

      await processQueuedMeetingWhatsappSend(meeting);

      expect(sendWhatsApp).not.toHaveBeenCalled();
      const row = (await pool.query(`select notify_whatsapp_status, notify_whatsapp_sent_at from public.meetings where id = $1`, [id])).rows[0];
      expect(row.notify_whatsapp_status).toBe("sent");
      expect(row.notify_whatsapp_sent_at).not.toBeNull();
    });
  });

  describe("deferrals do not consume attempts", () => {
    const deferred = () => new ProviderDeferredError("WhatsApp is disconnected or awaiting QR pairing.", 60_000);

    it("keeps re-queueing a proposal past 5 deferrals without counting attempts", async () => {
      const { processQueuedProposalWhatsappSend } = await import("../../src/services/proposalSending.service.js");
      const row = await sendableProposal();
      sendWhatsApp.mockRejectedValue(deferred());

      for (let i = 0; i < 6; i++) await processQueuedProposalWhatsappSend(row);

      expect(sendWhatsApp).toHaveBeenCalledTimes(6);
      const state = await proposalSendState(row.id);
      expect(state).toMatchObject({ whatsapp_send_status: "queued", whatsapp_attempt_count: 0, whatsapp_send_error: deferred().message });
      expect(state.whatsapp_next_attempt_at.getTime()).toBeGreaterThan(Date.now());
    });

    it("fails a proposal once it has been deferred for 72 hours", async () => {
      const { processQueuedProposalWhatsappSend } = await import("../../src/services/proposalSending.service.js");
      const row = await sendableProposal(73);
      sendWhatsApp.mockRejectedValue(deferred());

      await processQueuedProposalWhatsappSend(row);

      const state = await proposalSendState(row.id);
      expect(state.whatsapp_send_status).toBe("failed");
      expect(state.whatsapp_send_error).toContain("unavailable for 72 hours");
    });

    it("still fails a proposal on a real (non-deferral) error", async () => {
      const { processQueuedProposalWhatsappSend } = await import("../../src/services/proposalSending.service.js");
      const row = await sendableProposal();
      sendWhatsApp.mockRejectedValue(new Error("Baileys returned no message payload."));

      await processQueuedProposalWhatsappSend(row);

      expect(await proposalSendState(row.id)).toMatchObject({ whatsapp_send_status: "failed", whatsapp_send_error: "Baileys returned no message payload." });
    });

    it("keeps re-queueing a meeting notification past 5 deferrals while the meeting is upcoming", async () => {
      const { processQueuedMeetingWhatsappSend } = await import("../../src/services/meetingScheduledNotification.service.js");
      const row = await sendableMeeting(120);
      sendWhatsApp.mockRejectedValue(deferred());

      for (let i = 0; i < 6; i++) await processQueuedMeetingWhatsappSend(row);

      expect(sendWhatsApp).toHaveBeenCalledTimes(6);
      expect(await meetingSendState(row.id)).toMatchObject({ notify_whatsapp_status: "queued", notify_whatsapp_attempt_count: 0 });
    });

    it("skips a meeting notification with a clear reason once the meeting time has passed", async () => {
      const { processQueuedMeetingWhatsappSend } = await import("../../src/services/meetingScheduledNotification.service.js");
      const row = await sendableMeeting(-5);
      sendWhatsApp.mockRejectedValue(deferred());

      await processQueuedMeetingWhatsappSend(row);

      const state = await meetingSendState(row.id);
      expect(state.notify_whatsapp_status).toBe("skipped");
      expect(state.notify_whatsapp_error).toContain("meeting time passed");
    });
  });
});
