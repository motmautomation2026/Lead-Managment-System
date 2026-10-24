/**
 * CRM v2 list performance (B4), skipped unless RUN_PERF_TESTS=true (and TEST_DATABASE_URL).
 * Seeds one [test] workspace with 5,000 contacts, 1,000 companies and 1,500 deals
 * (one INSERT … SELECT generate_series per table), then times the first page and a deep
 * page (after 20 pages) of each list plus `q` search, and EXPLAINs the contacts default
 * sort and `q` search. Times: HTTP round trip from this machine (includes network to the
 * pooler) and EXPLAIN ANALYZE execution time (server-side; target < 300 ms).
 * PERF_REPORT_FILE=<path> also writes the report there.
 */
import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createTestWorkspace, deleteCreatedTestWorkspaces } from "../helpers/testWorkspaces.js";
import { qs, startTestApi, type TestApi } from "../helpers/testApi.js";
import type { Actor } from "../../src/authMiddleware.js";
import type { Queryable } from "../../src/dto.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfPerf = DATABASE_URL && process.env.RUN_PERF_TESTS === "true" ? describe : describe.skip;
const TARGET_MS = 300;

describeIfPerf("list performance (RUN_PERF_TESTS=true)", () => {
  let pool: Pool;
  let api: TestApi;
  let rep: Actor;
  let ws: string;
  const report: string[] = [];

  /** A Queryable that records each statement so it can be EXPLAINed with the same parameters. */
  const recorder = () => {
    const statements: { sql: string; params: unknown[] }[] = [];
    const db = { query: (sql: string, params: unknown[]) => (statements.push({ sql, params }), pool.query(sql, params)) } as unknown as Queryable;
    return { db, statements };
  };
  const explain = async (sql: string, params: unknown[]) => {
    const { rows } = await pool.query(`explain (analyze, buffers, format json) ${sql}`, params);
    const plan = rows[0]["QUERY PLAN"][0];
    const nodes: string[] = [];
    const walk = (n: { "Node Type": string; "Index Name"?: string; "Relation Name"?: string; Plans?: unknown[] }) => {
      nodes.push(`${n["Node Type"]}${n["Index Name"] ? ` ${n["Index Name"]}` : n["Relation Name"] ? ` on ${n["Relation Name"]}` : ""}`);
      for (const child of (n.Plans ?? []) as (typeof n)[]) walk(child);
    };
    walk(plan.Plan);
    return { executionMs: plan["Execution Time"] as number, nodes };
  };
  const timed = async (label: string, path: string) => {
    const started = performance.now();
    const res = await api.call(rep, ws, "GET", path);
    const ms = performance.now() - started;
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    report.push(`${label.padEnd(34)} HTTP ${ms.toFixed(0).padStart(5)} ms`);
    return res.body;
  };
  const deepCursor = async (path: string, params: Record<string, string | number>) => {
    let cursor: string | undefined;
    for (let i = 0; i < 20; i++) cursor = (await api.call(rep, ws, "GET", `${path}${qs({ ...params, cursor })}`)).body.nextCursor;
    expect(cursor).toEqual(expect.any(String));
    return cursor!;
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
    api = await startTestApi(pool, "list-perf");
    rep = await api.newUser("salesperson");
    ws = await createTestWorkspace(pool, "list-perf");
    const t0 = performance.now();
    await pool.query(
      `insert into public.companies (workspace_id, name, normalized_name, domain, industry, owner_id, created_at)
       select $1, 'Perf Company ' || g, 'perf company ' || g, 'perf' || g || '.example.com',
              (array['SaaS', 'Retail', 'Steel', null])[1 + g % 4], case when g % 5 = 0 then null else $2::uuid end, now() - g * interval '1 hour'
         from generate_series(1, 1000) g`,
      [ws, rep.id],
    );
    await pool.query(
      `insert into public.leads (workspace_id, first_name, last_name, company, company_id, company_link_checked_at, email, source, owner_id,
                                 created_at, last_activity_at)
       select $1, 'User' || g, 'Perf' || (g % 700), c.name, c.id, now(), 'user' || g || '@perf' || (g % 1000 + 1) || '.example.com', 'referral',
              case when g % 7 = 0 then null else $2::uuid end, now() - g * interval '1 minute', now() - (g % 997) * interval '1 hour'
         from generate_series(1, 5000) g
         join public.companies c on c.workspace_id = $1 and c.normalized_name = 'perf company ' || (g % 1000 + 1)`,
      [ws, rep.id],
    );
    await pool.query(
      `insert into public.deals (workspace_id, name, lead_id, company_id, owner_id, stage, amount, expected_close_date, source, loss_reason, closed_at, created_by_name)
       select $1, 'Perf deal ' || l.rn, l.id, l.company_id, l.owner_id, s.stage::public.deal_stage,
              case when l.rn % 5 = 0 then null else (l.rn % 100) * 1000 end,
              case when l.rn % 3 = 0 then null else current_date + (l.rn % 120)::int end, 'backfill',
              case when s.stage = 'lost' then 'other'::public.lead_loss_reason end,
              case when s.stage in ('won', 'lost') then now() end, 'Perf'
         from (select id, company_id, owner_id, row_number() over (order by created_at desc) as rn from public.leads where workspace_id = $1 limit 1500) l
         cross join lateral (select (array['qualified','meeting_scheduled','meeting_follow_up','proposal_preparation','proposal_sent','negotiation','won','lost'])[1 + l.rn % 8] as stage) s`,
      [ws],
    );
    await pool.query(`analyze public.leads; analyze public.companies; analyze public.deals`);
    report.push(`seed: ${(performance.now() - t0).toFixed(0)} ms`);
  }, 300_000);

  afterAll(async () => {
    console.log(`\n[list-perf]\n${report.join("\n")}\n`);
    if (process.env.PERF_REPORT_FILE) writeFileSync(process.env.PERF_REPORT_FILE, `${report.join("\n")}\n`);
    await deleteCreatedTestWorkspaces(pool);
    await api.close();
    await pool.end();
  }, 300_000);

  it("times first and deep pages, q search and global search over HTTP", async () => {
    await timed("warm-up contacts", "/contacts");
    await timed("contacts first page (50)", "/contacts");
    await timed("contacts deep page (after 20)", `/contacts${qs({ cursor: await deepCursor("/contacts", {}) })}`);
    await timed("contacts q=User12", `/contacts${qs({ q: "User12" })}`);
    await timed("contacts count", "/contacts/count");
    await timed("companies first page (40)", `/companies${qs({ limit: 40 })}`);
    await timed("companies deep page (after 20)", `/companies${qs({ limit: 40, cursor: await deepCursor("/companies", { limit: 40 }) })}`);
    await timed("companies sort contactCount", `/companies${qs({ sort: "contactCount:desc" })}`);
    await timed("deals first page (50, all)", `/deals${qs({ status: "all" })}`);
    await timed("deals deep page (after 20, all)", `/deals${qs({ status: "all", cursor: await deepCursor("/deals", { status: "all" }) })}`);
    await timed("deals sort amount desc", `/deals${qs({ status: "all", sort: "amount:desc" })}`);
    await timed("deals board", "/deals/board");
    await timed("search q=perf12", `/search${qs({ q: "perf12" })}`);
  }, 300_000);

  it("server-side execution under target; EXPLAIN contacts default sort and q", async () => {
    const { listContacts, contactListSchema } = await import("../../src/services/contacts.service.js");
    const { listCompanies, companyListSchema } = await import("../../src/services/companyRecords.service.js");
    const { listDeals, dealListSchema } = await import("../../src/services/dealRecords.service.js");
    const { globalSearch } = await import("../../src/services/search.service.js");
    const cases: [string, (db: Queryable) => Promise<unknown>][] = [
      ["contacts default", (db) => listContacts(db, rep, ws, contactListSchema.parse({}))],
      ["contacts deep", async (db) => listContacts(db, rep, ws, contactListSchema.parse({ cursor: await deepCursor("/contacts", {}) }))],
      ["contacts q", (db) => listContacts(db, rep, ws, contactListSchema.parse({ q: "User12" }))],
      ["companies default", (db) => listCompanies(db, rep, ws, companyListSchema.parse({ limit: "40" }))],
      ["companies contactCount", (db) => listCompanies(db, rep, ws, companyListSchema.parse({ sort: "contactCount:desc" }))],
      ["deals default", (db) => listDeals(db, rep, ws, dealListSchema.parse({ status: "all" }))],
      ["deals amount desc", (db) => listDeals(db, rep, ws, dealListSchema.parse({ status: "all", sort: "amount:desc" }))],
      ["search", (db) => globalSearch(db, ws, "perf12")],
    ];
    for (const [label, run] of cases) {
      const { db, statements } = recorder();
      await run(db);
      for (const [i, { sql, params }] of statements.entries()) {
        const { executionMs, nodes } = await explain(sql, params);
        report.push(`${`${label} #${i + 1}`.padEnd(34)} exec ${executionMs.toFixed(1).padStart(7)} ms   ${nodes.filter((n) => /Scan/.test(n)).join(", ")}`);
        expect(executionMs, label).toBeLessThan(TARGET_MS);
        if (label === "contacts default" && i === 0) expect(nodes.join(" ")).toContain("leads_workspace_created_idx");
      }
    }
  }, 300_000);
});
