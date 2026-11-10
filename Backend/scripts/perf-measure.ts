/**
 * npm run staging:perf-measure -- --label baseline|after [--runs 20]
 *
 * P7: times the API reads and worker paths at the seeded size (staging:load-seed), STAGING only. Each
 * scenario runs `--runs` times (wall p50/p95 from this machine, i.e. with the round trips to the
 * database). Every SQL statement of the first run is recorded and re-run under EXPLAIN (ANALYZE,
 * BUFFERS) inside a transaction that is rolled back: the server time and any sequential scan on a
 * table with more than 10,000 rows. Worker paths run against the load-seed workspaces only; nothing is
 * sent (dry run, nothing queued) and the AI uses the tests' fake model and embedder (never OpenAI).
 * Writes scripts/output/perf-<label>-<timestamp>.md.
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { stagingProblem } from "./lib/stagingGuard.js";
import { LOAD_SEED_LABEL } from "./load-seed.js";

interface Recorded {
  text: string;
  values: unknown[];
}
interface Result {
  name: string;
  group: "api" | "worker";
  runs: number[];
  statements: number;
  serverMs: number;
  worstStatementMs: number;
  seqScans: string[];
}

const percentile = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] ?? 0;
};

// Records every statement any pg Client runs while `recording` is on (pool.query and client.query both end here).
let recording: Recorded[] | null = null;
const originalQuery = pg.Client.prototype.query;
(pg.Client.prototype as unknown as { query: (...args: unknown[]) => unknown }).query = function (this: pg.Client, ...args: unknown[]) {
  if (recording) {
    const first = args[0] as string | { text: string; values?: unknown[] };
    const text = typeof first === "string" ? first : first?.text;
    const values = (typeof first === "string" ? args[1] : first?.values) as unknown[] | undefined;
    if (typeof text === "string" && /^\s*(with|select|update|insert|delete)\b/i.test(text)) recording.push({ text, values: Array.isArray(values) ? values : [] });
  }
  return (originalQuery as (...a: unknown[]) => unknown).apply(this, args);
};

async function main() {
  const argv = process.argv.slice(2);
  const label = argv[argv.indexOf("--label") + 1];
  if (!argv.includes("--label") || !label || label.startsWith("--")) throw new Error("Usage: npm run staging:perf-measure -- --label <name> [--runs 20]");
  const runsArg = argv.includes("--runs") ? Number(argv[argv.indexOf("--runs") + 1]) : 20;
  const problem = stagingProblem(process.env.DATABASE_URL);
  if (problem) throw new Error(problem);
  process.env.NORTHBEAM_DB_ROLE = "script";

  const { pool } = await import("../src/db.js");
  const explainClient = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await explainClient.connect();
  try {
    const seeded = (await pool.query<{ id: string }>(`select id from public.workspaces where name like $1 order by created_at`, [`[test] ${LOAD_SEED_LABEL} %`])).rows.map((r) => r.id);
    if (seeded.length === 0) throw new Error("No load-seed workspaces: run `npm run staging:load-seed -- --confirm` first.");
    const ws = seeded[0]!;
    const admin = (
      await pool.query<{ id: string; full_name: string; email: string }>(
        `select p.id, p.full_name, p.email from public.workspace_members m join public.profiles p on p.id = m.user_id where m.workspace_id = $1 and m.role = 'admin'`,
        [ws],
      )
    ).rows[0]!;
    const actor = { id: admin.id, fullName: admin.full_name, email: admin.email, isActive: true, role: "admin" as const };
    const rep = (
      await pool.query<{ id: string }>(`select user_id as id from public.workspace_members where workspace_id = $1 and role = 'salesperson' limit 1`, [ws])
    ).rows[0]!.id;
    const lead = (
      await pool.query<{ id: string; phone_e164: string; whatsapp_number_id: string }>(
        `select id, phone_e164, whatsapp_number_id from public.leads where workspace_id = $1 and whatsapp_number_id is not null order by id limit 1`,
        [ws],
      )
    ).rows[0]!;
    const token = (await pool.query<{ open_token: string }>(`select open_token from public.email_outbound_messages where workspace_id = $1 and open_token is not null limit 1`, [ws])).rows[0]!.open_token;
    const bigTables = new Set(
      (await pool.query<{ relname: string }>(`select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and reltuples > 10000`)).rows.map((r) => r.relname),
    );

    const contacts = await import("../src/services/contacts.service.js");
    const timeline = await import("../src/services/timeline.service.js");
    const companies = await import("../src/services/companyRecords.service.js");
    const deals = await import("../src/services/dealRecords.service.js");
    const work = await import("../src/services/workLists.service.js");
    const { globalSearch } = await import("../src/services/search.service.js");
    const { getHomeSummary } = await import("../src/services/home.service.js");
    const review = await import("../src/services/agentReview.service.js");
    const { getFunnel } = await import("../src/services/funnel.service.js");
    const { getWhatsAppConnection } = await import("../src/services/connections.service.js");
    const { claimDueActions } = await import("../src/services/automation.service.js");
    const { claimDueEmails, runEmailOutbound } = await import("../src/services/emailOutbound.service.js");
    const { loadSendStats } = await import("../src/services/whatsappSafety.service.js");
    const { runLeadScoreSweep } = await import("../src/services/leadScore.service.js");
    const { runCompanySweep } = await import("../src/services/companies.service.js");
    const { runDealSweep } = await import("../src/services/deals.service.js");
    const { runReplyDrafts, runReplyDraftSends } = await import("../src/services/replyDrafts.service.js");
    const { runReplyClassification } = await import("../src/services/replyClassifier.service.js");
    const { runReplyEscalation, runMeetingOutcomeTasks } = await import("../src/services/workReminders.service.js");
    const { runAgentSends } = await import("../src/services/agentSends.service.js");
    const { runAgentTick } = await import("../src/services/agentRunner.service.js");
    const { runOpenEvents, recordEmailOpen } = await import("../src/services/emailOpens.service.js");
    const { createFakeDecisionModel } = await import("../tests/helpers/fakeDecisionModel.js");
    const { fakeEmbedder } = await import("../tests/helpers/fakeEmbedder.js");

    // A claim that would really claim is measured inside a transaction that is rolled back.
    const rolledBack = async (fn: (c: pg.PoolClient) => Promise<unknown>) => {
      const c = await pool.connect();
      try {
        await c.query("begin");
        await fn(c);
      } finally {
        await c.query("rollback").catch(() => undefined);
        c.release();
      }
    };
    const now = Date.now();
    const days = (n: number) => new Date(now - n * 86_400_000).toISOString();

    type Scenario = { name: string; group: "api" | "worker"; run: () => Promise<unknown>; before?: () => Promise<unknown>; runs?: number };
    const api = (name: string, run: () => Promise<unknown>): Scenario => ({ name, group: "api", run });
    const scenarios: Scenario[] = [
      api("contacts: default (createdAt desc)", () => contacts.listContacts(pool, actor, ws, contacts.contactListSchema.parse({}))),
      ...["lastActivityAt:desc", "updatedAt:desc", "name:asc", "company:asc", "hotScore:desc"].map((sort) =>
        api(`contacts: sort ${sort}`, () => contacts.listContacts(pool, actor, ws, contacts.contactListSchema.parse({ sort }))),
      ),
      api("contacts: filter stage + owner", () => contacts.listContacts(pool, actor, ws, contacts.contactListSchema.parse({ leadStatus: "new", ownerId: rep }))),
      api("contacts: filter open deal + AI active", () => contacts.listContacts(pool, actor, ws, contacts.contactListSchema.parse({ hasOpenDeal: "true", agentStatus: "active" }))),
      api("contacts: search q=Seed123", () => contacts.listContacts(pool, actor, ws, contacts.contactListSchema.parse({ q: "Seed123" }))),
      api("contacts: count", () => contacts.countContacts(pool, actor, ws, contacts.contactFilterSchema.parse({}))),
      api("contacts: count q=Seed12", () => contacts.countContacts(pool, actor, ws, contacts.contactFilterSchema.parse({ q: "Seed12" }))),
      api("contact timeline page", () => timeline.listContactTimeline(pool, ws, lead.id, timeline.timelineListSchema.parse({}), true)),
      api("companies: default", () => companies.listCompanies(pool, actor, ws, companies.companyListSchema.parse({}))),
      api("companies: sort contactCount", () => companies.listCompanies(pool, actor, ws, companies.companyListSchema.parse({ sort: "contactCount:desc" }))),
      api("companies: search q=Company 12", () => companies.listCompanies(pool, actor, ws, companies.companyListSchema.parse({ q: "Company 12" }))),
      api("deals: default", () => deals.listDeals(pool, actor, ws, deals.dealListSchema.parse({}))),
      api("deals: open, sort amount", () => deals.listDeals(pool, actor, ws, deals.dealListSchema.parse({ status: "open", sort: "amount:desc" }))),
      api("deal board", () => deals.dealBoard(pool, actor, ws, deals.dealBoardSchema.parse({}))),
      api("tasks: default (open, due asc)", () => work.listWorkTasks(pool, actor, ws, work.taskListSchema.parse({ status: "open" }))),
      api("tasks: Hottest first", () => work.listWorkTasks(pool, actor, ws, work.taskListSchema.parse({ status: "open", sort: "hotScore:desc" }))),
      api("tasks: overdue", () => work.listWorkTasks(pool, actor, ws, work.taskListSchema.parse({ due: "overdue" }))),
      api("tasks: count", () => work.countWorkTasks(pool, actor, ws, work.taskFilterSchema.parse({ status: "open" }))),
      api("global search q=Seed 15", () => globalSearch(pool, ws, "Seed 15")),
      api("Home summary", () => getHomeSummary(pool, actor, ws)),
      api("AI Activity list", () => review.listDecisions(pool, ws, { limit: 50 })),
      api("AI Results stats", () => review.getAgentStats(pool, ws)),
      ...[30, 180].flatMap((d) =>
        (["source", "channel", "number", "angle"] as const).map((groupBy) =>
          api(`funnel ${d} d by ${groupBy}`, () => getFunnel(pool, ws, { from: days(d), to: new Date(now).toISOString(), groupBy })),
        ),
      ),
      api("Settings → WhatsApp numbers", () => getWhatsAppConnection(ws)),
      // Worker paths.
      { name: "workflow action claim (20)", group: "worker", run: () => rolledBack((c) => claimDueActions(c, 20)) },
      { name: "email outbound claim (10)", group: "worker", run: () => rolledBack((c) => claimDueEmails(c, 10, null)) },
      { name: "email outbound tick (seeded, dry run)", group: "worker", run: () => runEmailOutbound({ workspaceIds: seeded, dryRun: true }) },
      { name: "decideSend counters (loadSendStats)", group: "worker", run: () => loadSendStats(pool, ws, lead.whatsapp_number_id, `${lead.phone_e164.slice(1)}@s.whatsapp.net`, lead.phone_e164, null) },
      {
        name: "inbound reply match (phone)",
        group: "worker",
        run: () =>
          rolledBack((c) =>
            c.query(
              `select id, owner_id, agent_status, whatsapp_number_id, (select full_name from public.profiles p where p.id = leads.owner_id) as owner_name
                 from public.leads where phone_e164 = $1 and workspace_id = $2 and lifecycle_state = 'active' and merged_into_lead_id is null for update`,
              [lead.phone_e164, ws],
            ),
          ),
      },
      {
        name: "hot-score sweep batch (200 marked)",
        group: "worker",
        before: () => pool.query(`update public.leads set hot_score_dirty = true where id in (select id from public.leads where workspace_id = $1 order by random() limit 200)`, [ws]),
        run: () => runLeadScoreSweep({ workspaceId: ws }),
      },
      {
        name: "company sweep (20 contacts)",
        group: "worker",
        runs: 5,
        before: () => pool.query(`update public.leads set company_link_checked_at = null where id in (select id from public.leads where workspace_id = $1 and company_id is not null order by random() limit 20)`, [ws]),
        run: () => runCompanySweep({ workspaceId: ws, limit: 20 }),
      },
      {
        name: "deal sweep (10 contacts)",
        group: "worker",
        runs: 5,
        before: () => pool.query(`update public.meetings set deal_id = null where id in (select id from public.meetings where workspace_id = $1 order by random() limit 10)`, [ws]),
        run: () => runDealSweep({ workspaceId: ws, limit: 10 }),
      },
      { name: "reply labels tick", group: "worker", run: () => runReplyClassification(true, { model: createFakeDecisionModel(), workspaceIds: seeded }) },
      { name: "reply drafts tick", group: "worker", run: () => runReplyDrafts(true, { model: createFakeDecisionModel(), embedder: fakeEmbedder, workspaceIds: seeded }) },
      { name: "reply draft sends tick", group: "worker", run: () => runReplyDraftSends({ workspaceIds: seeded, dryRun: true }) },
      { name: "reply escalation tick", group: "worker", run: () => runReplyEscalation({ workspaceIds: seeded }) },
      { name: "meeting outcome tasks tick", group: "worker", run: () => runMeetingOutcomeTasks({ workspaceIds: seeded }) },
      { name: "AI sends tick", group: "worker", run: () => runAgentSends(true, { workspaceIds: seeded, dryRun: true }) },
      { name: "open events tick", group: "worker", run: () => runOpenEvents({ workspaceIds: seeded }) },
      { name: "open pixel UPDATE", group: "worker", run: () => recordEmailOpen(pool, token) },
      {
        // One seeded workspace in shadow for the claim (fake model: shadow drafts, never sent, never OpenAI); restored to off below.
        name: "AI wake-up claim + tick (shadow, fake model)",
        group: "worker",
        runs: 3,
        before: () => pool.query(`update public.agent_settings set mode = 'shadow' where workspace_id = $1`, [ws]),
        run: () => runAgentTick(true, { model: createFakeDecisionModel({ decisions: Array.from({ length: 50 }, () => ({ action: "wait", nextWakeInDays: 3, reasoning: "Load test." })) }), embedder: fakeEmbedder, workspaceIds: [ws] } as never),
      },
    ];

    // --explain "<part of a scenario name>": print the text plans of that scenario's statements and stop.
    const explainOnly = argv.includes("--explain") ? argv[argv.indexOf("--explain") + 1] : undefined;
    if (explainOnly) {
      for (const s of scenarios.filter((x) => x.name.includes(explainOnly))) {
        if (s.before) await s.before();
        recording = [];
        await s.run();
        const recorded = recording;
        recording = null;
        for (const st of recorded) {
          await explainClient.query("begin");
          const plan = await explainClient.query(`explain (analyze, buffers) ${st.text}`, st.values).catch((e: Error) => ({ rows: [{ "QUERY PLAN": e.message }] }));
          await explainClient.query("rollback");
          const lines = plan.rows.map((r: Record<string, unknown>) => String(r["QUERY PLAN"]));
          console.log(["", `=== ${s.name}`, st.text, `--- params ${JSON.stringify(st.values).slice(0, 300)}`, ...lines].join("\n"));
        }
      }
      return;
    }

    const results: Result[] = [];
    try {
      for (const s of scenarios) {
        const runs: number[] = [];
        let recorded: Recorded[] = [];
        const total = s.runs ?? runsArg;
        for (let i = 0; i < total; i++) {
          if (s.before) await s.before();
          recording = i === 0 ? [] : null;
          const started = performance.now();
          await s.run();
          runs.push(performance.now() - started);
          if (i === 0) recorded = recording ?? [];
          recording = null;
        }
        let serverMs = 0;
        let worst = 0;
        const seqScans = new Set<string>();
        for (const st of recorded) {
          try {
            await explainClient.query("begin");
            const plan = (await explainClient.query(`explain (analyze, buffers, format json) ${st.text}`, st.values)).rows[0]["QUERY PLAN"][0];
            serverMs += plan["Execution Time"] + plan["Planning Time"];
            worst = Math.max(worst, plan["Execution Time"]);
            const walk = (node: Record<string, unknown>) => {
              if (node["Node Type"] === "Seq Scan" && bigTables.has(String(node["Relation Name"]))) seqScans.add(String(node["Relation Name"]));
              for (const child of (node.Plans as Record<string, unknown>[] | undefined) ?? []) walk(child);
            };
            walk(plan.Plan);
          } catch {
            // A statement that only works inside its own transaction (e.g. depends on an earlier one): wall time still counts.
          } finally {
            await explainClient.query("rollback").catch(() => undefined);
          }
        }
        const r: Result = { name: s.name, group: s.group, runs, statements: recorded.length, serverMs, worstStatementMs: worst, seqScans: [...seqScans] };
        results.push(r);
        console.log(
          `${s.name.padEnd(46)} p50 ${percentile(runs, 50).toFixed(0).padStart(6)} ms  p95 ${percentile(runs, 95).toFixed(0).padStart(6)} ms  stmts ${String(r.statements).padStart(3)}  server ${serverMs.toFixed(1).padStart(7)} ms  worst ${worst.toFixed(1).padStart(6)} ms ${r.seqScans.length ? ` SEQ SCAN: ${r.seqScans.join(", ")}` : ""}`,
        );
      }
    } finally {
      await pool.query(`update public.agent_settings set mode = 'off' where workspace_id = any($1::uuid[])`, [seeded]);
    }

    const lines = [
      `# P7 measurements — ${label} (${new Date().toISOString()})`,
      "",
      `Workspace ${ws} of ${seeded.length} load-seed workspaces (${runsArg} runs per API read). Wall = this machine → staging (includes one network round trip per statement); server = EXPLAIN ANALYZE execution + planning of every statement of one call.`,
      "",
      "| Path | p50 wall ms | p95 wall ms | statements | server ms | worst statement ms | seq scan > 10k rows |",
      "|---|---:|---:|---:|---:|---:|---|",
      ...results.map(
        (r) =>
          `| ${r.group === "worker" ? "worker: " : ""}${r.name} | ${percentile(r.runs, 50).toFixed(0)} | ${percentile(r.runs, 95).toFixed(0)} | ${r.statements} | ${r.serverMs.toFixed(1)} | ${r.worstStatementMs.toFixed(1)} | ${r.seqScans.join(", ") || "—"} |`,
      ),
    ];
    mkdirSync(new URL("./output/", import.meta.url), { recursive: true });
    const file = new URL(`./output/perf-${label}-${new Date().toISOString().replace(/[:.]/g, "-")}.md`, import.meta.url);
    writeFileSync(file, lines.join("\n") + "\n");
    console.log(`Wrote ${file.pathname}`);
  } finally {
    await explainClient.end();
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
  });
}
