import { describe, expect, it } from "vitest";
import type { Queryable } from "../../src/dto.js";
import { assembleAgentContext, TRIED_CALLING_ACTION, type AgentContextSource } from "../../src/agent/contextAssembly.js";
import { buildDecisionMessages, buildGroundingMessages } from "../../src/agent/prompt.js";
import { buildAgentContext } from "../../src/services/agentContext.service.js";
import { settings as baseSettings } from "../helpers/agentContextFixture.js";
import { fakeEmbedder } from "../helpers/fakeEmbedder.js";

// DEMO-1 rule 2: the database-backed context and an in-memory one built from the same data are identical.
const NOW = new Date("2026-11-18T05:30:00Z");
const settings = { ...baseSettings, mode: "live" as const, live_scope: "test_contacts" as const, company_display_name: "MOTM Technologies", decision_model: "w", grounding_model: "c" };
const company = { id: "c1", name: "Altem Technologies", domain: "altem.example", website: "https://altem.example", industry: "Industrial automation", revenueRange: null, city: "Bengaluru", state: null, country: "India", employeeRange: "51-200", description: "Engineering services firm", mergedIntoCompanyId: null };

const source: AgentContextSource = {
  workspaceId: "ws",
  lead: {
    id: "lead-1", first_name: "Reshma", last_name: "Tantry", company: "Altem Technologies", job_title: "Marketing Manager", industry: "industrial-automation",
    revenue_range: null, source: "website", email: "reshma@altem.example", phone_e164: "+919000000102", pipeline_stage: "connected_qualifying",
    lifecycle_state: "active", objection_type: null, loss_reason: null, agent_status: "active", agent_touch_count: 2,
    agent_last_touch_at: new Date("2026-11-16T05:00:00Z"), agent_live_test: true, created_at: new Date("2026-11-16T04:35:00Z"), owner_id: "owner-1",
    owner_name: "Naitik", owner_email: "naitik@motm.example", owner_booking_url: "https://calendly.com/motm-demo/15min", company_name: "MOTM",
    linked_company: company, merge_target: null,
    deals: [{ id: "d1", name: "Altem SDR", stage: "qualified", updatedAt: "2026-11-17T05:00:00.000Z", stageSince: "2026-11-16T05:00:00.000Z", expectedCloseDate: null, latestMeeting: null, latestProposal: null }],
  },
  settings,
  websiteMessage: "Hi, We are looking for B2B lead generation and SDR support",
  channels: [{ channel: "email", status: "delivered" }],
  sends: [
    { action: "send_whatsapp", at: new Date("2026-11-16T04:50:00Z") },
    { action: "send_email", at: new Date("2026-11-16T05:00:00Z") },
  ],
  lastRepActivityAt: new Date("2026-11-17T06:00:00Z"),
  lastCall: { outcome: "interested_later" },
  timeline: [
    { occurred_at: new Date("2026-11-17T06:00:00Z"), event_kind: "call", title: "Call Connected - interested_later", detail: "Wants meetings with automation buyers in the UAE." },
    { occurred_at: new Date("2026-11-16T04:35:00Z"), event_kind: "system", title: "Website form submission", detail: null },
  ],
  pastMessages: [
    { created_at: new Date("2026-11-16T05:00:00Z"), action: "send_email", message_subject: "SDR support for Altem", message_body: "Hi Reshma, thank you for your enquiry.", outcome: "sent", playbook_version: 7 },
    { created_at: new Date("2026-11-16T04:50:00Z"), action: "send_whatsapp", message_subject: null, message_body: "Hi Reshma, thanks for reaching out.", outcome: "sent", playbook_version: 7 },
  ],
  decisionSummaries: [{ created_at: new Date("2026-11-16T05:00:00Z"), action: "send_email", outcome: "sent", reasoning: "Welcome by email" }],
  playbook: { version: 7, body: "Tone: warm and direct." },
  assets: [{ id: "a1", title: "Case study", useWhen: "Lead asks for proof", channels: ["email"], sizeBytes: 2048 }],
  senderAddress: "sales@motm.example",
  imapLastSuccessAt: new Date("2026-11-18T05:20:00Z"),
  aiSendReplied: false,
  assetHistory: { whatsappReplied: false, sentAssetIds: [] },
  emailThread: { messageId: "<m1@motm.example>", subject: "SDR support for Altem" },
  stage: { meeting: null, has_upcoming: false, proposal: null, rep_owned_before: false, call_or_meeting_held: true },
};
const chunks = [{ chunk_id: "k1", document_id: "doc1", title: "KB Approach", doc_type: "knowledge", content: "We qualify every lead by phone first.", metadata: {}, score: 0.9 }];

