import { modelSettingProblem } from "../agent/modelSetting.js";
import { costUsd, priceOf, type ModelPrices } from "../agent/pricing.js";
import type { DecisionModel } from "../providers/openai.provider.js";
import type { AgentContext } from "./agentContext.service.js";
import { draftDecision, type Usage } from "./agentRunner.service.js";

/**
 * E3a rule 9: runs the decision pipeline (as agent:preview --evaluate) for several writer > checker
 * combinations on the same contacts and reports them side by side. Saves and sends nothing.
 */

export const SPEND_CAP_USD = 3;

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
export function evaluationContext(ctx: AgentContext): { ctx: AgentContext; ignored: string[] } {
  const { rules } = ctx;
  const ignored = [
    rules.mode === "off" && "workspace mode off (evaluated as shadow)",
    rules.lead.agentStatus !== "active" && `AI status "${rules.lead.agentStatus}" (evaluated as active)`,
    (rules.lead.agentTouchCount > 0 || rules.recentTouchTimes.length > 0) && `${rules.lead.agentTouchCount} touch(es) so far, ${rules.recentTouchTimes.length} in the last 7 days (evaluated as none)`,
  ].filter((note): note is string => Boolean(note));
  const mode = rules.mode === "off" ? ("shadow" as const) : rules.mode;
  return {
    ignored,
    ctx: {
      ...ctx,
      settings: { ...ctx.settings, mode: ctx.settings.mode === "off" ? "shadow" : ctx.settings.mode },
      rules: { ...rules, mode, recentTouchTimes: [], lead: { ...rules.lead, agentStatus: "active", agentTouchCount: 0, agentLastTouchAt: null } },
    },
  };
}

export interface ContactRun {
  combo: string;
  leadId: string;
  name: string;
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
}

/** Combination by combination, one contact at a time; stops once the spend passes the cap. */
export async function runModelTest(input: { contexts: AgentContext[]; combos: Combo[]; model: DecisionModel; prices: ModelPrices; now: Date; capUsd?: number }): Promise<ModelTestResult> {
  const cap = input.capUsd ?? SPEND_CAP_USD;
  const runs: ContactRun[] = [];
  let spentUsd = 0;
  for (const combo of input.combos) {
    for (const ctx of input.contexts) {
      if (spentUsd > cap) return { runs, spentUsd, stoppedAtCap: true };
      const run = await runContact(ctx, combo, input);
      runs.push(run);
      spentUsd += run.usage.costUsd;
    }
  }
  return { runs, spentUsd, stoppedAtCap: spentUsd > cap };
}

async function runContact(ctx: AgentContext, combo: Combo, deps: { model: DecisionModel; prices: ModelPrices; now: Date }): Promise<ContactRun> {
  const usage: Required<Usage> = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: 0 };
  const base = { combo: combo.label, leadId: ctx.lead.id, name: `${ctx.lead.firstName} ${ctx.lead.lastName}`.trim() };
  const started = Date.now();
  try {
    const draft = await draftDecision(ctx, { model: deps.model, decisionModel: combo.decisionModel, groundingModel: combo.groundingModel, prices: deps.prices, now: deps.now }, usage);
    const d = draft.decision;
    const sent = d.action === "send_email" || d.action === "send_whatsapp";
    const shown = draft.failedAttempt?.rules.finalDecision ?? d;
    return {
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
    return { ...base, outcome, wroteMessage: false, passedFirstTry: false, regenerations: 0, autoFixes: 0, subject: null, body: null, failedAttempts: [], usage, latencyMs: Date.now() - started };
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
    `${meta.contacts} contacts, ${combos.length} combinations (writer > checker). Spent $${result.spentUsd.toFixed(4)}.${result.stoppedAtCap ? ` STOPPED: the spend passed the $${SPEND_CAP_USD} cap, so the results are incomplete.` : ""}`,
    "",
    "## Summary",
    "",
    ...combos.flatMap((combo) => comboSummary(combo.label, result.runs.filter((r) => r.combo === combo.label))),
    "## Contacts",
    "",
    ...[...new Set(result.runs.map((r) => r.leadId))].flatMap((id) => contactSection(id, combos, result.runs)),
  ].join("\n");
}
