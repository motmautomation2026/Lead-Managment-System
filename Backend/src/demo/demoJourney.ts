import { z } from "zod";
import { assembleAgentContext, type AgentContextLeadRow, type AgentContextSource, type KnowledgeSearch } from "../agent/contextAssembly.js";
import type { AgentContext, AgentKnowledgeChunk, AgentSettingsRow } from "../services/agentContext.service.js";
import { draftDecision, type Usage } from "../agent/draftDecision.js";
import { composeOutgoing } from "../agent/composeMessage.js";
import { composeReplyDraft, writeReplyDraft } from "../agent/replyDraftWriter.js";
import type { SendDecision } from "../agent/decisionSchema.js";
import { buildDecisionMessages, buildGroundingMessages, buildReplyDraftMessages, type ChatMessage } from "../agent/prompt.js";
import { nextAllowedSendTime, sendWindowSettings } from "../agent/rules.js";
import { ANGLE_LABELS, journeyAngle, preferredChannel, STAGE_LABELS, suggestedDays, type Channel } from "../agent/stagePlan.js";
import { wakeFor } from "../agent/wakePolicy.js";
import { buildReplyClassificationMessages, finalLabel, REPLY_CLASSIFICATION_JSON_SCHEMA, replyEffects, replyTaskTitle, type ReplyLabel } from "../agent/replyClassification.js";
import { costUsd, priceOf, type ModelPrices } from "../agent/pricing.js";
import { URL_RE, wordCount } from "../agent/messageChecks.js";
import { matchReplyKeyword } from "../domain/replyKeywords.js";
import { DRAFT_DEBOUNCE_MS, draftSkipReason } from "../domain/replyDrafts.js";
import { leadScore, type LeadScore } from "../domain/leadScore.js";
import { corporateDomain } from "../domain/companyNormalize.js";
import { normalizePhoneE164 } from "../domain/phone.js";
import { addWorkingTime } from "../domain/workingTime.js";
import { threadSubject } from "../domain/emailSafety.js";
import { chunkText, countTokens } from "../knowledge/chunkText.js";
import { extractText } from "../knowledge/extractText.js";
import type { DecisionModel, Embedder, ReplyClassifierModel } from "../providers/openai.provider.js";

/**
 * DEMO-1: the offline demo journey. Runs the REAL agent pipeline (stage plan, writer prompt,
 * compose step, code checks + auto-fixes, the checker, regeneration, reply drafts, hot score) for
 * the leads in demo-local/demo-leads.json on a simulated clock, with an in-memory context instead
 * of database reads (agent/contextAssembly.ts). No database, no senders: nothing can be sent.
 * Default = dry run (no model or embedding calls; plan, prompt sizes, estimated cost).
 */

// --- Input -------------------------------------------------------------------------

const leadSchema = z.object({
  key: z.string().regex(/^[a-z0-9_-]+$/),
  firstName: z.string().min(1),
  lastName: z.string(),
  company: z.string().nullable(),
  email: z.string().nullable(),
  emailDomainIsCorporate: z.boolean().optional(),
  phone: z.string().nullable(),
  source: z.string(),
  industry: z.string().nullable(),
  revenueRange: z.string().nullable(),
  enquiry: z.string(),
  scenario: z.object({
    repCallNote: z.string().min(1),
    leadReply: z.object({ channel: z.enum(["whatsapp", "email"]), text: z.string().min(1) }),
  }),
});

export const demoInputSchema = z.object({
  workspace: z.object({
    companyDisplayName: z.string().min(1),
    ownerName: z.string().min(1),
    bookingLink: z.string().url().nullable(),
    writer: z.string().min(1),
    checker: z.string().min(1),
    startAtIst: z.string().datetime({ offset: true }),
  }),
  leads: z.array(leadSchema).min(1),
});
export type DemoInput = z.infer<typeof demoInputSchema>;
export type DemoLead = z.infer<typeof leadSchema>;

export interface KnowledgeFile {
  name: string;
  text: string;
}

// --- Production defaults (migrations 024–050, 053) ----------------------------------

/** Migration 048's default banned phrases (a workspace's own list may differ). */
export const DEFAULT_BANNED_PHRASES = [
  "thanks for connecting", "just following up", "just checking in", "any update", "this week", "today", "free",
  "guarantee", "guaranteed", "revolutionary", "skyrocket", "100+", "140+",
  "hope this message finds you well", "hope this email finds you well", "hope you are doing well", "hope you're doing well",
  "I wanted to reach out", "touch base", "circle back", "delve", "leverage", "seamless", "seamlessly", "unlock", "elevate",
  "game-changer", "cutting-edge", "in today's fast-paced", "I came across your", "please do not hesitate", "don't hesitate",
  "feel free to", "at your earliest convenience", "synergy", "revolutionize", "supercharge",
];
/** Migration 053: MOTM's default target industries for the hot score. */
export const MOTM_TARGET_KEYWORDS = [
  "engineering", "manufacturing", "industrial", "machinery", "fabrication", "castings", "forgings", "pumps", "valves", "automation",
  "chemicals", "steel", "polymers", "plastics", "packaging", "electrical", "hydraulics", "conveyors", "tools", "epc", "water treatment",
];
const KB_LIMIT = 8;
const EMBEDDING_PER_1M_USD = 0.02; // text-embedding-3-small list price (not in OPENAI_PRICES_JSON)
// The same planning guess as agent:model-test, for output tokens and attempts per message.
const ESTIMATE = { attempts: 1.4, decideOutput: 400, groundingOutput: 200, labelOutput: 30 };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SIMULATED = /^\s*SIMULATED:\s*/i;
export const stripSimulated = (text: string) => text.replace(SIMULATED, "").trim();