/** Answers buildAgentContext's SQL with the source's rows (as Postgres would return them), by query shape. */
function fakeDb(s: AgentContextSource) {
  const asked: string[] = [];
  const answers: [string, (params: unknown[]) => unknown[]][] = [
    ["from public.leads l\n         join public.workspaces", () => [s.lead]],
    ["from public.agent_settings where workspace_id", () => [s.settings]],
    ["'rawMessage' as message", () => (s.websiteMessage ? [{ message: s.websiteMessage }] : [])],
    ["from public.lead_contact_channels c", () => s.channels],
    ["coalesce(sent_at, send_at, created_at) as at", () => s.sends],
    ["select greatest(", () => [{ at: s.lastRepActivityAt }]],
    ["coalesce(connected_outcome::text", () => (s.lastCall ? [s.lastCall] : [])],
    ["t.occurred_at, t.event_kind", () => s.timeline],
    ["message_subject, message_body", () => s.pastMessages],
    ["select created_at, action, outcome, reasoning", () => s.decisionSummaries],
    ["from public.agent_playbooks", () => (s.playbook ? [s.playbook] : [])],
    ["from public.agent_assets", () => s.assets.map((a) => ({ id: a.id, title: a.title, use_when: a.useWhen, channels: a.channels, size_bytes: String(a.sizeBytes), storage_path: "x" }))],
    ["from public.integration_connections", () => [{ address: s.senderAddress }]],
    ["from public.email_imap_state", () => [{ last_success_at: s.imapLastSuccessAt }]],
    ["as replied", () => [{ replied: s.aiSendReplied }]],
    ["as whatsapp_replied", () => [{ whatsapp_replied: s.assetHistory.whatsappReplied, sent_asset_ids: s.assetHistory.sentAssetIds, failed_asset_ids: [] }]],
    ["from public.email_outbound_messages", () => (s.emailThread ? [{ message_id: s.emailThread.messageId, subject: s.emailThread.subject }] : [])],
    ["as has_upcoming", () => [s.stage]],
    ["hnsw.iterative_scan", () => []],
    ["from public.kb_chunks c", () => chunks],
  ];
  const db = {
    asked,
    async query(sql: string, params: unknown[] = []) {
      const hit = answers.find(([needle]) => sql.includes(needle));
      if (!hit) throw new Error(`Unexpected query: ${sql.slice(0, 80)}`);
      asked.push(hit[0]);
      return { rows: hit[1](params), rowCount: 0 };
    },
  };
  return db;
}

describe("DEMO-1 rule 2: context provider", () => {
  it("the database-backed context and the in-memory one give the identical writer and checker prompts", async () => {
    const db = fakeDb(source);
    const fromDb = await buildAgentContext(db as unknown as Queryable, "ws", "lead-1", NOW, { embedder: fakeEmbedder });
    const inMemory = await assembleAgentContext(structuredClone(source), NOW, async () => chunks.map((c) => ({ id: c.chunk_id, title: c.title, text: c.content })));

    expect(db.asked).toHaveLength(20);
    expect(inMemory).toEqual(fromDb);
    const writer = (ctx: typeof fromDb) => buildDecisionMessages(ctx, ctx.settings, NOW);
    expect(writer(inMemory)).toEqual(writer(fromDb));
    const send = { action: "send_email" as const, subject: "-", body: "Hi Reshma, good to speak yesterday.", assetIds: [], nextWakeInDays: 3, reasoning: "after the call" };
    expect(buildGroundingMessages(send, inMemory)).toEqual(buildGroundingMessages(send, fromDb));
    // A real, non-trivial context: live, the call follow-up angle, the KB chunk and the email thread are in it.
    expect(fromDb.rules.mode).toBe("live");
    expect(fromDb.stagePlan?.angle).toBe("call_followup");
    expect(fromDb.knowledge.chunks).toEqual([{ id: "k1", title: "KB Approach", text: "We qualify every lead by phone first." }]);
    expect(writer(fromDb)[1]!.content).toContain("We qualify every lead by phone first.");
  });

  it("LL-3b: the AI still has all 8: tried-calling sends never count toward its total (7-day limit only)", async () => {
    const tried = ["2026-11-16T05:30:00Z", "2026-11-17T05:30:00Z", "2026-11-17T06:30:00Z"].map((at) => ({ action: TRIED_CALLING_ACTION, at: new Date(at) }));
    const base = await assembleAgentContext(structuredClone(source), NOW, async () => []);
    const withTried = await assembleAgentContext({ ...structuredClone(source), sends: [...source.sends, ...tried] }, NOW, async () => []);
    expect(withTried.rules.lead.agentTouchCount).toBe(base.rules.lead.agentTouchCount);
    expect(withTried.rules.recentTouchTimes.length).toBe(base.rules.recentTouchTimes.length + 3);
  });
});
