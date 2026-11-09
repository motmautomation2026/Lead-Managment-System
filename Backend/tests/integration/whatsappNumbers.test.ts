/**
 * E4a: several WhatsApp numbers per workspace on the real send path — sendWhatsApp picks the
 * lead's sticky number (rule 4 when it has none) and that number's manager sends. The registry
 * holds BaileysManagers with fake sockets (never a real WhatsApp connection); inbound replies go
 * through the real processInboundUpsert with the number they arrived on. One `[test]` workspace
 * per scenario. Skipped unless TEST_DATABASE_URL is set.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { addTestMember, createTestWorkspace, deleteCreatedTestWorkspaces } from "../helpers/testWorkspaces.js";
import { connectedNumber } from "../helpers/whatsappNumbers.js";
import type { BaileysManager } from "../../src/providers/baileys.manager.js";
import { PermanentProviderError, ProviderDeferredError } from "../../src/providers/provider-errors.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb("E4a several WhatsApp numbers (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let Manager: typeof BaileysManager;
  let registryManagers: Map<string, BaileysManager>;
  let sendWhatsApp: typeof import("../../src/providers/whatsapp.provider.js").sendWhatsApp;

  const randomPhone = () => `+9197${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;

  function fakeSocket() {
    return {
      user: { id: "919999999999:1@s.whatsapp.net" },
      fetchAccountReachoutTimelock: vi.fn(async () => null),
      fetchNewChatMessageCap: vi.fn(async () => null),
      onWhatsApp: vi.fn(async (number: string) => [{ exists: true, jid: `${number}@s.whatsapp.net` }]),
      sendMessage: vi.fn(async (_jid: string, content: { text?: string }) => ({ message: { conversation: content.text ?? "" } })),
      sendPresenceUpdate: vi.fn(async (_type: string, _jid?: string) => undefined),
    };
  }

  /** A workspace with numbers A (#1) and B (#2), both connected, each with a fake-socket manager in the registry. */
  async function workspace(label: string, settingsB: Record<string, unknown> = {}) {
    const ws = await createTestWorkspace(pool, `e4a-${label}`);
    const a = await connectedNumber(pool, ws, {}, "#1");
    const b = await connectedNumber(pool, ws, settingsB, "#2");
    const sockets = { a: fakeSocket(), b: fakeSocket() };
    for (const [id, socket] of [[a, sockets.a], [b, sockets.b]] as const) {
      const m = new Manager(ws, id, async () => undefined);
      Object.assign(m as unknown as Record<string, unknown>, { socket, connected: true });
      registryManagers.set(id, m);
    }
    return { ws, a, b, sockets };
  }

  async function lead(ws: string, owner: string | null = null) {
    const phone = randomPhone();
    const id = (
      await pool.query<{ id: string }>(
        `insert into public.leads (workspace_id, first_name, company, source, email, phone, phone_e164, owner_id)
         values ($1, 'Ira', 'Ira Pvt Ltd', 'referral', $2, $3, $3, $4) returning id`,
        [ws, `ira-${randomUUID()}@example.com`, phone, owner],
      )
    ).rows[0]!.id;
    return { id, phone };
  }

  /** A rep's proposal WhatsApp send through sendWhatsApp (number picked by the lead's sticky rule). */
  async function proposalSend(ws: string, l: { id: string; phone: string }) {
    const proposal = await pool.query<{ id: string }>(
      `insert into public.proposals (workspace_id, lead_id, title, whatsapp_send_status) values ($1, $2, 'E4a', 'sending') returning id`,
      [ws, l.id],
    );
    // Spacing is per number; these scenarios are about which number, not about timing.
    await pool.query(`update public.whatsapp_numbers set next_send_at = null where workspace_id = $1`, [ws]);
    return sendWhatsApp(ws, { source: { type: "proposal", id: proposal.rows[0]!.id }, to: l.phone, body: "Your proposal" }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error: error as Error }),
    );
  }

  /** `count` messages already sent today on a number (fillers on proposals of a filler lead). */
  async function sentToday(ws: string, numberId: string, count: number) {
    const filler = await lead(ws);
    await pool.query(
      `with p as (insert into public.proposals (workspace_id, lead_id, title) select $1, $2, 'filler' from generate_series(1, $3) returning id)
       insert into public.whatsapp_outbound_messages (workspace_id, proposal_id, message_id, remote_jid, status, sent_at, whatsapp_number_id)
       select $1, p.id, 'FILL-' || gen_random_uuid(), '910000000000@s.whatsapp.net', 'sent', now(), $4 from p`,
      [ws, filler.id, count, numberId],
    );
  }

  async function inbound(ws: string, numberId: string, phone: string, text: string) {
    const { processInboundUpsert } = await import("../../src/services/whatsapp-inbound.service.js");
    const id = `E4A-IN-${randomUUID()}`;
    await processInboundUpsert(
      ws,
      { type: "notify", messages: [{ key: { id, remoteJid: `${phone.slice(1)}@s.whatsapp.net`, fromMe: false }, message: { conversation: text }, messageTimestamp: Math.floor(Date.now() / 1000) }] as never },
      numberId,
    );
    return (await pool.query(`select * from public.whatsapp_inbound_events where message_id = $1`, [id])).rows[0];
  }

  const stickyOf = async (leadId: string) => (await pool.query(`select whatsapp_number_id from public.leads where id = $1`, [leadId])).rows[0].whatsapp_number_id;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    ({ BaileysManager: Manager } = await import("../../src/providers/baileys.manager.js"));
    ({ sendWhatsApp } = await import("../../src/providers/whatsapp.provider.js"));
    const { baileysRegistry } = await import("../../src/providers/baileys-registry.js");
    registryManagers = (baileysRegistry as unknown as { managers: Map<string, BaileysManager> }).managers;
  });

  afterEach(() => registryManagers.clear());

  afterAll(async () => {
    await deleteCreatedTestWorkspaces(pool);
    await pool.end();
  });

  it("two leads spread over two numbers by room left; each then sticks to its number", async () => {
    const { ws, a, b, sockets } = await workspace("spread");
    await sentToday(ws, a, 5);
    const first = await lead(ws);
    expect(await proposalSend(ws, first)).toMatchObject({ ok: true });
    expect(await stickyOf(first.id)).toBe(b);

    await sentToday(ws, b, 5); // B: 6 sent, A: 5 → A has more room now.
    const second = await lead(ws);
    expect(await proposalSend(ws, second)).toMatchObject({ ok: true });
    expect(await stickyOf(second.id)).toBe(a);

    // Sticky: the first lead stays on B although A has more room.
    expect(await proposalSend(ws, first)).toMatchObject({ ok: true });
    expect(sockets.b.sendMessage).toHaveBeenCalledTimes(2);
    expect(sockets.a.sendMessage).toHaveBeenCalledTimes(1);
    const facts = (await pool.query(`select lead_id, whatsapp_number_id from public.message_facts where workspace_id = $1 order by sent_at`, [ws])).rows;
    expect(facts).toEqual([
      { lead_id: first.id, whatsapp_number_id: b },
      { lead_id: second.id, whatsapp_number_id: a },
      { lead_id: first.id, whatsapp_number_id: b },
    ]);
  });

  it("the lead owner's number comes first (rule 4a)", async () => {
    const owner = (await pool.query<{ id: string }>(`select id from public.profiles where is_active order by created_at limit 1`)).rows[0]!.id;
    const { ws, b, sockets } = await workspace("owner", { owner_user_id: owner });
    await sentToday(ws, b, 30); // less room than A, still the owner's
    const l = await lead(ws, owner);
    expect(await proposalSend(ws, l)).toMatchObject({ ok: true });
    expect(await stickyOf(l.id)).toBe(b);
    expect(sockets.b.sendMessage).toHaveBeenCalledOnce();
  });

  it("daily cap reached on A: new leads go to B, A's existing leads wait (no switch)", async () => {
    const { ws, a, b, sockets } = await workspace("cap");
    await pool.query(`update public.whatsapp_numbers set daily_cap = 5 where id = $1`, [a]);
    const onA = await lead(ws);
    await pool.query(`update public.leads set whatsapp_number_id = $2 where id = $1`, [onA.id, a]);
    await sentToday(ws, a, 5);

    const waiting = await proposalSend(ws, onA);
    expect(waiting.ok || waiting.error).toBeInstanceOf(ProviderDeferredError);
    expect(waiting.ok || waiting.error.message).toBe("Daily cap (5) reached.");
    expect(await stickyOf(onA.id)).toBe(a);

    const fresh = await lead(ws);
    expect(await proposalSend(ws, fresh)).toMatchObject({ ok: true });
    expect(await stickyOf(fresh.id)).toBe(b);
    expect(sockets.a.sendMessage).not.toHaveBeenCalled();
    expect(sockets.b.sendMessage).toHaveBeenCalledOnce();
  });

  it("pausing one number: its leads wait (never moved), the other number keeps sending; admins are told which number", async () => {
    const { ws, a, b, sockets } = await workspace("pause");
    // E4b rule 6: the alert goes to this workspace's admins, so it needs one.
    const auth = await pool.query<{ id: string }>(`insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`, [`e4a-admin-${randomUUID()}@example.com`]);
    const adminId = auth.rows[0]!.id;
    await pool.query(`update public.profiles set role = 'admin', is_active = true where id = $1`, [adminId]);
    await addTestMember(pool, ws, adminId, "admin");
    const onA = await lead(ws);
    const onB = await lead(ws);
    await pool.query(`update public.leads set whatsapp_number_id = $2 where id = $1`, [onA.id, a]);
    await pool.query(`update public.leads set whatsapp_number_id = $2 where id = $1`, [onB.id, b]);
    const { autoPause } = await import("../../src/services/whatsappSafety.service.js");
    expect(await autoPause(pool, ws, a, "Test pause.")).toBe(true);

    const waiting = await proposalSend(ws, onA);
    expect(waiting.ok || waiting.error).toBeInstanceOf(ProviderDeferredError);
    expect(waiting.ok || waiting.error.message).toBe("WhatsApp number #1 is paused.");
    expect(await stickyOf(onA.id)).toBe(a);
    expect(await proposalSend(ws, onB)).toMatchObject({ ok: true });
    expect(sockets.b.sendMessage).toHaveBeenCalledOnce();
    expect(sockets.a.sendMessage).not.toHaveBeenCalled();

    const titles = (await pool.query(`select distinct title from public.notifications where workspace_id = $1`, [ws])).rows.map((r) => r.title);
    expect(titles).toEqual(["WhatsApp number #1 paused automatically"]);
    const recipients = (await pool.query(`select recipient_id from public.notifications where workspace_id = $1`, [ws])).rows.map((r) => r.recipient_id);
    expect(recipients).toEqual([adminId]);
    await pool.query(`update public.profiles set is_active = false where id = $1`, [adminId]);
    // A new lead never lands on the paused number.
    const fresh = await lead(ws);
    expect(await proposalSend(ws, fresh)).toMatchObject({ ok: true });
    expect(await stickyOf(fresh.id)).toBe(b);
  });

  it("the first inbound sets the sticky number; a reply on the other number is recorded + flagged, sticky unchanged", async () => {
    const { ws, a, b } = await workspace("inbound");
    const l = await lead(ws);
    const firstIn = await inbound(ws, a, l.phone, "Hello, interested");
    expect(firstIn).toMatchObject({ disposition: "matched", lead_id: l.id, whatsapp_number_id: a, other_number: false });
    expect(await stickyOf(l.id)).toBe(a);

    const other = await inbound(ws, b, l.phone, "Also, what's the price?");
    expect(other).toMatchObject({ disposition: "matched", lead_id: l.id, whatsapp_number_id: b, other_number: true });
    expect(await stickyOf(l.id)).toBe(a);
    // Handled like any reply: automation stopped, the timeline has both.
    expect((await pool.query(`select automation_mode from public.leads where id = $1`, [l.id])).rows[0].automation_mode).toBe("manual");
    const replies = await pool.query(`select count(*)::int as n from public.timeline_events where lead_id = $1 and title = 'WhatsApp reply received - automation stopped'`, [l.id]);
    expect(replies.rows[0].n).toBe(2);
  });

  it("STOP on number B opts the lead (on A) out of WhatsApp entirely; it counts toward B's STOP signal", async () => {
    const { ws, a, b } = await workspace("stop");
    const l = await lead(ws);
    await pool.query(`update public.leads set whatsapp_number_id = $2 where id = $1`, [l.id, a]);
    const stop = await inbound(ws, b, l.phone, "STOP");
    expect(stop).toMatchObject({ reply_label: "asked_to_stop", other_number: true, whatsapp_number_id: b });
    const channel = await pool.query(`select status from public.lead_contact_channels where lead_id = $1 and channel = 'whatsapp'`, [l.id]);
    expect(channel.rows[0].status).toBe("opted_out");

    const refused = await proposalSend(ws, l);
    expect(refused.ok || refused.error).toBeInstanceOf(PermanentProviderError);

    const { loadSendStats } = await import("../../src/services/whatsappSafety.service.js");
    expect((await loadSendStats(pool, ws, b, "", "", null)).stops24h).toBe(1);
    expect((await loadSendStats(pool, ws, a, "", "", null)).stops24h).toBe(0);
  });

  it("a moved lead's next send goes out on its new number, not as a first message again", async () => {
    const { ws, a, b, sockets } = await workspace("moved");
    const l = await lead(ws);
    await pool.query(`update public.leads set whatsapp_number_id = $2 where id = $1`, [l.id, a]);
    expect(await proposalSend(ws, l)).toMatchObject({ ok: true });
    await pool.query(`update public.leads set whatsapp_number_id = $2 where id = $1`, [l.id, b]);
    expect(await proposalSend(ws, l)).toMatchObject({ ok: true });
    expect(sockets.a.sendMessage).toHaveBeenCalledOnce();
    expect(sockets.b.sendMessage).toHaveBeenCalledOnce();
    // A new chat for B's limit; still not the lead's first message (no opt-out line on a rep send anyway).
    const rows = (await pool.query(`select whatsapp_number_id, new_chat from public.whatsapp_outbound_messages where workspace_id = $1 and remote_jid = $2 order by sent_at`, [ws, `${l.phone.slice(1)}@s.whatsapp.net`])).rows;
    expect(rows).toEqual([
      { whatsapp_number_id: a, new_chat: true },
      { whatsapp_number_id: b, new_chat: true },
    ]);
  });
});
