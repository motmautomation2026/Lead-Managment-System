/**
 * Revenue-based owner assignment for new leads, against a real database and
 * (for the API) the real HTTP stack with the login check bypassed.
 * Rules in the test workspace: up to ₹5 Cr -> A, above ₹5 Cr -> B, fallback C.
 * Skipped unless TEST_DATABASE_URL is set; commits rows in fresh workspaces.
 */
import { randomUUID } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestWorkspace, deleteCreatedTestWorkspaces } from "../helpers/testWorkspaces.js";
import { Pool } from "pg";
import type { Actor } from "../../src/authMiddleware.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb("lead assignment by revenue (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  const authUserIds: string[] = [];
  let admin: Actor;
  let rep: Actor;
  let a: Actor;
  let b: Actor;
  let c: Actor;
  let inactive: Actor;
  let actor: Actor;
  let WORKSPACE_ID: string;
  let server: Server;
  let base: string;

  async function newUser(name: string, role: "admin" | "salesperson" = "salesperson", isActive = true): Promise<Actor> {
    const auth = await pool.query(`insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`, [`assign-${name}-${randomUUID()}@example.com`]);
    authUserIds.push(auth.rows[0].id);
    const profile = await pool.query(
      `update public.profiles set role = $2, is_active = $3, full_name = $4 where id = $1 returning id, full_name, email`,
      [auth.rows[0].id, role, isActive, `Assign ${name}`],
    );
    return { id: profile.rows[0].id, fullName: profile.rows[0].full_name, email: profile.rows[0].email, isActive, role };
  }

  async function newWorkspace(): Promise<string> {
    const id = randomUUID();
    await createTestWorkspace(pool, "assign-test", { id: id });
    return id;
  }

  async function api(as: Actor, method: string, path: string, body?: unknown, workspaceId = WORKSPACE_ID) {
    actor = as;
    const res = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: { "Content-Type": "application/json", "X-Workspace-Id": workspaceId },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  }

  const email = () => `assign-${randomUUID()}@example.com`;
  const leadBody = (extra: Record<string, unknown> = {}) => ({ firstName: "Rev", company: "Rev Co", source: "referral", email: email(), ...extra });
  const rulesBody = () => ({
    rules: [
      { position: 0, minCr: null, maxCr: 5, ownerId: a.id },
      { position: 1, minCr: 5, maxCr: null, ownerId: b.id },
    ],
    fallbackOwnerId: c.id,
  });

  async function timeline(leadId: string, title: string) {
    return (await pool.query(`select detail from public.timeline_events where lead_id = $1 and title = $2`, [leadId, title])).rows.map((r) => r.detail as string);
  }

  async function ingest(message: string, workspaceId = WORKSPACE_ID) {
    const { ingestWebsiteLead } = await import("../../src/services/leadIngest.service.js");
    const { withTransaction } = await import("../../src/db.js");
    const outcome = await withTransaction((db) => ingestWebsiteLead(db, workspaceId, { name: "Web Lead", email: email(), phone: "", company: "Web Co", message }));
    expect(outcome.status).toBe("created");
    const leadId = (outcome as { leadId: string }).leadId;
    const row = (await pool.query(`select owner_id, revenue_range, revenue_min_cr, revenue_max_cr from public.leads where id = $1`, [leadId])).rows[0];
    return { leadId, ...row };
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    admin = await newUser("admin", "admin");
    rep = await newUser("rep");
    a = await newUser("A");
    b = await newUser("B");
    c = await newUser("C");
    inactive = await newUser("gone", "salesperson", false);
    WORKSPACE_ID = await newWorkspace();

    const { createApp } = await import("../../src/app.js");
    const app = express();
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use(createApp());
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await deleteCreatedTestWorkspaces(pool);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // Users with append-only admin_audit_events rows can't be deleted; that must not block the others.
    for (const id of authUserIds) {
      await pool.query(`delete from auth.users where id = $1`, [id]).catch((error: Error) => console.warn(`[leadAssignment] test user ${id} not deleted: ${error.message}`));
    }
    await pool.end();
  });

  it("rules are admin-only: a salesperson gets 403", async () => {
    expect((await api(rep, "GET", "/assignment-rules")).status).toBe(403);
    expect((await api(rep, "PUT", "/assignment-rules", rulesBody())).status).toBe(403);
  });

  it("rejects invalid rule lists", async () => {
    const invalid = [
      { ...rulesBody(), rules: [{ position: 0, minCr: 5, maxCr: 5, ownerId: a.id }] },
      { ...rulesBody(), rules: [{ position: 1, minCr: null, maxCr: 5, ownerId: a.id }] },
      { ...rulesBody(), rules: [{ position: 0, minCr: null, maxCr: 5, ownerId: inactive.id }] },
      { ...rulesBody(), fallbackOwnerId: inactive.id },
    ];
    for (const body of invalid) expect((await api(admin, "PUT", "/assignment-rules", body)).status).toBe(400);
    expect((await api(admin, "GET", "/assignment-rules")).body.rules).toEqual([]);
  });

  it("an admin replaces and reads back the rules and fallback owner, with an audit row", async () => {
    const saved = await api(admin, "PUT", "/assignment-rules", rulesBody());
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      rules: [
        { position: 0, minCr: null, maxCr: 5, ownerId: a.id, ownerName: a.fullName, ownerActive: true },
        { position: 1, minCr: 5, maxCr: null, ownerId: b.id, ownerName: b.fullName, ownerActive: true },
      ],
      fallbackOwnerId: c.id,
      fallbackOwnerName: c.fullName,
      fallbackOwnerAvailable: true,
    });
    expect((await api(admin, "GET", "/assignment-rules")).body).toEqual(saved.body);
    const audit = await pool.query(`select actor_id from public.admin_audit_events where action = 'workspace.assignment_rules_replaced' and target_id = $1`, [WORKSPACE_ID]);
    expect(audit.rows).toEqual([{ actor_id: admin.id }]);
  });

  it("the existing website-leads endpoints read and write the same fallback owner", async () => {
    expect((await api(rep, "GET", "/connections/website-leads")).body).toEqual({ defaultOwnerId: c.id, defaultOwnerName: c.fullName, ownerAvailable: true });
    expect((await api(rep, "PUT", "/connections/website-leads", { defaultOwnerId: b.id })).status).toBe(200);
    expect((await api(admin, "GET", "/assignment-rules")).body.fallbackOwnerId).toBe(b.id);
    expect((await api(rep, "PUT", "/connections/website-leads", { defaultOwnerId: c.id })).status).toBe(200);
  });

  it("manual create without an owner is assigned by rule, notifies the owner and explains why", async () => {
    const res = await api(rep, "POST", "/leads", leadBody({ revenueRange: "₹1–5 Cr" }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ownerId: a.id, revenueRange: "₹1–5 Cr", revenueMinCr: 1, revenueMaxCr: 5 });
    expect(await timeline(res.body.id, "Lead Assigned")).toEqual([`Owner: ${a.fullName} (Revenue ₹1–5 Cr matched rule: up to ₹5 Cr)`]);
    const task = await pool.query(`select owner_id, owner_name from public.tasks where lead_id = $1`, [res.body.id]);
    expect(task.rows).toEqual([{ owner_id: a.id, owner_name: a.fullName }]);
    const notified = await pool.query(`select recipient_id, title from public.notifications where lead_id = $1`, [res.body.id]);
    expect(notified.rows).toEqual([{ recipient_id: a.id, title: "New lead assigned to you" }]);

    const unknown = await api(rep, "POST", "/leads", leadBody({ revenueRange: "not disclosed" }));
    expect(unknown.body).toMatchObject({ ownerId: c.id, revenueRange: "not disclosed", revenueMinCr: null, revenueMaxCr: null });
    expect(await timeline(unknown.body.id, "Lead Assigned")).toEqual([`Owner: ${c.fullName} (Revenue unknown — default owner)`]);
  });

  it("manual create keeps an explicit owner and doesn't notify the creator", async () => {
    const res = await api(rep, "POST", "/leads", leadBody({ revenueRange: "Above 50 Cr", ownerId: rep.id }));
    expect(res.body.ownerId).toBe(rep.id);
    expect(await timeline(res.body.id, "Lead Assigned")).toEqual([`Owner: ${rep.fullName}`]);
    expect((await pool.query(`select 1 from public.notifications where lead_id = $1`, [res.body.id])).rowCount).toBe(0);
  });

  it("updating revenue never reassigns the lead", async () => {
    const created = await api(rep, "POST", "/leads", leadBody({ revenueRange: "2 Cr" }));
    expect(created.body.ownerId).toBe(a.id);
    const updated = await api(rep, "PATCH", `/leads/${created.body.id}`, { revenueRange: "Above 50 Cr" });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ ownerId: a.id, revenueRange: "Above 50 Cr", revenueMinCr: 50, revenueMaxCr: null });
    expect(await timeline(created.body.id, "Lead Assigned")).toHaveLength(1);
  });

  it("a CSV import assigns each row by revenue and sends one summary notification per owner", async () => {
    // DB clock, not the laptop's: a laptop running ahead would skip the new notifications.
    const before = (await pool.query<{ now: Date }>(`select now()`)).rows[0]!.now;
    const row = (rowNumber: number, revenueRange?: string) => ({ rowNumber, firstName: `Csv${rowNumber}`, company: "Csv Co", source: "referral", email: email(), ...(revenueRange ? { revenueRange } : {}) });
    const res = await api(rep, "POST", "/leads/import", { rows: [row(2, "2 Cr"), row(3, "50L-1Cr"), row(4, "60 Cr"), row(5)] });
    expect(res.status).toBe(201);
    expect(res.body.data.created.map((lead: { ownerId: string }) => lead.ownerId)).toEqual([a.id, a.id, b.id, c.id]);

    const summaries = await pool.query(
      `select recipient_id, title, lead_id, href from public.notifications where workspace_id = $1 and created_at >= $2 and title like '%assigned to you' and lead_id is null order by title`,
      [WORKSPACE_ID, before],
    );
    expect(summaries.rows).toEqual(
      expect.arrayContaining([
        { recipient_id: a.id, title: "2 new leads assigned to you", lead_id: null, href: "/leads" },
        { recipient_id: b.id, title: "1 new lead assigned to you", lead_id: null, href: "/leads" },
        { recipient_id: c.id, title: "1 new lead assigned to you", lead_id: null, href: "/leads" },
      ]),
    );
    expect(summaries.rows).toHaveLength(3);
  });

  it("website ingest assigns by the form's revenue range, else the fallback owner", async () => {
    const mid = await ingest("Hello\nRevenue range: ₹1–5 Cr");
    expect(mid).toMatchObject({ owner_id: a.id, revenue_range: "₹1–5 Cr", revenue_min_cr: "1.00", revenue_max_cr: "5.00" });
    expect(await timeline(mid.leadId, "Lead Assigned")).toEqual([`Owner: ${a.fullName} (Revenue ₹1–5 Cr matched rule: up to ₹5 Cr)`]);

    const big = await ingest("Revenue range: Above 50 Cr");
    expect(big.owner_id).toBe(b.id);

    const none = await ingest("Just saying hi");
    expect(none).toMatchObject({ owner_id: c.id, revenue_range: null });
    expect(await timeline(none.leadId, "Lead Assigned")).toEqual([`Owner: ${c.fullName} (Revenue unknown — default owner)`]);
  });

  it("with no rules and no fallback a website lead stays unassigned and everyone is notified", async () => {
    const empty = await newWorkspace();
    const lead = await ingest("Revenue range: ₹1–5 Cr", empty);
    expect(lead.owner_id).toBeNull();
    expect(await timeline(lead.leadId, "Lead Unassigned")).toEqual(["No rule matched — unassigned"]);
    const notified = (await pool.query(`select recipient_id from public.notifications where lead_id = $1`, [lead.leadId])).rows.map((r) => r.recipient_id);
    expect(notified).toEqual(expect.arrayContaining([a.id, b.id, c.id, rep.id, admin.id]));
    expect(notified).not.toContain(inactive.id);
  });
});
