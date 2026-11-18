import { composeOutgoing } from "../agent/composeMessage.js";
import { wordCount } from "../agent/messageChecks.js";
import { modelSettingProblem } from "../agent/modelSetting.js";
import { costUsd, priceOf, type ModelPrices } from "../agent/pricing.js";
import type { DecisionModel } from "../providers/openai.provider.js";
import { ANGLE_LABELS, CALL_ANGLES, STAGE_LABELS, stagePlan, type Angle, type Channel } from "../agent/stagePlan.js";
import type { AgentContext } from "./agentContext.service.js";
import { draftDecision, type Usage } from "./agentRunner.service.js";

/**
 * E3a rule 9: runs the decision pipeline (as agent:preview --evaluate) for several writer > checker
 * combinations on the same contacts and reports them side by side. Saves and sends nothing.
 */

/** E3b-1b rule 5: the default --max-cost; --max-cost may raise it up to MAX_SPEND_CAP_USD. */
export const SPEND_CAP_USD = 0.1;
export const MAX_SPEND_CAP_USD = 3;

export interface RunOptions {
  /** Forces the planned channel (when that channel is usable); null = as planned. */
  channel: Channel | null;
  /** Full names to run (case-insensitive); null = every contact. */
  only: string[] | null;
  maxCostUsd: number;
}

const normName = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();

/** E3b-1b rule 5: --channel, --only and --max-cost; throws on anything invalid. */
export function parseRunOptions(raw: { channel?: string; only?: string; maxCost?: string }): RunOptions {
  if (raw.channel !== undefined && raw.channel !== "email" && raw.channel !== "whatsapp") throw new Error("--channel takes email or whatsapp.");
  const only = raw.only === undefined ? null : raw.only.split(",").map(normName).filter(Boolean);
  if (only && !only.length) throw new Error("--only takes comma-separated full names.");
  const maxCostUsd = raw.maxCost === undefined ? SPEND_CAP_USD : Number(raw.maxCost);
  if (!(maxCostUsd > 0 && maxCostUsd <= MAX_SPEND_CAP_USD)) throw new Error(`--max-cost takes US dollars above 0 and at most ${MAX_SPEND_CAP_USD}.`);
  return { channel: (raw.channel as Channel | undefined) ?? null, only, maxCostUsd };
}

/** The contacts whose full name is in --only (all when null); throws when a name matches none, so a typo never runs a different set. */
export function filterByNames<T extends { first_name: string; last_name: string | null }>(leads: T[], only: string[] | null): T[] {
  if (!only) return leads;
  const full = (lead: T) => normName(`${lead.first_name} ${lead.last_name ?? ""}`);
  const missing = only.filter((name) => !leads.some((lead) => full(lead) === name));
  if (missing.length) throw new Error(`No test contact named: ${missing.join(", ")}.`);
  return leads.filter((lead) => only.includes(full(lead)));
}

// A guess for the plan only: about what staging decisions cost in tokens (2026-10-29 onward: 13,655 input per decision).
const ESTIMATE = { attempts: 1.4, decide: { input: 6000, output: 400 }, grounding: { input: 5000, output: 200 } };

export interface Combo {
  label: string;
  decisionModel: string;
  groundingModel: string;
}

/** "writer>checker,writer>checker", or "/" for ">" (npm.cmd runs through cmd.exe, which takes ">" as a redirect); throws on anything else. */
export function parseCombos(raw: string): Combo[] {
  const combos = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((label) => {
      const [decisionModel, groundingModel, extra] = label.split(/[>/]/).map((m) => m.trim());
      const problem = !decisionModel || !groundingModel || extra !== undefined ? `"${label}" is not writer>checker.` : (modelSettingProblem(decisionModel) ?? modelSettingProblem(groundingModel));
      if (problem) throw new Error(problem);
      return { label, decisionModel: decisionModel!, groundingModel: groundingModel! };
    });
  if (!combos.length) throw new Error("No combos given.");
  return combos;
}

/** The model settings without a price in OPENAI_PRICES_JSON (the runner would defer them). */
export const unpricedModels = (combos: Combo[], prices: ModelPrices) => [...new Set(combos.flatMap((c) => [c.decisionModel, c.groundingModel]))].filter((m) => !priceOf(prices, m));

