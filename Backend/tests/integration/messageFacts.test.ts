/**
 * E3b-2b rule 14: per-message facts and last-touch attribution. Emails are inserted as already
 * sent (no SMTP); the real meeting / deal services fire the hooks. WhatsApp facts are covered on
 * the real send path in whatsappSafety.test.ts. Skipped unless TEST_DATABASE_URL is set; [test]
 * workspaces only.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createTestWorkspace, deleteCreatedTestWorkspaces } from "../helpers/testWorkspaces.js";
import { startTestApi, type TestApi } from "../helpers/testApi.js";
import type { Actor } from "../../src/authMiddleware.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const DAY = 86_400_000;

describeIfDb("E3b-2b message facts (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let api: TestApi;
  let rep: Actor;
  let ws: string;

  async function lead() {
    return (
      await pool.query(
        `insert into public.leads (workspace_id, first_name, company, source, email, owner_id) values ($1, 'Asha', 'Acme Steel', 'website', $2, $3) returning id`,
        [ws, `facts-${randomUUID()}@example.com`, rep.id],
      )
    ).rows[0].id as string;
  }
  /** An email row in the given state, sent `daysAgo` days ago; returns its id after recordEmailFact. */
  async function email(leadId: string | null, daysAgo: number, opts: { source?: string; status?: string; dryRun?: boolean } = {}) {
    const id = (
      await pool.query(
        `insert into public.email_outbound_messages (workspace_id, source, source_id, lead_id, to_address, subject, html, text_body, status, sent_at, dry_run)
         values ($1, $2, gen_random_uuid(), $3, 'asha@example.com', 's', '<p>s</p>', 's', $4, now() - $5 * interval '1 day', $6) returning id`,
        [ws, opts.source ?? "scheduled_action", leadId, opts.status ?? "sent", daysAgo, opts.dryRun ?? false],
      )
    ).rows[0].id as string;
    const { recordEmailFact } = await import("../../src/services/messageFacts.service.js");
    await recordEmailFact(pool, id);
    return id;
  }
  const facts = async (leadId: string) =>
    (
      await pool.query(
        `select email_outbound_id, source, channel, message_number, replied_at, reply_label, meeting_booked_at, deal_created_at, deal_won_at
           from public.message_facts where lead_id = $1 order by message_number`,
        [leadId],
      )
    ).rows;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
    api = await startTestApi(pool, "message-facts");
    rep = await api.newUser("salesperson", { name: "Facts Rep" });
    ws = await createTestWorkspace(pool, "message-facts");
  });

  afterAll(async () => {
    await deleteCreatedTestWorkspaces(pool);
    await api.close();
    await pool.end();
  });

  it("one fact per message that really went out (not queued, not dry run, not a test email); message_number counts per lead; recording twice is a no-op", async () => {
    const l = await lead();
    const first = await email(l, 3);
    await email(l, 2, { status: "queued" });
    await email(l, 2, { dryRun: true });
    await email(null, 2, { source: "test" });
    const second = await email(l, 1, { source: "proposal" });
    const { recordEmailFact } = await import("../../src/services/messageFacts.service.js");
    await recordEmailFact(pool, second);
    expect(await facts(l)).toMatchObject([
      { email_outbound_id: first, source: "workflow", channel: "email", message_number: 1 },
      { email_outbound_id: second, source: "proposal", channel: "email", message_number: 2 },
    ]);
  });

  it("a reply, its label, a meeting and a deal go to the LAST message within 14 days, each set once; older messages get nothing", async () => {
    const l = await lead();
    await email(l, 5);
    const last = await email(l, 2);
    const { attributeOutcome, attributeReplyLabel } = await import("../../src/services/messageFacts.service.js");
    await pool.query(`update public.leads set hot_score_dirty = false where id = $1`, [l]);
    await attributeOutcome(pool, l, "reply");
    await attributeReplyLabel(pool, l, "positive");
    expect((await pool.query(`select hot_score_dirty from public.leads where id = $1`, [l])).rows[0].hot_score_dirty).toBe(true);
    const repliedAt = (await facts(l))[1]!.replied_at as Date;
    // A second reply and a corrected label change nothing (set once).
    await attributeOutcome(pool, l, "reply");
    await attributeReplyLabel(pool, l, "annoyed");

    const { scheduleMeeting } = await import("../../src/services/meetings.service.js");
    await scheduleMeeting(pool, rep, ws, { leadId: l, title: "Intro call", at: new Date(Date.now() + 2 * DAY).toISOString() });
    const { createDeal } = await import("../../src/services/deals.service.js");
    await createDeal(pool, rep, ws, { leadId: l, source: "manual", stage: "won" });

    const rows = await facts(l);
    expect(rows[0]).toMatchObject({ replied_at: null, reply_label: null, meeting_booked_at: null, deal_created_at: null, deal_won_at: null });
    expect(rows[1]).toMatchObject({ email_outbound_id: last, replied_at: repliedAt, reply_label: "positive" });
    // scheduleMeeting attaches a deal too (deal_created), then the won deal sets deal_won.
    expect(rows[1]!.meeting_booked_at).toBeInstanceOf(Date);
    expect(rows[1]!.deal_created_at).toBeInstanceOf(Date);
    expect(rows[1]!.deal_won_at).toBeInstanceOf(Date);
  });

  it("nothing is attributed to a message older than 14 days (or after the event)", async () => {
    const l = await lead();
    await email(l, 20);
    const { attributeOutcome } = await import("../../src/services/messageFacts.service.js");
    await attributeOutcome(pool, l, "reply");
    await attributeOutcome(pool, l, "meeting_booked", new Date(Date.now() - 30 * DAY));
    expect((await facts(l))[0]).toMatchObject({ replied_at: null, meeting_booked_at: null });
  });
});
