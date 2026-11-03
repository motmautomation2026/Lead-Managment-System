/**
 * E3b-2a rule 7c: a fresh website lead on a Sunday evening (inside 08:00–21:00 IST) passes the AI's
 * send re-check AND both channels' window checks (WhatsApp decideSend, email decideEmailSend) with the
 * default Mon–Sat 09:30–19:00 window; without the fresh-inbound flag both defer to Monday. Nothing is
 * sent. Skipped unless TEST_DATABASE_URL is set; [test] workspaces only.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createTestWorkspace, deleteCreatedTestWorkspaces } from "../helpers/testWorkspaces.js";
import { startTestApi, type TestApi } from "../helpers/testApi.js";
import type { Actor } from "../../src/authMiddleware.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const ist = (local: string) => new Date(`${local}:00+05:30`);
const SUNDAY_8PM = ist("2026-11-08T20:00");
const MINUTE = 60_000;

describeIfDb("fresh inbound lead on a Sunday evening (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let api: TestApi;
  let owner: Actor;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
    api = await startTestApi(pool, "sunday-inbound");
    owner = await api.newUser("salesperson", { name: "Sunday Owner" });
  });

  afterAll(async () => {
    await deleteCreatedTestWorkspaces(pool);
    await api.close();
    await pool.end();
  });

  it("passes the re-check and both window checks at 20:00 IST on Sunday; a non-fresh lead defers to Monday 09:30", async () => {
    const ws = await createTestWorkspace(pool, "sunday-inbound");
    // The default window (Mon–Sat 09:30–19:00): Sunday 20:00 is outside it.
    await pool.query(`update public.agent_settings set mode = 'live', live_scope = 'test_contacts' where workspace_id = $1`, [ws]);
    await pool.query(`insert into public.email_imap_state (workspace_id, last_success_at) values ($1, $2)`, [ws, new Date(SUNDAY_8PM.getTime() - 5 * MINUTE)]);
    const lead = (
      await pool.query(
        `insert into public.leads (workspace_id, first_name, last_name, company, source, email, phone, phone_e164, owner_id, agent_status, agent_live_test, pipeline_stage, created_at)
         values ($1, 'Ravi', 'Shah', 'Shah Forgings', 'website', $2, '+919600000077', '+919600000077', $3, 'active', true, 'new', $4) returning id`,
        [ws, `sunday-${randomUUID()}@example.com`, owner.id, new Date(SUNDAY_8PM.getTime() - 20 * MINUTE)],
      )
    ).rows[0].id as string;
    const decision = async (action: "send_whatsapp" | "send_email") =>
      (
        await pool.query(
          `insert into public.agent_decisions (workspace_id, lead_id, mode, action, reasoning, message_subject, message_body, outcome, send_status, send_next_at, created_at)
           values ($1, $2, 'live', $3, 'r', $4, 'Thank you for your enquiry, Ravi.', 'executed', 'queued', $5, $5) returning id`,
          [ws, lead, action, action === "send_email" ? "Your enquiry" : null, new Date(SUNDAY_8PM.getTime() - 10 * MINUTE)],
        )
      ).rows[0].id as string;
    const whatsappDecision = await decision("send_whatsapp");
    const emailDecision = await decision("send_email");

    const { agentSendRecheck } = await import("../../src/services/agentSendState.service.js");
    const { decideSend, DEFAULT_SEND_WINDOW } = await import("../../src/domain/whatsappSafety.js");
    const { decideEmailSend } = await import("../../src/domain/emailSafety.js");
    const client = await pool.connect();
    try {
      await client.query("begin");
      const whatsappCheck = await agentSendRecheck(client, whatsappDecision, "whatsapp", SUNDAY_8PM);
      const emailCheck = await agentSendRecheck(client, emailDecision, "email", SUNDAY_8PM);
      await client.query("rollback");
      expect(whatsappCheck).toMatchObject({ ok: true, freshInbound: true });
      expect(emailCheck).toMatchObject({ ok: true, freshInbound: true });

      const whatsapp = (firstInboundWindow: boolean) =>
        decideSend({
          source: "agent",
          now: SUNDAY_8PM,
          window: DEFAULT_SEND_WINDOW,
          dailyCap: 100,
          warmupDay: null,
          sentToday: 0,
          maxNewChatsPerDay: 20,
          newChatsToday: 0,
          isFirstMessage: false,
          text: "Thank you for your enquiry, Ravi.",
          paused: false,
          nextSendAt: null,
          firstInboundWindow,
          random: () => 0,
        });
      const email = (firstInboundWindow: boolean) =>
        decideEmailSend({
          source: "agent",
          now: SUNDAY_8PM,
          window: DEFAULT_SEND_WINDOW,
          dailyCap: 100,
          hourlyCap: 20,
          warmupDay: null,
          alreadyWarmed: true,
          sentToday: 0,
          sentThisHour: 0,
          paused: false,
          nextSendAt: null,
          recipientProblem: null,
          firstInboundWindow,
          random: () => 0,
        });
      expect(whatsapp("freshInbound" in whatsappCheck && whatsappCheck.freshInbound === true)).toMatchObject({ send: true });
      expect(email("freshInbound" in emailCheck && emailCheck.freshInbound === true)).toMatchObject({ send: true });
      // The same moment for a lead that isn't fresh: both wait for Monday's opening.
      expect(whatsapp(false)).toMatchObject({ defer: ist("2026-11-09T09:30") });
      expect(email(false)).toMatchObject({ defer: ist("2026-11-09T09:30") });
    } finally {
      client.release();
    }
  });
});
