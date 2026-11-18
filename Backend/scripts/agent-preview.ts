// Dev only: shows what the AI agent would see and (with --call) draft for one lead, using the
// runner's pipeline (incl. grounding and one regeneration).
//   npm run agent:preview -- --lead <uuid> [--call] [--evaluate]
// --evaluate (implies --call, E2b): runs the full pipeline even when the workspace is off, the contact's AI
// status isn't active or its touch limits are used up (it prints what it ignored), then a "Quality checks" section.
// Reads only: saves nothing to the database and never sends anything.
// Refuses to run against the production project.
import "dotenv/config";
import { ANGLE_LABELS, STAGE_LABELS } from "../src/agent/stagePlan.js";

const PRODUCTION_REF = "jorxltfwboabyjiydyhu";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const leadId = arg("--lead");
const evaluate = process.argv.includes("--evaluate");
const call = evaluate || process.argv.includes("--call");
if (!leadId || !/^[0-9a-f-]{36}$/i.test(leadId)) {
  console.error("Usage: npm run agent:preview -- --lead <lead uuid> [--call] [--evaluate]");
  process.exit(1);
}
for (const name of ["DATABASE_URL", "SUPABASE_URL"]) {
  if (process.env[name]?.includes(PRODUCTION_REF)) {
    console.error(`${name} points at the production project; agent:preview only runs against staging.`);
    process.exit(1);
  }
}
if (process.env.NODE_ENV === "production") {
  console.error("NODE_ENV=production; agent:preview only runs against staging.");
  process.exit(1);
}

const section = (title: string) => console.log(`\n=== ${title} ${"=".repeat(Math.max(0, 70 - title.length))}`);

