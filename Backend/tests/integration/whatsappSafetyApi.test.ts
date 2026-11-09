/**
 * E1 + E4a WhatsApp API: workspace settings (master switch, window, max numbers), the numbers
 * (list, add, edit, pause/resume, remove with the rule-10 options, connect/logout), the admin
 * move of a contact (rule 6), and the admin-only WhatsApp opt-out clear (rule 8). Real HTTP
 * stack, `[test]` workspace, no socket. Skipped unless TEST_DATABASE_URL is set.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createTestWorkspace, deleteCreatedTestWorkspaces } from "../helpers/testWorkspaces.js";
import type { TestApi } from "../helpers/testApi.js";
import type { Actor } from "../../src/authMiddleware.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb("WhatsApp settings + numbers API (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let api: TestApi;
  let admin: Actor;
  let rep: Actor;
  let ws: string;
  let first: string;

  const settings = { enabled: true, maxNumbers: 3, sendWindow: { days: [1, 2, 3, 4, 5], start: "10:00", end: "18:30" } };
  const numberSettings = { dailyCap: 150, minDelaySeconds: 60, maxDelaySeconds: 90, maxNewChatsPerDay: 10 };
  type NumberDto = { id: string; label: string; [key: string]: unknown };
  const byLabel = (body: { numbers: NumberDto[] }, label: string) => body.numbers.find((n) => n.label === label)!;

  async function createContact(phone: string) {
    const created = await api.call(admin, ws, "POST", "/leads", {
      firstName: "Nia",
      company: "Nia Pvt Ltd",
      source: "referral",
      email: `nia-${randomUUID()}@example.com`,
      phone,
    });
    expect(created.status).toBe(201);
    return created.body.id as string;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    const { startTestApi } = await import("../helpers/testApi.js");
    api = await startTestApi(pool, "wa-safety-api");
    admin = await api.newUser("admin", { name: "E1 Admin" });
    rep = await api.newUser("salesperson", { name: "E1 Rep" });
    ws = await createTestWorkspace(pool, "wa-safety-api");
    await pool.query(`insert into public.whatsapp_connection (workspace_id) values ($1)`, [ws]);
    first = (await pool.query<{ id: string }>(`insert into public.whatsapp_numbers (workspace_id, label) values ($1, '#1') returning id`, [ws])).rows[0]!.id;
  });

  afterAll(async () => {
    await deleteCreatedTestWorkspaces(pool);
    await api.close();
    await pool.end();
  });

  it("defaults: workspace window Mon–Sat 09:30–19:00, max 5 numbers; number #1 45–120 s, 20 new chats, fully warmed", async () => {
    const res = await api.call(rep, ws, "GET", "/connections/whatsapp/settings");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      enabled: true,
      maxNumbers: 5,
      sendWindow: { days: [1, 2, 3, 4, 5, 6], start: "09:30", end: "19:00" },
      sessionSlots: { numbers: expect.any(Number), headroom: 8, overHeadroom: expect.any(Boolean) },
      failures24h: 0,
      stops24h: 0,
      safetyEvents: [],
    });
    expect(res.body.numbers).toEqual([
      expect.objectContaining({
        id: first,
        label: "#1",
        status: "disconnected",
        minDelaySeconds: 45,
        maxDelaySeconds: 120,
        maxNewChatsPerDay: 20,
        pairedAt: null,
        warmupDay: null,
        effectiveDailyCap: 200,
        sentToday: 0,
        newChatsToday: 0,
        leadCount: 0,
        queuedSends: 0,
        pause: null,
      }),
    ]);
    expect(res.body.daily).toHaveLength(14);
    expect(res.body.daily[0]).toEqual({ date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), sent: 0, failed: 0, stops: 0 });
  });

  it("a salesperson can't change settings, add, edit, pause, resume or remove numbers, or move a contact (403); connect stays open", async () => {
    expect((await api.call(rep, ws, "PUT", "/connections/whatsapp/settings", settings)).status).toBe(403);
    expect((await api.call(rep, ws, "POST", "/connections/whatsapp/numbers", {})).status).toBe(403);
    expect((await api.call(rep, ws, "PUT", `/connections/whatsapp/numbers/${first}`, numberSettings)).status).toBe(403);
    expect((await api.call(rep, ws, "POST", `/connections/whatsapp/numbers/${first}/pause`)).status).toBe(403);
    expect((await api.call(rep, ws, "POST", `/connections/whatsapp/numbers/${first}/resume`)).status).toBe(403);
    expect((await api.call(rep, ws, "DELETE", `/connections/whatsapp/numbers/${first}`, {})).status).toBe(403);
    const contact = await createContact("+919811100001");
    expect((await api.call(rep, ws, "POST", `/contacts/${contact}/whatsapp-number`, { numberId: first, reason: "x" })).status).toBe(403);
    const connect = await api.call(rep, ws, "POST", `/connections/whatsapp/numbers/${first}/connect`);
    expect(connect.status).toBe(200);
    expect(byLabel(connect.body, "#1").desiredState).toBe("connected");
    expect((await api.call(rep, ws, "POST", `/connections/whatsapp/numbers/${first}/logout`)).status).toBe(200);
  });

  it("validates spacing, the send window and unknown numbers", async () => {
    const minOverMax = await api.call(admin, ws, "PUT", `/connections/whatsapp/numbers/${first}`, { minDelaySeconds: 100, maxDelaySeconds: 50 });
    expect(minOverMax.status).toBe(400);
    const backwards = await api.call(admin, ws, "PUT", "/connections/whatsapp/settings", { ...settings, sendWindow: { days: [1], start: "19:00", end: "09:30" } });
    expect(backwards.status).toBe(400);
    const noDays = await api.call(admin, ws, "PUT", "/connections/whatsapp/settings", { ...settings, sendWindow: { days: [], start: "09:30", end: "19:00" } });
    expect(noDays.status).toBe(400);
    expect((await api.call(admin, ws, "PUT", `/connections/whatsapp/numbers/${randomUUID()}`, numberSettings)).status).toBe(404);
    expect((await api.call(admin, ws, "POST", `/connections/whatsapp/numbers/not-a-uuid/pause`)).status).toBe(400);
  });

  it("an admin saves workspace + number settings; pause by them, Resume turns the number back on", async () => {
    const saved = await api.call(admin, ws, "PUT", "/connections/whatsapp/settings", settings);
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ enabled: true, maxNumbers: 3, sendWindow: settings.sendWindow });

    const edited = await api.call(admin, ws, "PUT", `/connections/whatsapp/numbers/${first}`, { ...numberSettings, label: "Sales line", ownerUserId: rep.id });
    expect(edited.status).toBe(200);
    expect(byLabel(edited.body, "Sales line")).toMatchObject({ ...numberSettings, ownerUserId: rep.id, ownerName: "E1 Rep", pause: null });
    expect((await api.call(admin, ws, "PUT", `/connections/whatsapp/numbers/${first}`, { ownerUserId: randomUUID() })).status).toBe(400);

    const off = await api.call(admin, ws, "POST", `/connections/whatsapp/numbers/${first}/pause`);
    expect(byLabel(off.body, "Sales line").pause).toEqual({ reason: "Paused by E1 Admin.", at: expect.any(String), byName: "E1 Admin" });

    const resumed = await api.call(admin, ws, "POST", `/connections/whatsapp/numbers/${first}/resume`);
    expect(resumed.status).toBe(200);
    expect(byLabel(resumed.body, "Sales line")).toMatchObject({ enabled: true, pause: null });
    expect(resumed.body.safetyEvents.map((e: { kind: string; numberLabel: string }) => [e.kind, e.numberLabel])).toEqual([
      ["resumed", "Sales line"],
      ["paused", "Sales line"],
    ]);

    // The master switch is separate from each number's pause.
    const masterOff = await api.call(admin, ws, "PUT", "/connections/whatsapp/settings", { ...settings, enabled: false });
    expect(masterOff.body.enabled).toBe(false);
    expect(byLabel(masterOff.body, "Sales line").enabled).toBe(true);
    await api.call(admin, ws, "PUT", "/connections/whatsapp/settings", settings);
  });

  it("add: '#n' label by default, pairing requested, at most max numbers (409)", async () => {
    const added = await api.call(admin, ws, "POST", "/connections/whatsapp/numbers", {});
    expect(added.status).toBe(201);
    expect(byLabel(added.body, "#2")).toMatchObject({ desiredState: "connected", status: "disconnected", enabled: true });
    const third = await api.call(admin, ws, "POST", "/connections/whatsapp/numbers", { label: "Backup" });
    expect(third.body.numbers.map((n: NumberDto) => n.label)).toEqual(["Sales line", "#2", "Backup"]);
    const fourth = await api.call(admin, ws, "POST", "/connections/whatsapp/numbers", {});
    expect(fourth.status).toBe(409);
    expect(fourth.body.error.message).toMatch(/maximum is 3/);
  });

  it("rule 6: an admin moves a contact with a reason — timeline, audit, queued rows follow", async () => {
    const list = (await api.call(admin, ws, "GET", "/connections/whatsapp/settings")).body;
    const second = byLabel(list, "#2").id;
    const contact = await createContact("+919811100002");
    await pool.query(`update public.leads set whatsapp_number_id = $2 where id = $1`, [contact, first]);
    const proposal = await pool.query<{ id: string }>(`insert into public.proposals (workspace_id, lead_id, title) values ($1, $2, 'p') returning id`, [ws, contact]);
    await pool.query(
      `insert into public.whatsapp_outbound_messages (workspace_id, proposal_id, message_id, remote_jid, whatsapp_number_id) values ($1, $2, $3, '919811100002@s.whatsapp.net', $4)`,
      [ws, proposal.rows[0]!.id, `E4A-${randomUUID()}`, first],
    );

    expect((await api.call(admin, ws, "POST", `/contacts/${contact}/whatsapp-number`, { numberId: second, reason: " " })).status).toBe(400);
    expect((await api.call(admin, ws, "POST", `/contacts/${contact}/whatsapp-number`, { numberId: first, reason: "Same" })).status).toBe(400);
    expect((await api.call(admin, ws, "POST", `/contacts/${contact}/whatsapp-number`, { numberId: randomUUID(), reason: "Gone" })).status).toBe(400);
    const moved = await api.call(admin, ws, "POST", `/contacts/${contact}/whatsapp-number`, { numberId: second, reason: "Rep changed" });
    expect(moved.status).toBe(200);
    expect(moved.body).toEqual({ whatsappNumber: { id: second, label: "#2" } });

    expect((await api.call(rep, ws, "GET", `/contacts/${contact}`)).body.whatsappNumber).toEqual({ id: second, label: "#2" });
    const queued = await pool.query(`select whatsapp_number_id from public.whatsapp_outbound_messages where proposal_id = $1`, [proposal.rows[0]!.id]);
    expect(queued.rows[0].whatsapp_number_id).toBe(second);
    const timeline = await pool.query(`select title, detail, actor_name from public.timeline_events where lead_id = $1 and event_kind = 'whatsapp'`, [contact]);
    expect(timeline.rows).toContainEqual({ title: "WhatsApp number changed to #2", detail: "Rep changed", actor_name: "E1 Admin" });
    const audit = await pool.query(`select count(*)::int as n from public.admin_audit_events where action = 'lead.whatsapp_number_changed' and target_id = $1`, [contact]);
    expect(audit.rows[0].n).toBe(1);
  });

  it("rule 10: remove needs a choice while sends are queued; move or unassign; never the last number", async () => {
    const list = (await api.call(admin, ws, "GET", "/connections/whatsapp/settings")).body;
    const second = byLabel(list, "#2").id;
    const backup = byLabel(list, "Backup").id;

    const blocked = await api.call(admin, ws, "DELETE", `/connections/whatsapp/numbers/${second}`, {});
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toMatch(/1 queued WhatsApp send/);
    expect((await api.call(admin, ws, "DELETE", `/connections/whatsapp/numbers/${second}`, { leads: "move" })).status).toBe(400);

    const moved = await api.call(admin, ws, "DELETE", `/connections/whatsapp/numbers/${second}`, { leads: "move", moveToNumberId: backup });
    expect(moved.status).toBe(200);
    expect(moved.body.numbers.map((n: NumberDto) => n.label)).toEqual(["Sales line", "Backup"]);
    expect(byLabel(moved.body, "Backup").leadCount).toBe(1);
    const removed = await pool.query(`select removed_at, desired_state, enabled from public.whatsapp_numbers where id = $1`, [second]);
    expect(removed.rows[0]).toMatchObject({ removed_at: expect.any(Date), desired_state: "disconnected", enabled: false });

    // No queued sends: removed straight away, its contacts left without a number.
    const unassigned = await api.call(admin, ws, "DELETE", `/connections/whatsapp/numbers/${backup}`, { leads: "unassign" });
    expect(unassigned.status).toBe(200);
    expect(unassigned.body.numbers.map((n: NumberDto) => n.label)).toEqual(["Sales line"]);
    expect((await pool.query(`select count(*)::int as n from public.leads where whatsapp_number_id = $1`, [backup])).rows[0].n).toBe(0);

    const last = await api.call(admin, ws, "DELETE", `/connections/whatsapp/numbers/${first}`, {});
    expect(last.status).toBe(409);
    expect((await api.call(admin, ws, "PUT", `/connections/whatsapp/numbers/${second}`, numberSettings)).status).toBe(404);
  });

  describe("clearing a WhatsApp opt-out (rule 8)", () => {
    let leadId: string;

    beforeAll(async () => {
      const created = await api.call(admin, ws, "POST", "/leads", {
        firstName: "Opal",
        company: "Opal Pvt Ltd",
        source: "referral",
        email: `opal-${randomUUID()}@example.com`,
        phone: "+919811122233",
      });
      expect(created.status).toBe(201);
      leadId = created.body.id;
      await pool.query(
        `insert into public.lead_contact_channels (lead_id, channel, status, reason, updated_by_name) values ($1, 'whatsapp', 'opted_out', 'Asked to stop on WhatsApp', 'Automation')`,
        [leadId],
      );
    });

    it("403 for a salesperson; 400 without a reason for an admin", async () => {
      expect((await api.call(rep, ws, "POST", `/leads/${leadId}/contactability`, { channel: "whatsapp", status: "valid", reason: "Called" })).status).toBe(403);
      expect((await api.call(admin, ws, "POST", `/leads/${leadId}/contactability`, { channel: "whatsapp", status: "valid", reason: "  " })).status).toBe(400);
      expect((await api.call(admin, ws, "POST", `/leads/${leadId}/contactability`, { channel: "whatsapp", status: "valid" })).status).toBe(400);
    });

    it("an admin clears it with a reason; the timeline says who and why", async () => {
      const res = await api.call(admin, ws, "POST", `/leads/${leadId}/contactability`, { channel: "whatsapp", status: "valid", reason: "Asked to resume on a call" });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([expect.objectContaining({ channel: "whatsapp", status: "valid", reason: "Asked to resume on a call" })]);
      const titles = await pool.query(`select title from public.timeline_events where lead_id = $1`, [leadId]);
      expect(titles.rows.map((r) => r.title)).toContain("WhatsApp opt-out cleared by E1 Admin: Asked to resume on a call");
    });

    it("other contactability changes stay open to every CRM user", async () => {
      expect((await api.call(rep, ws, "POST", `/leads/${leadId}/contactability`, { channel: "whatsapp", status: "opted_out", reason: "Asked again" })).status).toBe(200);
      expect((await api.call(rep, ws, "POST", `/leads/${leadId}/contactability`, { channel: "phone", status: "wrong_number" })).status).toBe(200);
    });
  });
});
