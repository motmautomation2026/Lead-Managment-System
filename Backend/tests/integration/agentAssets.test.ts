/**
 * E2g: AI attachments reach the contact on the real worker paths — the runner (fake
 * DecisionModel), AI WhatsApp through BaileysManager.performSend with a fake socket, AI
 * email through the E1b queue with a fake SMTP transport — and the asset files live in
 * Storage (staging bucket agent-assets). Never a real WhatsApp, SMTP or OpenAI call; only
 * `[test]` workspaces. Skipped unless TEST_DATABASE_URL is set.
 */
import { randomUUID } from "node:crypto";
import nodemailer from "nodemailer";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { createTestWorkspace, deleteCreatedTestWorkspaces } from "../helpers/testWorkspaces.js";
import { createFakeDecisionModel } from "../helpers/fakeDecisionModel.js";
import { fakeEmbedder } from "../helpers/fakeEmbedder.js";
import type { AgentDecision } from "../../src/agent/decisionSchema.js";
import type { BaileysManager } from "../../src/providers/baileys.manager.js";
import type { EmailTransport, TransportCache as TransportCacheType } from "../../src/providers/email.provider.js";
import type { WhatsAppSender } from "../../src/services/agentSends.service.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const PRICES = { "m-decide": { inputPer1M: 1, outputPer1M: 1 }, "m-ground": { inputPer1M: 1, outputPer1M: 1 } };
const MODELS = { decision: "m-decide", grounding: "m-ground" };
const PDF = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n");
const ATTACH_LINE = "I've attached a short case study on a similar company.";

const PLAIN_LINE = "We helped a similar company build outbound.";
const OVER_LIMIT = 10 * 1024 * 1024 + 1024;

const emailWith = (assetIds: string[], line = ATTACH_LINE): AgentDecision => ({
  action: "send_email",
  subject: "Outbound for Acme Steel",
  body: `Hi Asha,\n\nFollowing up on my last message. ${line} Would a short call on Tuesday or Wednesday work?`,
  assetIds,
  nextWakeInDays: 3,
  reasoning: "Share proof.",
});
const whatsappWith = (assetIds: string[], line = ATTACH_LINE): AgentDecision => ({
  action: "send_whatsapp",
  body: `Hi Asha, thanks for your reply. ${line} Would a short call on Tuesday or Wednesday work?`,
  assetIds,
  nextWakeInDays: 3,
  reasoning: "Share proof.",
});