export function demoSettings(input: DemoInput, files: { playbook: KnowledgeFile; style: KnowledgeFile | null }): AgentSettingsRow {
  return {
    mode: "live",
    send_days: [1, 2, 3, 4, 5, 6],
    send_window_start: "09:30:00",
    send_window_end: "19:00:00",
    min_gap_hours: 48,
    max_touches_7d: 2,
    max_touches_total: 8,
    email_max_words: 120,
    whatsapp_max_words: 60,
    wake_min_days: 1,
    wake_max_days: 30,
    nurture_long_term: false,
    rep_quiet_hours: 24,
    email_opt_out_text: `If you'd prefer not to hear from us, just reply "stop".`,
    whatsapp_opt_out_text: "Reply STOP to opt out.",
    decision_model: input.workspace.writer,
    grounding_model: input.workspace.checker,
    monthly_budget_usd: "100",
    max_decisions_per_day: 50,
    current_playbook_version: playbookVersion(files.playbook.name),
    company_display_name: input.workspace.companyDisplayName,
    // The demo contacts are "AI live test" contacts: live without the go-live gate.
    live_scope: "test_contacts",
    live_since: null,
    banned_phrases: DEFAULT_BANNED_PHRASES,
    style_examples: files.style?.text.trim() ?? "",
    first_channel: "whatsapp",
  };
}

const playbookVersion = (name: string) => Number(/_v(\d+)/i.exec(name)?.[1] ?? 1);

/** The playbook, the style examples and the knowledge documents (everything else). */
export function sortKnowledge(files: KnowledgeFile[]) {
  const playbook = files.find((f) => /playbook/i.test(f.name));
  if (!playbook) throw new Error("No playbook file (a name containing PLAYBOOK) in the knowledge folder.");
  const style = files.find((f) => /style_examples/i.test(f.name)) ?? null;
  const documents = files.filter((f) => f !== playbook && f !== style);
  if (!documents.length) throw new Error("No knowledge documents in the knowledge folder.");
  return { playbook, style, documents };
}

// --- Knowledge in memory (rule 3) ----------------------------------------------------

export interface MemoryChunk {
  id: string;
  title: string;
  text: string;
  tokens: number;
}

/** The real extractor + chunker, as ingestion runs them for a text document. */
export async function chunkDocuments(documents: KnowledgeFile[]): Promise<MemoryChunk[]> {
  const chunks: MemoryChunk[] = [];
  for (const doc of documents) {
    const { sections } = await extractText(Buffer.from(doc.text, "utf8"), "text/markdown", doc.name);
    const title = doc.name.replace(/\.[^.]+$/, "");
    chunkText(sections).forEach((c, i) => chunks.push({ id: `${title}#${i}`, title, text: c.content, tokens: c.tokenCount }));
  }
  return chunks;
}

const cosine = (a: number[], b: number[]) => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

