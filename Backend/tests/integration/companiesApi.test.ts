/**
 * CRM v2 companies API + duplicate review (B4) through the HTTP stack: paging for every
 * sort, filters, create/rename rules, merge re-pointing, relink, dismiss, isolation.
 * Skipped unless TEST_DATABASE_URL is set; [test] workspaces only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createTestWorkspace, deleteCreatedTestWorkspaces } from "../helpers/testWorkspaces.js";
import { expectConsistentPaging, qs, startTestApi, type TestApi } from "../helpers/testApi.js";
import type { Actor } from "../../src/authMiddleware.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb("companies API (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let api: TestApi;
  let admin: Actor;
  let rep: Actor;
  let ws: string;
  let otherWs: string;
  let otherCompanyId: string;
  let withTransaction: typeof import("../../src/db.js").withTransaction;
  let leads: typeof import("../../src/services/leads.service.js");

  const call = (method: string, path: string, body?: unknown, as: Actor = admin, workspace = ws) => api.call(as, workspace, method, path, body);
  const listIds = async (params: Parameters<typeof qs>[0]) => {
    const res = await call("GET", `/companies${qs({ ...params, limit: 100 })}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return (res.body.data as { id: string }[]).map((r) => r.id);
  };
  const company = async (name: string, extra: Record<string, unknown> = {}, workspace = ws) => {
    const res = await call("POST", "/companies", { name, ...extra }, admin, workspace);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id as string;
  };
  const contact = (company: string, email: string, workspace = ws) =>
    withTransaction(async (client) => (await leads.createLead(client, rep, workspace, { firstName: "Co", company, email, source: "referral", ownerId: rep.id })).id);
  const candidate = (a: string, b: string | null, extra: { leadId?: string; status?: string; observedName?: string } = {}) =>
    pool
      .query<{ id: string }>(
        `insert into public.company_duplicate_candidates (workspace_id, company_a_id, company_b_id, lead_id, observed_name, reason, status, resolved_at)
         values ($1, $2, $3, $4, $5, $6, $7, case when $7 = 'open' then null else now() end) returning id`,
        [ws, b ? [a, b].sort()[0] : a, b ? [a, b].sort()[1] : null, extra.leadId ?? null, extra.observedName ?? null, b ? "similar_name" : "same_domain_different_name", extra.status ?? "open"],
      )
      .then((r) => r.rows[0]!.id);
  const candidateRow = (id: string) => pool.query(`select company_a_id, company_b_id, status from public.company_duplicate_candidates where id = $1`, [id]).then((r) => r.rows[0]);

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
    api = await startTestApi(pool, "companies-api");
    admin = await api.newUser("admin", { name: "Admin Companies" });
    rep = await api.newUser("salesperson", { name: "Rep Companies" });
    ({ withTransaction } = await import("../../src/db.js"));
    leads = await import("../../src/services/leads.service.js");
    ws = await createTestWorkspace(pool, "companies-api");
    otherWs = await createTestWorkspace(pool, "companies-api-other");
    otherCompanyId = await company("Other Workspace Co", {}, otherWs);
  });

  afterAll(async () => {
    await deleteCreatedTestWorkspaces(pool);
    await api.close();
    await pool.end();
  });

  it("pages consistently for every sort in both directions; count, filters and literal q", async () => {
    const pageWs = await createTestWorkspace(pool, "companies-api-paging");
    const get = (q: string) => call("GET", `/companies${q}`, undefined, rep, pageWs);
    const names = ["Alpha", "beta", "Gamma 50% Club", "delta_one", "Epsilon", "Zeta", "Eta", "Theta", "Iota", "Kappa", "Lambda", "Mu", "Nu", "Xi", "Omicron"];
    const ids: string[] = [];
    for (const [i, name] of names.entries()) {
      ids.push(
        (await call("POST", "/companies", { name, domain: i % 3 ? `${name.toLowerCase().replace(/[^a-z]/g, "")}.example.com` : null, industry: i % 2 ? "Retail" : "SaaS", ownerId: i % 4 ? rep.id : null }, rep, pageWs)).body.id,
      );
    }
    // Contact counts 0–3 with ties; one merged-away contact that must not count.
    for (const [i, n] of [3, 1, 1, 2].entries()) for (let k = 0; k < n; k++) await contact(names[i]!, `p${i}-${k}@${i % 3 ? names[i]!.toLowerCase().replace(/[^a-z]/g, "") : `x${i}`}.example.com`, pageWs);
    await pool.query(`update public.companies set created_at = '2026-01-01T00:00:00Z' where id = any($1)`, [[ids[5], ids[6], ids[7]]]);

    for (const field of ["name", "createdAt", "updatedAt", "contactCount"]) {
      for (const dir of ["asc", "desc"]) {
        const paged = await expectConsistentPaging(get, { sort: `${field}:${dir}` });
        expect(paged.length).toBe(names.length);
      }
    }
    expect((await get(`/count`)).body).toEqual({ count: names.length });
    const byCount = (await get(qs({ sort: "contactCount:desc", limit: 2 }))).body.data;
    expect(byCount[0]).toMatchObject({ id: ids[0], contactCount: 3, openDealCount: 0, openDealAmount: 0 });
    expect(byCount[0].owner).toBeNull();
    expect(Object.keys(byCount[0]).sort()).toEqual(["id", "name", "domain", "industry", "city", "owner", "contactCount", "openDealCount", "openDealAmount", "createdAt", "updatedAt"].sort());

    const filterIds = async (params: Parameters<typeof qs>[0]) => (await get(qs({ ...params, limit: 100 }))).body.data.map((r: { id: string }) => r.id);
    expect((await filterIds({ ownerId: "none" })).sort()).toEqual([0, 4, 8, 12].map((i) => ids[i]).sort());
    expect((await filterIds({ ownerId: "me" })).length).toBe(11);
    expect((await filterIds({ industry: "Retail" })).length).toBe(7);
    expect((await filterIds({ industry: ["Retail", "SaaS"] })).length).toBe(15);
    expect((await filterIds({ hasDomain: "false" })).sort()).toEqual([0, 3, 6, 9, 12].map((i) => ids[i]).sort());
    expect((await filterIds({ createdFrom: "2025-12-31T00:00:00Z", createdTo: "2026-01-02T00:00:00Z" })).sort()).toEqual([ids[5], ids[6], ids[7]].sort());
    expect(await filterIds({ q: "50%" })).toEqual([ids[2]]);
    expect(await filterIds({ q: "delta_" })).toEqual([ids[3]]);
    expect(await filterIds({ q: "a_p" })).toEqual([]); // "_" is literal, not "any character" (would match Alpha)
    expect(await filterIds({ q: "zetaexample" })).toEqual([]);
    expect(await filterIds({ q: "zeta.example" })).toEqual([ids[5]]);
    expect((await get(`/count${qs({ industry: "Retail" })}`)).body).toEqual({ count: 7 });
    expect((await get("/industries")).body).toEqual({ data: ["Retail", "SaaS"] });
    expect((await get(qs({ sort: "domain:asc" }))).status).toBe(400);
    expect((await get(qs({ hasDomain: "yes" }))).status).toBe(400);
  }, 180_000);

  it("create: normaliser + unique rules (409 with the existing id), placeholder and free-mail rejected", async () => {
    const acme = await company("Acme Industries Pvt Ltd", { domain: "https://www.Acme-Ind.example.com/about", industry: "Steel" });
    const detail = (await call("GET", `/companies/${acme}`)).body;
    expect(detail).toMatchObject({ name: "Acme Industries Pvt Ltd", domain: "acme-ind.example.com", industry: "Steel", contactCount: 0, mergedIntoCompanyId: null, lastActivityAt: null });
    expect(detail.owner).toEqual({ id: admin.id, name: "Admin Companies" });
    const sameName = await call("POST", "/companies", { name: "ACME industries limited" });
    expect(sameName.status).toBe(409);
    expect(sameName.body.error.details).toEqual({ companyId: acme });
    const sameDomain = await call("POST", "/companies", { name: "Different", domain: "acme-ind.example.com" });
    expect(sameDomain.status).toBe(409);
    expect(sameDomain.body.error.details).toEqual({ companyId: acme });
    expect((await call("POST", "/companies", { name: "Not provided" })).status).toBe(400);
    expect((await call("POST", "/companies", { name: "Mailers", domain: "gmail.com" })).status).toBe(400);
    expect((await call("POST", "/companies", { name: "Bad", domain: "not a domain" })).status).toBe(400);
    expect((await call("POST", "/companies", { name: "Extra", nope: 1 })).status).toBe(400);
    // A similar name opens a suggestion through the trigram index.
    const similar = await company("Acme Industrie");
    const suggestion = await pool.query(`select reason from public.company_duplicate_candidates where workspace_id = $1 and $2 in (company_a_id, company_b_id)`, [ws, similar]);
    expect(suggestion.rows).toEqual([{ reason: "similar_name" }]);
  });

  it("PATCH: a rename re-normalizes and syncs contacts' company text; clashes are 409", async () => {
    const id = await company("Rename Me Ltd");
    const taken = await company("Taken Name", { domain: "taken.example.com" });
    const c1 = await contact("Rename Me Ltd", "a@renameme.example.com");
    const c2 = await contact("Rename Me", "b@renameme.example.com");
    const linked = await pool.query(`select company_id from public.leads where id = any($1)`, [[c1, c2]]);
    expect(linked.rows.every((r) => r.company_id === id)).toBe(true);

    const res = await call("PATCH", `/companies/${id}`, { name: "Renamed Co", city: "Pune", revenueRange: "Rs 10 to 50 cr", ownerId: null }, rep);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ name: "Renamed Co", city: "Pune", revenueRange: "Rs 10 to 50 cr", revenueMinCr: 10, revenueMaxCr: 50, owner: null, contactCount: 2 });
    const lastActivity = (await pool.query(`select max(last_activity_at) as at from public.leads where id = any($1)`, [[c1, c2]])).rows[0].at as Date;
    expect(new Date(res.body.lastActivityAt).getTime()).toBe(lastActivity.getTime());
    const texts = await pool.query(`select company from public.leads where id = any($1)`, [[c1, c2]]);
    expect(texts.rows.map((r) => r.company)).toEqual(["Renamed Co", "Renamed Co"]);
    expect((await pool.query(`select normalized_name from public.companies where id = $1`, [id])).rows[0].normalized_name).toBe("renamed");

    const clash = await call("PATCH", `/companies/${id}`, { name: "TAKEN name pvt ltd" });
    expect(clash.status).toBe(409);
    expect(clash.body.error.details).toEqual({ companyId: taken });
    expect((await call("PATCH", `/companies/${id}`, { domain: "taken.example.com" })).status).toBe(409);
    expect((await call("PATCH", `/companies/${id}`, { stage: "x" })).status).toBe(400);
    expect((await pool.query(`select company from public.leads where id = $1`, [c1])).rows[0].company).toBe("Renamed Co");

    const contacts = await call("GET", `/companies/${id}/contacts${qs({ sort: "createdAt:asc" })}`);
    expect(contacts.body.data.map((r: { id: string }) => r.id)).toEqual([c1, c2]);
    expect((await call("GET", `/companies/${id}/contacts${qs({ companyId: id })}`)).status).toBe(400);
  });

  it("merge re-points the source's other open suggestions, moves contact rows, dismisses duplicates; admin only", async () => {
    const [target, source, x, y] = [await company("Merge Target"), await company("Merge Source"), await company("Merge X Corp"), await company("Merge Y Corp")];
    const l1 = await contact("Merge Source", "l1@mergesrc.example.com");
    const l2 = await contact("Merge Source", "l2@mergesrc.example.com");
    await pool.query(`delete from public.company_duplicate_candidates where workspace_id = $1 and (company_a_id = any($2) or company_b_id = any($2))`, [ws, [target, source, x, y]]);
    const pair = await candidate(target, source);
    const toX = await candidate(source, x);
    const toY = await candidate(source, y);
    await candidate(target, y, { status: "dismissed" }); // exists in another status → (source, y) is dismissed
    const row1 = await candidate(source, null, { leadId: l1, observedName: "Src" });
    const row2 = await candidate(source, null, { leadId: l2, observedName: "Src" });
    await candidate(target, null, { leadId: l2, observedName: "Src", status: "dismissed" });

    expect((await call("POST", `/companies/${target}/merge`, { sourceId: source }, rep)).status).toBe(403);
    const res = await call("POST", `/companies/${target}/merge`, { sourceId: source });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ targetId: target, sourceId: source, movedContacts: 2 });

    expect(await candidateRow(pair)).toMatchObject({ status: "merged" });
    expect(await candidateRow(toX)).toMatchObject({ status: "open", company_a_id: [target, x].sort()[0], company_b_id: [target, x].sort()[1] });
    expect(await candidateRow(toY)).toMatchObject({ status: "dismissed" });
    expect(await candidateRow(row1)).toMatchObject({ status: "open", company_a_id: target, company_b_id: null });
    expect(await candidateRow(row2)).toMatchObject({ status: "dismissed", company_a_id: source });
    expect(await listIds({ q: "Merge" })).not.toContain(source);
    expect((await call("GET", `/companies/${source}`)).body.mergedIntoCompanyId).toBe(target);
    expect((await call("PATCH", `/companies/${source}`, { city: "X" })).status).toBe(409);
    expect((await call("GET", `/companies/${source}/contacts`)).status).toBe(404);
  });

  it("duplicate review: list, merge (pair), relink to an existing and to a new company, dismiss; admin only", async () => {
    const reviewWs = await createTestWorkspace(pool, "companies-api-dupes");
    const as = (method: string, path: string, body?: unknown, who: Actor = admin) => call(method, path, body, who, reviewWs);
    // "TML" linked to Tata Motors by domain → a contact-level suggestion.
    const tata = await contact("Tata Motors", "a@tatamotors.example.com", reviewWs);
    const tml = await contact("TML", "b@tatamotors.example.com", reviewWs);
    const bolt = (await as("POST", "/companies", { name: "Bolt Motors" })).body.id;
    const bolt2 = (await as("POST", "/companies", { name: "Bolt Motor" })).body.id;

    expect((await as("GET", "/company-duplicates", undefined, rep)).status).toBe(403);
    const list = await as("GET", `/company-duplicates${qs({ limit: 10 })}`);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const contactRow = list.body.data.find((r: { kind: string }) => r.kind === "contact");
    const pairRow = list.body.data.find((r: { kind: string }) => r.kind === "pair");
    expect(contactRow).toMatchObject({ reason: "same_domain_different_name", status: "open", observedName: "TML", contact: { id: tml }, companyB: null });
    expect(contactRow.companyA).toMatchObject({ name: "Tata Motors", contactCount: 2 });
    expect(pairRow.companyA.id === bolt || pairRow.companyB.id === bolt).toBe(true);
    expect((await as("GET", `/company-duplicates${qs({ kind: "pair" })}`)).body.data).toHaveLength(1);
    // C3: count (same filters), companyId filter, industry + open deal count on each company.
    expect((await as("GET", "/company-duplicates/count")).body).toEqual({ count: list.body.data.length });
    const contactRows = list.body.data.filter((r: { kind: string }) => r.kind === "contact").length;
    expect((await as("GET", `/company-duplicates/count${qs({ kind: "contact" })}`)).body).toEqual({ count: contactRows });
    expect((await as("GET", `/company-duplicates/count${qs({ limit: 5 })}`)).status).toBe(400);
    expect((await as("GET", "/company-duplicates/count", undefined, rep)).status).toBe(403);
    expect((await as("GET", `/company-duplicates${qs({ companyId: bolt2 })}`)).body.data.map((r: { id: string }) => r.id)).toEqual([pairRow.id]);
    expect((await as("GET", `/company-duplicates/count${qs({ companyId: bolt2 })}`)).body).toEqual({ count: 1 });
    expect(pairRow.companyA).toMatchObject({ industry: null, openDealCount: 0, merged: false });

    // Relink to a NEW company from the observed name; then the row is resolved.
    expect((await as("POST", `/company-duplicates/${pairRow.id}/relink`, {})).status).toBe(400);
    const relinked = await as("POST", `/company-duplicates/${contactRow.id}/relink`, {});
    expect(relinked.status, JSON.stringify(relinked.body)).toBe(200);
    const tmlRow = (await pool.query(`select company, company_id from public.leads where id = $1`, [tml])).rows[0];
    expect(tmlRow).toEqual({ company: "TML", company_id: relinked.body.companyId });
    expect((await as("POST", `/company-duplicates/${contactRow.id}/dismiss`)).status).toBe(409);

    // Relink to an EXISTING company.
    const row2 = (await pool.query<{ id: string }>(
      `insert into public.company_duplicate_candidates (workspace_id, company_a_id, lead_id, observed_name, reason)
       select $1, company_id, id, 'Tata', 'name_domain_conflict' from public.leads where id = $2 returning id`,
      [reviewWs, tata],
    )).rows[0]!.id;
    expect((await as("POST", `/company-duplicates/${row2}/relink`, { companyId: otherCompanyId })).status).toBe(404);
    const toBolt = await as("POST", `/company-duplicates/${row2}/relink`, { companyId: bolt });
    expect(toBolt.body).toEqual({ leadId: tata, companyId: bolt });
    expect((await pool.query(`select company from public.leads where id = $1`, [tata])).rows[0].company).toBe("Bolt Motors");

    // Merge the pair, keeping company B; dismiss is refused afterwards.
    expect((await as("POST", `/company-duplicates/${pairRow.id}/merge`, { targetId: tata })).status).toBe(400);
    const merged = await as("POST", `/company-duplicates/${pairRow.id}/merge`, { targetId: bolt2 });
    expect(merged.body).toMatchObject({ targetId: bolt2, sourceId: bolt, movedContacts: 1 });
    expect((await as("GET", `/company-duplicates${qs({ status: "merged" })}`)).body.data.map((r: { id: string }) => r.id)).toEqual([pairRow.id]);
    expect((await as("POST", `/company-duplicates/${pairRow.id}/dismiss`)).status).toBe(409);

    const third = (await pool.query<{ id: string }>(
      `insert into public.company_duplicate_candidates (workspace_id, company_a_id, lead_id, observed_name, reason) values ($1, $2, $3, 'x', 'name_domain_conflict') returning id`,
      [reviewWs, bolt2, tml],
    )).rows[0]!.id;
    expect((await as("POST", `/company-duplicates/${third}/dismiss`)).status).toBe(204);
    expect(await candidateRow(third)).toMatchObject({ status: "dismissed" });
  });

  it("workspace isolation: list, count, detail, contacts, merge and duplicates never cross workspaces", async () => {
    expect(await listIds({})).not.toContain(otherCompanyId);
    expect(await listIds({ q: "Other Workspace" })).toEqual([]);
    expect((await call("GET", `/companies/${otherCompanyId}`)).status).toBe(404);
    expect((await call("PATCH", `/companies/${otherCompanyId}`, { city: "X" })).status).toBe(404);
    expect((await call("GET", `/companies/${otherCompanyId}/contacts`)).status).toBe(404);
    const mine = await company("Isolation Target");
    expect((await call("POST", `/companies/${mine}/merge`, { sourceId: otherCompanyId })).status).toBe(404);
    expect((await call("GET", "/companies/count", undefined, admin, otherWs)).body).toEqual({ count: 1 });
    const second = await company("Second Other Co", {}, otherWs);
    const [a, b] = [otherCompanyId, second].sort();
    const foreign = (await pool.query<{ id: string }>(
      `insert into public.company_duplicate_candidates (workspace_id, company_a_id, company_b_id, reason)
       values ($1, $2, $3, 'similar_name') on conflict do nothing returning id`,
      [otherWs, a, b],
    )).rows[0]?.id ?? (await pool.query<{ id: string }>(`select id from public.company_duplicate_candidates where company_a_id = $1 and company_b_id = $2`, [a, b])).rows[0]!.id;
    const dupes = (await call("GET", `/company-duplicates${qs({ status: "all", limit: 100 })}`)).body.data.map((r: { id: string }) => r.id);
    expect(dupes).not.toContain(foreign);
    expect((await call("POST", `/company-duplicates/${foreign}/dismiss`)).status).toBe(404);
  });
});
