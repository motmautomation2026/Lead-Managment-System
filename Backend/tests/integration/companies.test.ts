/**
 * CRM v2 companies (B3a): linking contacts on create / import / website / edit,
 * concurrency, failure isolation, the sweeper and company merge.
 * Skipped unless TEST_DATABASE_URL is set; commits rows in fresh [test] workspaces only.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { createTestWorkspace, deleteCreatedTestWorkspaces } from "../helpers/testWorkspaces.js";
import type { Actor } from "../../src/authMiddleware.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb("companies (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let actor: Actor;
  let authUserId: string;
  let leads: typeof import("../../src/services/leads.service.js");
  let companies: typeof import("../../src/services/companies.service.js");
  let withTransaction: typeof import("../../src/db.js").withTransaction;

  const tag = () => randomUUID().slice(0, 8);
  const workspace = () => createTestWorkspace(pool, "companies");

  async function create(ws: string, company: string, email: string | null, db?: PoolClient) {
    const input = { firstName: "Co", company, email: email ?? undefined, phone: email ? undefined : "+919876500000", source: "referral", ownerId: actor.id };
    return db ? leads.createLead(db, actor, ws, input) : withTransaction((client) => leads.createLead(client, actor, ws, input));
  }

  async function lead(id: string) {
    return (
      await pool.query<{ company: string; company_id: string | null; company_link_checked_at: Date | null; company_link_attempts: number }>(
        `select company, company_id, company_link_checked_at, company_link_attempts from public.leads where id = $1`,
        [id],
      )
    ).rows[0]!;
  }

  async function companiesIn(ws: string) {
    return (
      await pool.query<{ id: string; name: string; domain: string | null; merged_into_company_id: string | null }>(
        `select id, name, domain, merged_into_company_id from public.companies where workspace_id = $1 order by created_at`,
        [ws],
      )
    ).rows;
  }

  async function candidatesIn(ws: string) {
    return (
      await pool.query<{ company_a_id: string; company_b_id: string | null; lead_id: string | null; observed_name: string | null; reason: string; status: string }>(
        `select company_a_id, company_b_id, lead_id, observed_name, reason, status from public.company_duplicate_candidates where workspace_id = $1`,
        [ws],
      )
    ).rows;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
    const auth = await pool.query(`insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`, [`companies-${randomUUID()}@example.com`]);
    authUserId = auth.rows[0].id;
    const profile = await pool.query(`update public.profiles set full_name = 'Companies Rep' where id = $1 returning id, full_name, email`, [authUserId]);
    actor = { id: profile.rows[0].id, fullName: profile.rows[0].full_name, email: profile.rows[0].email, isActive: true, role: "salesperson" };
    leads = await import("../../src/services/leads.service.js");
    companies = await import("../../src/services/companies.service.js");
    ({ withTransaction } = await import("../../src/db.js"));
  });

  afterAll(async () => {
    await deleteCreatedTestWorkspaces(pool);
    await pool.query(`delete from auth.users where id = $1`, [authUserId]).catch((error: Error) => console.warn(`[companies] test user not deleted: ${error.message}`));
    await pool.end();
  });

  it("creating a lead creates and links its company; the same name with Pvt Ltd links to it", async () => {
    const ws = await workspace();
    const first = await create(ws, "Bolt Motors", `a@bolt-${tag()}.co.in`);
    const [company] = await companiesIn(ws);
    expect(company).toMatchObject({ name: "Bolt Motors" });
    expect(company!.domain).toMatch(/^bolt-.*\.co\.in$/);
    expect(await lead(first.id)).toMatchObject({ company: "Bolt Motors", company_id: company!.id, company_link_attempts: 0 });
    expect((await lead(first.id)).company_link_checked_at).not.toBeNull();
    expect(leads.leadToDto(first).companyId).toBe(company!.id);

    const second = await create(ws, "Bolt Motors Pvt. Ltd.", `b-${tag()}@gmail.com`);
    expect(await companiesIn(ws)).toHaveLength(1);
    expect(await lead(second.id)).toMatchObject({ company: "Bolt Motors", company_id: company!.id });
  });

  it("free and reserved/test mail store no domain; a known corporate domain with a similar name links + contact-level candidate", async () => {
    const ws = await workspace();
    await create(ws, "Free Co", `x-${tag()}@gmail.com`);
    expect((await companiesIn(ws))[0]!.domain).toBeNull();
    // E2f: example.com says nothing about the company: two names → two companies, texts kept.
    const one = await create(ws, "Sharda Hydraulics Pvt Ltd", `rakesh-${tag()}@example.com`);
    const two = await create(ws, "Vedant Automation", `meena-${tag()}@example.com`);
    expect((await lead(one.id)).company).toBe("Sharda Hydraulics Pvt Ltd");
    expect((await lead(two.id)).company).toBe("Vedant Automation");
    expect((await companiesIn(ws)).filter((c) => c.domain !== null)).toHaveLength(0);

    const domain = `tatamotors-${tag()}.co.in`;
    await create(ws, "Tata Motors", `a@${domain}`);
    const tata = (await companiesIn(ws)).find((c) => c.name === "Tata Motors")!;
    const motor = await create(ws, "Tata Motor", `b@${domain}`);
    expect(await lead(motor.id)).toMatchObject({ company: "Tata Motors", company_id: tata.id });
    expect(await candidatesIn(ws)).toContainEqual(
      expect.objectContaining({ company_a_id: tata.id, company_b_id: null, lead_id: motor.id, observed_name: "Tata Motor", reason: "same_domain_different_name", status: "open" }),
    );
  });

  it("E2f name wins: different names on the same corporate domain → two companies + one pair candidate, texts unchanged", async () => {
    const ws = await workspace();
    const domain = `tatamotors-${tag()}.co.in`;
    const tataLead = await create(ws, "Tata Motors", `a@${domain}`);
    const tmlLead = await create(ws, "TML", `b@${domain}`);
    const all = await companiesIn(ws);
    expect(all).toHaveLength(2);
    const tata = all.find((c) => c.name === "Tata Motors")!;
    const tml = all.find((c) => c.name === "TML")!;
    expect(tata.domain).toBe(domain);
    expect(tml.domain).toBeNull();
    expect(await lead(tataLead.id)).toMatchObject({ company: "Tata Motors", company_id: tata.id });
    expect(await lead(tmlLead.id)).toMatchObject({ company: "TML", company_id: tml.id });
    const [a, b] = [tata.id, tml.id].sort();
    expect(await candidatesIn(ws)).toEqual([
      expect.objectContaining({ company_a_id: a, company_b_id: b, lead_id: null, reason: "same_domain_different_name", status: "open" }),
    ]);
    // A similar spelling ("Tata Motors Ltd" normalises to the same name) still links to the existing company.
    const ltd = await create(ws, "Tata Motors Ltd", `c@${domain}`);
    expect(await lead(ltd.id)).toMatchObject({ company: "Tata Motors", company_id: tata.id });
    expect(await companiesIn(ws)).toHaveLength(2);
  });

  it("same name with a domain owned by another company links by name + pair candidate", async () => {
    const ws = await workspace();
    const [acmeDomain, betaDomain] = [`acme-${tag()}.co.in`, `beta-${tag()}.co.in`];
    await create(ws, "Acme", `a@${acmeDomain}`);
    await create(ws, "Beta", `b@${betaDomain}`);
    const all = await companiesIn(ws);
    const acme = all.find((c) => c.name === "Acme")!;
    const beta = all.find((c) => c.name === "Beta")!;

    const conflict = await create(ws, "Acme", `c@${betaDomain}`);
    expect(await lead(conflict.id)).toMatchObject({ company_id: acme.id });
    const [a, b] = [acme.id, beta.id].sort();
    expect(await candidatesIn(ws)).toContainEqual(expect.objectContaining({ company_a_id: a, company_b_id: b, reason: "name_domain_conflict" }));
  });

  it("a placeholder company gives no company but marks the lead checked", async () => {
    const ws = await workspace();
    const row = await create(ws, "Not provided", `np-${tag()}@gmail.com`);
    const after = await lead(row.id);
    expect(after).toMatchObject({ company: "Not provided", company_id: null });
    expect(after.company_link_checked_at).not.toBeNull();
    expect(await companiesIn(ws)).toHaveLength(0);
  });

  it("updateLead relinks on a company change and unlinks on a placeholder", async () => {
    const ws = await workspace();
    const row = await create(ws, "Gamma Labs", `g-${tag()}@gmail.com`);
    const gamma = (await companiesIn(ws))[0]!;
    await withTransaction((db) => leads.updateLead(db, actor, ws, row.id, { company: "Delta Labs" }));
    const delta = (await companiesIn(ws)).find((c) => c.name === "Delta Labs")!;
    expect(delta.id).not.toBe(gamma.id);
    expect(await lead(row.id)).toMatchObject({ company: "Delta Labs", company_id: delta.id });

    const updated = await withTransaction((db) => leads.updateLead(db, actor, ws, row.id, { company: "N/A" }));
    expect(await lead(row.id)).toMatchObject({ company: "N/A", company_id: null });
    expect(leads.leadToDto(updated).companyId).toBeNull();
  });

  it("CSV import of 3 rows where 2 share a company creates 2 companies", async () => {
    const ws = await workspace();
    const rows = [
      { rowNumber: 1, firstName: "One", company: "Delta Foods", email: `1-${tag()}@gmail.com`, source: "referral" },
      { rowNumber: 2, firstName: "Two", company: "Delta Foods Pvt Ltd", email: `2-${tag()}@gmail.com`, source: "referral" },
      { rowNumber: 3, firstName: "Three", company: "Echo Tech", email: `3-${tag()}@gmail.com`, source: "referral" },
    ];
    const result = await withTransaction((db) => leads.importLeads(db, actor, ws, rows));
    expect(result.created).toHaveLength(3);
    expect((await companiesIn(ws)).map((c) => c.name).sort()).toEqual(["Delta Foods", "Echo Tech"]);
    for (const created of result.created) expect((await lead(created.id)).company_id).not.toBeNull();
  });

  it("website ingest links a new lead; a duplicate submission changes nothing", async () => {
    const ws = await workspace();
    const { ingestWebsiteLead } = await import("../../src/services/leadIngest.service.js");
    const email = `web-${tag()}@foxtrot-${tag()}.co.in`;
    const form = { name: "Web Person", email, phone: "", company: "Foxtrot Ltd", message: "Hello" };
    const created = await withTransaction((db) => ingestWebsiteLead(db, ws, form));
    expect(created.status).toBe("created");
    const leadId = (created as { leadId: string }).leadId;
    const [company] = await companiesIn(ws);
    expect(await lead(leadId)).toMatchObject({ company: "Foxtrot Ltd", company_id: company!.id });

    const before = await lead(leadId);
    const again = await withTransaction((db) => ingestWebsiteLead(db, ws, { ...form, company: "Other Name", message: "Second" }));
    expect(again.status).toBe("duplicate");
    expect(await lead(leadId)).toEqual(before);
    expect(await companiesIn(ws)).toHaveLength(1);
  });

  it("two concurrent creates with the same new company end with one company", async () => {
    const ws = await workspace();
    const first = await pool.connect();
    const second = await pool.connect();
    try {
      await first.query("begin");
      await second.query("begin");
      const a = await create(ws, "Hotel Group", `h1-${tag()}@gmail.com`, first); // company inserted, not committed
      const pending = create(ws, "Hotel Group Pvt Ltd", `h2-${tag()}@gmail.com`, second); // its insert waits on the unique index
      await new Promise((resolve) => setTimeout(resolve, 500));
      await first.query("commit");
      const b = await pending;
      await second.query("commit");
      const all = await companiesIn(ws);
      expect(all).toHaveLength(1);
      expect((await lead(a.id)).company_id).toBe(all[0]!.id);
      expect((await lead(b.id)).company_id).toBe(all[0]!.id);
    } finally {
      await first.query("rollback").catch(() => undefined);
      await second.query("rollback").catch(() => undefined);
      first.release();
      second.release();
    }
  });

  it("a failed link never blocks the lead; the sweeper links it later", async () => {
    const ws = await workspace();
    const locker = await pool.connect();
    const client = await pool.connect();
    let leadId: string;
    try {
      // Hold a lock that blocks inserts into companies, so the inline link times out.
      await locker.query("begin");
      await locker.query("lock table public.companies in share mode");
      await client.query("begin");
      await client.query("set local lock_timeout = '300ms'");
      leadId = (await create(ws, "India Steel", `i-${tag()}@gmail.com`, client)).id;
      await client.query("commit");
    } finally {
      await locker.query("rollback").catch(() => undefined);
      await client.query("rollback").catch(() => undefined);
      locker.release();
      client.release();
    }
    expect(await lead(leadId)).toMatchObject({ company: "India Steel", company_id: null, company_link_checked_at: null, company_link_attempts: 1 });

    expect(await companies.runCompanySweep({ workspaceId: ws })).toMatchObject({ processed: 1, created: 1, failed: 0 });
    const [company] = await companiesIn(ws);
    expect(await lead(leadId)).toMatchObject({ company_id: company!.id, company_link_attempts: 1 });
  });

  it("the sweeper links old leads and a second run does nothing", async () => {
    const ws = await workspace();
    const a = await create(ws, "Juliet Co", `j1-${tag()}@gmail.com`);
    const b = await create(ws, "Juliet Company", `j2-${tag()}@gmail.com`);
    const c = await create(ws, "Not provided", `j3-${tag()}@gmail.com`);
    // Pretend they predate CRM v2.
    await pool.query(`update public.leads set company_id = null, company_link_checked_at = null where workspace_id = $1`, [ws]);
    await pool.query(`delete from public.companies where workspace_id = $1`, [ws]);

    expect(await companies.runCompanySweep({ workspaceId: ws })).toEqual({ processed: 3, created: 1, linked: 1, none: 1, failed: 0 });
    const [company] = await companiesIn(ws);
    expect((await lead(a.id)).company_id).toBe(company!.id);
    expect((await lead(b.id)).company_id).toBe(company!.id);
    expect((await lead(c.id)).company_id).toBeNull();
    expect(await companies.runCompanySweep({ workspaceId: ws })).toEqual({ processed: 0, created: 0, linked: 0, none: 0, failed: 0 });
  });

  it("mergeCompanies re-points contacts and their text, hides the source, resolves the candidate and deletes nothing", async () => {
    const ws = await workspace();
    const target = await create(ws, "Lima Engineering Works", `l1-${tag()}@gmail.com`);
    const source = await create(ws, "Lima Engineering Work", `l2@lima-${tag()}.co.in`);
    const [targetCompany, sourceCompany] = await companiesIn(ws);
    const [a, b] = [targetCompany!.id, sourceCompany!.id].sort();
    expect(await candidatesIn(ws)).toContainEqual(expect.objectContaining({ company_a_id: a, company_b_id: b, reason: "similar_name", status: "open" }));
    const leadCount = (await pool.query(`select count(*)::int as n from public.leads where workspace_id = $1`, [ws])).rows[0].n;

    const result = await withTransaction((db) => companies.mergeCompanies(db, actor, ws, targetCompany!.id, sourceCompany!.id));
    expect(result.movedContacts).toBe(1);
    expect(await lead(source.id)).toMatchObject({ company: "Lima Engineering Works", company_id: targetCompany!.id });
    expect(await lead(target.id)).toMatchObject({ company_id: targetCompany!.id });

    const after = await companiesIn(ws);
    expect(after).toHaveLength(2);
    expect(after.find((c) => c.id === sourceCompany!.id)!.merged_into_company_id).toBe(targetCompany!.id);
    expect(after.find((c) => c.id === targetCompany!.id)!.domain).toBe(sourceCompany!.domain); // filled from the source
    expect(await candidatesIn(ws)).toContainEqual(expect.objectContaining({ company_a_id: a, company_b_id: b, status: "merged" }));
    expect((await pool.query(`select count(*)::int as n from public.leads where workspace_id = $1`, [ws])).rows[0].n).toBe(leadCount);
    const note = await pool.query(`select title from public.timeline_events where lead_id = $1 and title = 'Company merged'`, [source.id]);
    expect(note.rowCount).toBe(1);

    await expect(withTransaction((db) => companies.mergeCompanies(db, actor, ws, targetCompany!.id, sourceCompany!.id))).rejects.toThrow(/already merged/);
  });
});
