import type { Queryable } from "../dto.js";
import { NotFoundError } from "../errors.js";
import type { LeadLossReason, LifecycleState, ObjectionType, PipelineStage } from "../domain/enums.js";
import type { AgentMode, AgentRuleSettings, AgentStatus, RulesContext } from "../agent/rules.js";
import { buildKbQuery } from "../agent/kbQuery.js";
import { countTokens } from "../knowledge/chunkText.js";
import type { Embedder } from "../providers/openai.provider.js";
import { searchKnowledge } from "./knowledge.service.js";

/**
 * Everything the agent needs to make ONE decision for ONE lead (3C). Reads
 * only, every query scoped to the workspace. Nothing is saved or sent.
 */

export const CONTEXT_TOKEN_CAP = 12_000;
const TIMELINE_LIMIT = 30;
const TEXT_LIMIT = 1_000;
const SUMMARY_LIMIT = 10;
const REASONING_LIMIT = 200;
// shortcut: the newest 50 earlier send decisions, not literally all; raise if shadow runs ever need more.
const PAST_MESSAGES_LIMIT = 50;
const KB_LIMIT = 8;

/** agent_settings as the rules, prompt and composer read it (snake_case). */
export interface AgentSettingsRow extends AgentRuleSettings {
  mode: AgentMode;
  email_opt_out_text: string;
  whatsapp_opt_out_text: string;
  decision_model: string | null;
  grounding_model: string | null;
  monthly_budget_usd: string;
  max_decisions_per_day: number;
  current_playbook_version: number | null;
  company_display_name: string | null;
}

export interface AgentContextLead {
  id: string;
  firstName: string;
  lastName: string;
  company: string;
  designation: string | null;
  industry: string | null;
  revenueRange: string | null;
  source: string;
  websiteMessage: string | null;
  pipelineStage: PipelineStage;
  lifecycleState: LifecycleState;
  objectionType: ObjectionType | null;
  lossReason: LeadLossReason | null;
  ownerName: string | null;
  ownerEmail: string | null;
}

export interface AgentTimelineEntry {
  at: string;
  kind: string;
  title: string;
  detail: string | null;
}

export interface AgentPastMessage {
  at: string;
  channel: "email" | "whatsapp";
  subject: string | null;
  body: string;
  outcome: string;
}

export interface AgentDecisionSummary {
  at: string;
  action: string;
  outcome: string;
  reasoning: string;
}

export interface AgentKnowledgeChunk {
  id: string;
  title: string;
  text: string;
}

export interface AgentAssetSummary {
  id: string;
  title: string;
  useWhen: string;
  channels: string[];
  sizeBytes: number;
}

export interface AgentContext {
  workspaceId: string;
  /** The selling company as the agent names it: agent_settings.company_display_name, else the workspace name. */
  companyName: string;
  workspaceName: string;
  lead: AgentContextLead;
  settings: AgentSettingsRow;
  /** Exactly what validateDecision needs. */
  rules: RulesContext;
  /** Oldest first. */
  timeline: AgentTimelineEntry[];
  /** Oldest first. */
  pastMessages: AgentPastMessage[];
  /** Oldest first. */
  decisionSummaries: AgentDecisionSummary[];
  playbook: { version: number; body: string } | null;
  knowledge: { query: string; chunks: AgentKnowledgeChunk[] };
  assets: AgentAssetSummary[];
  meta: { tokenEstimate: number; trimmedTimelineEvents: number; trimmedDecisionSummaries: number };
}

export interface AgentContextDeps {
  embedder: Embedder;
  /** The legacy env sender (SMTP_FROM_ADDRESS) used while a workspace has no saved email connection. */
  fallbackSenderAddress?: string | null;
}

const latest = (dates: Date[]) => (dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null);
const truncate = (text: string | null, max: number) => (text && text.length > max ? `${text.slice(0, max - 1)}…` : text);

