/**
 * E3b-2a-2 rule 4: `npm run staging:seed-reply-draft` — one open sample draft for a seeded test contact's
 * latest matched reply (no AI call), optionally after a fake matched reply (--with-reply), its refusals and
 * --remove. [test] workspaces only (scoped by workspaceId). Skipped unless TEST_DATABASE_URL is set.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createTestWorkspace, deleteCreatedTestWorkspaces } from "../helpers/testWorkspaces.js";
import { startTestApi, type TestApi } from "../helpers/testApi.js";
import type { Actor } from "../../src/authMiddleware.js";
import { assertStagingDatabase, SEED_MARKER } from "../../scripts/seed-ai-test-contacts.js";
import { DEFAULT_REPLY_TEXT, removeSeededReplyDrafts, SAMPLE_BODY, SEED_DRAFT_MODEL, seedReplyDraft, withReplyArg } from "../../scripts/seed-reply-draft.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb("E3b-2a-2 staging:seed-reply-draft (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let api: TestApi;
  let owner: Actor;
  let ws: string;

  async function contact(first: string, opts: { seeded?: boolean; phone?: boolean; email?: boolean } = {}) {
    const last = `Seed${randomUUID().slice(0, 8)}`;
    const phone = opts.phone === false ? null : `+9197${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
    const row = await pool.query(
      `insert into public.leads (workspace_id, first_name, last_name, company, source, email, phone, phone_e164, owner_id, agent_status, created_by_name)
       values ($1, $2, $3, 'Acme Steel', 'referral', $4, $5, $5, $6, 'active', $7) returning id`,
      [ws, first, last, opts.email === false ? null : `seed-${randomUUID()}@example.com`, phone, owner.id, opts.seeded === false ? "Someone" : SEED_MARKER],
    );
    return { id: row.rows[0].id as string, name: `${first} ${last}` };
  }

  const whatsappReply = (leadId: string, minutesAgo = 0) =>
    pool.query(
      `insert into public.whatsapp_inbound_events (message_id, workspace_id, sender_jid, sender_phone_e164, message_type, received_at, disposition, match_count, lead_id)
       values ($1, $2, '919000000001@s.whatsapp.net', '+919000000001', 'conversation', now() - $4 * interval '1 minute', 'matched', 1, $3) returning message_id`,
      [`seed-${randomUUID()}`, ws, leadId, minutesAgo],
    );
  const count = async (sql: string, params: unknown[]) => (await pool.query<{ n: number }>(`select count(*)::int as n from ${sql}`, params)).rows[0]!.n;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
    api = await startTestApi(pool, "seed-reply-draft");
    owner = await api.newUser("salesperson", { name: "Seed Owner" });
    ws = await createTestWorkspace(pool, "seed-reply-draft");
  });

  afterAll(async () => {
    await deleteCreatedTestWorkspaces(pool);
    await api.close();
    await pool.end();
  });

  it("refuses production / non-staging databases (checked before connecting); --with-reply text defaults", () => {
    expect(() => assertStagingDatabase("postgres://postgres.jorxltfwboabyjiydyhu:x@pooler.supabase.com:5432/postgres")).toThrow(/production/);
    expect(() => assertStagingDatabase("postgres://localhost/postgres")).toThrow(/not the staging/);
    expect(withReplyArg(["--contact", "A B"])).toBeUndefined();
    expect(withReplyArg(["--contact", "A B", "--with-reply"])).toBe(DEFAULT_REPLY_TEXT);
    expect(withReplyArg(["--with-reply", "--contact", "A B"])).toBe(DEFAULT_REPLY_TEXT);
    expect(withReplyArg(["--with-reply", "Do you work in Pune?"])).toBe("Do you work in Pune?");
  });

  it("refuses a contact that isn't seeded or has no matched reply; seeds one open draft on the latest reply; refuses a second; --remove deletes it", async () => {
    const other = await contact("Ravi", { seeded: false });
    await whatsappReply(other.id);
    await expect(seedReplyDraft(pool, { contact: other.name, workspaceId: ws })).rejects.toThrow(/is not a seeded AI test contact/);
    await expect(seedReplyDraft(pool, { contact: other.name, workspaceId: ws, withReply: "x" })).rejects.toThrow(/is not a seeded AI test contact/);

    const quiet = await contact("Meera");
    await expect(seedReplyDraft(pool, { contact: quiet.name, workspaceId: ws })).rejects.toThrow(/has no matched reply.*--with-reply/);

    const asha = await contact("Asha");
    await whatsappReply(asha.id, 10);
    const latest = (await whatsappReply(asha.id, 1)).rows[0].message_id as string;
    expect(await seedReplyDraft(pool, { contact: asha.name.toUpperCase(), workspaceId: ws })).toMatch(new RegExp(`^Seeded an open WhatsApp suggested reply .+ for ${asha.name}`));
    const rows = (await pool.query(`select whatsapp_message_id, status, body, model, cost_usd from public.reply_drafts where lead_id = $1`, [asha.id])).rows;
    expect(rows).toEqual([{ whatsapp_message_id: latest, status: "open", body: SAMPLE_BODY.whatsapp, model: SEED_DRAFT_MODEL, cost_usd: "0.000000" }]);
    await expect(seedReplyDraft(pool, { contact: asha.name, workspaceId: ws })).rejects.toThrow(/already has an open suggested reply/);
    // The open-draft refusal comes before any fake reply is stored.
    await expect(seedReplyDraft(pool, { contact: asha.name, workspaceId: ws, withReply: "Hi" })).rejects.toThrow(/already has an open suggested reply/);
    expect(await count(`public.whatsapp_inbound_events where lead_id = $1`, [asha.id])).toBe(2);

    // --remove deletes only the seeded drafts; the real replies stay.
    await pool.query(`insert into public.reply_drafts (workspace_id, lead_id, channel, whatsapp_message_id, body, status, model) values ($1, $2, 'whatsapp', $3, 'real', 'superseded', 'm')`, [
      ws,
      asha.id,
      (await whatsappReply(asha.id, 20)).rows[0].message_id,
    ]);
    expect(await removeSeededReplyDrafts(pool, { contact: asha.name, workspaceId: ws })).toEqual({ drafts: 1, replies: 0, tasks: 0, timeline: 0, queuedEmails: 0, queuedWhatsApp: 0 });
    expect((await pool.query(`select model from public.reply_drafts where lead_id = $1`, [asha.id])).rows).toEqual([{ model: "m" }]);
    expect(await count(`public.whatsapp_inbound_events where lead_id = $1`, [asha.id])).toBe(3);
  });

  it("--with-reply: a fake WhatsApp reply stored like a real one (encrypted, label question/keyword, no AI step, no draft step), its reply task never escalates, nothing sent or notified", async () => {
    const neha = await contact("Neha");
    expect(await seedReplyDraft(pool, { contact: neha.name, workspaceId: ws, withReply: DEFAULT_REPLY_TEXT })).toMatch(/^Seeded a fake WhatsApp reply and an open WhatsApp suggested reply/);
    const event = (
      await pool.query(
        `select message_id, disposition, reply_label, reply_label_source, classification_status, draft_status, body_ciphertext, body_iv, body_tag, body_key_version
           from public.whatsapp_inbound_events where lead_id = $1`,
        [neha.id],
      )
    ).rows;
    expect(event).toHaveLength(1);
    expect(event[0]).toMatchObject({ disposition: "matched", reply_label: "question", reply_label_source: "keyword", classification_status: "skipped", draft_status: null });
    const { decryptInboundBody } = await import("../../src/services/inboundReplies.service.js");
    expect(decryptInboundBody(event[0], `whatsapp:inbound:${event[0].message_id}`)).toBe(DEFAULT_REPLY_TEXT);
    expect((await pool.query(`select whatsapp_message_id, status from public.reply_drafts where lead_id = $1`, [neha.id])).rows).toEqual([{ whatsapp_message_id: event[0].message_id, status: "open" }]);
    expect((await pool.query(`select title, metadata->>'messageId' as id from public.timeline_events where lead_id = $1 and event_kind = 'whatsapp'`, [neha.id])).rows).toEqual([
      { title: "WhatsApp reply received - automation stopped", id: event[0].message_id },
    ]);
    // The Activity reply row carries the Suggested reply card's draft, as for a real reply.
    const timeline = (await api.call(owner, ws, "GET", `/contacts/${neha.id}/timeline`)).body.data as { reply?: { messageId: string; draft: { status: string; body: string } | null } }[];
    expect(timeline.find((r) => r.reply?.messageId === event[0].message_id)?.reply?.draft).toMatchObject({ status: "open", body: SAMPLE_BODY.whatsapp });
    const tasks = (await pool.query(`select title, origin, escalated_at is not null as escalated from public.tasks where lead_id = $1 and status = 'open'`, [neha.id])).rows;
    expect(tasks).toEqual([{ title: "Asked a question — respond today", origin: "agent", escalated: true }]);

    const { runReplyEscalation } = await import("../../src/services/workReminders.service.js");
    expect(await runReplyEscalation({ now: new Date(Date.now() + 7 * 86_400_000), workspaceIds: [ws] })).toEqual([]);
    expect(await count(`public.notifications where lead_id = $1`, [neha.id])).toBe(0);
    expect(await count(`public.email_outbound_messages where lead_id = $1`, [neha.id])).toBe(0);

    // E3b-2b rule 3: a seeded draft can never be sent; it stays open.
    const draftId = (await pool.query(`select id from public.reply_drafts where lead_id = $1`, [neha.id])).rows[0].id as string;
    const refused = await api.call(owner, ws, "POST", `/contacts/${neha.id}/reply-drafts/${draftId}/send`, { body: SAMPLE_BODY.whatsapp });
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toBe("Seeded test draft — sending is disabled");
    expect((await pool.query(`select status, send_status from public.reply_drafts where id = $1`, [draftId])).rows[0]).toEqual({ status: "open", send_status: null });
    // A WhatsApp Send queued before this rule existed: --remove deletes it and counts it.
    await pool.query(`update public.reply_drafts set status = 'sent', send_status = 'queued', send_next_at = now() + interval '1 day' where id = $1`, [draftId]);
    expect(await removeSeededReplyDrafts(pool, { contact: neha.name, workspaceId: ws })).toMatchObject({ drafts: 1, queuedWhatsApp: 1, queuedEmails: 0 });
    expect((await pool.query(`select agent_status from public.leads where id = $1`, [neha.id])).rows[0].agent_status).toBe("active");
  });

  it("--with-reply falls back to email when WhatsApp isn't usable, refuses when neither is; --remove deletes the fake reply, its task, timeline row, draft and a queued rep Send, and nothing else", async () => {
    const none = await contact("Kiran", { phone: false });
    await pool.query(`insert into public.lead_contact_channels (lead_id, channel, status, reason) values ($1, 'email', 'unsubscribed', 'test')`, [none.id]);
    await expect(seedReplyDraft(pool, { contact: none.name, workspaceId: ws, withReply: "Hi" })).rejects.toThrow(/no usable WhatsApp number or email address/);
    expect(await count(`public.email_inbound_events where lead_id = $1`, [none.id])).toBe(0);

    const raj = await contact("Raj");
    await pool.query(`insert into public.lead_contact_channels (lead_id, channel, status, reason) values ($1, 'whatsapp', 'opted_out', 'test')`, [raj.id]);
    const realReply = (await whatsappReply(raj.id, 60)).rows[0].message_id as string;
    const manual = await pool.query(`insert into public.tasks (workspace_id, lead_id, owner_id, task_type, title, due_at) values ($1, $2, $3, 'follow_up', 'Call Raj', now()) returning id`, [ws, raj.id, owner.id]);
    expect(await seedReplyDraft(pool, { contact: raj.name, workspaceId: ws, withReply: "Which regions do you cover?" })).toMatch(/^Seeded a fake email reply and an open email suggested reply/);
    const draft = (await pool.query(`select id, channel, subject, in_reply_to from public.reply_drafts where lead_id = $1`, [raj.id])).rows[0];
    expect(draft).toMatchObject({ channel: "email", subject: "Re: your message", in_reply_to: expect.stringMatching(/^<staging-seed-.+@seed\.invalid>$/) });
    expect((await pool.query(`select title from public.tasks where lead_id = $1 and origin = 'agent'`, [raj.id])).rows).toEqual([{ title: "Asked a question — respond today" }]);

    // E3b-2b rule 3: the email Send is refused too (409), nothing queued.
    const refused = await api.call(owner, ws, "POST", `/contacts/${raj.id}/reply-drafts/${draft.id}/send`, { body: SAMPLE_BODY.email });
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toBe("Seeded test draft — sending is disabled");
    expect(await count(`public.email_outbound_messages where source = 'reply_draft' and source_id = $1`, [draft.id])).toBe(0);
    // An email Send queued before this rule existed (the worker is stopped): --remove deletes it.
    const { enqueueEmail } = await import("../../src/services/emailOutbound.service.js");
    await enqueueEmail(pool, { workspaceId: ws, source: "reply_draft", sourceId: draft.id, leadId: raj.id, to: "raj@example.com", subject: "Re: your message", html: "<p>Hi</p>" });

    expect(await removeSeededReplyDrafts(pool, { contact: raj.name, workspaceId: ws })).toEqual({ drafts: 1, replies: 1, tasks: 1, timeline: 1, queuedEmails: 1, queuedWhatsApp: 0 });
    expect(await count(`public.email_inbound_events where lead_id = $1`, [raj.id])).toBe(0);
    expect(await count(`public.reply_drafts where lead_id = $1`, [raj.id])).toBe(0);
    expect(await count(`public.email_outbound_messages where lead_id = $1`, [raj.id])).toBe(0);
    expect(await count(`public.timeline_events where lead_id = $1 and metadata->>'seeded' = 'true'`, [raj.id])).toBe(0);
    expect((await pool.query(`select id from public.tasks where lead_id = $1`, [raj.id])).rows).toEqual([{ id: manual.rows[0].id }]);
    expect((await pool.query(`select message_id from public.whatsapp_inbound_events where lead_id = $1`, [raj.id])).rows).toEqual([{ message_id: realReply }]);
  });
});