/** searchKnowledge in memory: the query embedded, cosine order, top 8 (no asset documents exist here). */
export function memorySearch(chunks: MemoryChunk[], vectors: number[][], embedder: Embedder, onEmbed: (tokens: number) => void): KnowledgeSearch {
  return async (query) => {
    onEmbed(countTokens(query));
    const [vector] = await embedder.embed([query]);
    if (!vector) return [];
    return chunks
      .map((c, i) => ({ c, score: cosine(vector, vectors[i]!) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, KB_LIMIT)
      .map(({ c }) => ({ id: c.id, title: c.title, text: c.text }));
  };
}

/** Dry run (no embeddings): the 8 largest chunks, so the prompt-size estimate is an upper bound. */
export function dryRunSearch(chunks: MemoryChunk[]): KnowledgeSearch {
  const largest = [...chunks].sort((a, b) => b.tokens - a.tokens).slice(0, KB_LIMIT);
  return async () => largest.map((c): AgentKnowledgeChunk => ({ id: c.id, title: c.title, text: c.text }));
}

// --- The simulated contact -------------------------------------------------------------

interface Touch {
  decidedAt: Date;
  at: Date;
  channel: Channel;
  subject: string | null;
  body: string;
  simulated: boolean;
}

interface SimState {
  lead: AgentContextLeadRow;
  touches: Touch[];
  timeline: AgentContextSource["timeline"];
  decisions: AgentContextSource["decisionSummaries"];
  channels: AgentContextSource["channels"];
  lastRepActivityAt: Date | null;
  lastCall: { outcome: string | null } | null;
  aiSendReplied: boolean;
  whatsappReplied: boolean;
  callHeld: boolean;
}

const cloneState = (s: SimState): SimState => ({
  ...s,
  lead: { ...s.lead },
  touches: [...s.touches],
  timeline: [...s.timeline],
  decisions: [...s.decisions],
  channels: [...s.channels],
});

function initialState(lead: DemoLead, input: DemoInput, startAt: Date): SimState {
  const company = lead.company?.trim() || null;
  return {
    lead: {
      id: `demo-${lead.key}`,
      first_name: lead.firstName,
      last_name: lead.lastName,
      // Website leads without a company keep the placeholder (no company link, no company points).
      company: company ?? "Not provided",
      job_title: null,
      industry: lead.industry,
      revenue_range: lead.revenueRange,
      // The website form creates leads with source "website" (leadIngest.service.ts).
      source: lead.source === "website_form" ? "website" : lead.source,
      email: lead.email,
      phone_e164: lead.phone ? normalizePhoneE164(lead.phone) : null,
      pipeline_stage: "new",
      lifecycle_state: "active",
      objection_type: null,
      loss_reason: null,
      agent_status: "active",
      agent_touch_count: 0,
      agent_last_touch_at: null,
      agent_live_test: true,
      automated: true,
      created_at: startAt,
      owner_id: "demo-owner",
      owner_name: input.workspace.ownerName,
      owner_email: null,
      owner_booking_url: input.workspace.bookingLink,
      company_name: input.workspace.companyDisplayName,
      linked_company: company
        ? { id: `demo-company-${lead.key}`, name: company, domain: null, website: null, industry: null, revenueRange: null, city: null, state: null, country: null, employeeRange: null, description: null, mergedIntoCompanyId: null }
        : null,
      merge_target: null,
      deals: [],
    },
    touches: [],
    timeline: [],
    decisions: [],
    channels: [],
    lastRepActivityAt: null,
    lastCall: null,
    aiSendReplied: false,
    whatsappReplied: false,
    callHeld: false,
  };
}

/** The in-memory AgentContextSource at `now`: the same rows buildAgentContext would read for this history (a live contact). */
export function sourceAt(state: SimState, settings: AgentSettingsRow, playbook: KnowledgeFile, enquiry: string, now: Date): AgentContextSource {
  const touches = state.touches.filter((t) => t.decidedAt <= now);
  const last = touches.at(-1) ?? null;
  const emails = touches.filter((t) => t.channel === "email" && now.getTime() - t.at.getTime() < 45 * DAY);
  const thread = emails.at(-1);
  const newestFirst = <T>(rows: T[], at: (r: T) => Date) => [...rows].sort((a, b) => at(b).getTime() - at(a).getTime());
  return {
    workspaceId: "demo-workspace",
    lead: { ...state.lead, agent_touch_count: touches.length, agent_last_touch_at: last?.at ?? null },
    settings,
    websiteMessage: enquiry,
    channels: state.channels,
    sends: touches.map((t) => ({ action: `send_${t.channel}`, at: t.at })),
    lastRepActivityAt: state.lastRepActivityAt,
    lastCall: state.lastCall,
    timeline: newestFirst(state.timeline, (t) => t.occurred_at).slice(0, 30),
    pastMessages: newestFirst(touches, (t) => t.decidedAt).map((t) => ({
      created_at: t.decidedAt,
      action: t.channel === "email" ? ("send_email" as const) : ("send_whatsapp" as const),
      message_subject: t.subject,
      message_body: t.body,
      outcome: "sent",
      playbook_version: settings.current_playbook_version,
    })),
    decisionSummaries: newestFirst(state.decisions, (d) => d.created_at).slice(0, 10),
    playbook: { version: settings.current_playbook_version ?? 1, body: playbook.text },
    assets: [],
    senderAddress: null,
    // Live AI email needs reply reading (IMAP) that worked in the last 30 minutes: healthy here.
    imapLastSuccessAt: new Date(now.getTime() - 2 * 60_000),
    aiSendReplied: state.aiSendReplied,
    assetHistory: { whatsappReplied: state.whatsappReplied, sentAssetIds: [] },
    emailThread: thread ? { messageId: `<demo-${state.lead.id}-${thread.at.getTime()}@motm.demo>`, subject: thread.subject ?? "" } : null,
    stage: { meeting: null, has_upcoming: false, proposal: null, rep_owned_before: false, call_or_meeting_held: state.callHeld },
  };
}

// --- Output records ------------------------------------------------------------------

export interface DemoMessage {
  channel: Channel;
  subject: string | null;
  /** Exactly as the lead would receive it (composed: booking line, signature, opt-out line). */
  text: string;
  words: number;
  firstWhatsApp: boolean;
  bookingLink: boolean;
  optOutLine: boolean;
  hasLink: boolean;
  sent: boolean;
}

export interface DemoStep {
  lead: string;
  step: string;
  title: string;
  at: string;
  atIst: string;
  status: "done" | "planned" | "skipped (cost cap)" | "error";
  happened: string[];
  stage: string | null;
  channel: Channel | null;
  action: string | null;
  reasoning: string | null;
  message: DemoMessage | null;
  checker: string | null;
  attempts: number | null;
  autoFixes: string[];
  problems: string[];
  promptTokens: { writer: number; checker: number } | null;
  estimateUsd: number;
  costUsd: number;
}

export interface DemoLeadResult {
  key: string;
  name: string;
  company: string | null;
  score: LeadScore;
  steps: DemoStep[];
}

export interface DemoResult {
  confirm: boolean;
  writer: string;
  checker: string;
  startAt: string;
  maxCostUsd: number;
  spentUsd: number;
  estimateUsd: number;
  stoppedAtCap: boolean;
  knowledge: { documents: number; chunks: number; chunkTokens: number; playbook: string; style: string | null };
  leads: DemoLeadResult[];
}

const IST_FORMAT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
export const ist = (d: Date) => `${IST_FORMAT.format(d).replace(",", "")} IST`;

// --- The run -------------------------------------------------------------------------

export interface DemoDeps {
  input: DemoInput;
  knowledge: KnowledgeFile[];
  prices: ModelPrices;
  confirm: boolean;
  maxCostUsd: number;
  only?: string | null;
  /** Used only with confirm. */
  model?: DecisionModel & ReplyClassifierModel;
  embedder?: Embedder;
  log?: (line: string) => void;
}

const isSendDecision = (d: { action: string }): d is SendDecision => d.action === "send_email" || d.action === "send_whatsapp";
const tokensOf = (messages: ChatMessage[] | null) => (messages ? countTokens(messages.map((m) => m.content).join("\n")) : 0);
const placeholderBody = (n: number) =>
  `(dry run: message ${n} is written in the paid run) Hi, a short note about steady enquiries from the buyers you want to reach and how we support them.`;

export async function runDemoJourney(deps: DemoDeps): Promise<DemoResult> {
  const { input, prices, confirm } = deps;
  const log = deps.log ?? (() => undefined);
  const writer = input.workspace.writer;
  const checker = input.workspace.checker;
  for (const m of [writer, checker]) if (!priceOf(prices, m)) throw new Error(`No price in OPENAI_PRICES_JSON for ${m}.`);
  if (confirm && (!deps.model || !deps.embedder)) throw new Error("A confirmed run needs the OpenAI model and embedder.");
  const startAt = new Date(input.workspace.startAtIst);
  const leads = deps.only ? input.leads.filter((l) => l.key === deps.only) : input.leads;
  if (!leads.length) throw new Error(`No lead with key "${deps.only}" (keys: ${input.leads.map((l) => l.key).join(", ")}).`);

  const files = sortKnowledge(deps.knowledge);
  const settings = demoSettings(input, files);
  const chunks = await chunkDocuments(files.documents);
  const chunkTokens = chunks.reduce((sum, c) => sum + c.tokens, 0);

  let spent = 0;
  let estimated = 0;
  let stopped = false;
  const embedCost = (tokens: number) => (tokens * EMBEDDING_PER_1M_USD) / 1_000_000;
  /** Rule 6: stops before a step whose estimate would take the spend past the cap. */
  const affordable = (estimate: number) => {
    if (!confirm) return true;
    if (stopped || spent + estimate > deps.maxCostUsd) stopped = true;
    return !stopped;
  };

  estimated += embedCost(chunkTokens);
  let search: KnowledgeSearch = dryRunSearch(chunks);
  if (confirm) {
    if (!affordable(embedCost(chunkTokens))) throw new Error("--max-cost is too low to embed the knowledge documents.");
    const vectors = await deps.embedder!.embed(chunks.map((c) => c.text));
    spent += embedCost(chunkTokens);
    search = memorySearch(chunks, vectors, deps.embedder!, (tokens) => {
      spent += embedCost(tokens);
    });
  }

  const decisionEstimate = (ctx: AgentContext, now: Date, channel: Channel | null) => {
    const writerTokens = tokensOf(buildDecisionMessages(ctx, ctx.settings, now));
    const sample: SendDecision =
      channel === "email"
        ? { action: "send_email", subject: "Steady enquiries", body: placeholderBody(1), assetIds: [], nextWakeInDays: 3, reasoning: "estimate" }
        : { action: "send_whatsapp", body: placeholderBody(1), assetIds: [], nextWakeInDays: 3, reasoning: "estimate" };
    const checkerTokens = tokensOf(buildGroundingMessages(sample, ctx));
    const usd = ((costUsd(prices, writer, writerTokens, ESTIMATE.decideOutput) ?? 0) + (costUsd(prices, checker, checkerTokens, ESTIMATE.groundingOutput) ?? 0)) * ESTIMATE.attempts;
    return { usd: usd + embedCost(countTokens(ctx.knowledge.query)), writerTokens, checkerTokens };
  };

  const results: DemoLeadResult[] = [];
  for (const lead of leads) {
    const name = `${lead.firstName} ${lead.lastName}`.trim();
    log(`\n${name} (${lead.key})`);
    const enquiry = lead.enquiry;
    const state = initialState(lead, input, startAt);
    const steps: DemoStep[] = [];
    const contextAt = (s: SimState, now: Date, settingsOverride: AgentSettingsRow = settings) =>
      assembleAgentContext(sourceAt(s, settingsOverride, files.playbook, enquiry, now), now, search);
    const emptyStep = (step: string, title: string, at: Date): DemoStep => ({
      lead: lead.key, step, title, at: at.toISOString(), atIst: ist(at), status: confirm ? "done" : "planned", happened: [], stage: null, channel: null,
      action: null, reasoning: null, message: null, checker: null, attempts: null, autoFixes: [], problems: [], promptTokens: null, estimateUsd: 0, costUsd: 0,
    });
    const push = (step: DemoStep) => {
      steps.push(step);
      estimated += step.estimateUsd;
      log(`  ${step.step.padEnd(3)} ${step.atIst.padEnd(28)} ${step.title}${step.stage ? ` · ${step.stage}` : ""}${step.channel ? ` · ${step.channel}` : ""}` +
        `${step.promptTokens ? ` · prompt ${step.promptTokens.writer}/${step.promptTokens.checker} tokens` : ""}${step.estimateUsd ? ` · est. $${step.estimateUsd.toFixed(4)}` : ""}` +
        `${confirm ? ` · ${step.status}${step.costUsd ? ` $${step.costUsd.toFixed(4)}` : ""}` : ""}`);
    };

    /** One agent decision at `now`: the real pipeline, then the composed message. Records the touch when it counts. */
    const decide = async (step: DemoStep, s: SimState, ctx: AgentContext, now: Date, counts: boolean) => {
      const plan = ctx.stagePlan;
      step.stage = plan ? `${STAGE_LABELS[plan.stageKey]} · ${plan.angle ? ANGLE_LABELS[plan.angle] : "no message now"}` : null;
      step.channel = plan?.preferredChannel ?? null;
      const est = decisionEstimate(ctx, now, step.channel);
      step.promptTokens = { writer: est.writerTokens, checker: est.checkerTokens };
      step.estimateUsd = est.usd;
      if (plan?.angle && ["welcome", "check_in", "call_followup", "final_check"].includes(plan.angle)) step.happened.push(`Suggested days for a call: ${suggestedDays(now)}.`);
      const recordTouch = (decision: SendDecision, at: Date, simulatedBody: boolean) => {
        if (!counts) return;
        s.touches.push({ decidedAt: now, at, channel: decision.action === "send_email" ? "email" : "whatsapp", subject: decision.action === "send_email" ? decision.subject : null, body: decision.body, simulated: simulatedBody });
      };
      if (!confirm) {
        const at = nextAllowedSendTime(now, sendWindowSettings(settings, ctx.rules.freshInbound), ctx.rules.lead.agentLastTouchAt, ctx.rules.recentTouchTimes, ctx.rules.lastRepActivityAt);
        if (plan?.angle && step.channel) {
          const body = placeholderBody(s.touches.length + 1);
          recordTouch(step.channel === "email" ? { action: "send_email", subject: "Steady enquiries", body, assetIds: [], nextWakeInDays: 3, reasoning: "" } : { action: "send_whatsapp", body, assetIds: [], nextWakeInDays: 3, reasoning: "" }, at, true);
        }
        return;
      }
      if (!affordable(est.usd)) {
        step.status = "skipped (cost cap)";
        return;
      }
      const usage: Usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: 0 };
      const before = spent;
      try {
        const draft = await draftDecision(ctx, { model: deps.model!, decisionModel: writer, groundingModel: checker, prices, now }, usage);
        const d = draft.decision;
        const last = draft.attempts.at(-1)!;
        step.action = d.action === "handoff" ? `handoff: ${d.title}` : d.action;
        step.reasoning = d.reasoning.slice(0, 400);
        step.attempts = draft.attempts.length;
        step.autoFixes = draft.attempts.flatMap((a) => a.autoFixes.map((f) => f.rule));
        step.problems = draft.attempts.flatMap((a, i) => a.problems.map((p) => `attempt ${i + 1}: ${p}`));
        step.checker = last.grounding
          ? last.grounding.supported && !(last.grounding.styleViolations ?? []).length
            ? "supported (no unsupported claims, no style problems)"
            : `problems: ${[...last.grounding.unsupportedClaims, ...(last.grounding.styleViolations ?? []).map((v) => `${v.rule} "${v.quote}"`)].join("; ")}`
          : "not run (the code checks failed or the action is not a message)";
        const shown = draft.failedAttempt?.rules.finalDecision ?? d;
        if (isSendDecision(shown)) {
          const composed = composeOutgoing(shown, {
            ownerName: ctx.lead.ownerName ?? "The team",
            companyName: ctx.companyName,
            settings: ctx.settings,
            isFirstWhatsApp: !ctx.rules.hasSentWhatsApp,
            bookingUrl: ctx.lead.ownerBookingUrl,
            angle: plan?.angle ?? null,
          });
          step.message = messageOf(composed, shown, ctx, isSendDecision(d));
          if (isSendDecision(d)) recordTouch(d, draft.rules.sendAt ?? now, false);
          if (draft.rules.sendAt && draft.rules.sendAt.getTime() > now.getTime()) step.happened.push(`Queued: goes out at ${ist(draft.rules.sendAt)} (send window / gap rules).`);
        }
        s.decisions.push({ created_at: now, action: d.action, outcome: isSendDecision(d) ? "sent" : "draft", reasoning: d.reasoning });
      } catch (error) {
        step.status = "error";
        step.happened.push(`Error: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
      }
      spent += usage.costUsd;
      step.costUsd = spent - before;
    };

    // Step 1: the lead arrives.
    const s1 = emptyStep("1", "Lead arrives (website form)", startAt);
    const scoreEmail = lead.emailDomainIsCorporate && lead.email && !corporateDomain(lead.email) ? `${lead.email.split("@")[0]}@${slug(lead.company ?? lead.key)}.com` : lead.email;
    const score = leadScore({
      lifecycleState: "active",
      enquiry,
      email: scoreEmail,
      company: lead.company,
      industry: lead.industry,
      revenueRange: lead.revenueRange,
      targetKeywords: MOTM_TARGET_KEYWORDS,
      opens: [],
      replies: [],
      meetings: [],
      proposals: [],
      now: startAt,
    });
    const wake1 = wakeFor("lead_created", startAt, settings);
    s1.happened.push(
      `Hot score ${score.score} (${score.band}); reasons: ${score.reasons.join(", ") || "none"}.${scoreEmail !== lead.email ? " (The demo email address is a stand-in; scored as the real corporate domain.)" : ""}`,
      `Task created for ${input.workspace.ownerName}: "First call" (call), due ${ist(addWorkingTime(startAt, HOUR))}; notification "New website lead — call within 1 working hour".`,
      `AI enrolled (AI live test contact, live mode); first AI wake-up at ${ist(wake1.dueAt)}.`,
    );
    s1.status = "done";
    push(s1);

    // Step 2: the first message (fresh inbound), plus the same moment on email for comparison.
    const now2 = wake1.dueAt;
    const before2 = cloneState(state);
    const ctx2 = await contextAt(state, now2);
    const s2 = emptyStep("2", "First AI message", now2);
    s2.happened.push("The AI wakes 5 minutes after the lead is created; a fresh website lead may get its first message 08:00–21:00 IST, any day.");
    await decide(s2, state, ctx2, now2, true);
    push(s2);
    const ctx2b = await contextAt(before2, now2, { ...settings, first_channel: "email" });
    const s2b = emptyStep("2b", "The same first message by email (comparison only, not sent)", now2);
    s2b.happened.push("Channels alternate and the next message must wait 48 hours, so only one first message goes out; this shows what the email version would be.");
    await decide(s2b, before2, ctx2b, now2, false);
    if (s2b.message) s2b.message.sent = false;
    push(s2b);

    // Step 3: the rep logs a call (+1 day); the AI waits rep_quiet_hours, then follows up on the call.
    const callAt = new Date(startAt.getTime() + DAY);
    const note = stripSimulated(lead.scenario.repCallNote);
    state.timeline.push({ occurred_at: callAt, event_kind: "call", title: "Call Connected - interested_later", detail: note });
    state.lastRepActivityAt = callAt;
    state.lastCall = { outcome: "interested_later" };
    state.callHeld = true;
    state.lead = { ...state.lead, pipeline_stage: "connected_qualifying" };
    const wake3 = wakeFor("call_logged", callAt, settings).dueAt;
    const last2 = state.touches.at(-1)?.at ?? null;
    const now3 = nextAllowedSendTime(wake3, settings, last2, state.touches.map((t) => t.at), callAt);
    const s3 = emptyStep("3", "Rep logs a call → AI follow-up on the call", now3);
    s3.happened.push(
      `${ist(callAt)}: ${input.workspace.ownerName} logs a connected call (outcome: interested later). Note (simulated): "${note}"`,
      `The AI waits ${settings.rep_quiet_hours} h after rep activity (wake-up ${ist(wake3)})${now3.getTime() > wake3.getTime() ? ` and the 48 h gap / send window until ${ist(now3)}` : ""}.`,
    );
    await decide(s3, state, await contextAt(state, now3), now3, true);
    push(s3);

    // Step 4: no reply; the next follow-up 48 h after the previous message (plus the weekly limit and window).
    const prev = state.touches.at(-1)?.at ?? now3;
    const candidate = new Date(prev.getTime() + settings.min_gap_hours * HOUR);
    const now4 = nextAllowedSendTime(candidate, settings, prev, state.touches.map((t) => t.at), state.lastRepActivityAt);
    const s4 = emptyStep("4", "No reply → next follow-up", now4);
    s4.happened.push(
      `48 h after the previous message is ${ist(candidate)}.${now4.getTime() > candidate.getTime() ? ` The rules move it to ${ist(now4)} (at most 2 messages in 7 days, Mon–Sat 09:30–19:00 IST).` : ""}`,
    );
    await decide(s4, state, await contextAt(state, now4), now4, true);
    push(s4);
    const noReply = cloneState(state);

    // Step 5: the lead replies (simulated) → label, handoff, the rep's task, the suggested reply.
    const reply = lead.scenario.leadReply;
    const replyText = stripSimulated(reply.text);
    const replyAt = new Date((state.touches.at(-1)?.at ?? now4).getTime() + 2 * HOUR);
    const s5 = emptyStep("5", `Lead replies on ${reply.channel === "email" ? "email" : "WhatsApp"} → suggested reply for the rep`, replyAt);
    s5.channel = reply.channel;
    s5.happened.push(`${ist(replyAt)}: the lead replies on ${reply.channel === "email" ? "email" : "WhatsApp"} (simulated): "${replyText}"`);
    const keyword = matchReplyKeyword(replyText);
    let label: ReplyLabel | null = keyword;
    const labelMessages = buildReplyClassificationMessages(replyText, reply.channel);
    const labelEstimate = costUsd(prices, checker, tokensOf(labelMessages), ESTIMATE.labelOutput) ?? 0;
    s5.estimateUsd += keyword ? 0 : labelEstimate;
    if (keyword) s5.happened.push(`Label by keyword: ${keyword}.`);
    else if (!confirm) s5.happened.push(`No stop keyword; the AI label (checker model ${checker}) is assigned in the paid run (planned as a question).`);
    else if (affordable(labelEstimate)) {
      try {
        const r = await deps.model!.classifyReply({ model: checker, messages: labelMessages, jsonSchema: { name: "reply_label", schema: REPLY_CLASSIFICATION_JSON_SCHEMA as unknown as Record<string, unknown> } });
        const c = costUsd(prices, checker, r.inputTokens, r.outputTokens, r.cachedInputTokens ?? 0) ?? 0;
        spent += c;
        s5.costUsd += c;
        label = finalLabel(r.json);
        s5.happened.push(`No stop keyword; AI label: ${label} (confidence ${r.json.confidence.toFixed(2)}).`);
      } catch (error) {
        s5.status = "error";
        s5.happened.push(`Label error: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
      }
    } else s5.status = "skipped (cost cap)";
    const planned: ReplyLabel = label ?? "question";
    const effects = replyEffects(planned);
    state.lead = { ...state.lead, agent_status: effects.agentStopReason ? "stopped" : "handed_off" };
    state.aiSendReplied = true;
    if (reply.channel === "whatsapp") {
      state.whatsappReplied = true;
      state.channels = [...state.channels.filter((c) => c.channel !== "whatsapp"), { channel: "whatsapp", status: "reachable" }];
    }
    state.timeline.push({ occurred_at: replyAt, event_kind: reply.channel, title: reply.channel === "whatsapp" ? "WhatsApp reply received - automation stopped" : "Replied by email", detail: null });
    s5.happened.push(
      effects.agentStopReason ? `AI stopped (${effects.agentStopReason}).` : "AI handed off: it sends nothing more on its own; the rep owns the conversation.",
      `Task for ${input.workspace.ownerName}: "${replyTaskTitle(planned, reply.channel)}".`,
    );
    const skip = draftSkipReason({
      channel: reply.channel,
      lifecycleState: "active",
      channelStatus: state.channels.find((c) => c.channel === reply.channel)?.status ?? null,
      phoneStatus: null,
      address: reply.channel === "email" ? state.lead.email : state.lead.phone_e164,
      labels: [planned],
      contactDraftsToday: 0,
      mode: "live",
      spentUsd: 0,
      budgetUsd: Number(settings.monthly_budget_usd),
      decisionsToday: 1,
      maxDecisionsPerDay: settings.max_decisions_per_day,
      hasOwner: true,
    });
    const draftAt = new Date(replyAt.getTime() + DRAFT_DEBOUNCE_MS);
    if (skip) s5.happened.push(`No suggested reply: ${skip}.`);
    else {
      const ctx5 = await contextAt(state, draftAt);
      const writerTokens = tokensOf(buildReplyDraftMessages(ctx5, replyText, reply.channel, draftAt));
      const sample: SendDecision = reply.channel === "email" ? { action: "send_email", subject: "-", body: placeholderBody(0), assetIds: [], nextWakeInDays: 1, reasoning: "" } : { action: "send_whatsapp", body: placeholderBody(0), assetIds: [], nextWakeInDays: 1, reasoning: "" };
      const checkerTokens = tokensOf(buildGroundingMessages(sample, ctx5)) + countTokens(replyText);
      const est = ((costUsd(prices, writer, writerTokens, ESTIMATE.decideOutput) ?? 0) + (costUsd(prices, checker, checkerTokens, ESTIMATE.groundingOutput) ?? 0)) * ESTIMATE.attempts;
      s5.promptTokens = { writer: writerTokens, checker: checkerTokens };
      s5.estimateUsd += est;
      s5.happened.push(`The suggested reply is written ${DRAFT_DEBOUNCE_MS / 60_000} quiet minutes after the reply (${ist(draftAt)}); the rep edits, sends or discards it.`);
      const subject = reply.channel === "email" ? threadSubject(state.touches.filter((t) => t.channel === "email").at(-1)?.subject ?? "your message") : "";
      if (confirm && s5.status !== "skipped (cost cap)" && affordable(est)) {
        const usage: Usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: 0 };
        try {
          let calls = 0;
          const counting: DecisionModel = { decide: (i) => (calls++, deps.model!.decide(i)), checkGrounding: (i) => deps.model!.checkGrounding(i) };
          const written = await writeReplyDraft(ctx5, replyText, reply.channel, { model: counting, decisionModel: writer, groundingModel: checker, prices, now: draftAt }, usage);
          s5.attempts = calls;
          s5.action = written.decision ? "suggested reply written" : "no suggested reply (checks failed)";
          s5.problems = written.problems;
          s5.checker = written.decision ? "supported (no unsupported claims, no style problems)" : `failed: ${written.problems.join(", ")}`;
          if (written.decision) {
            const composed = composeReplyDraft({
              channel: reply.channel,
              subject,
              body: written.decision.body,
              ownerName: input.workspace.ownerName,
              companyName: ctx5.companyName,
              settings,
              bookingUrl: input.workspace.bookingLink,
            });
            s5.message = { ...messageOf(composed, written.decision, ctx5, false), firstWhatsApp: false };
          }
        } catch (error) {
          s5.status = "error";
          s5.happened.push(`Draft error: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
        }
        spent += usage.costUsd;
        s5.costUsd += usage.costUsd;
      } else if (confirm && s5.status !== "error") s5.status = "skipped (cost cap)";
    }
    push(s5);

    // Step 6: the final polite check, had the lead never replied: the journey's next messages simulated, then the last one.
    const branch = noReply;
    const simulatedAt: string[] = [];
    // A run stopped at the cap (or an AI that chose not to send) may leave no earlier message: start from step 4's time.
    while (branch.touches.length < settings.max_touches_total - 1) {
      const lastTouch = branch.touches.at(-1)?.at ?? now4;
      const at = nextAllowedSendTime(new Date(lastTouch.getTime() + settings.min_gap_hours * HOUR), settings, lastTouch, branch.touches.map((t) => t.at), branch.lastRepActivityAt);
      const channel = preferredChannel({ touches: branch.touches, emailUsable: true, whatsappUsable: true, firstChannel: settings.first_channel })!;
      const n = branch.touches.length + 1;
      branch.touches.push({
        decidedAt: at,
        at,
        channel,
        subject: channel === "email" ? (branch.touches.filter((t) => t.channel === "email").at(-1)?.subject ? threadSubject(branch.touches.filter((t) => t.channel === "email").at(-1)!.subject!) : "Steady enquiries") : null,
        body: `(Simulated earlier message ${n}, not written for the demo: the journey's "${ANGLE_LABELS[journeyAngle(n - 1, settings.max_touches_total, true) ?? "insight"]}" message.)`,
        simulated: true,
      });
      simulatedAt.push(`${n} (${channel === "email" ? "email" : "WhatsApp"}, ${ist(at)})`);
    }
    const lastSim = branch.touches.at(-1)?.at ?? now4;
    const now6 = nextAllowedSendTime(new Date(lastSim.getTime() + settings.min_gap_hours * HOUR), settings, lastSim, branch.touches.map((t) => t.at), branch.lastRepActivityAt);
    const s6 = emptyStep("6", `Final polite check (message ${settings.max_touches_total}, if the lead never replied)`, now6);
    s6.happened.push(`Branch without step 5: messages 1–${noReply.touches.length} as above, then simulated messages ${simulatedAt.join("; ")}.`);
    await decide(s6, branch, await contextAt(branch, now6), now6, true);
    push(s6);

    results.push({ key: lead.key, name, company: lead.company, score, steps });
  }

  return {
    confirm,
    writer,
    checker,
    startAt: startAt.toISOString(),
    maxCostUsd: deps.maxCostUsd,
    spentUsd: spent,
    estimateUsd: estimated,
    stoppedAtCap: stopped,
    knowledge: { documents: files.documents.length, chunks: chunks.length, chunkTokens, playbook: files.playbook.name, style: files.style?.name ?? null },
    leads: results,
  };
}

const slug = (text: string) => text.toLowerCase().replace(/\b(pvt|private|ltd|limited|llp)\b/g, "").replace(/[^a-z0-9]+/g, "").slice(0, 30) || "company";

function messageOf(composed: ReturnType<typeof composeOutgoing>, decision: SendDecision, ctx: AgentContext, sent: boolean): DemoMessage {
  const firstWhatsApp = composed.channel === "whatsapp" && !ctx.rules.hasSentWhatsApp;
  return {
    channel: composed.channel,
    subject: composed.channel === "email" ? composed.subject : null,
    text: composed.text,
    words: wordCount(decision.body),
    firstWhatsApp,
    bookingLink: composed.bookingLinkAdded,
    optOutLine: composed.channel === "whatsapp" ? composed.text.trim().endsWith(ctx.settings.whatsapp_opt_out_text.trim()) : composed.text.includes(ctx.settings.email_opt_out_text.trim()),
    hasLink: new RegExp(URL_RE.source, "i").test(composed.text),
    sent,
  };
}

// --- Rendering -------------------------------------------------------------------------

const quoted = (text: string) => text.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n");
const money = (usd: number) => `$${usd.toFixed(4)}`;
const pct = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)} %` : "—");

export function summaryOf(result: DemoResult) {
  const rows = result.leads.map((l) => {
    const written = l.steps.filter((s) => s.message);
    const firstTry = written.filter((s) => s.attempts === 1);
    return {
      lead: l.name,
      messages: written.length,
      firstTry: firstTry.length,
      regenerations: l.steps.reduce((sum, s) => sum + Math.max(0, (s.attempts ?? 1) - 1), 0),
      autoFixes: l.steps.reduce((sum, s) => sum + s.autoFixes.length, 0),
      costUsd: l.steps.reduce((sum, s) => sum + s.costUsd, 0),
    };
  });
  const total = rows.reduce((t, r) => ({ messages: t.messages + r.messages, firstTry: t.firstTry + r.firstTry, regenerations: t.regenerations + r.regenerations, autoFixes: t.autoFixes + r.autoFixes, costUsd: t.costUsd + r.costUsd }), {
    messages: 0,
    firstTry: 0,
    regenerations: 0,
    autoFixes: 0,
    costUsd: 0,
  });
  return { rows, total };
}

function stepMarkdown(s: DemoStep): string[] {
  const lines = [`### Step ${s.step} — ${s.title}`, "", `**When:** ${s.atIst}${s.status !== "done" ? ` · **${s.status}**` : ""}`, ""];
  for (const h of s.happened) lines.push(`- ${h}`);
  if (s.happened.length) lines.push("");
  if (s.stage) lines.push(`**Stage plan:** ${s.stage}${s.channel ? ` · channel: ${s.channel === "email" ? "email" : "WhatsApp"}` : ""}`, "");
  if (s.action) lines.push(`**AI action:** ${s.action}${s.reasoning ? ` — ${s.reasoning}` : ""}`, "");
  if (s.message) {
    const m = s.message;
    const tags = [
      m.channel === "email" ? "Email" : "WhatsApp",
      `${m.words} words (body)`,
      m.firstWhatsApp ? "first WhatsApp: opt-out line, no link" : null,
      m.bookingLink ? "booking link added" : null,
      m.sent ? null : "NOT SENT",
    ].filter(Boolean);
    lines.push(`**Message as the lead receives it** (${tags.join(" · ")}):`, "");
    if (m.subject) lines.push(`Subject: **${m.subject}**`, "");
    lines.push(quoted(m.text), "");
  }
  if (s.checker) lines.push(`**Checker:** ${s.checker}`, "");
  if (s.attempts !== null) lines.push(`**Attempts:** ${s.attempts}${s.autoFixes.length ? ` · auto-fixes: ${s.autoFixes.join(", ")}` : " · no auto-fixes"}`, "");
  if (s.problems.length) lines.push("**Problems found on the way (fixed by regeneration or ending in a handoff):**", "", ...s.problems.map((p) => `- ${p}`), "");
  if (s.costUsd || s.estimateUsd) lines.push(`**Cost:** ${s.costUsd ? money(s.costUsd) : "—"}${s.estimateUsd ? ` (estimate ${money(s.estimateUsd)})` : ""}`, "");
  return lines;
}

