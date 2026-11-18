// E3a: compares writer > checker model combinations on the same contacts. Saves nothing, sends nothing.
//   npm run agent:model-test -- --combos "gpt-5.4-mini>gpt-4.1,gpt-5.4-mini@low>gpt-4.1" [--leads <ids|seeded>]
//     [--only "Full Name,Full Name"] [--channel email|whatsapp] [--max-cost <usd>] [--confirm]
// On Windows write "/" instead of ">": npm.cmd runs through cmd.exe, which takes ">" as a redirect.
// Default contacts: the seeded AI test contacts + Suyash + Raj; --only keeps the named ones (case-insensitive full name).
// --channel forces the planned channel (where usable). Without --confirm it only prints the plan and the estimated cost.
// With --confirm it spends OpenAI credit (stops before the next contact once the spend reaches --max-cost, default $0.10,
// at most $3) and writes scripts/output/model-test-<timestamp>.md.
// Refuses to run against the production project.
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";

const PRODUCTION_REF = "jorxltfwboabyjiydyhu";
const SEED_MARKER = "AI test seed";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const combosArg = arg("--combos");
const leadsArg = arg("--leads");
const confirm = process.argv.includes("--confirm");
if (!combosArg) {
  console.error('Usage: npm run agent:model-test -- --combos "writer>checker,writer>checker" [--leads <ids|seeded>] [--only "Full Name,..."] [--channel email|whatsapp] [--max-cost <usd>] [--confirm]');
  process.exit(1);
}
for (const name of ["DATABASE_URL", "SUPABASE_URL"]) {
  if (process.env[name]?.includes(PRODUCTION_REF)) {
    console.error(`${name} points at the production project; agent:model-test only runs against staging.`);
    process.exit(1);
  }
}
if (process.env.NODE_ENV === "production") {
  console.error("NODE_ENV=production; agent:model-test only runs against staging.");
  process.exit(1);
}

async function main(rawCombos: string) {
  // Imported after the checks above so nothing connects before them.
  process.env.NORTHBEAM_DB_ROLE = "script";
  const { pool } = await import("../src/db.js");
  const { env } = await import("../src/env.js");
  const { parsePrices } = await import("../src/agent/pricing.js");
  const { buildAgentContext } = await import("../src/services/agentContext.service.js");
  const { estimateCost, evaluationContext, filterByNames, parseCombos, parseRunOptions, renderReport, runModelTest, stoppedText, unpricedModels } = await import(
    "../src/services/agentModelTest.service.js"
  );
  const { createOpenAIDecisionModel, getDefaultEmbedder } = await import("../src/providers/openai.provider.js");

  try {
    const combos = parseCombos(rawCombos);
    const options = parseRunOptions({ channel: arg("--channel"), only: arg("--only"), maxCost: arg("--max-cost") });
    const prices = parsePrices(env.OPENAI_PRICES_JSON);
    const unpriced = unpricedModels(combos, prices);
    if (unpriced.length) throw new Error(`No price in OPENAI_PRICES_JSON for ${unpriced.join(", ")}.`);

    const leads = filterByNames(await loadLeads(pool, leadsArg), options.only);
    if (!leads.length) throw new Error("No contacts found.");
    const estimate = estimateCost(combos, leads.length, prices);
    console.log(`Contacts: ${leads.length} (${leads.map((l) => `${l.first_name} ${l.last_name ?? ""}`.trim()).join(", ")})`);
    if (options.channel) console.log(`Channel forced: ${options.channel}`);
    for (const c of estimate.perCombo) console.log(`  ${c.label}: about $${c.usd.toFixed(2)}`);
    console.log(`Estimated cost: about $${estimate.totalUsd.toFixed(2)} (stops before the next contact once the spend reaches $${options.maxCostUsd.toFixed(2)}).`);
    if (!confirm) {
      console.log("Dry run: nothing was called. Add --confirm to run it.");
      return;
    }
    if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set.");

    const now = new Date();
    const contexts = [];
    for (const lead of leads) contexts.push(evaluationContext(await buildAgentContext(pool, lead.workspace_id, lead.id, now, { embedder: getDefaultEmbedder() }), options.channel).ctx);
    const result = await runModelTest({ contexts, combos, model: createOpenAIDecisionModel(), prices, now, capUsd: options.maxCostUsd });

    for (const r of result.runs) {
      const m = r.message ? ` · ${r.message.channel} · first WhatsApp: ${r.message.firstWhatsApp ? "yes" : "no"} · ${r.message.words} words · booking link: ${r.bookingLink ? "yes" : `no (${r.bookingLinkNote})`}` : "";
      console.log(`  ${r.combo} · ${r.name}: ${r.outcome}${m}`);
    }
    mkdirSync("scripts/output", { recursive: true });
    const file = `scripts/output/model-test-${now.toISOString().replace(/[:.]/g, "-")}.md`;
    writeFileSync(file, renderReport(result, combos, { at: now, contacts: contexts.length }));
    console.log(`Spent $${result.spentUsd.toFixed(4)}.${result.stoppedAtCap ? ` ${stoppedText(result)}` : ""} Report: Backend/${file}`);
  } finally {
    await pool.end();
  }
}

/** Comma-separated ids; "seeded"; or by default the seeded contacts plus Suyash and Raj from the same workspace. */
async function loadLeads(pool: { query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> }, leads: string | undefined) {
  type Lead = { id: string; workspace_id: string; first_name: string; last_name: string | null };
  if (leads && leads !== "seeded") {
    const ids = leads.split(",").map((id) => id.trim());
    if (!ids.every((id) => /^[0-9a-f-]{36}$/i.test(id))) throw new Error("--leads takes comma-separated lead ids, or seeded.");
    return (await pool.query<Lead>(`select id, workspace_id, first_name, last_name from public.leads where id = any($1::uuid[])`, [ids])).rows;
  }
  const seeded = (await pool.query<Lead>(`select id, workspace_id, first_name, last_name from public.leads where created_by_name = $1 order by created_at`, [SEED_MARKER])).rows;
  if (leads === "seeded" || !seeded[0]) return seeded;
  const named = await pool.query<Lead>(
    `select distinct on (lower(first_name)) id, workspace_id, first_name, last_name from public.leads
      where workspace_id = $1 and lower(first_name) in ('suyash', 'raj') and created_by_name is distinct from $2 and lifecycle_state = 'active'
      order by lower(first_name), created_at desc`,
    [seeded[0].workspace_id, SEED_MARKER],
  );
  return [...seeded, ...named.rows];
}

main(combosArg).catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exit(1);
});