describeIfDb("E2g AI attachments (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let adminId: string;
  let Manager: typeof BaileysManager;
  let TransportCache: typeof TransportCacheType;

  const randomPhone = () => `+9197${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;

  /** A live workspace (scope test_contacts), every window open, WhatsApp connected, SMTP configured, IMAP healthy. */
  async function workspace(label: string) {
    const ws = await createTestWorkspace(pool, `assets-${label}`);
    await pool.query(`insert into public.agent_playbooks (workspace_id, version, body, created_by_name) values ($1, 1, 'Be helpful.', 'Test')`, [ws]);
    await pool.query(
      `update public.agent_settings
          set mode = 'live', live_scope = 'test_contacts', send_days = '{1,2,3,4,5,6,7}', send_window_start = '00:00', send_window_end = '23:59:59',
              current_playbook_version = 1, company_display_name = 'MOTM Technologies', rep_quiet_hours = 0
        where workspace_id = $1`,
      [ws],
    );
    await pool.query(
      `insert into public.whatsapp_connection (workspace_id, enabled, status, desired_state, send_window_days, send_window_start, send_window_end)
       values ($1, true, 'connected', 'connected', '{1,2,3,4,5,6,7}', '00:00', '23:59:59')`,
      [ws],
    );
    const { encryptJson } = await import("../../src/security/encryption.js");
    const secret = encryptJson({ smtpUsername: "crm@motm.example", smtpPassword: "app-password" }, "integration:email");
    await pool.query(
      `insert into public.integration_connections
         (workspace_id, id, provider, enabled, settings, secret_ciphertext, secret_iv, secret_tag, key_version,
          send_window_days, send_window_start, send_window_end, min_delay_seconds, max_delay_seconds)
       values ($1, 'email', 'smtp', true, $2, $3, $4, $5, $6, '{1,2,3,4,5,6,7}', '00:00', '23:59:59', 1, 1)`,
      [ws, { senderName: "MOTM Sales", senderAddress: "crm@motm.example", replyTo: "replies@motm.example", smtpHost: "smtp.motm.example", smtpPort: 465, smtpSecurity: "ssl" }, secret.ciphertext, secret.iv, secret.tag, secret.keyVersion],
    );
    await pool.query(`insert into public.email_imap_state (workspace_id, last_success_at) values ($1, now())`, [ws]);
    return ws;
  }

  /** An uploaded PDF asset in Storage. */
  async function asset(ws: string, title: string, channels: string[]) {
    const { supabaseAdmin } = await import("../../src/supabaseAdmin.js");
    const path = `${ws}/${randomUUID()}-case.pdf`;
    const { error } = await supabaseAdmin.storage.from("agent-assets").upload(path, PDF, { contentType: "application/pdf" });
    if (error) throw new Error(`upload failed: ${error.message}`);
    const row = await pool.query<{ id: string }>(
      `insert into public.agent_assets (workspace_id, title, use_when, channels, storage_path, file_name, mime_type, size_bytes)
       values ($1, $2, 'After a call with a steel trader', $3, $4, 'steel_case_v3.pdf', 'application/pdf', $5) returning id`,
      [ws, title, channels, path, PDF.length],
    );
    return { id: row.rows[0]!.id, path };
  }

  /**
   * A live-test contact that already got one real AI message (5 days ago); `replied` adds a matched WhatsApp reply after it.
   * E3b-1 channels alternate: the earlier message is on `prior` (default: email when replied, so WhatsApp is due; else
   * WhatsApp, so email is due); `emailOnly` leaves out the phone, so email is always the channel.
   */
  async function lead(ws: string, opts: { replied?: boolean; prior?: "email" | "whatsapp"; emailOnly?: boolean } = {}) {
    const phone = opts.emailOnly ? null : randomPhone();
    const prior = opts.prior ?? (opts.replied ? "email" : "whatsapp");
    const l = (
      await pool.query<{ id: string; email: string }>(
        `insert into public.leads (workspace_id, first_name, last_name, company, source, email, phone, phone_e164, owner_id, agent_status, agent_live_test, pipeline_stage)
         values ($1, 'Asha', 'Rao', 'Acme Steel', 'linkedin', $2, $3, $3, $4, 'active', true, 'connected_qualifying') returning id, email`,
        [ws, `assets-${randomUUID()}@example.com`, phone, adminId],
      )
    ).rows[0]!;
    await pool.query(
      `insert into public.agent_decisions (workspace_id, lead_id, mode, action, reasoning, message_body, outcome, send_status, sent_at, created_at)
       values ($1, $2, 'live', $3, 'First touch', 'Hi Asha, quick question about outbound.', 'sent', 'sent', now() - interval '5 days', now() - interval '5 days')`,
      [ws, l.id, `send_${prior}`],
    );
    if (opts.replied) {
      await pool.query(
        `insert into public.whatsapp_inbound_events (message_id, sender_jid, sender_phone_e164, message_type, received_at, disposition, match_count, workspace_id, lead_id)
         values ($1, $2, $3, 'conversation', now() - interval '4 days', 'matched', 1, $4, $5)`,
        [`IN-${randomUUID()}`, `${phone!.slice(1)}@s.whatsapp.net`, phone, ws, l.id],
      );
    }
    await pool.query(`insert into public.agent_wakeups (workspace_id, lead_id, due_at, reason) values ($1, $2, now() - interval '1 minute', 'enrolled')`, [ws, l.id]);
    return { ...l, phone };
  }

  async function tick(ws: string, decisions: AgentDecision[]) {
    const { runAgentTick } = await import("../../src/services/agentRunner.service.js");
    return runAgentTick(true, { model: createFakeDecisionModel({ decisions }), embedder: fakeEmbedder, prices: PRICES, defaultModels: MODELS, workspaceIds: [ws] });
  }

  function whatsapp(ws: string) {
    const socket = {
      user: { id: "919999999999:1@s.whatsapp.net" },
      fetchAccountReachoutTimelock: vi.fn(async () => null),
      fetchNewChatMessageCap: vi.fn(async () => null),
      onWhatsApp: vi.fn(async (number: string) => [{ exists: true, jid: `${number}@s.whatsapp.net` }]),
      sendMessage: vi.fn(async (_jid: string, content: { text?: string; caption?: string }) => ({ message: { conversation: content.text ?? content.caption ?? "" } })),
      sendPresenceUpdate: vi.fn(async (_type: string, _jid?: string) => undefined),
    };
    const m = new Manager(ws, async () => undefined);
    Object.assign(m as unknown as Record<string, unknown>, { socket, connected: true });
    const send: WhatsAppSender = (_ws, input) =>
      m.sendAction({ source: input.source, phoneE164: input.to, body: input.body, attachment: input.attachment, textMentionsAttachment: input.textMentionsAttachment });
    return { socket, send };
  }

  /** The send time is the runner's (local) clock; the claims compare with the database clock, which can lag by a second. */
  async function due(ws: string) {
    await pool.query(`update public.agent_decisions set send_next_at = now() - interval '1 second' where workspace_id = $1 and send_status = 'queued'`, [ws]);
    await pool.query(`update public.email_outbound_messages set next_attempt_at = now() - interval '1 second' where workspace_id = $1 and status = 'queued'`, [ws]);
  }

  async function sendTick(ws: string, send: WhatsAppSender) {
    await due(ws);
    const { runAgentSends } = await import("../../src/services/agentSends.service.js");
    return runAgentSends(true, { workspaceIds: [ws], send });
  }

  function fakeSmtp() {
    const sent: { attachments: { filename?: string; contentType?: string; size: number }[]; raw: string; text: string }[] = [];
    const builder = nodemailer.createTransport({ streamTransport: true, buffer: true });
    const transport: EmailTransport = {
      async sendMail(mail) {
        const info = await builder.sendMail(mail);
        const attachments = ((mail.attachments ?? []) as { filename?: string; contentType?: string; content: Buffer }[]).map((a) => ({
          filename: a.filename,
          contentType: a.contentType,
          size: a.content.length,
        }));
        sent.push({ attachments, raw: (info.message as Buffer).toString("utf8"), text: mail.text as string });
        return { messageId: info.messageId, response: "250 OK" };
      },
      verify: async () => true,
      close: () => undefined,
    };
    return { sent, cache: new TransportCache(() => transport) };
  }

  async function emailTick(ws: string, smtp: ReturnType<typeof fakeSmtp>, dryRun = false) {
    await due(ws);
    const { runEmailOutbound } = await import("../../src/services/emailOutbound.service.js");
    return runEmailOutbound({ workspaceIds: [ws], transports: smtp.cache, wait: async () => undefined, dryRun });
  }

  const decisionOf = async (leadId: string) =>
    (await pool.query(`select * from public.agent_decisions where lead_id = $1 order by created_at desc limit 1`, [leadId])).rows[0];
  const sentRow = async (leadId: string, title: string) =>
    (await pool.query<{ title: string; detail: string | null }>(`select title, detail from public.timeline_events where lead_id = $1 and title like $2`, [leadId, `${title}%`])).rows[0];

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    ({ BaileysManager: Manager } = await import("../../src/providers/baileys.manager.js"));
    ({ TransportCache } = await import("../../src/providers/email.provider.js"));
    const auth = await pool.query(`insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`, [`assets-admin-${randomUUID()}@example.com`]);
    adminId = auth.rows[0].id;
    await pool.query(`update public.profiles set role = 'admin', is_active = true, full_name = 'Govinda Rep' where id = $1`, [adminId]);
  });

  afterAll(async () => {
    await deleteCreatedTestWorkspaces(pool);
    await pool.query(`delete from auth.users where id = $1`, [adminId]).catch((error: Error) => console.warn(`[agentAssets] user cleanup failed: ${error.message}`));
    await pool.end();
  });

  it("live email with an asset: the email carries it (file name = title + extension, PDF MIME); the decision and timeline say so", async () => {
    const ws = await workspace("email");
    const a = await asset(ws, "Steel trading case study", ["email"]);
    const l = await lead(ws, { emailOnly: true });
    expect((await tick(ws, [emailWith([a.id])]))[0]).toMatchObject({ result: "executed", action: "send_email" });
    const d = await decisionOf(l.id);
    expect(d.asset_ids).toEqual([a.id]);
    const queued = (await pool.query(`select attachments from public.email_outbound_messages where source = 'agent' and source_id = $1`, [d.id])).rows[0];
    expect(queued.attachments).toEqual([
      { bucket: "agent-assets", path: a.path, fileName: "Steel trading case study.pdf", mimeType: "application/pdf", size: PDF.length, assetId: a.id, title: "Steel trading case study" },
    ]);

    const smtp = fakeSmtp();
    await emailTick(ws, smtp);
    expect(smtp.sent).toHaveLength(1);
    expect(smtp.sent[0]!.attachments).toEqual([{ filename: "Steel trading case study.pdf", contentType: "application/pdf", size: PDF.length }]);
    expect(smtp.sent[0]!.raw).toMatch(/Content-Type: application\/pdf; name="Steel trading case study\.pdf"/);
    expect(smtp.sent[0]!.text).toContain(ATTACH_LINE);
    expect(await decisionOf(l.id)).toMatchObject({ send_status: "sent", sent_asset_ids: [a.id], attachment_issues: null });
    expect(await sentRow(l.id, "AI sent email")).toEqual({ title: "AI sent email: Outbound for Acme Steel", detail: "With attachment: Steel trading case study" });

    // Rule 4: the same asset is never attached again.
    await pool.query(`update public.agent_wakeups set status = 'cancelled' where lead_id = $1 and status = 'pending'`, [l.id]);
    await pool.query(`insert into public.agent_wakeups (workspace_id, lead_id, due_at, reason) values ($1, $2, now() - interval '1 minute', 'enrolled')`, [ws, l.id]);
    await pool.query(`update public.leads set agent_last_touch_at = now() - interval '3 days' where id = $1`, [l.id]);
    await pool.query(`update public.agent_decisions set sent_at = now() - interval '3 days' where id = $1`, [d.id]);
    await tick(ws, [emailWith([a.id], PLAIN_LINE)]);
    const again = await decisionOf(l.id);
    expect(again.asset_ids).toEqual([]);
    expect(again.quality_checks.at(-1).attachmentsRemoved).toEqual([{ assetId: a.id, reason: "already_sent", title: "Steel trading case study" }]);
  });

  it("WhatsApp after the contact replied: one message, the document with the text as caption", async () => {
    const ws = await workspace("wa");
    const a = await asset(ws, "Steel trading case study", ["email", "whatsapp"]);
    const l = await lead(ws, { replied: true });
    expect((await tick(ws, [whatsappWith([a.id])]))[0]).toMatchObject({ result: "executed", action: "send_whatsapp" });
    const d = await decisionOf(l.id);
    expect(d.asset_ids).toEqual([a.id]);

    const { socket, send } = whatsapp(ws);
    expect(await sendTick(ws, send)).toEqual([{ id: d.id, result: "sent" }]);
    expect(socket.sendMessage).toHaveBeenCalledTimes(1);
    const content = socket.sendMessage.mock.calls[0]![1] as unknown as { document: Buffer; fileName: string; mimetype: string; caption: string };
    expect(content.fileName).toBe("Steel trading case study.pdf");
    expect(content.mimetype).toBe("application/pdf");
    expect(content.document.equals(PDF)).toBe(true);
    expect(content.caption).toContain(ATTACH_LINE);
    expect(await decisionOf(l.id)).toMatchObject({ send_status: "sent", sent_asset_ids: [a.id] });
    expect(await sentRow(l.id, "AI sent WhatsApp")).toEqual({ title: "AI sent WhatsApp", detail: "With attachment: Steel trading case study" });
  });

  it("WhatsApp before the contact replied: the attachment is dropped (recorded), the text still goes", async () => {
    const ws = await workspace("wa-noreply");
    const a = await asset(ws, "Steel trading case study", ["email", "whatsapp"]);
    const l = await lead(ws, { prior: "email" });
    await tick(ws, [whatsappWith([a.id], PLAIN_LINE)]);
    const d = await decisionOf(l.id);
    expect(d).toMatchObject({ action: "send_whatsapp", asset_ids: [], send_status: "queued" });
    expect(d.quality_checks.at(-1).attachmentsRemoved).toEqual([{ assetId: a.id, reason: "whatsapp_no_reply", title: "Steel trading case study" }]);

    const { socket, send } = whatsapp(ws);
    await sendTick(ws, send);
    const content = socket.sendMessage.mock.calls[0]![1] as { text?: string; document?: Buffer };
    expect(content.document).toBeUndefined();
    expect(content.text).toContain("Hi Asha");
    expect(await decisionOf(l.id)).toMatchObject({ send_status: "sent", sent_asset_ids: null });
  });

  it("a file deleted at send time, text not mentioning it: the email and the WhatsApp go without it, and it is recorded", async () => {
    const ws = await workspace("deleted");
    const { supabaseAdmin } = await import("../../src/supabaseAdmin.js");

    // Email: the Storage object is gone (the asset row is still there).
    const emailAsset = await asset(ws, "Steel trading case study", ["email"]);
    const e = await lead(ws);
    await tick(ws, [emailWith([emailAsset.id], PLAIN_LINE)]);
    await supabaseAdmin.storage.from("agent-assets").remove([emailAsset.path]);
    const smtp = fakeSmtp();
    await emailTick(ws, smtp);
    expect(smtp.sent).toHaveLength(1);
    expect(smtp.sent[0]!.attachments).toEqual([]);
    const emailDecision = await decisionOf(e.id);
    expect(emailDecision).toMatchObject({ send_status: "sent", sent_asset_ids: null });
    expect(emailDecision.attachment_issues).toEqual([
      { assetId: emailAsset.id, title: "Steel trading case study", reason: 'The file "Steel trading case study.pdf" is missing from storage.' },
    ]);
    expect((await sentRow(e.id, "AI sent email"))!.detail).toBe('Attachment not sent: Steel trading case study (The file "Steel trading case study.pdf" is missing from storage.)');

    // WhatsApp: the admin deleted the asset (row and file) after the decision.
    const waAsset = await asset(ws, "EPC case study", ["whatsapp"]);
    const w = await lead(ws, { replied: true });
    await tick(ws, [whatsappWith([waAsset.id], PLAIN_LINE)]);
    await pool.query(`delete from public.agent_assets where id = $1`, [waAsset.id]);
    await supabaseAdmin.storage.from("agent-assets").remove([waAsset.path]);
    const { socket, send } = whatsapp(ws);
    await sendTick(ws, send);
    expect((socket.sendMessage.mock.calls[0]![1] as { document?: Buffer }).document).toBeUndefined();
    const waDecision = await decisionOf(w.id);
    expect(waDecision).toMatchObject({ send_status: "sent", sent_asset_ids: null });
    expect(waDecision.attachment_issues).toEqual([{ assetId: waAsset.id, title: null, reason: "The asset was deleted or turned off before sending." }]);
  });

  const removeFile = async (path: string) => {
    const { supabaseAdmin } = await import("../../src/supabaseAdmin.js");
    await supabaseAdmin.storage.from("agent-assets").remove([path]);
  };
  const touches = async (leadId: string) => (await pool.query(`select agent_touch_count from public.leads where id = $1`, [leadId])).rows[0].agent_touch_count;
  const wakeNow = async (leadId: string) =>
    (await pool.query(`select count(*)::int as n from public.agent_wakeups where lead_id = $1 and status = 'pending' and due_at <= now() + interval '1 minute'`, [leadId])).rows[0].n;

  it("E2h email: file deleted, text mentions it → cancelled attachment_missing, no touch, a new wake-up; the asset isn't offered again", async () => {
    const ws = await workspace("mention-email");
    const a = await asset(ws, "Steel trading case study", ["email"]);
    const l = await lead(ws);
    await tick(ws, [emailWith([a.id])]);
    await removeFile(a.path);
    const smtp = fakeSmtp();
    await emailTick(ws, smtp);
    expect(smtp.sent).toHaveLength(0);
    const d = await decisionOf(l.id);
    expect(d).toMatchObject({ send_status: "cancelled", cancel_reason: "attachment_missing", sent_at: null, sent_asset_ids: null });
    expect(d.attachment_issues).toEqual([{ assetId: a.id, title: "Steel trading case study", reason: 'The file "Steel trading case study.pdf" is missing from storage.' }]);
    expect(d.outcome).not.toBe("sent");
    expect(await touches(l.id)).toBe(0);
    expect(await sentRow(l.id, "AI sent email")).toBeUndefined();
    expect(await wakeNow(l.id)).toBe(1);
    expect((await pool.query(`select status from public.email_outbound_messages where source_id = $1`, [d.id])).rows[0].status).toBe("cancelled");

    // The fresh decision can't pick the broken asset again: unknown asset → regenerated, the clean text is queued.
    await pool.query(`update public.agent_wakeups set due_at = now() - interval '1 minute' where lead_id = $1 and status = 'pending'`, [l.id]);
    await tick(ws, [emailWith([a.id]), emailWith([], PLAIN_LINE)]);
    const fresh = await decisionOf(l.id);
    expect(fresh.id).not.toBe(d.id);
    expect(fresh).toMatchObject({ send_status: "queued", asset_ids: [], regenerated: true });
  });

  it("E2h WhatsApp after a reply, file missing: text mentions it → cancelled + wake-up; text doesn't → sent without it, recorded", async () => {
    const ws = await workspace("mention-wa");
    const a = await asset(ws, "Steel trading case study", ["whatsapp"]);
    const mention = await lead(ws, { replied: true });
    await tick(ws, [whatsappWith([a.id])]);
    await removeFile(a.path);
    const first = whatsapp(ws);
    await sendTick(ws, first.send);
    expect(first.socket.sendMessage).not.toHaveBeenCalled();
    const d = await decisionOf(mention.id);
    expect(d).toMatchObject({ send_status: "cancelled", cancel_reason: "attachment_missing", sent_at: null });
    expect(d.attachment_issues).toEqual([{ assetId: a.id, title: "Steel trading case study", reason: "The file was missing from storage." }]);
    expect(await touches(mention.id)).toBe(0);
    expect(await wakeNow(mention.id)).toBe(1);

    const b = await asset(ws, "EPC case study", ["whatsapp"]);
    const plain = await lead(ws, { replied: true });
    await pool.query(`update public.agent_wakeups set status = 'cancelled' where lead_id = $1`, [mention.id]);
    await tick(ws, [whatsappWith([b.id], PLAIN_LINE)]);
    await removeFile(b.path);
    await pool.query(`update public.whatsapp_connection set next_send_at = null where workspace_id = $1`, [ws]);
    const second = whatsapp(ws);
    await sendTick(ws, second.send);
    const content = second.socket.sendMessage.mock.calls[0]![1] as { text?: string; document?: Buffer };
    expect(content.document).toBeUndefined();
    expect(content.text).toContain("Hi Asha");
    const sent = await decisionOf(plain.id);
    expect(sent).toMatchObject({ send_status: "sent", sent_asset_ids: null });
    expect(sent.attachment_issues).toEqual([{ assetId: b.id, title: "EPC case study", reason: "The file was missing from storage." }]);
  });

  it("E2h: asset turned off, text mentions it: both channels cancel", async () => {
    const ws = await workspace("mention-off");
    const a = await asset(ws, "Steel trading case study", ["email", "whatsapp"]);
    const e = await lead(ws);
    const w = await lead(ws, { replied: true });
    await pool.query(`update public.agent_wakeups set status = 'cancelled' where lead_id = $1`, [w.id]);
    await tick(ws, [emailWith([a.id])]);
    await pool.query(`update public.agent_wakeups set due_at = now() + interval '30 days' where lead_id = $1 and status = 'pending'`, [e.id]);
    await pool.query(`insert into public.agent_wakeups (workspace_id, lead_id, due_at, reason) values ($1, $2, now() - interval '1 minute', 'enrolled')`, [ws, w.id]);
    await tick(ws, [whatsappWith([a.id])]);
    await pool.query(`update public.agent_assets set is_active = false where id = $1`, [a.id]);
    const smtp = fakeSmtp();
    await emailTick(ws, smtp);
    await sendTick(ws, whatsapp(ws).send);
    expect(smtp.sent).toHaveLength(0);
    expect(await decisionOf(e.id)).toMatchObject({ send_status: "cancelled", cancel_reason: "attachment_missing" });
    expect(await decisionOf(w.id)).toMatchObject({ send_status: "cancelled", cancel_reason: "attachment_missing" });
  });

  it("E2h rule 3: an unknown size is read from Storage at decision time; a file over 10 MB is dropped", async () => {
    const { supabaseAdmin } = await import("../../src/supabaseAdmin.js");
    const ws = await workspace("size-decide");
    const a = await asset(ws, "Steel trading case study", ["email"]);
    await supabaseAdmin.storage.from("agent-assets").upload(a.path, Buffer.alloc(OVER_LIMIT), { upsert: true, contentType: "application/pdf" });
    await pool.query(`update public.agent_assets set size_bytes = null where id = $1`, [a.id]);
    const { assetFileSize } = await import("../../src/services/knowledgeLibrary.service.js");
    expect(await assetFileSize(a.path)).toBe(OVER_LIMIT);
    expect(await assetFileSize(`${ws}/no-such-file.pdf`)).toBeNull();
    const l = await lead(ws);
    await tick(ws, [emailWith([a.id], PLAIN_LINE)]);
    const d = await decisionOf(l.id);
    expect(d.asset_ids).toEqual([]);
    expect(d.quality_checks.at(-1).attachmentsRemoved).toEqual([{ assetId: a.id, reason: "size_limit", title: "Steel trading case study" }]);
  });

  it("E2h rule 3: a file that grew past 10 MB after the decision follows rule 2 on both channels, and the email never fails", async () => {
    const { supabaseAdmin } = await import("../../src/supabaseAdmin.js");
    const ws = await workspace("size-send");
    const grow = (path: string) => supabaseAdmin.storage.from("agent-assets").upload(path, Buffer.alloc(OVER_LIMIT), { upsert: true, contentType: "application/pdf" });

    // Email, text mentions it → cancelled.
    const a = await asset(ws, "Steel trading case study", ["email"]);
    const e = await lead(ws);
    await tick(ws, [emailWith([a.id])]);
    await pool.query(`update public.email_outbound_messages set attachments = jsonb_set(attachments, '{0,size}', 'null') where lead_id = $1`, [e.id]);
    await grow(a.path);
    const smtp = fakeSmtp();
    await emailTick(ws, smtp);
    expect(smtp.sent).toHaveLength(0);
    const cancelled = await decisionOf(e.id);
    expect(cancelled).toMatchObject({ send_status: "cancelled", cancel_reason: "attachment_missing" });
    expect(cancelled.attachment_issues[0].reason).toBe("The file is over the 10 MB limit.");

    // Email, text doesn't mention it → sent without it, recorded.
    const b = await asset(ws, "EPC case study", ["email"]);
    const quiet = await lead(ws);
    await tick(ws, [emailWith([b.id], PLAIN_LINE)]);
    await grow(b.path);
    await pool.query(`update public.integration_connections set next_send_at = null where workspace_id = $1 and id = 'email'`, [ws]);
    await emailTick(ws, smtp);
    expect(smtp.sent).toHaveLength(1);
    expect(smtp.sent[0]!.attachments).toEqual([]);
    const sent = await decisionOf(quiet.id);
    expect(sent).toMatchObject({ send_status: "sent", sent_asset_ids: null });
    expect(sent.attachment_issues[0].reason).toBe("The file is over the 10 MB limit.");

    // WhatsApp, text mentions it → cancelled.
    const c = await asset(ws, "Trading case study", ["whatsapp"]);
    const w = await lead(ws, { replied: true });
    await tick(ws, [whatsappWith([c.id])]);
    await grow(c.path);
    const { socket, send } = whatsapp(ws);
    await sendTick(ws, send);
    expect(socket.sendMessage).not.toHaveBeenCalled();
    expect(await decisionOf(w.id)).toMatchObject({ send_status: "cancelled", cancel_reason: "attachment_missing" });
  }, 90_000); // Uploads a real file over 10 MB to Storage.

  it("createAsset stores the real file size", async () => {
    const ws = await workspace("upload");
    const { createAsset, deleteAsset } = await import("../../src/services/knowledgeLibrary.service.js");
    const actor = { id: adminId, fullName: "Govinda Rep", email: "assets-admin@example.com" } as Parameters<typeof createAsset>[0];
    const created = await createAsset(actor, ws, {
      title: "Upload size",
      useWhen: "Test",
      tags: [],
      channels: ["email"],
      file: { buffer: PDF, originalName: "case.pdf", mimeType: "application/pdf", size: PDF.length },
    });
    expect(created.sizeBytes).toBe(PDF.length);
    await deleteAsset(actor, ws, created.id);
  });

  it("WORKER_DRY_RUN: recorded as a dry run with its asset, nothing sent", async () => {
    const ws = await workspace("dry");
    const a = await asset(ws, "Steel trading case study", ["email"]);
    const l = await lead(ws);
    await tick(ws, [emailWith([a.id])]);
    const smtp = fakeSmtp();
    await emailTick(ws, smtp, true);
    expect(smtp.sent).toHaveLength(0);
    expect(await decisionOf(l.id)).toMatchObject({ send_status: "dry_run", asset_ids: [a.id], sent_asset_ids: null });
  });

  it("the decision detail and the contact's AI panel show the attachments by title", async () => {
    const ws = await workspace("visible");
    const a = await asset(ws, "Steel trading case study", ["email", "whatsapp"]);
    const l = await lead(ws, { prior: "email" });
    await tick(ws, [whatsappWith([a.id], PLAIN_LINE)]);
    const { getDecision, getLeadAgentPanel } = await import("../../src/services/agentReview.service.js");
    const d = await decisionOf(l.id);
    const detail = await getDecision(pool, ws, d.id);
    expect(detail.attachments).toEqual({
      assets: [],
      removed: [{ assetId: a.id, reason: "whatsapp_no_reply", title: "Steel trading case study" }],
      issues: [],
    });
    const panel = await getLeadAgentPanel(pool, ws, l.id);
    expect((panel.decisions[0] as { attachments: unknown }).attachments).toEqual(detail.attachments);
  });
});