export function renderMarkdown(result: DemoResult, generatedAt: Date): string {
  const { rows, total } = summaryOf(result);
  return [
    "# MOTM Flow — how two website leads are handled, end to end",
    "",
    `Generated ${ist(generatedAt)} by \`npm run agent:demo-journey\` (offline: no database, nothing sent). Writer ${result.writer}, checker ${result.checker}. ` +
      `Simulated clock from ${ist(new Date(result.startAt))}. Lead names, companies, industries and enquiries are real; phone and email are replaced; ` +
      "everything marked **(simulated)** (the rep's call notes, the lead replies, earlier messages in step 6) is made up for the demo. " +
      `Every message below is the system's real output${result.confirm ? "" : " — this file is a DRY RUN (no AI calls): messages are not written yet"}.`,
    "",
    "## Summary",
    "",
    "| Lead | Messages written | Passed first try | Regenerations | Auto-fixes | Cost |",
    "|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.lead} | ${r.messages} | ${pct(r.firstTry, r.messages)} (${r.firstTry}/${r.messages}) | ${r.regenerations} | ${r.autoFixes} | ${money(r.costUsd)} |`),
    `| **Total** | ${total.messages} | ${pct(total.firstTry, total.messages)} | ${total.regenerations} | ${total.autoFixes} | ${money(result.spentUsd)} (incl. embeddings) |`,
    "",
    result.stoppedAtCap ? `**Stopped at the $${result.maxCostUsd.toFixed(2)} cost cap: later steps were not run.**\n` : "",
    `Knowledge: ${result.knowledge.documents} documents → ${result.knowledge.chunks} chunks (top 8 per message); playbook ${result.knowledge.playbook}; style examples ${result.knowledge.style ?? "none"}.`,
    "",
    "The rules applied (all in code, not left to the AI): send window Mon–Sat 09:30–19:00 IST (a new website lead's first message 08:00–21:00, any day), at least 48 h between AI messages, at most 2 in 7 days and 8 in total, " +
      "24 h quiet after a rep's call, no link and an opt-out line in a first WhatsApp, word limits (WhatsApp 60, email 120), the booking link only with a call question, no attachment in a first message.",
    "",
    ...result.leads.flatMap((l) => [
      `## ${l.name}${l.company ? ` — ${l.company}` : ""}`,
      "",
      `Hot score at arrival: **${l.score.score} (${l.score.band})** — ${l.score.reasons.join(", ") || "no reasons"}.`,
      "",
      ...l.steps.flatMap(stepMarkdown),
    ]),
  ].join("\n");
}

/** The dry-run plan's last lines: the estimate and whether --max-cost covers it. */
export function planSummary(result: DemoResult): string[] {
  const writerTokens = result.leads.flatMap((l) => l.steps).reduce((sum, s) => sum + (s.promptTokens?.writer ?? 0), 0);
  return [
    `Knowledge: ${result.knowledge.documents} documents, ${result.knowledge.chunks} chunks (${result.knowledge.chunkTokens} tokens to embed).`,
    `Writer prompts: ${writerTokens} tokens in total (knowledge: the 8 largest chunks as an upper bound).`,
    `Estimated cost of --confirm: about $${result.estimateUsd.toFixed(2)} (${ESTIMATE.attempts} attempts per message on average; real prompt sizes).`,
    result.estimateUsd > result.maxCostUsd
      ? `That is above --max-cost $${result.maxCostUsd.toFixed(2)}: the run would stop early. Raise --max-cost (e.g. --max-cost ${Math.ceil(result.estimateUsd * 1.5 * 10) / 10}).`
      : `--max-cost $${result.maxCostUsd.toFixed(2)} covers it (the run stops before a step that would pass it).`,
  ];
}