export function estimateCost(combos: Combo[], contacts: number, prices: ModelPrices) {
  const perCombo = combos.map((combo) => {
    const decide = costUsd(prices, combo.decisionModel, ESTIMATE.decide.input, ESTIMATE.decide.output) ?? 0;
    const grounding = costUsd(prices, combo.groundingModel, ESTIMATE.grounding.input, ESTIMATE.grounding.output) ?? 0;
    return { label: combo.label, usd: (decide + grounding) * ESTIMATE.attempts * contacts };
  });
  return { perCombo, totalUsd: perCombo.reduce((sum, c) => sum + c.usd, 0) };
}

/** The contact as the runner would see it if mode, AI status and touch limits allowed a decision (they are quality runs). */
export function evaluationContext(ctx: AgentContext, channel: Channel | null = null): { ctx: AgentContext; ignored: string[] } {
  const { rules } = ctx;
  const ignored = [
    rules.mode === "off" && "workspace mode off (evaluated as shadow)",
    rules.lead.agentStatus !== "active" && `AI status "${rules.lead.agentStatus}" (evaluated as active)`,
    (rules.lead.agentTouchCount > 0 || rules.recentTouchTimes.length > 0) && `${rules.lead.agentTouchCount} touch(es) so far, ${rules.recentTouchTimes.length} in the last 7 days (evaluated as none)`,
  ].filter((note): note is string => Boolean(note));
  const mode = rules.mode === "off" ? ("shadow" as const) : rules.mode;
  // E3b-1: the stage plan as if no message had been sent yet (touches are ignored too); E3b-1b: --channel is its first channel.
  const input = ctx.stagePlanInput;
  const plan = input ? stagePlan({ ...input, touches: [], ...(channel ? { firstChannel: channel } : {}) }) : ctx.stagePlan;
  if (channel && plan?.preferredChannel && plan.preferredChannel !== channel) ignored.push(`--channel ${channel}: not usable for this contact (planned ${plan.preferredChannel})`);
  return {
    ignored,
    ctx: {
      ...ctx,
      stagePlan: plan,
      settings: { ...ctx.settings, mode: ctx.settings.mode === "off" ? "shadow" : ctx.settings.mode },
      rules: { ...rules, mode, stagePlan: plan, recentTouchTimes: [], lead: { ...rules.lead, agentStatus: "active", agentTouchCount: 0, agentLastTouchAt: null } },
    },
  };
}

export interface ContactRun {
  combo: string;
  leadId: string;
  name: string;
  /** E3b-1: "Stage: … · Angle: …" (the stage plan the decision was made under); null = none. */
  stage: string | null;
  /** E3b-1 rule 5: the composed message got the owner's booking line (null = no message). */
  bookingLink: boolean | null;
  /** E3b-2a-2 rule 5a: why it didn't (null = added, or no message). */
  bookingLinkNote: string | null;
  /** E3b-1b rule 5: the message's channel, whether it is a first WhatsApp (opt-out line, no link) and the body's word count; null = no message. */
  message: { channel: Channel; firstWhatsApp: boolean; words: number } | null;
  /** send / wait / stop / "handoff: <title>" / "error: <text>". */
  outcome: string;
  /** A message was written (it went through the checks). */
  wroteMessage: boolean;
  passedFirstTry: boolean;
  regenerations: number;
  autoFixes: number;
  subject: string | null;
  body: string | null;
  failedAttempts: { attempt: number; message: string; problems: string[] }[];
  usage: Required<Usage>;
  latencyMs: number;
}

export interface ModelTestResult {
  runs: ContactRun[];
  spentUsd: number;
  stoppedAtCap: boolean;
  capUsd: number;
  /** Runs planned (contacts × combinations), to say how far a stopped run got. */
  plannedRuns: number;
}

/** E3b-2a-2 rule 5a: why the composed message has no booking line (the same conditions as composeMessage's bookingLine). */
export function bookingLinkNote(ctx: AgentContext, angle: Angle | null, channel: Channel): string {
  if (!ctx.lead.ownerBookingUrl) return "owner has no booking link";
  if (!angle || !CALL_ANGLES.includes(angle)) return "the angle doesn't ask for a call";
  return channel === "whatsapp" && !ctx.rules.hasSentWhatsApp ? "first WhatsApp: no links" : "not added";
}

