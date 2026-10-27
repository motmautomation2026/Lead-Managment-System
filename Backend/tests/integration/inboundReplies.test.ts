/**
 * D2: GET /contacts/:id/replies/:messageId (owner + admins, audited, no-store) and the
 * contact timeline's `reply` field. Replies arrive through the real processInboundUpsert,
 * so the text is encrypted with the real encryptText. Nothing is sent.
 * Skipped unless TEST_DATABASE_URL is set; [test] workspaces only.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { createTestWorkspace, deleteCreatedTestWorkspaces } from "../helpers/testWorkspaces.js";
import { startTestApi, type TestApi } from "../helpers/testApi.js";
import type { Actor } from "../../src/authMiddleware.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb("inbound reply text (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let api: TestApi;
  let owner: Actor;
  let admin: Actor;
  let otherRep: Actor;
  let ws: string;
  let otherWs: string;
  let leadA: string;
  let leadB: string;
  const secret = `D2 secret reply ${randomUUID()}`;
  const msg: Record<string, string> = {};
  const logged: string[] = [];

  const randomPhone = () => `+9196${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;

  async function newLead(phone: string) {
    const result = await pool.query(
      `insert into public.leads (workspace_id, first_name, company, source, email, phone, phone_e164, owner_id)
       values ($1, 'Replier', 'Reply Co', 'referral', $2, $3, $3, $4) returning id`,
      [ws, `d2-${randomUUID()}@example.com`, phone, owner.id],
    );
    return result.rows[0].id as string;
  }

  async function inbound(phone: string, message: Record<string, unknown>) {
    const { processInboundUpsert } = await import("../../src/services/whatsapp-inbound.service.js");
    const id = `d2-${randomUUID()}`;
    await processInboundUpsert(ws, {
      type: "notify",
      messages: [{ key: { id, remoteJid: `${phone.slice(1)}@s.whatsapp.net`, fromMe: false }, message, messageTimestamp: Math.floor(Date.now() / 1000) }],
    } as never);
    return id;
  }

  const read = (as: Actor, lead: string, messageId: string, workspace = ws) => api.call(as, workspace, "GET", `/contacts/${lead}/replies/${messageId}`);
  const views = async (messageId: string) =>
    (await pool.query(`select lead_id, viewer_id, outcome from public.inbound_message_views where message_id = $1 order by viewed_at`, [messageId])).rows;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
    api = await startTestApi(pool, "inbound-replies");
    owner = await api.newUser("salesperson", { name: "D2 Owner" });
    admin = await api.newUser("admin", { name: "D2 Admin" });
    otherRep = await api.newUser("salesperson", { name: "D2 Other" });
    ws = await createTestWorkspace(pool, "inbound-replies");
    otherWs = await createTestWorkspace(pool, "inbound-replies-other");
    const phoneA = randomPhone();
    leadA = await newLead(phoneA);
    leadB = await newLead(randomPhone());
    msg.text = await inbound(phoneA, { conversation: secret });
    msg.long = await inbound(phoneA, { conversation: "x".repeat(4100) });
    msg.sticker = await inbound(phoneA, { stickerMessage: {} });
    msg.broken = await inbound(phoneA, { conversation: `${secret} (broken)` });
    await pool.query(`update public.whatsapp_inbound_events set body_ciphertext = $2 where message_id = $1`, [msg.broken, Buffer.from("not the real ciphertext")]);
    const phoneB = (await pool.query(`select phone_e164 from public.leads where id = $1`, [leadB])).rows[0].phone_e164;
    msg.ofB = await inbound(phoneB, { conversation: "B's reply" });

    // Everything the code under test logs from here on.
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      });
    }
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await deleteCreatedTestWorkspaces(pool);
    await api.close();
    await pool.end();
  });

  it("the owner reads the text once per request, no-store, with one shown audit row", async () => {
    const res = await read(owner, leadA, msg.text!);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.body).toMatchObject({ messageId: msg.text, text: secret, truncated: false });
    expect(typeof res.body.receivedAt).toBe("string");
    expect(await views(msg.text!)).toEqual([{ lead_id: leadA, viewer_id: owner.id, outcome: "shown" }]);
  });

  it("an admin reads it; another salesperson gets 403 and a denied audit row", async () => {
    const asAdmin = await read(admin, leadA, msg.text!);
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body.text).toBe(secret);

    const denied = await read(otherRep, leadA, msg.text!);
    expect(denied.status).toBe(403);
    expect(denied.headers.get("cache-control")).toBe("no-store");
    expect(denied.body.error.message).toBe("Only the contact owner and admins can read replies.");
    expect(JSON.stringify(denied.body)).not.toContain(secret);
    expect((await views(msg.text!)).map((v) => [v.viewer_id, v.outcome])).toEqual([
      [owner.id, "shown"],
      [admin.id, "shown"],
      [otherRep.id, "denied"],
    ]);
  });

  it("404 for another workspace, another contact's reply or an unknown id (not audited)", async () => {
    expect((await read(owner, leadA, msg.text!, otherWs)).status).toBe(404);
    expect((await read(owner, leadA, msg.ofB!)).status).toBe(404);
    expect((await read(owner, leadB, msg.text!)).status).toBe(404);
    expect((await read(owner, leadA, "no-such-message")).status).toBe(404);
    expect((await read(owner, randomUUID(), msg.text!)).status).toBe(404);
    expect(await views(msg.ofB!)).toEqual([]);
  });

  it("no stored text → not_stored; truncated flag; unreadable without any text", async () => {
    const none = await read(owner, leadA, msg.sticker!);
    expect(none.status).toBe(200);
    expect(none.body).toMatchObject({ text: null, reason: "not_stored" });
    expect((await views(msg.sticker!)).map((v) => v.outcome)).toEqual(["no_text"]);

    const long = await read(owner, leadA, msg.long!);
    expect(long.body.truncated).toBe(true);
    expect(long.body.text).toHaveLength(4000);

    const broken = await read(owner, leadA, msg.broken!);
    expect(broken.status).toBe(200);
    expect(broken.body).toMatchObject({ text: null, reason: "unreadable" });
    expect(JSON.stringify(broken.body)).not.toContain(secret);
    expect((await views(msg.broken!)).map((v) => v.outcome)).toEqual(["decrypt_failed"]);
  });

  it("timeline rows carry reply {messageId, hasText, canRead} and never the text", async () => {
    const own = await api.call(owner, ws, "GET", `/contacts/${leadA}/timeline?limit=100`);
    expect(own.status).toBe(200);
    expect(JSON.stringify(own.body)).not.toContain(secret);
    const replies = (own.body.data as { reply?: { messageId: string; hasText: boolean; canRead: boolean } }[]).flatMap((r) => (r.reply ? [r.reply] : []));
    expect(replies).toHaveLength(4);
    expect(replies.find((r) => r.messageId === msg.text)).toEqual({ messageId: msg.text, hasText: true, canRead: true });
    expect(replies.find((r) => r.messageId === msg.sticker)).toEqual({ messageId: msg.sticker, hasText: false, canRead: true });

    const other = await api.call(otherRep, ws, "GET", `/contacts/${leadA}/timeline?limit=100`);
    expect(JSON.stringify(other.body)).not.toContain(secret);
    expect((other.body.data as { reply?: { canRead: boolean } }[]).filter((r) => r.reply).every((r) => r.reply!.canRead === false)).toBe(true);
    const asAdmin = await api.call(admin, ws, "GET", `/contacts/${leadA}/timeline?kind=messages`);
    expect((asAdmin.body.data as { reply?: { canRead: boolean } }[]).filter((r) => r.reply).every((r) => r.reply!.canRead)).toBe(true);
  });

  it("nothing logged during these reads contains the plaintext", () => {
    expect(logged.some((line) => line.includes("could not decrypt inbound message"))).toBe(true);
    expect(logged.filter((line) => line.includes("D2 secret reply"))).toEqual([]);
  });
});
