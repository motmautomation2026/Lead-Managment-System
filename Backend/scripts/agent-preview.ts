// Dev only: shows what the AI agent would see and (with --call) decide for one lead.
//   npm run agent:preview -- --lead <uuid> [--call]
// Reads only: saves nothing to the database and never sends anything.
// Refuses to run against the production project.
import "dotenv/config";

const PRODUCTION_REF = "jorxltfwboabyjiydyhu";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const leadId = arg("--lead");
const call = process.argv.includes("--call");
if (!leadId || !/^[0-9a-f-]{36}$/i.test(leadId)) {
  console.error("Usage: npm run agent:preview -- --lead <lead uuid> [--call]");
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
  const { pool } = await import("../src/db.js");
  const { env } = await import("../src/env.js");
  const { buildAgentContext } = await import("../src/services/agentContext.service.js");
  const { buildDecisionMessages, buildGroundingMessages, GROUNDING_JSON_SCHEMA } = await import("../src/agent/prompt.js");
  const { DECISION_JSON_SCHEMA } = await import("../src/agent/decisionSchema.js");
  const { validateDecision } = await import("../src/agent/rules.js");
  const { composeOutgoing } = await import("../src/agent/composeMessage.js");
  const { costUsd, parsePrices } = await import("../src/agent/pricing.js");
  const { createOpenAIDecisionModel, getDefaultEmbedder, resolveAgentModels } = await import("../src/providers/openai.provider.js");

  try {
    const lead = (await pool.query<{ workspace_id: string }>(`select workspace_id from public.leads where id = $1`, [id])).rows[0];
    if (!lead) throw new Error(`No lead ${id}.`);

    // Without an OpenAI key the KB search can't embed its query: show the prompt without knowledge.
    const embedder = env.OPENAI_API_KEY ? getDefaultEmbedder() : { model: "none", embed: async () => [] };
    if (!env.OPENAI_API_KEY) console.warn("OPENAI_API_KEY is not set: knowledge search skipped.");

    const now = new Date();
    const ctx = await buildAgentContext(pool, lead.workspace_id, id, now, { embedder, fallbackSenderAddress: process.env.SMTP_FROM_ADDRESS ?? null });
    const messages = buildDecisionMessages(ctx, ctx.settings, now);

    section("Context");
    console.log(`Lead: ${ctx.lead.firstName} ${ctx.lead.lastName} (${ctx.lead.company}) · workspace ${ctx.companyName} · mode ${ctx.settings.mode}`);
    console.log(`Token estimate: ${ctx.meta.tokenEstimate}`);
    console.log(`Trimmed: ${ctx.meta.trimmedTimelineEvents} timeline event(s), ${ctx.meta.trimmedDecisionSummaries} decision summary(ies)`);
    console.log(`KB query:\n  ${ctx.knowledge.query.replace(/\n/g, "\n  ")}`);
    console.log(`KB chunks: ${ctx.knowledge.chunks.map((c, i) => `[K${i + 1}] ${c.title}`).join(", ") || "none"}`);

    for (const message of messages) {
      section(`Prompt: ${message.role}`);
      console.log(message.content);
    }
    if (!call) return;

    const prices = parsePrices(env.OPENAI_PRICES_JSON);
    const price = (model: string, input: number, output: number) => {
      const cost = costUsd(prices, model, input, output);
      return cost === null ? `no price configured for ${model}` : `$${cost.toFixed(6)}`;
    };
    const { decisionModel, groundingModel } = resolveAgentModels(ctx.settings);
    const ai = createOpenAIDecisionModel();

    const decided = await ai.decide({ model: decisionModel, messages, jsonSchema: { name: "agent_decision", schema: DECISION_JSON_SCHEMA as unknown as Record<string, unknown> } });
    section("Decision");
    console.log(JSON.stringify(decided.json, null, 2));
    console.log(`Model ${decided.model} · ${decided.inputTokens} in / ${decided.outputTokens} out · ${price(decisionModel, decided.inputTokens, decided.outputTokens)}`);

    const rules = validateDecision(decided.json, ctx.rules, ctx.settings, now);
    section("Rules result");
    console.log(JSON.stringify(rules, null, 2));

    const final = rules.finalDecision;
    const grounding = buildGroundingMessages(final, ctx.knowledge.chunks);
    if (grounding) {
      const checked = await ai.checkGrounding({ model: groundingModel, messages: grounding, jsonSchema: { name: "grounding_check", schema: GROUNDING_JSON_SCHEMA as unknown as Record<string, unknown> } });
      section("Grounding");
      console.log(JSON.stringify(checked.json, null, 2));
      console.log(`Model ${checked.model} · ${checked.inputTokens} in / ${checked.outputTokens} out · ${price(groundingModel, checked.inputTokens, checked.outputTokens)}`);
    }
    if (final.action === "send_email" || final.action === "send_whatsapp") {
      section("Composed message (NOT sent)");
      const composed = composeOutgoing(final, {
        ownerName: ctx.lead.ownerName ?? "The team",
        companyName: ctx.companyName,
        settings: ctx.settings,
        isFirstWhatsApp: !ctx.rules.hasSentWhatsApp,
      });
      console.log(composed.channel === "email" ? `Subject: ${composed.subject}\n\n${composed.text}` : composed.text);
    }
  } finally {
    await pool.end();
  }
}

main(leadId).catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exit(1);
});