// Timeline events worth showing the agent: calls (with outcome), notes, meetings, proposals,
// stage changes, manual/inbound email and WhatsApp, and lifecycle changes.
const TIMELINE_KINDS = ["call", "note", "meeting", "proposal", "stage", "email", "whatsapp"];
const LIFECYCLE_TITLES = ["Won", "Lost", "Discarded", "Do Not Contact", "Moved to Long-Term Nurture", "Reactivated", "Merged"];
const WEBSITE_TITLES = ["Website form submission", "Website form submitted again"];

export async function buildAgentContext(
  db: Queryable,
  workspaceId: string,
  leadId: string,
  now: Date,
  deps: AgentContextDeps,
): Promise<AgentContext> {
  const leadRow = (
    await db.query<{
      id: string;
      first_name: string;
      last_name: string;
      company: string;
      job_title: string | null;
      industry: string | null;
      revenue_range: string | null;
      source: string;
      email: string | null;
      phone_e164: string | null;
      pipeline_stage: PipelineStage;
      lifecycle_state: LifecycleState;
      objection_type: ObjectionType | null;
      loss_reason: LeadLossReason | null;
      agent_status: AgentStatus;
      agent_touch_count: number;
      agent_last_touch_at: Date | null;
      owner_id: string | null;
      owner_name: string | null;
      owner_email: string | null;
      company_name: string;
    }>(
      `select l.id, l.first_name, l.last_name, l.company, l.job_title, l.industry, l.revenue_range, l.source,
              l.email, l.phone_e164, l.pipeline_stage, l.lifecycle_state, l.objection_type, l.loss_reason,
              l.agent_status, l.agent_touch_count, l.agent_last_touch_at, l.owner_id,
              o.full_name as owner_name, o.email as owner_email, w.name as company_name
         from public.leads l
         join public.workspaces w on w.id = l.workspace_id
         left join public.profiles o on o.id = l.owner_id
        where l.id = $1 and l.workspace_id = $2`,
      [leadId, workspaceId],
    )
  ).rows[0];
  if (!leadRow) throw new NotFoundError("Lead");

  const settings = (await db.query<AgentSettingsRow>(`select * from public.agent_settings where workspace_id = $1`, [workspaceId])).rows[0];
  if (!settings) throw new NotFoundError("Agent settings");
  const shadow = settings.mode === "shadow";

  const [website, channels, sends, repActivity, lastCall, timelineRows, pastRows, summaryRows, playbookRow, assetRows, sender] = await Promise.all([
    db.query<{ message: string | null }>(
      `select t.metadata ->> 'rawMessage' as message
         from public.timeline_events t join public.leads l on l.id = t.lead_id
        where t.lead_id = $1 and l.workspace_id = $2 and t.title = any($3::text[]) and t.metadata ? 'rawMessage'
        order by t.occurred_at desc limit 1`,
      [leadId, workspaceId, WEBSITE_TITLES],
    ),
    db.query<{ channel: string; status: string }>(
      `select c.channel::text as channel, c.status
         from public.lead_contact_channels c join public.leads l on l.id = c.lead_id
        where c.lead_id = $1 and l.workspace_id = $2`,
      [leadId, workspaceId],
    ),
    // Touches: real sends; in shadow also the drafts the rules allowed, so shadow drafts
    // respect the same gaps and limits a live agent would (leads.agent_touch_* stay real-only).
    db.query<{ action: string; at: Date }>(
      `select action, coalesce(send_at, created_at) as at from public.agent_decisions
        where lead_id = $1 and workspace_id = $2 and action in ('send_email', 'send_whatsapp')
          and (outcome = 'sent' or ($3::boolean and outcome = 'draft' and coalesce((rules_result ->> 'allowed')::boolean, false)))`,
      [leadId, workspaceId, shadow],
    ),
    db.query<{ at: Date | null }>(
      `select greatest(
         (select max(created_at) from public.calls where lead_id = $1 and workspace_id = $2),
         (select max(n.created_at) from public.lead_notes n join public.leads l on l.id = n.lead_id where n.lead_id = $1 and l.workspace_id = $2)
       ) as at`,
      [leadId, workspaceId],
    ),
    db.query<{ outcome: string | null }>(
      `select coalesce(connected_outcome::text, not_connected_reason::text) as outcome from public.calls
        where lead_id = $1 and workspace_id = $2 order by created_at desc limit 1`,
      [leadId, workspaceId],
    ),
    db.query<{ occurred_at: Date; event_kind: string; title: string; detail: string | null }>(
      `select t.occurred_at, t.event_kind, t.title, t.detail
         from public.timeline_events t join public.leads l on l.id = t.lead_id
        where t.lead_id = $1 and l.workspace_id = $2
          and (t.event_kind = any($3::text[]) or (t.event_kind = 'system' and t.title = any($4::text[])))
        order by t.occurred_at desc, t.created_at desc limit $5`,
      [leadId, workspaceId, TIMELINE_KINDS, LIFECYCLE_TITLES, TIMELINE_LIMIT],
    ),
    db.query<{ created_at: Date; action: "send_email" | "send_whatsapp"; message_subject: string | null; message_body: string | null; outcome: string }>(
      `select created_at, action, message_subject, message_body, outcome from public.agent_decisions
        where lead_id = $1 and workspace_id = $2 and action in ('send_email', 'send_whatsapp') and message_body is not null
        order by created_at desc limit $3`,
      [leadId, workspaceId, PAST_MESSAGES_LIMIT],
    ),
    db.query<{ created_at: Date; action: string; outcome: string; reasoning: string | null }>(
      `select created_at, action, outcome, reasoning from public.agent_decisions
        where lead_id = $1 and workspace_id = $2 order by created_at desc limit $3`,
      [leadId, workspaceId, SUMMARY_LIMIT],
    ),
    settings.current_playbook_version === null
      ? Promise.resolve({ rows: [] as { version: number; body: string }[] })
      : db.query<{ version: number; body: string }>(
          `select version, body from public.agent_playbooks where workspace_id = $1 and version = $2`,
          [workspaceId, settings.current_playbook_version],
        ),
    db.query<{ id: string; title: string; use_when: string; channels: string[]; size_bytes: string | null }>(
      `select id, title, use_when, channels, size_bytes from public.agent_assets
        where workspace_id = $1 and is_active order by title`,
      [workspaceId],
    ),
    db.query<{ address: string | null }>(
      `select case when provider is not null then settings ->> 'senderAddress' end as address
         from public.integration_connections where workspace_id = $1 and id = 'email'`,
      [workspaceId],
    ),
  ]);

  const lead: AgentContextLead = {
    id: leadRow.id,
    firstName: leadRow.first_name,
    lastName: leadRow.last_name,
    company: leadRow.company,
    designation: leadRow.job_title,
    industry: leadRow.industry,
    revenueRange: leadRow.revenue_range,
    source: leadRow.source,
    websiteMessage: website.rows[0]?.message ?? null,
    pipelineStage: leadRow.pipeline_stage,
    lifecycleState: leadRow.lifecycle_state,
    objectionType: leadRow.objection_type,
    lossReason: leadRow.loss_reason,
    ownerName: leadRow.owner_name,
    ownerEmail: leadRow.owner_email,
  };

  const status = (channel: string) => channels.rows.find((c) => c.channel === channel)?.status ?? null;
  const weekAgo = now.getTime() - 7 * 24 * 3600 * 1000;
  const senderAddress = sender.rows[0]?.address || deps.fallbackSenderAddress || null;
  const assets: AgentAssetSummary[] = assetRows.rows.map((a) => ({
    id: a.id,
    title: a.title,
    useWhen: a.use_when,
    channels: a.channels,
    sizeBytes: Number(a.size_bytes ?? 0),
  }));

  const rules: RulesContext = {
    lead: {
      lifecycleState: leadRow.lifecycle_state,
      agentStatus: leadRow.agent_status,
      pipelineStage: leadRow.pipeline_stage,
      email: leadRow.email,
      phoneE164: leadRow.phone_e164,
      agentTouchCount: shadow ? sends.rows.length : leadRow.agent_touch_count,
      agentLastTouchAt: shadow ? latest(sends.rows.map((s) => s.at)) : leadRow.agent_last_touch_at,
      ownerId: leadRow.owner_id,
      ownerName: leadRow.owner_name,
    },
    contactability: { email: status("email"), whatsapp: status("whatsapp"), phone: status("phone") },
    // A deferred draft's touch time can be in the future; nextAllowedSendTime ignores touches after its candidate time.
    recentTouchTimes: sends.rows.map((s) => s.at).filter((at) => at.getTime() >= weekAgo),
    lastRepActivityAt: repActivity.rows[0]?.at ?? null,
    hasSentWhatsApp: sends.rows.some((s) => s.action === "send_whatsapp"),
    assets: assets.map((a) => ({ id: a.id, active: true, channels: a.channels, sizeBytes: a.sizeBytes })),
    allowedContacts: {
      emails: [...new Set([leadRow.email, leadRow.owner_email, senderAddress].filter((v): v is string => Boolean(v)).map((v) => v.toLowerCase()))],
      phones: leadRow.phone_e164 ? [leadRow.phone_e164] : [],
    },
    mode: settings.mode,
  };

  const query = buildKbQuery(lead, lastCall.rows[0] ?? null);
  const hits = await searchKnowledge(db, deps.embedder, workspaceId, query, { limit: KB_LIMIT });

  const context: AgentContext = {
    workspaceId,
    companyName: settings.company_display_name ?? leadRow.company_name,
    workspaceName: leadRow.company_name,
    lead,
    settings,
    rules,
    timeline: timelineRows.rows.reverse().map((t) => ({
      at: t.occurred_at.toISOString(),
      kind: t.event_kind,
      title: truncate(t.title, TEXT_LIMIT)!,
      detail: truncate(t.detail, TEXT_LIMIT),
    })),
    pastMessages: pastRows.rows.reverse().map((d) => ({
      at: d.created_at.toISOString(),
      channel: d.action === "send_email" ? "email" : "whatsapp",
      subject: d.message_subject,
      body: d.message_body!,
      outcome: d.outcome,
    })),
    decisionSummaries: summaryRows.rows.reverse().map((d) => ({
      at: d.created_at.toISOString(),
      action: d.action,
      outcome: d.outcome,
      reasoning: truncate(d.reasoning, REASONING_LIMIT) ?? "",
    })),
    playbook: playbookRow.rows[0] ?? null,
    knowledge: { query, chunks: hits.map((h) => ({ id: h.chunkId, title: h.documentTitle, text: h.content })) },
    assets,
    meta: { tokenEstimate: 0, trimmedTimelineEvents: 0, trimmedDecisionSummaries: 0 },
  };
  return trimToCap(context, CONTEXT_TOKEN_CAP);
}

