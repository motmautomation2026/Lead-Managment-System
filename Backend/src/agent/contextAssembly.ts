import type { LeadLossReason, LifecycleState, ObjectionType, PipelineStage } from "../domain/enums.js";
import { emailUsable, isFreshInbound, whatsappUsable, type AgentStatus, type RulesContext } from "./rules.js";
import { leadIsDeciding, stagePlan } from "./stagePlan.js";
import { buildKbQuery } from "./kbQuery.js";
import { situationOf } from "./situation.js";
import { signalsOf } from "./signals.js";
import { companyDescription, companyFacts, resolveCompany, type CompanyRecord } from "./companyFacts.js";
import { buildDealContext, type AgentDealRow } from "./dealContext.js";
import { effectiveMode, liveChannels } from "./liveMode.js";
import { countTokens } from "../knowledge/chunkText.js";
import type {
  AgentAssetSummary,
  AgentContext,
  AgentContextLead,
  AgentKnowledgeChunk,
  AgentSettingsRow,
} from "../services/agentContext.service.js";
import type { AiEmailThread } from "../services/agentSendState.service.js";

/**
 * DEMO-1 rule 2: the agent context, assembled from the facts buildAgentContext reads. No I/O
 * and no database import: buildAgentContext loads the source with SQL (services/agentContext.service.ts)
 * and the offline demo journey builds it in memory; both go through this one function.
 */

export const CONTEXT_TOKEN_CAP = 12_000;
const TEXT_LIMIT = 1_000;
const REASONING_LIMIT = 200;

/** The lead row as buildAgentContext's first query returns it (snake_case, pg types). */
export interface AgentContextLeadRow {
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
  owner_booking_url: string | null;
  company_name: string;
  linked_company: CompanyRecord | null;
  merge_target: CompanyRecord | null;
  deals: (Omit<AgentDealRow, "updatedAt" | "stageSince"> & { updatedAt: string; stageSince: string })[];
}

/** The stage plan's meeting / proposal facts (E3b-1 rule 1). */
export interface AgentContextStageRow {
  meeting: { status: string; outcome: string | null; scheduledAt: string; notes: string | null } | null;
  has_upcoming: boolean;
  proposal: { status: string; sentAt: string | null } | null;
  rep_owned_before: boolean;
  call_or_meeting_held: boolean;
}

/** Everything one decision's context is built from. Rows keep their SQL shape and order. */
export interface AgentContextSource {
  workspaceId: string;
  lead: AgentContextLeadRow;
  settings: AgentSettingsRow;
  /** The latest website-form enquiry text. */
  websiteMessage: string | null;
  /** lead_contact_channels rows. */
  channels: { channel: string; status: string }[];
  /** The touches that count for the contact's effective mode (real sends; in shadow also allowed drafts; LL-3: + TRIED_CALLING_ACTION rows). */
  sends: { action: string; at: Date }[];
  /** The latest call or note a rep logged. */
  lastRepActivityAt: Date | null;
  /** The latest call's outcome (connected outcome or not-connected reason); null = no call. */
  lastCall: { outcome: string | null } | null;
  /** Newest first. */
  timeline: { occurred_at: Date; event_kind: string; title: string; detail: string | null }[];
  /** Newest first: earlier send decisions with a message (live: real sends only). */
  pastMessages: { created_at: Date; action: "send_email" | "send_whatsapp"; message_subject: string | null; message_body: string | null; outcome: string; playbook_version: number | null }[];
  /** Newest first. */
  decisionSummaries: { created_at: Date; action: string; outcome: string; reasoning: string | null }[];
  playbook: { version: number; body: string } | null;
  /** Active assets the contact may still get (E2h: failed ones already left out), with their sizes. */
  assets: AgentAssetSummary[];
  /** The workspace's SMTP sender address (null = none). */
  senderAddress: string | null;
  imapLastSuccessAt: Date | null;
  aiSendReplied: boolean;
  assetHistory: { whatsappReplied: boolean; sentAssetIds: string[] };
  emailThread: AiEmailThread | null;
  stage: AgentContextStageRow;
}

/** The knowledge search: the query text → the top chunks (production: pgvector, top 8, no asset documents). */
export type KnowledgeSearch = (query: string) => Promise<AgentKnowledgeChunk[]>;