/** Combination by combination, one contact at a time; stops before the next contact once the spend reaches the cap. */
export async function runModelTest(input: { contexts: AgentContext[]; combos: Combo[]; model: DecisionModel; prices: ModelPrices; now: Date; capUsd?: number }): Promise<ModelTestResult> {
  const capUsd = input.capUsd ?? SPEND_CAP_USD;
  const plannedRuns = input.contexts.length * input.combos.length;
  const runs: ContactRun[] = [];
  let spentUsd = 0;
  for (const combo of input.combos) {
    for (const ctx of input.contexts) {
      if (spentUsd >= capUsd) return { runs, spentUsd, stoppedAtCap: true, capUsd, plannedRuns };
      const run = await runContact(ctx, combo, input);
      runs.push(run);
      spentUsd += run.usage.costUsd;
    }
  }
  return { runs, spentUsd, stoppedAtCap: false, capUsd, plannedRuns };
}

/** How far a run stopped at the cap got. */
export const stoppedText = (result: ModelTestResult) =>
  `STOPPED: the spend reached the $${result.capUsd.toFixed(2)} cap after ${result.runs.length} of ${result.plannedRuns} runs, so the results are incomplete.`;

async function runContact(ctx: AgentContext, combo: Combo, deps: { model: DecisionModel; prices: ModelPrices; now: Date }): Promise<ContactRun> {
  const usage: Required<Usage> = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: 0 };
  const plan = ctx.stagePlan;
  const stage = plan ? `Stage: ${STAGE_LABELS[plan.stageKey]} · Angle: ${plan.angle ? ANGLE_LABELS[plan.angle] : "none (no message now)"}` : null;
  const base = { combo: combo.label, leadId: ctx.lead.id, name: `${ctx.lead.firstName} ${ctx.lead.lastName}`.trim(), stage };
  const started = Date.now();
  try {
    const draft = await draftDecision(ctx, { model: deps.model, decisionModel: combo.decisionModel, groundingModel: combo.groundingModel, prices: deps.prices, now: deps.now }, usage);
    const d = draft.decision;
    const sent = d.action === "send_email" || d.action === "send_whatsapp";
    const shown = draft.failedAttempt?.rules.finalDecision ?? d;
    const composed =
      shown.action === "send_email" || shown.action === "send_whatsapp"
        ? composeOutgoing(shown, {
            ownerName: ctx.lead.ownerName ?? "The team",
            companyName: ctx.companyName,
            settings: ctx.settings,
            isFirstWhatsApp: !ctx.rules.hasSentWhatsApp,
            bookingUrl: ctx.lead.ownerBookingUrl,
            angle: plan?.angle ?? null,
          })
        : null;
    return {
      bookingLink: composed ? composed.bookingLinkAdded : null,
      bookingLinkNote: composed && !composed.bookingLinkAdded ? bookingLinkNote(ctx, plan?.angle ?? null, composed.channel) : null,
      message: composed && (shown.action === "send_email" || shown.action === "send_whatsapp") ? { channel: composed.channel, firstWhatsApp: composed.channel === "whatsapp" && !ctx.rules.hasSentWhatsApp, words: wordCount(shown.body) } : null,
      ...base,
      outcome: sent ? "send" : d.action === "handoff" ? `handoff: ${d.title}` : d.action,
      wroteMessage: sent || Boolean(draft.failedAttempt),
      passedFirstTry: sent && draft.attempts.length === 1,
      regenerations: draft.attempts.length - 1,
      autoFixes: draft.attempts.reduce((sum, a) => sum + a.autoFixes.length, 0),
      subject: shown.action === "send_email" ? shown.subject : null,
      body: shown.action === "send_email" || shown.action === "send_whatsapp" ? shown.body : null,
      failedAttempts: draft.attempts
        .map((a, i) => {
          const t = a.rules.finalDecision;
          return { attempt: i + 1, message: t.action === "send_email" || t.action === "send_whatsapp" ? t.body : `(${t.action})`, problems: a.problems };
        })
        .filter((a) => a.problems.length),
      usage,
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    const outcome = `error: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200);
    return { ...base, bookingLink: null, bookingLinkNote: null, message: null, outcome, wroteMessage: false, passedFirstTry: false, regenerations: 0, autoFixes: 0, subject: null, body: null, failedAttempts: [], usage, latencyMs: Date.now() - started };
  }
}

const pct = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)} %` : "—");
const quoted = (text: string) => text.split("\n").map((line) => `> ${line}`).join("\n");

function comboSummary(label: string, runs: ContactRun[]): string[] {
  const writers = runs.filter((r) => r.wroteMessage);
  const outcomes = new Map<string, number>();
  for (const r of runs) outcomes.set(r.outcome, (outcomes.get(r.outcome) ?? 0) + 1);
  const total = (pick: (r: ContactRun) => number) => runs.reduce((sum, r) => sum + pick(r), 0);
  const cost = total((r) => r.usage.costUsd);
  return [
    `### ${label}`,
    "",
    `- Passed first try: ${pct(writers.filter((r) => r.passedFirstTry).length, writers.length)} (${writers.filter((r) => r.passedFirstTry).length} of ${writers.length} messages)`,
    `- Regenerations: ${total((r) => r.regenerations)}`,
    `- Auto-fixes: ${total((r) => r.autoFixes)}`,
    `- Cost: $${cost.toFixed(4)} total, $${(runs.length ? cost / runs.length : 0).toFixed(4)} per contact`,
    `- Cached input: ${pct(total((r) => r.usage.cachedInputTokens), total((r) => r.usage.inputTokens))}`,
    `- Average latency: ${runs.length ? Math.round(total((r) => r.latencyMs) / runs.length) : 0} ms`,
    "- Outcomes:",
    ...[...outcomes].sort((a, b) => b[1] - a[1]).map(([outcome, n]) => `  - ${outcome}: ${n}`),
    "",
  ];
}

function contactSection(leadId: string, combos: Combo[], runs: ContactRun[]): string[] {
  const own = runs.filter((r) => r.leadId === leadId);
  return [
    `### ${own[0]!.name} (${leadId})`,
    "",
    ...combos.flatMap((combo) => {
      const r = own.find((x) => x.combo === combo.label);
      if (!r) return [`**${combo.label}**: not run`, ""];
      return [
        `**${combo.label}**: ${r.outcome}`,
        "",
        ...(r.stage ? [r.stage, ""] : []),
        ...(r.message ? [`Channel: ${r.message.channel === "email" ? "email" : "WhatsApp"} · first WhatsApp: ${r.message.firstWhatsApp ? "yes" : "no"} · ${r.message.words} words`, ""] : []),
        ...(r.bookingLink === null ? [] : [`Booking link added: ${r.bookingLink ? "yes" : `no${r.bookingLinkNote ? ` (${r.bookingLinkNote})` : ""}`}`, ""]),
        ...(r.subject ? [`Subject: ${r.subject}`, ""] : []),
        ...(r.body ? [quoted(r.body), ""] : []),
        ...r.failedAttempts.flatMap((a) => [`Failed attempt ${a.attempt}:`, ...a.problems.map((p) => `- ${p}`), "", quoted(a.message), ""]),
      ];
    }),
  ];
}

/** The Markdown report: per combination, then each contact's messages side by side. */
export function renderReport(result: ModelTestResult, combos: Combo[], meta: { at: Date; contacts: number }): string {
  return [
    `# AI model test, ${meta.at.toISOString()}`,
    "",
    `${meta.contacts} contacts, ${combos.length} combinations (writer > checker). Spent $${result.spentUsd.toFixed(4)}.${result.stoppedAtCap ? ` ${stoppedText(result)}` : ""}`,
    "",
    "## Summary",
    "",
    ...combos.flatMap((combo) => comboSummary(combo.label, result.runs.filter((r) => r.combo === combo.label))),
    "## Contacts",
    "",
    ...[...new Set(result.runs.map((r) => r.leadId))].flatMap((id) => contactSection(id, combos, result.runs)),
  ].join("\n");
}
