// DEMO-1: the offline demo journey — the REAL agent pipeline for the demo leads on a simulated clock, with no database
// and no senders (nothing can be sent).
//   npm run agent:demo-journey -- --input demo-local/demo-leads.json --knowledge demo-local/knowledge --out demo-local/output
//     [--confirm] [--max-cost 0.40] [--only <lead key>]
// Paths are relative to the current folder, or to the repository root (demo-local/ lives there).
// Without --confirm: a dry run (no OpenAI calls) that prints the plan, the prompt sizes and the estimated cost.
// With --confirm: spends OpenAI credit (OPENAI_API_KEY + OPENAI_PRICES_JSON from Backend/.env), stops before a step
// that would take the spend past --max-cost (default $0.40, at most $3), and writes demo-journey.md + demo-journey.json.
import "dotenv/config";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { installNoDatabaseGuard } from "../src/noDatabase.js";

// Rule 1: no database at all. Before anything else is imported: no connection string, and any pg connect throws.
delete process.env.DATABASE_URL;
delete process.env.DATABASE_SESSION_URL;
installNoDatabaseGuard();

const DEFAULT_MAX_COST = 0.4;
const MAX_COST_LIMIT = 3;

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/** A path as given, else under the repository root (the script runs from Backend/, demo-local/ is beside it). */
function locate(path: string): string {
  if (existsSync(resolve(path))) return resolve(path);
  const first = path.split(/[\\/]/)[0]!;
  return existsSync(resolve("..", first)) ? resolve("..", path) : resolve(path);
}

async function main() {
  const inputArg = arg("--input");
  const knowledgeArg = arg("--knowledge");
  const outArg = arg("--out");
  if (!inputArg || !knowledgeArg || !outArg) {
    throw new Error("Usage: npm run agent:demo-journey -- --input <demo-leads.json> --knowledge <folder> --out <folder> [--confirm] [--max-cost 0.40] [--only <lead key>]");
  }
  const confirm = process.argv.includes("--confirm");
  const maxCostUsd = arg("--max-cost") === undefined ? DEFAULT_MAX_COST : Number(arg("--max-cost"));
  if (!(maxCostUsd > 0 && maxCostUsd <= MAX_COST_LIMIT)) throw new Error(`--max-cost takes US dollars above 0 and at most ${MAX_COST_LIMIT}.`);

  const { demoInputSchema, planSummary, renderMarkdown, runDemoJourney } = await import("../src/demo/demoJourney.js");
  const { parsePrices } = await import("../src/agent/pricing.js");

  const input = demoInputSchema.parse(JSON.parse(readFileSync(locate(inputArg), "utf8")));
  const knowledgeDir = locate(knowledgeArg);
  const knowledge = readdirSync(knowledgeDir)
    .filter((name) => /\.(md|txt)$/i.test(name))
    .sort()
    .map((name) => ({ name, text: readFileSync(join(knowledgeDir, name), "utf8") }));
  const prices = parsePrices(process.env.OPENAI_PRICES_JSON);

  let openai: { model: Awaited<ReturnType<typeof import("../src/providers/openai.provider.js")["createOpenAIDecisionModel"]>>; embedder: import("../src/providers/openai.provider.js").Embedder } | null = null;
  if (confirm) {
    if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set in Backend/.env.");
    // Only a paid run loads the OpenAI provider (it reads Backend/.env; DATABASE_URL is not needed).
    const provider = await import("../src/providers/openai.provider.js");
    openai = { model: provider.createOpenAIDecisionModel(), embedder: provider.createOpenAIEmbedder() };
  }

  console.log(`${confirm ? "PAID RUN" : "DRY RUN (no OpenAI calls)"} · writer ${input.workspace.writer} · checker ${input.workspace.checker} · max cost $${maxCostUsd.toFixed(2)}`);
  console.log(`Knowledge: ${knowledge.map((k) => k.name).join(", ")}`);
  const result = await runDemoJourney({
    input,
    knowledge,
    prices,
    confirm,
    maxCostUsd,
    only: arg("--only") ?? null,
    ...(openai ? { model: openai.model, embedder: openai.embedder } : {}),
    log: (line) => console.log(line),
  });
  console.log("");
  if (!confirm) {
    for (const line of planSummary(result)) console.log(line);
    console.log("Dry run: nothing was called and nothing was written. Add --confirm to run it.");
    return;
  }
  const outDir = locate(outArg);
  mkdirSync(outDir, { recursive: true });
  const now = new Date();
  writeFileSync(join(outDir, "demo-journey.md"), renderMarkdown(result, now));
  writeFileSync(join(outDir, "demo-journey.json"), `${JSON.stringify({ generatedAt: now.toISOString(), ...result }, null, 2)}\n`);
  console.log(`Spent $${result.spentUsd.toFixed(4)} (estimate $${result.estimateUsd.toFixed(2)}).${result.stoppedAtCap ? ` STOPPED at the $${maxCostUsd.toFixed(2)} cap: later steps were not run.` : ""}`);
  console.log(`Wrote ${join(outDir, "demo-journey.md")} and demo-journey.json.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exit(1);
});