const tokensOf = (value: unknown) => countTokens(JSON.stringify(value));

/**
 * Keeps the context under `cap` tokens (a JSON estimate) by dropping the oldest
 * timeline events, then the oldest decision summaries. The playbook, knowledge
 * chunks and past messages are never trimmed. Exported for tests.
 */
export function trimToCap(context: AgentContext, cap: number): AgentContext {
  const { timeline, decisionSummaries, ...rest } = context;
  const timelineTokens = timeline.map(tokensOf);
  const summaryTokens = decisionSummaries.map(tokensOf);
  let total = tokensOf(rest) + timelineTokens.reduce((a, b) => a + b, 0) + summaryTokens.reduce((a, b) => a + b, 0);
  let dropTimeline = 0;
  while (total > cap && dropTimeline < timeline.length) total -= timelineTokens[dropTimeline++]!;
  let dropSummaries = 0;
  while (total > cap && dropSummaries < decisionSummaries.length) total -= summaryTokens[dropSummaries++]!;
  return {
    ...context,
    timeline: timeline.slice(dropTimeline),
    decisionSummaries: decisionSummaries.slice(dropSummaries),
    meta: { tokenEstimate: total, trimmedTimelineEvents: dropTimeline, trimmedDecisionSummaries: dropSummaries },
  };
}
