/**
 * E3b-2b rule 19: GET /analytics/funnel through the real HTTP stack: totals, groups, the 14-day
 * meeting rule, the website main number, reply → answer time, an empty period and range checks.
 * Facts and events are inserted directly. Skipped unless TEST_DATABASE_URL is set; [test] workspaces only.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createTestWorkspace, deleteCreatedTestWorkspaces } from "../helpers/testWorkspaces.js";
import { qs, startTestApi, type TestApi } from "../helpers/testApi.js";
import type { Actor } from "../../src/authMiddleware.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const MIN = 60_000;
const DAY = 86_400_000;

describeIfDb("E3b-2b funnel numbers (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let api: TestApi;
  let rep: Actor;
  let ws: string;

  async function lead(source: string, createdAt: Date) {
    return (
      await pool.query(
        `insert into public.leads (workspace_id, first_name, company, source, email, created_at) values ($1, 'Asha', 'Acme Steel', $2, $3, $4) returning id`,
        [ws, source, `funnel-${randomUUID()}@example.com`, createdAt],
      )
    ).rows[0].id as string;
  }
  async function fact(leadId: string, channel: "email" | "whatsapp", sentAt: Date, extra: Record<string, unknown> = {}) {
    const outbound =
      channel === "email"
        ? (
            await pool.query(
              `insert into public.email_outbound_messages (workspace_id, source, source_id, lead_id, to_address, subject, html, text_body, status, sent_at)
               values ($1, 'agent', gen_random_uuid(), $2, 'a@example.com', 's', 's', 's', 'sent', $3) returning id`,
              [ws, leadId, sentAt],
            )
          ).rows[0].id
        : null;
    const cols = Object.keys(extra);
    await pool.query(
      `insert into public.message_facts (workspace_id, lead_id, source, channel, email_outbound_id, whatsapp_outbound_id, message_number, sent_at${cols.map((c) => `, ${c}`).join("")})
       values ($1, $2, 'agent', $3, $4, $5, 1, $6${cols.map((_, i) => `, $${i + 7}`).join("")})`,
      [ws, leadId, channel, outbound, channel === "whatsapp" ? await whatsappOutbound(leadId) : null, sentAt, ...Object.values(extra)],
    );
  }
  /** A sent WhatsApp outbound row for a fact (its source: a filler proposal). */
  async function whatsappOutbound(leadId: string) {
    const proposal = await pool.query(`insert into public.proposals (workspace_id, lead_id, title) values ($1, $2, 'Filler') returning id`, [ws, leadId]);
    return (
      await pool.query(
        `insert into public.whatsapp_outbound_messages (workspace_id, proposal_id, message_id, remote_jid, status, sent_at) values ($1, $2, $3, '919000000003@s.whatsapp.net', 'sent', now()) returning id`,
        [ws, proposal.rows[0].id, `funnel-${randomUUID()}`],
      )
    ).rows[0].id;
  }
  const get = (params: Record<string, string | undefined>) => api.call(rep, ws, "GET", `/analytics/funnel${qs(params)}`);

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
    api = await startTestApi(pool, "funnel");
    rep = await api.newUser("salesperson", { name: "Funnel Rep" });
    ws = await createTestWorkspace(pool, "funnel");

    const now = Date.now();
    // A: website, first message after 5 min, positive reply after 1 h answered 30 min later, meeting booked on day 3.
    const aCreated = new Date(now - 4 * DAY);
    const a = await lead("website", aCreated);
    await fact(a, "email", new Date(aCreated.getTime() + 5 * MIN), {
      angle: "welcome",
      first_counted_open_at: new Date(aCreated.getTime() + 20 * MIN),
      replied_at: new Date(aCreated.getTime() + 60 * MIN),
      reply_label: "positive",
      meeting_booked_at: new Date(aCreated.getTime() + 3 * DAY),
    });
    await pool.query(
      `insert into public.whatsapp_inbound_events (message_id, workspace_id, sender_jid, sender_phone_e164, message_type, received_at, disposition, match_count, lead_id, reply_label)
       values ($1, $2, '919000000004@s.whatsapp.net', '+919000000004', 'conversation', $3, 'matched', 1, $4, 'positive')`,
      [`funnel-${randomUUID()}`, ws, new Date(aCreated.getTime() + 60 * MIN), a],
    );
    await fact(a, "whatsapp", new Date(aCreated.getTime() + 90 * MIN));
    await pool.query(`insert into public.meetings (workspace_id, lead_id, title, scheduled_at, status, created_at) values ($1, $2, 'Intro', $3, 'scheduled', $4)`, [
      ws,
      a,
      new Date(now + DAY),
      new Date(aCreated.getTime() + 3 * DAY),
    ]);
    // B: website, first message after 1 h, meeting booked 20 days after it came in (outside 14 days).
    const bCreated = new Date(now - 20 * DAY);
    const b = await lead("website", bCreated);
    await fact(b, "whatsapp", new Date(bCreated.getTime() + 60 * MIN));
    await pool.query(`insert into public.meetings (workspace_id, lead_id, title, scheduled_at, status, created_at) values ($1, $2, 'Intro', $3, 'scheduled', $4)`, [
      ws,
      b,
      new Date(now + DAY),
      new Date(now - MIN),
    ]);
    // C: referral, nothing sent yet.
    await lead("referral", new Date(now - DAY));
  });

  afterAll(async () => {
    await deleteCreatedTestWorkspaces(pool);
    await api.close();
    await pool.end();
  });

  it("totals (last 30 days by default), the website main number with the 14-day rule, and reply → answer time", async () => {
    const res = await get({});
    expect(res.status).toBe(200);
    expect(res.body.totals).toEqual({
      leadsCreated: 3,
      contacted: 2,
      firstMessageWithin15Min: { count: 1, pct: 33.3 },
      medianMinutesToFirstMessage: 32.5,
      emailsSent: 1,
      countedOpens: 1,
      replies: 1,
      positiveReplies: 1,
      meetingsBookedWithin14Days: 1,
      proposals: 0,
      won: 0,
    });
    expect(res.body.websiteMeetingRate).toEqual({ websiteLeads: 2, bookedWithin14Days: 1, pct: 50 });
    expect(res.body.medianMinutesReplyToAnswer).toBe(30);
    expect(res.body.groups).toEqual([]);
  });

  it("groups: lead source, channel, WhatsApp number and angle", async () => {
    const source = (await get({ groupBy: "source" })).body.groups;
    expect(source.map((g: { key: string; leadsCreated: number }) => [g.key, g.leadsCreated])).toEqual([
      ["website", 2],
      ["referral", 1],
    ]);
    const channel = (await get({ groupBy: "channel" })).body.groups;
    expect(channel).toEqual([
      { key: "whatsapp", label: "WhatsApp", messagesSent: 2, emailsSent: 0, countedOpens: 0, replies: 0, positiveReplies: 0, meetingsBooked: 0, dealsCreated: 0, won: 0 },
      { key: "email", label: "Email", messagesSent: 1, emailsSent: 1, countedOpens: 1, replies: 1, positiveReplies: 1, meetingsBooked: 1, dealsCreated: 0, won: 0 },
    ]);
    const number = (await get({ groupBy: "number" })).body.groups;
    expect(number).toEqual([expect.objectContaining({ key: null, label: "WhatsApp", messagesSent: 2 })]);
    const angle = (await get({ groupBy: "angle" })).body.groups;
    expect(angle).toEqual([
      expect.objectContaining({ key: null, label: "Not an AI message", messagesSent: 2 }),
      expect.objectContaining({ key: "welcome", label: expect.any(String), messagesSent: 1, replies: 1 }),
    ]);
  });

  it("an empty period gives zeros (no percentages); over 180 days, from after to or an unknown group → 400", async () => {
    const empty = await get({ from: "2025-01-01T00:00:00Z", to: "2025-02-01T00:00:00Z", groupBy: "channel" });
    expect(empty.status).toBe(200);
    expect(empty.body.totals).toMatchObject({ leadsCreated: 0, contacted: 0, firstMessageWithin15Min: { count: 0, pct: null }, medianMinutesToFirstMessage: null });
    expect(empty.body.websiteMeetingRate).toEqual({ websiteLeads: 0, bookedWithin14Days: 0, pct: null });
    expect(empty.body.groups).toEqual([]);
    expect((await get({ from: "2025-01-01T00:00:00Z", to: "2025-07-02T00:00:00Z" })).status).toBe(400);
    expect((await get({ from: "2025-02-01T00:00:00Z", to: "2025-01-01T00:00:00Z" })).status).toBe(400);
    expect((await get({ groupBy: "owner" })).status).toBe(400);
  });
});
