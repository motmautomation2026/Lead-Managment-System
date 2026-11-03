import type { Queryable } from "../dto.js";
import { NotFoundError } from "../errors.js";
import type { LeadLossReason, LifecycleState, ObjectionType, PipelineStage } from "../domain/enums.js";
import { emailUsable, isFreshInbound, whatsappUsable, type AgentMode, type AgentRuleSettings, type AgentStatus, type RulesContext } from "../agent/rules.js";
import { stagePlan, type StagePlan, type StagePlanInput } from "../agent/stagePlan.js";
import { buildKbQuery } from "../agent/kbQuery.js";
import { situationOf } from "../agent/situation.js";
import { signalsOf } from "../agent/signals.js";
import { companyDescription, companyFacts, resolveCompany, type CompanyFacts, type CompanyRecord } from "../agent/companyFacts.js";
import { buildDealContext, type AgentDealContext, type AgentDealRow } from "../agent/dealContext.js";
import { effectiveMode, liveChannels, type LiveScope } from "../agent/liveMode.js";
import { countTokens } from "../knowledge/chunkText.js";
import type { Embedder } from "../providers/openai.provider.js";
import { latestAiEmail, type AiEmailThread } from "./agentSendState.service.js";
import { searchKnowledge } from "./knowledge.service.js";
import { assetFileSize } from "./knowledgeLibrary.service.js";

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
  live_scope: LiveScope;
  live_since: Date | null;
  banned_phrases: string[];
  style_examples: string;
  first_channel: "whatsapp" | "email";
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
  /** The playbook version the message was written under (null = before it was recorded). */
  playbookVersion: number | null;
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
  /** The linked company's facts (company first, contact fallback); lead data, an approved grounding source. Null = no company. */
  company: CompanyFacts | null;
  /** Decide-only context, never stated to the lead and never a grounding source. Never trimmed. */
  internal: { companyDescription: string | null; deal: AgentDealContext };
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
  /** E2c rule 2: a real AI send got a matched reply (WhatsApp or email) after it. */
  aiSendReplied: boolean;
  /** E3a rule 7: the real AI email a follow-up email continues; null = a new email needs its own subject. */
  emailThread: AiEmailThread | null;
  /** E3b-1 rule 1: the stage plan; null = the lifecycle isn't one the agent acts on. */
  stagePlan: StagePlan | null;
  /** What the stage plan was computed from (agent:model-test / --evaluate recompute it without touches). */
  stagePlanInput: StagePlanInput | null;
  /** E3b-1: the latest held meeting's outcome and notes (lead data for meeting_recap; null = none). */
  latestMeeting: { outcome: string | null; notes: string | null } | null;
  knowledge: { query: string; chunks: AgentKnowledgeChunk[] };
  assets: AgentAssetSummary[];
  meta: { tokenEstimate: number; trimmedTimelineEvents: number; trimmedDecisionSummaries: number };
}

export interface AgentContextDeps {
  embedder: Embedder;
}

const companyJson = (alias: string) =>
  `case when ${alias}.id is null then null else json_build_object(
     'id', ${alias}.id, 'name', ${alias}.name, 'domain', ${alias}.domain, 'website', ${alias}.website, 'industry', ${alias}.industry,
     'revenueRange', ${alias}.revenue_range, 'city', ${alias}.city, 'state', ${alias}.state, 'country', ${alias}.country,
     'employeeRange', ${alias}.employee_range, 'description', ${alias}.description, 'mergedIntoCompanyId', ${alias}.merged_into_company_id) end`;

const latest = (dates: Date[]) => (dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null);
const truncate = (text: string | null, max: number) => (text && text.length > max ? `${text.slice(0, max - 1)}…` : text);

