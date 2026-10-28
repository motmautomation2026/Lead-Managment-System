/**
 * E1 WhatsApp safety API: admin-only settings + resume, monitoring numbers, and the
 * admin-only WhatsApp opt-out clear (rule 8). Real HTTP stack, `[test]` workspace.
 * Skipped unless TEST_DATABASE_URL is set.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createTestWorkspace, deleteCreatedTestWorkspaces } from "../helpers/testWorkspaces.js";
import type { TestApi } from "../helpers/testApi.js";
import type { Actor } from "../../src/authMiddleware.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb("WhatsApp safety API (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let api: TestApi;
  let admin: Actor;
  let rep: Actor;
  let ws: string;

  const settings = {
    enabled: true,
    dailyCap: 150,
    minDelaySeconds: 60,
    maxDelaySeconds: 90,
    maxNewChatsPerDay: 10,
    sendWindow: { days: [1, 2, 3, 4, 5], start: "10:00", end: "18:30" },
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    const { startTestApi } = await import("../helpers/testApi.js");
    api = await startTestApi(pool, "wa-safety-api");
    admin = await api.newUser("admin", { name: "E1 Admin" });
    rep = await api.newUser("salesperson", { name: "E1 Rep" });
    ws = await createTestWorkspace(pool, "wa-safety-api");
    await pool.query(`insert into public.whatsapp_connection (workspace_id) values ($1)`, [ws]);
  });

  afterAll(async () => {
    await deleteCreatedTestWorkspaces(pool);
    await api.close();
    await pool.end();
  });

  it("defaults: 45–120 s spacing, 20 new chats, Mon–Sat 09:30–19:00, numbers paired before E1 fully warmed", async () => {
    const res = await api.call(rep, ws, "GET", "/connections/whatsapp/settings");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      minDelaySeconds: 45,
      maxDelaySeconds: 120,
      maxNewChatsPerDay: 20,
      sendWindow: { days: [1, 2, 3, 4, 5, 6], start: "09:30", end: "19:00" },
      pairedAt: null,
      warmupDay: null,
      effectiveDailyCap: 200,
      newChatsToday: 0,
      failures24h: 0,
      stops24h: 0,
      safetyEvents: [],
    });
    expect(res.body.daily).toHaveLength(14);
    expect(res.body.daily[0]).toEqual({ date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), sent: 0, failed: 0, stops: 0 });
  });

  it("a salesperson can't change safety settings or resume (403)", async () => {
    expect((await api.call(rep, ws, "PUT", "/connections/whatsapp/settings", settings)).status).toBe(403);
    expect((await api.call(rep, ws, "POST", "/connections/whatsapp/resume")).status).toBe(403);
  });

  it("validates spacing and the send window", async () => {
    const minOverMax = await api.call(admin, ws, "PUT", "/connections/whatsapp/settings", { ...settings, minDelaySeconds: 100, maxDelaySeconds: 50 });
    expect(minOverMax.status).toBe(400);
    const backwards = await api.call(admin, ws, "PUT", "/connections/whatsapp/settings", { ...settings, sendWindow: { days: [1], start: "19:00", end: "09:30" } });
    expect(backwards.status).toBe(400);
    const noDays = await api.call(admin, ws, "PUT", "/connections/whatsapp/settings", { ...settings, sendWindow: { days: [], start: "09:30", end: "19:00" } });
    expect(noDays.status).toBe(400);
  });

  it("an admin saves the settings; switching off is a pause by them, Resume turns it back on", async () => {
    const saved = await api.call(admin, ws, "PUT", "/connections/whatsapp/settings", settings);
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ enabled: true, dailyCap: 150, minDelaySeconds: 60, maxDelaySeconds: 90, maxNewChatsPerDay: 10, sendWindow: settings.sendWindow, pause: null });

    const off = await api.call(admin, ws, "PUT", "/connections/whatsapp/settings", { ...settings, enabled: false });
    expect(off.body.pause).toEqual({ reason: "Paused by E1 Admin.", at: expect.any(String), byName: "E1 Admin" });

    const resumed = await api.call(admin, ws, "POST", "/connections/whatsapp/resume");
    expect(resumed.status).toBe(200);
    expect(resumed.body).toMatchObject({ enabled: true, pause: null });
    expect(resumed.body.safetyEvents.map((e: { kind: string }) => e.kind)).toEqual(["resumed", "paused", "resumed"]);
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