async function main(id: string) {
  // Imported after the checks above so nothing connects before them.
  process.env.NORTHBEAM_DB_ROLE = "script";
  const { pool } = await import("../src/db.js");
  const { env } = await import("../src/env.js");
  const { buildAgentContext } = await import("../src/services/agentContext.service.js");
  const { buildDecisionMessages } = await import("../src/agent/prompt.js");
  const { draftDecision } = await import("../src/services/agentRunner.service.js");
  const { composeOutgoing } = await import("../src/agent/composeMessage.js");
  const { parsePrices, priceOf } = await import("../src/agent/pricing.js");
  const { countTokens } = await import("../src/knowledge/chunkText.js");
  const { checkMessage, messageFactsOf } = await import("../src/agent/messageChecks.js");
  const { STYLE_RULES } = await import("../src/agent/prompt.js");
  const { ATTACHMENT_REMOVAL_TEXT } = await import("../src/agent/assetRules.js");
  const { evaluationContext } = await import("../src/services/agentModelTest.service.js");
  const { createOpenAIDecisionModel, getDefaultEmbedder, resolveAgentModels } = await import("../src/providers/openai.provider.js");

  try {
    const lead = (await pool.query<{ workspace_id: string }>(`select workspace_id from public.leads where id = $1`, [id])).rows[0];
    if (!lead) throw new Error(`No lead ${id}.`);

    // Without an OpenAI key the KB search can't embed its query: show the prompt without knowledge.
    const embedder = env.OPENAI_API_KEY ? getDefaultEmbedder() : { model: "none", embed: async () => [] };
    if (!env.OPENAI_API_KEY) console.warn("OPENAI_API_KEY is not set: knowledge search skipped.");

    const now = new Date();
    let ctx = await buildAgentContext(pool, lead.workspace_id, id, now, { embedder });
    if (evaluate) {
      // Quality evaluation only: what the rules would block first (mode, AI status, touch limits) is ignored.
      const evaluated = evaluationContext(ctx);
      ctx = evaluated.ctx;
      const { ignored } = evaluated;
      section("Evaluate mode");
      console.log(ignored.length ? `Ignored: ${ignored.join("; ")}.` : "Nothing ignored: mode, AI status and touch limits already allow a decision.");
    }
    const messages = buildDecisionMessages(ctx, ctx.settings, now);

    section("Context");
    console.log(`Lead: ${ctx.lead.firstName} ${ctx.lead.lastName} (${ctx.lead.company}) · workspace ${ctx.companyName} · mode ${ctx.settings.mode}`);
    console.log(`Token estimate: ${ctx.meta.tokenEstimate}`);
    // E3b-1 rule 2: the stage plan the decision is made under.
    const plan = ctx.stagePlan;
    console.log(
      plan
        ? `Stage: ${STAGE_LABELS[plan.stageKey]} · Angle: ${plan.angle ? ANGLE_LABELS[plan.angle] : "none (no message now)"} · channel ${plan.preferredChannel ?? "none usable"} (${plan.reason})`
        : "Stage: none (the lifecycle isn't one the agent acts on)",
    );
    console.log(`Trimmed: ${ctx.meta.trimmedTimelineEvents} timeline event(s), ${ctx.meta.trimmedDecisionSummaries} decision summary(ies)`);
    console.log(`KB query:\n  ${ctx.knowledge.query.replace(/\n/g, "\n  ")}`);
    console.log(`KB chunks: ${ctx.knowledge.chunks.map((c, i) => `[K${i + 1}] ${c.title}`).join(", ") || "none"}`);
    console.log(`Prompt tokens (cl100k, all messages): ${countTokens(messages.map((m) => m.content).join("\n"))}`);

    const userText = messages.find((m) => m.role === "user")!.content;
    section("Company (lead data: an approved grounding source)");
    console.log(ctx.company ? userText.slice(userText.lastIndexOf("Company record:"), userText.indexOf("</lead_data>")).trim() : "No company: the prompt is the same as before D1.");
    section("Internal context (decide only, never stated, not a grounding source)");
    console.log(/<internal_context>\n([\s\S]*?)\n<\/internal_context>/.exec(userText)?.[1] ?? "None (no company description, no deals).");

    for (const message of messages) {
      section(`Prompt: ${message.role}`);
      console.log(message.content);
    }
    if (!call) return;

    // The runner's own pipeline (decide, rules, grounding, one regeneration, handoff fallback), minus every write.
    const prices = parsePrices(env.OPENAI_PRICES_JSON);
    const models = resolveAgentModels(ctx.settings);
    const unpriced = [models.decisionModel, models.groundingModel].filter((m) => !priceOf(prices, m));
    if (unpriced.length) console.warn(`No price in OPENAI_PRICES_JSON for ${unpriced.join(", ")} (the runner would defer); cost below excludes it.`);
    const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: 0 };
    const draft = await draftDecision(ctx, { model: createOpenAIDecisionModel(), ...models, prices, now }, usage);

    draft.attempts.forEach((attempt, i) => {
      section(`Attempt ${i + 1}: decision`);
      console.log(JSON.stringify(attempt.decision, null, 2));
      section(`Attempt ${i + 1}: rules result`);
      console.log(JSON.stringify(attempt.rules, null, 2));
      section(`Attempt ${i + 1}: grounding`);
      console.log(attempt.grounding ? JSON.stringify(attempt.grounding, null, 2) : "(not checked: not an allowed send)");
      if (attempt.problems.length) console.log(`Problems:\n- ${attempt.problems.join("\n- ")}`);
    });

    if (evaluate) {
      section("Quality checks");
      draft.attempts.forEach((attempt, i) => {
        const d = attempt.rules.finalDecision;
        const converted = attempt.decision.action !== d.action ? `${attempt.decision.action} → ` : "";
        console.log(`Attempt ${i + 1} (${converted}${d.action}):`);
        if (d.action !== "send_email" && d.action !== "send_whatsapp") {
          const why = attempt.rules.violations.map((v) => v.message).join(" ");
          console.log(`  (not a message: nothing to check${why ? `; ${why}` : ""})`);
          return;
        }
        const failed = checkMessage(d, ctx.settings, messageFactsOf(ctx));
        for (const f of attempt.autoFixes) console.log(`  note  fixed automatically: ${f.rule} — "${f.before}" → "${f.after}"`);
        const line = (ok: boolean, name: string, detail?: string) => console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
        for (const [rule, name] of [
          ["banned_phrase", "no banned phrases"],
          ["length", "word limit"],
          ["one_question", "at most one question"],
          ["compound_question", "question about one thing"],
          ["exclamation", "no exclamation marks"],
          ["not_thanking_inbound", "inbound first message thanks them"],
          ["introduction_mid_conversation", "no introduction mid-conversation"],
          ["internal_info_leak", "no internal information"],
          ["attachment_mention", "no mention of an attachment that isn't there"],
          ["subject_style", "plain subject"],
          ["contact_details", "no links, email addresses or phone numbers"],
        ] as const) {
          const hit = failed.find((v) => v.rule === rule);
          line(!hit, name, hit?.message);
        }
        const other = attempt.rules.violations.filter((v) => !failed.some((f) => f.rule === v.rule));
        line(other.length === 0, "other rules (contacts, signature, opt-out, HTML, assets, channel)", other.map((v) => v.message).join(" "));
        // E2g: dropped attachments are notes, not failures (the message is kept).
        const title = (id: string) => ctx.assets.find((a) => a.id === id)?.title ?? id;
        const kept = d.assetIds.map(title);
        console.log(`  note  attachments: ${kept.length ? kept.join(", ") : "none"}`);
        for (const r of attempt.rules.attachmentsRemoved ?? []) console.log(`  note  attachment_removed: ${r.reason} — ${title(r.assetId)} (${ATTACHMENT_REMOVAL_TEXT[r.reason]})`);
        if (!attempt.grounding) {
          console.log("  n/a   facts + style (not grounded: a check above failed first)");
          return;
        }
        line(attempt.grounding.supported, "facts supported", attempt.grounding.unsupportedClaims.join("; "));
        for (const rule of STYLE_RULES) {
          const hits = (attempt.grounding.styleViolations ?? []).filter((v) => v.rule === rule);
          line(hits.length === 0, `style: ${rule}`, hits.map((v) => `"${v.quote}"`).join("; "));
        }
      });
    }

    section("Result (what the runner would record as a draft)");
    console.log(JSON.stringify({ outcome: draft.outcome, regenerated: draft.regenerated, decision: draft.decision }, null, 2));
    console.log(`Models ${models.decisionModel} / ${models.groundingModel} · ${usage.inputTokens} in (${usage.cachedInputTokens} cached) / ${usage.outputTokens} out · $${usage.costUsd.toFixed(6)}`);

    const final = draft.decision;
    if (final.action === "send_email" || final.action === "send_whatsapp") {
      section("Composed message (NOT sent)");
      const composed = composeOutgoing(final, {
        ownerName: ctx.lead.ownerName ?? "The team",
        companyName: ctx.companyName,
        settings: ctx.settings,
        isFirstWhatsApp: !ctx.rules.hasSentWhatsApp,
        bookingUrl: ctx.lead.ownerBookingUrl,
        angle: ctx.stagePlan?.angle ?? null,
      });
      console.log(composed.channel === "email" ? `Subject: ${composed.subject}\n\n${composed.text}` : composed.text);
      console.log(`\nBooking link added: ${composed.bookingLinkAdded ? "yes" : "no"}${ctx.lead.ownerBookingUrl ? "" : " (the owner has no booking link)"}`);
    }
  } finally {
    await pool.end();
  }
}

main(leadId).catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exit(1);
});
