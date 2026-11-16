/**
 * Feature 4A: inbound WhatsApp replies store the text encrypted (matched leads
 * only), hand an AI-enrolled lead off and give its owner one agent task.
 * Calls processInboundUpsert directly; nothing is sent. Skipped unless
 * TEST_DATABASE_URL is set; uses fresh [test] workspaces.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createTestWorkspace, deleteCreatedTestWorkspaces } from "../helpers/testWorkspaces.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb("inbound WhatsApp reply logging and AI handoff (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let ws: string;
  let ownerId: string;

  const randomPhone = () => `+9197${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;

  async function newLead(phoneE164: string, agentStatus = "none", ownerless = false) {
    const result = await pool.query(
      `insert into public.leads (workspace_id, first_name, company, source, email, phone, phone_e164, owner_id)
       values ($1, 'Reply', 'Reply Co', 'referral', $2, $3, $3, $4) returning id`,
      [ws, `wa4a-${randomUUID()}@example.com`, phoneE164, ownerless ? null : ownerId],
    );
    const id = result.rows[0].id as string;
    if (agentStatus !== "none") {
      await pool.query(`update public.leads set agent_status = $2, agent_status_reason = 'admin_enroll' where id = $1`, [id, agentStatus]);
      await pool.query(
        `insert into public.agent_wakeups (workspace_id, lead_id, reason, due_at) values ($1, $2, 'enrolled', now() + interval '1 hour')`,
        [ws, id],
      );
    }
    return id;
  }

  async function inbound(phoneE164: string, message: Record<string, unknown>, messageId = `wa4a-${randomUUID()}`) {
    const { processInboundUpsert } = await import("../../src/services/whatsapp-inbound.service.js");
    await processInboundUpsert(ws, {
      type: "notify",
      messages: [
        {
          key: { id: messageId, remoteJid: `${phoneE164.slice(1)}@s.whatsapp.net`, fromMe: false },
          message,
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ],
    } as never);
    return messageId;
  }

  const event = async (messageId: string) =>
    (
      await pool.query(
        `select disposition, message_type, body_ciphertext, body_iv, body_tag, body_key_version, body_truncated
           from public.whatsapp_inbound_events where message_id = $1`,
        [messageId],
      )
    ).rows[0];

  async function body(messageId: string) {
    const row = await event(messageId);
    if (!row.body_ciphertext) return null;
    const { decryptText } = await import("../../src/security/encryption.js");
    return decryptText({ ciphertext: row.body_ciphertext, iv: row.body_iv, tag: row.body_tag, keyVersion: row.body_key_version }, `whatsapp:inbound:${messageId}`);
  }

  const agentTasks = async (leadId: string) =>
    (await pool.query(`select owner_id, title, status, task_type, due_at, created_by_name from public.tasks where lead_id = $1 and origin = 'agent'`, [leadId])).rows;
  const pendingWakeups = async (leadId: string) =>
    (await pool.query(`select 1 from public.agent_wakeups where lead_id = $1 and status = 'pending'`, [leadId])).rowCount;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    const auth = await pool.query(`insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`, [`wa4a-${randomUUID()}@example.com`]);
    ownerId = auth.rows[0].id;
    await pool.query(`update public.profiles set is_active = true, full_name = 'WA4A Owner' where id = $1`, [ownerId]);
    ws = randomUUID();
    await createTestWorkspace(pool, "wa4a", { id: ws });
    await pool.query(`update public.agent_settings set mode = 'shadow' where workspace_id = $1`, [ws]);
  });

  afterAll(async () => {
    await deleteCreatedTestWorkspaces(pool);
    await pool.query(`delete from auth.users where id = $1`, [ownerId]).catch((error: Error) => console.warn(`[whatsappInbound] test user not deleted: ${error.message}`));
    await pool.end();
  });

  it("a reply from an AI-enrolled lead: body stored encrypted, handed off, wakeups cancelled, one owner task; a second reply adds no task", async () => {
    const phone = randomPhone();
    const leadId = await newLead(phone, "active");
    const text = "Haan ji, kal 11 baje call kar lo 🙏";
    const first = await inbound(phone, { conversation: text });

    const row = await event(first);
    expect(row.disposition).toBe("matched");
    expect(Buffer.from(row.body_ciphertext).toString("utf8")).not.toContain("call kar lo");
    expect(await body(first)).toBe(text);
    expect(row.body_truncated).toBe(false);
    expect((await pool.query(`select agent_status from public.leads where id = $1`, [leadId])).rows[0].agent_status).toBe("handed_off");
    expect(await pendingWakeups(leadId)).toBe(0);

    const tasks = await agentTasks(leadId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ owner_id: ownerId, title: "Lead replied on WhatsApp — respond today", status: "open", task_type: "follow_up", created_by_name: "AI Agent" });
    // 23:59 IST today = 18:29 UTC.
    expect(tasks[0].due_at.getUTCHours() * 60 + tasks[0].due_at.getUTCMinutes()).toBe(18 * 60 + 29);
    expect(tasks[0].due_at.getTime()).toBeGreaterThan(Date.now());

    const second = await inbound(phone, { extendedTextMessage: { text: "Also send the brochure" } });
    expect(await body(second)).toBe("Also send the brochure");
    expect(await agentTasks(leadId)).toHaveLength(1);
  });

  it("a paused lead also gets the task; LL-1: an ownerless one gets an unowned task", async () => {
    const phone = randomPhone();
    const paused = await newLead(phone, "paused");
    await inbound(phone, { conversation: "ok" });
    expect(await agentTasks(paused)).toHaveLength(1);

    const phone2 = randomPhone();
    const ownerless = await newLead(phone2, "active", true);
    await inbound(phone2, { conversation: "ok" });
    expect(await agentTasks(ownerless)).toMatchObject([{ owner_id: null, title: "Lead replied on WhatsApp — respond today", status: "open" }]);
  });

  it("a reply from a lead not in the AI: body stored; LL-1: it gets the reply task too", async () => {
    const phone = randomPhone();
    const leadId = await newLead(phone);
    const id = await inbound(phone, { conversation: "Who is this?" });
    expect(await body(id)).toBe("Who is this?");
    expect(await agentTasks(leadId)).toMatchObject([{ title: "Lead replied on WhatsApp — respond today", status: "open" }]);
    expect((await pool.query(`select agent_status, response_state from public.leads where id = $1`, [leadId])).rows[0]).toEqual({
      agent_status: "none",
      response_state: "responded",
    });
  });

  it("an image caption is stored; an audio message stores no body but is still recorded", async () => {
    const phone = randomPhone();
    await newLead(phone);
    const image = await inbound(phone, { imageMessage: { caption: "Our current setup" } });
    expect(await body(image)).toBe("Our current setup");
    const audio = await inbound(phone, { audioMessage: { seconds: 7 } });
    const row = await event(audio);
    expect(row).toMatchObject({ disposition: "matched", message_type: "audioMessage", body_ciphertext: null, body_key_version: null, body_truncated: false });
  });

  it("unmatched and ambiguous senders: no body stored", async () => {
    const unmatched = await inbound(randomPhone(), { conversation: "wrong number?" });
    expect(await event(unmatched)).toMatchObject({ disposition: "unmatched", body_ciphertext: null });

    const shared = randomPhone();
    const a = await newLead(shared, "active");
    const b = await newLead(shared, "active");
    const ambiguous = await inbound(shared, { conversation: "hello" });
    expect(await event(ambiguous)).toMatchObject({ disposition: "ambiguous", body_ciphertext: null });
    expect(await agentTasks(a)).toHaveLength(0);
    expect(await agentTasks(b)).toHaveLength(0);
  });

  it("a long reply is stored truncated; a duplicate message_id is skipped", async () => {
    const phone = randomPhone();
    const leadId = await newLead(phone);
    const id = await inbound(phone, { conversation: "x".repeat(4_100) });
    expect((await body(id))!.length).toBe(4_000);
    expect((await event(id)).body_truncated).toBe(true);

    const timelineCount = async () => (await pool.query(`select count(*)::int as n from public.timeline_events where lead_id = $1`, [leadId])).rows[0].n;
    const before = await timelineCount();
    await inbound(phone, { conversation: "different text" }, id);
    expect(await body(id)).toBe("x".repeat(4_000));
    expect(await timelineCount()).toBe(before);
  });
});