const latest = (dates: Date[]) => (dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null);
export const truncate = (text: string | null, max: number) => (text && text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The contact's effective mode (E2 rule 2), which also decides which touches and past messages the source holds. */
export const sourceMode = (settings: AgentSettingsRow, lead: Pick<AgentContextLeadRow, "agent_live_test" | "created_at">) =>
  effectiveMode(settings, { agentLiveTest: lead.agent_live_test, createdAt: lead.created_at });

export async function assembleAgentContext(source: AgentContextSource, now: Date, search: KnowledgeSearch): Promise<AgentContext> {
  const { lead: leadRow, settings, workspaceId } = source;
  // E2 rule 2: in a live workspace a contact outside the live scope runs as shadow.
  const mode = sourceMode(settings, leadRow);
  const shadow = mode === "shadow";

  const lead: AgentContextLead = {
    id: leadRow.id,
    firstName: leadRow.first_name,
    lastName: leadRow.last_name,
    company: leadRow.company,
    designation: leadRow.job_title,
    industry: leadRow.industry,
    revenueRange: leadRow.revenue_range,
    source: leadRow.source,
    websiteMessage: source.websiteMessage,
    pipelineStage: leadRow.pipeline_stage,
    lifecycleState: leadRow.lifecycle_state,
    objectionType: leadRow.objection_type,
    lossReason: leadRow.loss_reason,
    ownerName: leadRow.owner_name,
    ownerEmail: leadRow.owner_email,
    ownerBookingUrl: leadRow.owner_booking_url,
  };

  const company = resolveCompany(leadRow.linked_company, leadRow.merge_target);
  const deals: AgentDealRow[] = leadRow.deals.map((d) => ({ ...d, updatedAt: new Date(d.updatedAt), stageSince: new Date(d.stageSince) }));

  // LL-3: "We tried calling" sends count toward the 7-day and total limits only (not the 48 h gap, the journey or channels).
  const allSends = source.sends;
  const sends = allSends.filter((s) => s.action !== TRIED_CALLING_ACTION);
  const triedCalling = allSends.length - sends.length;
  const status = (channel: string) => source.channels.find((c) => c.channel === channel)?.status ?? null;
  const weekAgo = now.getTime() - 7 * 24 * 3600 * 1000;
  const senderAddress = source.senderAddress || null;
  const { emailBlockedReason } = liveChannels(mode, source.imapLastSuccessAt, now);
  const assets = source.assets;

  const rules: RulesContext = {
    lead: {
      lifecycleState: leadRow.lifecycle_state,
      agentStatus: leadRow.agent_status,
      pipelineStage: leadRow.pipeline_stage,
      email: leadRow.email,
      phoneE164: leadRow.phone_e164,
      agentTouchCount: (shadow ? sends.length : leadRow.agent_touch_count) + triedCalling,
      agentLastTouchAt: shadow ? latest(sends.map((s) => s.at)) : leadRow.agent_last_touch_at,
      ownerId: leadRow.owner_id,
      ownerName: leadRow.owner_name,
    },
    contactability: { email: status("email"), whatsapp: status("whatsapp"), phone: status("phone") },
    // A deferred draft's touch time can be in the future; nextAllowedSendTime ignores touches after its candidate time.
    recentTouchTimes: allSends.map((s) => s.at).filter((at) => at.getTime() >= weekAgo),
    lastRepActivityAt: source.lastRepActivityAt,
    hasSentWhatsApp: sends.some((s) => s.action === "send_whatsapp"),
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
    timeline: [...source.timeline].reverse().map((t) => ({
      at: t.occurred_at.toISOString(),
      kind: t.event_kind,
      title: truncate(t.title, TEXT_LIMIT)!,
      detail: truncate(t.detail, TEXT_LIMIT),
    })),
    pastMessages: [...source.pastMessages].reverse().map((d) => ({
      at: d.created_at.toISOString(),
      channel: d.action === "send_email" ? "email" : "whatsapp",
      subject: d.message_subject,
      body: d.message_body!,
      outcome: d.outcome,
      playbookVersion: d.playbook_version,
    })),
    decisionSummaries: [...source.decisionSummaries].reverse().map((d) => ({
      at: d.created_at.toISOString(),
      action: d.action,
      outcome: d.outcome,
      reasoning: truncate(d.reasoning, REASONING_LIMIT) ?? "",
    })),
    playbook: source.playbook,
    aiSendReplied: source.aiSendReplied,
    emailThread: source.emailThread,
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
  const stage = source.stage;
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
      ? { status: meeting.status, outcome: meeting.outcome, scheduledAt: new Date(meeting.scheduledAt), hasNotes: Boolean(meeting.notes?.trim()), deciding: leadIsDeciding(meeting.notes) }
      : null,
    hasUpcomingMeeting: stage.has_upcoming,
    latestProposal: stage.proposal ? { status: stage.proposal.status, sentAt: stage.proposal.sentAt ? new Date(stage.proposal.sentAt) : null } : null,
    touches: sends
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
    whatsappReplied: source.assetHistory.whatsappReplied,
    callOrMeetingHeld: stage.call_or_meeting_held,
    sentAssetIds: source.assetHistory.sentAssetIds,
  };
  // E2b rule 5: the query adds topics for where the conversation stands.
  const query = buildKbQuery(lead, source.lastCall, situation);
  // E2g rule 5 (in the search): an asset's file is never a fact source.
  context.knowledge = { query, chunks: await search(query) };
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

/** LL-3: the `action` of a "We tried calling" WhatsApp in the context's sends (counts toward the 7-day and total limits only). */
export const TRIED_CALLING_ACTION = "tried_calling";