// Timeline events worth showing the agent: calls (with outcome), notes, meetings, proposals,
// stage changes, manual/inbound email and WhatsApp, and lifecycle changes.
const TIMELINE_KINDS = ["call", "note", "meeting", "proposal", "stage", "email", "whatsapp"];
const LIFECYCLE_TITLES = ["Won", "Lost", "Discarded", "Do Not Contact", "Moved to Long-Term Nurture", "Reactivated", "Merged"];
const WEBSITE_TITLES = ["Website form submission", "Website form submitted again"];
const UPCOMING_MEETING_STATUSES = ["tentative", "scheduled", "confirmed", "rescheduled"];

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
      agent_live_test: boolean;
      created_at: Date;
      owner_id: string | null;
      owner_name: string | null;
      owner_email: string | null;
      company_name: string;
      linked_company: CompanyRecord | null;
      merge_target: CompanyRecord | null;
      deals: (Omit<AgentDealRow, "updatedAt" | "stageSince"> & { updatedAt: string; stageSince: string })[];
    }>(
      `select l.id, l.first_name, l.last_name, l.company, l.job_title, l.industry, l.revenue_range, l.source,
              l.email, l.phone_e164, l.pipeline_stage, l.lifecycle_state, l.objection_type, l.loss_reason,
              l.agent_status, l.agent_touch_count, l.agent_last_touch_at, l.agent_live_test, l.created_at, l.owner_id,
              o.full_name as owner_name, o.email as owner_email, w.name as company_name,
              ${companyJson("c")} as linked_company, ${companyJson("cm")} as merge_target,
              coalesce(dl.deals, '[]'::json) as deals
         from public.leads l
         join public.workspaces w on w.id = l.workspace_id
         left join public.profiles o on o.id = l.owner_id
         left join public.companies c on c.id = l.company_id and c.workspace_id = l.workspace_id
         left join public.companies cm on cm.id = c.merged_into_company_id and cm.workspace_id = l.workspace_id
         -- The contact's deals for the decide-only deal context: never amounts, loss reasons/notes or owners.
         left join lateral (
           select json_agg(json_build_object(
                    'id', d.id, 'name', d.name, 'stage', d.stage, 'updatedAt', d.updated_at,
                    -- Every stage move writes a timeline row with metadata.to (moveDealStage).
                    'stageSince', coalesce((select max(t.occurred_at) from public.timeline_events t
                                             where t.related_deal_id = d.id and t.metadata ->> 'to' = d.stage::text), d.created_at),
                    'expectedCloseDate', d.expected_close_date::text,
                    'latestMeeting', (select json_build_object('status', m.status, 'scheduledAt', m.scheduled_at)
                                        from public.meetings m where m.deal_id = d.id order by m.scheduled_at desc limit 1),
                    'latestProposal', (select json_build_object('status', p.status)
                                         from public.proposals p where p.deal_id = d.id order by p.updated_at desc, p.id desc limit 1))) as deals
             from public.deals d where d.lead_id = l.id and d.workspace_id = l.workspace_id
         ) dl on true
        where l.id = $1 and l.workspace_id = $2`,
      [leadId, workspaceId],
    )
  ).rows[0];
  if (!leadRow) throw new NotFoundError("Lead");

  const settings = (await db.query<AgentSettingsRow>(`select * from public.agent_settings where workspace_id = $1`, [workspaceId])).rows[0];
  if (!settings) throw new NotFoundError("Agent settings");
  // E2 rule 2: in a live workspace a contact outside the live scope runs as shadow.
  const mode = effectiveMode(settings, { agentLiveTest: leadRow.agent_live_test, createdAt: leadRow.created_at });
  const shadow = mode === "shadow";

  const [website, channels, sends, repActivity, lastCall, timelineRows, pastRows, summaryRows, playbookRow, assetRows, sender, imap, replied, assetHistory, emailThread, stageRows] = await Promise.all([
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
    // A live contact counts real sends only (E2 rule 6).
    db.query<{ action: string; at: Date }>(
      `select action, coalesce(sent_at, send_at, created_at) as at from public.agent_decisions
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
    db.query<{ created_at: Date; action: "send_email" | "send_whatsapp"; message_subject: string | null; message_body: string | null; outcome: string; playbook_version: number | null }>(
      `select created_at, action, message_subject, message_body, outcome, playbook_version from public.agent_decisions
        where lead_id = $1 and workspace_id = $2 and action in ('send_email', 'send_whatsapp') and message_body is not null
          and ($4::boolean or outcome = 'sent')
        order by created_at desc limit $3`,
      // Only a live contact's history is limited to real sends (E2 rule 6); drafts are labelled in the prompt.
      [leadId, workspaceId, PAST_MESSAGES_LIMIT, mode !== "live"],
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
    db.query<{ id: string; title: string; use_when: string; channels: string[]; size_bytes: string | null; storage_path: string }>(
      `select id, title, use_when, channels, size_bytes, storage_path from public.agent_assets
        where workspace_id = $1 and is_active order by title`,
      [workspaceId],
    ),
    db.query<{ address: string | null }>(
      `select case when provider = 'smtp' then settings ->> 'senderAddress' end as address
         from public.integration_connections where workspace_id = $1 and id = 'email'`,
      [workspaceId],
    ),
    db.query<{ last_success_at: Date | null }>(`select last_success_at from public.email_imap_state where workspace_id = $1`, [workspaceId]),
    db.query<{ replied: boolean }>(
      `select exists (
         select 1 from public.agent_decisions d
          where d.lead_id = $1 and d.workspace_id = $2 and d.outcome = 'sent' and d.sent_at is not null
            and (exists (select 1 from public.whatsapp_inbound_events w
                          where w.lead_id = $1 and w.workspace_id = $2 and w.disposition = 'matched' and w.received_at > d.sent_at)
              or exists (select 1 from public.email_inbound_events e
                          where e.lead_id = $1 and e.workspace_id = $2 and e.kind = 'reply' and e.match_status = 'matched' and e.received_at > d.sent_at))
       ) as replied`,
      [leadId, workspaceId],
    ),
    // E2g rules 3–4: a WhatsApp reply from this contact, and the assets really sent to them.
    db.query<{ whatsapp_replied: boolean; sent_asset_ids: string[]; failed_asset_ids: string[] }>(
      `select exists (select 1 from public.whatsapp_inbound_events
                       where lead_id = $1 and workspace_id = $2 and disposition = 'matched') as whatsapp_replied,
              coalesce((select array_agg(distinct a) from public.agent_decisions d, unnest(d.sent_asset_ids) a
                         where d.lead_id = $1 and d.workspace_id = $2 and d.outcome = 'sent'), '{}') as sent_asset_ids,
              coalesce((select array_agg(distinct i ->> 'assetId') from public.agent_decisions d, jsonb_array_elements(d.attachment_issues) i
                         where d.lead_id = $1 and d.workspace_id = $2 and d.attachment_issues is not null), '{}') as failed_asset_ids`,
      [leadId, workspaceId],
    ),
    latestAiEmail(db, leadId, now),
    // E3b-1 rule 1: the stage plan's meeting / proposal facts.
    db.query<{
      meeting: { status: string; outcome: string | null; scheduledAt: string; notes: string | null } | null;
      has_upcoming: boolean;
      proposal: { status: string; sentAt: string | null } | null;
      rep_owned_before: boolean;
    }>(
      `select (select json_build_object('status', m.status, 'outcome', m.outcome, 'scheduledAt', m.scheduled_at, 'notes', m.notes)
                 from public.meetings m where m.lead_id = $1 and m.workspace_id = $2 order by m.scheduled_at desc limit 1) as meeting,
              exists (select 1 from public.meetings m where m.lead_id = $1 and m.workspace_id = $2
                       and m.status = any($3::meeting_status[]) and m.scheduled_at > $4) as has_upcoming,
              (select json_build_object('status', p.status, 'sentAt', p.sent_at)
                 from public.proposals p where p.lead_id = $1 and p.workspace_id = $2 order by p.updated_at desc, p.id desc limit 1) as proposal,
              exists (select 1 from public.agent_decisions d where d.lead_id = $1 and d.workspace_id = $2 and d.stage_key = 'rep_owned') as rep_owned_before`,
      [leadId, workspaceId, UPCOMING_MEETING_STATUSES, now],
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

  const company = resolveCompany(leadRow.linked_company, leadRow.merge_target);
  const deals: AgentDealRow[] = leadRow.deals.map((d) => ({ ...d, updatedAt: new Date(d.updatedAt), stageSince: new Date(d.stageSince) }));

  const status = (channel: string) => channels.rows.find((c) => c.channel === channel)?.status ?? null;
  const weekAgo = now.getTime() - 7 * 24 * 3600 * 1000;
  const senderAddress = sender.rows[0]?.address || null;
  const { emailBlockedReason } = liveChannels(mode, imap.rows[0]?.last_success_at ?? null, now);
  // E2h: an asset that couldn't be sent to this contact isn't offered again, or a cancelled message would wake, pick it and cancel for ever.
  const failedAssetIds = assetHistory.rows[0]?.failed_asset_ids ?? [];
  const assets: AgentAssetSummary[] = await Promise.all(
    assetRows.rows
      .filter((a) => !failedAssetIds.includes(a.id))
      .map(async (a) => ({
        id: a.id,
        title: a.title,
        useWhen: a.use_when,
        channels: a.channels,
        // E2h rule 3: no recorded size → Storage; still unknown → 0 (allowed), and the send handles an oversized file.
        sizeBytes: Number(a.size_bytes ?? (await assetFileSize(a.storage_path)) ?? 0),
      })),
  );

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
    mode,
    // Only when blocked, so a shadow contact's rules context (and prompt) is unchanged.
    ...(emailBlockedReason ? { emailBlockedReason } : {}),
  };

  const context: AgentContext = {
    workspaceId,
    companyName: settings.company_display_name ?? leadRow.company_name,
    workspaceName: leadRow.company_name,
    lead,
    company: companyFacts(company, lead),
    internal: { companyDescription: companyDescription(company), deal: buildDealContext(deals, now) },
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
      playbookVersion: d.playbook_version,
    })),
    decisionSummaries: summaryRows.rows.reverse().map((d) => ({
      at: d.created_at.toISOString(),
      action: d.action,
      outcome: d.outcome,
      reasoning: truncate(d.reasoning, REASONING_LIMIT) ?? "",
    })),
    playbook: playbookRow.rows[0] ?? null,
    aiSendReplied: replied.rows[0]?.replied ?? false,
    emailThread,
    stagePlan: null,
    stagePlanInput: null,
    latestMeeting: null,
    knowledge: { query: "", chunks: [] },
    assets,
    meta: { tokenEstimate: 0, trimmedTimelineEvents: 0, trimmedDecisionSummaries: 0 },
  };
  // E2f rule 6: only when present, so a contact without a signal keeps today's rules context.
  const signal = signalsOf(context)[0];
  if (signal) context.rules.signal = { action: signal.action, title: signal.title };
  const situation = situationOf(context);
  // E3b-1 rules 1–4: the stage plan and the speed-to-lead window.
  const stage = stageRows.rows[0]!;
  const meeting = stage.meeting;
  context.latestMeeting = meeting?.status === "completed" ? { outcome: meeting.outcome, notes: truncate(meeting.notes?.trim() || null, TEXT_LIMIT) } : null;
  context.stagePlanInput = {
    now,
    lifecycleState: leadRow.lifecycle_state,
    nurtureLongTerm: settings.nurture_long_term,
    pipelineStage: leadRow.pipeline_stage,
    openDealStage: context.internal.deal.open?.stage ?? null,
    lastCallOrNoteAt: rules.lastRepActivityAt,
    latestMeeting: meeting
      ? { status: meeting.status, outcome: meeting.outcome, scheduledAt: new Date(meeting.scheduledAt), hasNotes: Boolean(meeting.notes?.trim()) }
      : null,
    hasUpcomingMeeting: stage.has_upcoming,
    latestProposal: stage.proposal ? { status: stage.proposal.status, sentAt: stage.proposal.sentAt ? new Date(stage.proposal.sentAt) : null } : null,
    touches: sends.rows
      .map((s) => ({ at: s.at, channel: s.action === "send_email" ? ("email" as const) : ("whatsapp" as const) }))
      .sort((a, b) => a.at.getTime() - b.at.getTime()),
    conversationExists: situation.conversationExists,
    emailUsable: emailUsable(rules),
    whatsappUsable: whatsappUsable(rules),
    firstChannel: settings.first_channel,
    maxTouchesTotal: settings.max_touches_total,
    repOwnedBefore: stage.rep_owned_before,
  };
  context.stagePlan = stagePlan(context.stagePlanInput);
  context.rules.stagePlan = context.stagePlan;
  if (isFreshInbound({ source: leadRow.source, createdAt: leadRow.created_at, touchCount: rules.lead.agentTouchCount }, now)) context.rules.freshInbound = true;
  // E2g rules 2–4. Drafts never count: pastMessages' "sent" rows are real sends.
  context.rules.assetFacts = {
    conversationExists: situation.conversationExists,
    realMessageSent: context.pastMessages.some((m) => m.outcome === "sent") || context.timeline.some((t) => t.kind === "email" || t.kind === "whatsapp"),
    whatsappReplied: assetHistory.rows[0]?.whatsapp_replied ?? false,
    sentAssetIds: assetHistory.rows[0]?.sent_asset_ids ?? [],
  };
  // E2b rule 5: the query adds topics for where the conversation stands.
  const query = buildKbQuery(lead, lastCall.rows[0] ?? null, situation);
  // E2g rule 5: an asset's file is never a fact source: its chunks reach neither the decision nor grounding.
  const hits = await searchKnowledge(db, deps.embedder, workspaceId, query, { limit: KB_LIMIT, excludeDocTypes: ["asset"] });
  context.knowledge = { query, chunks: hits.map((h) => ({ id: h.chunkId, title: h.documentTitle, text: h.content })) };
  return trimToCap(context, CONTEXT_TOKEN_CAP);
}

const tokensOf = (value: unknown) => countTokens(JSON.stringify(value));

/**
 * Keeps the context under `cap` tokens (a JSON estimate) by dropping the oldest
 * timeline events, then the oldest decision summaries. The playbook, knowledge
 * chunks, past messages, company and internal context are never trimmed. Exported for tests.
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
