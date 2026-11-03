/**
 * Feature 3D-1: reviewing agent decisions through the real HTTP stack (login
 * check bypassed): the decision log, detail, ratings, problem reports, stats
 * and the lead AI panel. Decisions are seeded directly; nothing calls OpenAI or
 * sends. Skipped unless TEST_DATABASE_URL is set; uses fresh workspaces per run.
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

describeIfDb("agent decision review (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  const authUserIds: string[] = [];
  const workspaceIds: string[] = [];
  let admin: Actor;
  let owner: Actor;
  let otherRep: Actor;
  let actor: Actor;
  let server: Server;
  let base: string;

  async function newUser(name: string, role: "admin" | "salesperson"): Promise<Actor> {
    const auth = await pool.query(`insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`, [`agent3d-${name}-${randomUUID()}@example.com`]);
    authUserIds.push(auth.rows[0].id);
    const profile = await pool.query(`update public.profiles set role = $2, is_active = true, full_name = $3 where id = $1 returning id, full_name, email`, [
      auth.rows[0].id,
      role,
      `Agent3D ${name}`,
    ]);
    return { id: profile.rows[0].id, fullName: profile.rows[0].full_name, email: profile.rows[0].email, isActive: true, role };
  }

  async function newWorkspace(displayName: string | null = null): Promise<string> {
    const id = randomUUID();
    await createTestWorkspace(pool, "agent3d", { id: id });
    await pool.query(`update public.agent_settings set mode = 'shadow', company_display_name = $2 where workspace_id = $1`, [id, displayName]);
    workspaceIds.push(id);
    return id;
  }

  async function newLead(workspaceId: string, ownerId: string | null = owner.id) {
    const result = await pool.query(
      `insert into public.leads (workspace_id, first_name, last_name, company, source, email, owner_id, agent_status)
       values ($1, 'Asha', 'Rao', 'Acme Steel', 'referral', $2, $3, 'active') returning id`,
      [workspaceId, `agent3d-${randomUUID()}@example.com`, ownerId],
    );
    return result.rows[0].id as string;
  }

  interface Seed {
    action?: string;
    outcome?: string;
    subject?: string | null;
    body?: string | null;
    rating?: "good" | "bad" | null;
    reason?: string | null;
    createdAt?: string;
    chunkIds?: string[] | null;
    cost?: number;
    allowed?: boolean;
  }
  async function decision(workspaceId: string, leadId: string, seed: Seed = {}) {
    const action = seed.action ?? "send_email";
    const result = await pool.query(
      `insert into public.agent_decisions
         (workspace_id, lead_id, mode, action, reasoning, message_subject, message_body, handoff_title, outcome, rating, rating_reason,
          created_at, chunk_ids, cost_usd, rules_result, grounding_result)
       values ($1, $2, 'shadow', $3, 'Because.', $4, $5, $6, $7, $8, $9, coalesce($10::timestamptz, now()), $11, $12, $13, $14) returning id`,
      [
        workspaceId,
        leadId,
        action,
        seed.subject === undefined ? (action === "send_email" ? "Outbound for Acme Steel" : null) : seed.subject,
        seed.body === undefined ? (action.startsWith("send_") ? `Hi Asha,\n\n${"Following up on our call. ".repeat(10)}` : null) : seed.body,
        action === "handoff" ? "Call her back" : null,
        seed.outcome ?? "draft",
        seed.rating ?? null,
        seed.reason ?? null,
        seed.createdAt ?? null,
        seed.chunkIds ?? null,
        seed.cost ?? 0,
        JSON.stringify({ allowed: seed.allowed ?? true, outcome: "draft", violations: [], adjustments: [] }),
        JSON.stringify({ supported: true, unsupportedClaims: [] }),
      ],
    );
    return result.rows[0].id as string;
  }

  async function api(as: Actor, workspaceId: string, method: string, path: string, body?: unknown) {
    actor = as;
    const res = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: { "Content-Type": "application/json", "X-Workspace-Id": workspaceId },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  }
  const ids = (body: { data: { id: string }[] }) => body.data.map((d) => d.id);

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    admin = await newUser("admin", "admin");
    owner = await newUser("owner", "salesperson");
    otherRep = await newUser("other", "salesperson");

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
    for (const id of authUserIds) {
      await pool.query(`delete from auth.users where id = $1`, [id]).catch((error: Error) => console.warn(`[agentReview] test user ${id} not deleted: ${error.message}`));
    }
    await pool.end();
  });

  it("pagination: 3 pages, stable (created_at desc, id desc) order, no duplicates, ties broken by id", async () => {
    const ws = await newWorkspace();
    const leadId = await newLead(ws);
    // 60 decisions over 30 distinct timestamps: every timestamp is shared by two rows.
    for (let i = 0; i < 60; i++) await decision(ws, leadId, { createdAt: new Date(Date.UTC(2026, 9, 1, 0, Math.floor(i / 2))).toISOString() });
    const expected = (await pool.query(`select id from public.agent_decisions where workspace_id = $1 order by created_at desc, id desc`, [ws])).rows.map((r) => r.id);

    const seen: string[] = [];
    let cursor: string | null = null;
    const sizes: number[] = [];
    do {
      const page = await api(owner, ws, "GET", `/agent/decisions${cursor ? `?cursor=${cursor}` : ""}`);
      expect(page.status).toBe(200);
      sizes.push(page.body.data.length);
      seen.push(...ids(page.body));
      cursor = page.body.nextCursor;
    } while (cursor);
    expect(sizes).toEqual([25, 25, 10]);
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(60);

    const row = (await api(owner, ws, "GET", "/agent/decisions?limit=1")).body.data[0];
    expect(row).toMatchObject({
      lead: { id: leadId, name: "Asha Rao", company: "Acme Steel" },
      ownerName: owner.fullName,
      action: "send_email",
      outcome: "draft",
      subject: "Outbound for Acme Steel",
      regenerated: false,
      rating: null,
      ratingReason: null,
      openReports: 0,
    });
    expect(row.bodyPreview).toHaveLength(160);

    expect((await api(owner, ws, "GET", "/agent/decisions?limit=51")).status).toBe(400);
    expect((await api(owner, ws, "GET", "/agent/decisions?cursor=garbage")).status).toBe(400);
    expect((await api(owner, ws, "GET", "/agent/decisions?hasOpenReport=yes")).status).toBe(400);
  });

  it("filters: action, outcome, leadId, rating (incl. unrated), hasOpenReport, from/to", async () => {
    const ws = await newWorkspace();
    const leadA = await newLead(ws);
    const leadB = await newLead(ws);
    const email = await decision(ws, leadA, { createdAt: "2026-09-01T00:00:00Z" });
    const handoff = await decision(ws, leadA, { action: "handoff", outcome: "draft", createdAt: "2026-09-10T00:00:00Z" });
    const blocked = await decision(ws, leadB, { action: "send_whatsapp", outcome: "blocked", createdAt: "2026-09-20T00:00:00Z" });
    const good = await decision(ws, leadB, { rating: "good", createdAt: "2026-09-25T00:00:00Z" });
    const bad = await decision(ws, leadB, { rating: "bad", reason: "wrong_tone", createdAt: "2026-09-26T00:00:00Z" });
    await pool.query(`insert into public.agent_decision_reports (workspace_id, decision_id, note) values ($1, $2, 'open'), ($1, $3, 'closed')`, [ws, email, handoff]);
    await pool.query(`update public.agent_decision_reports set resolved_at = now() where decision_id = $1`, [handoff]);

    const list = async (query: string) => {
      const res = await api(owner, ws, "GET", `/agent/decisions?${query}`);
      expect(res.status, query).toBe(200);
      return ids(res.body).sort();
    };
    const sorted = (...values: string[]) => values.sort();
    expect(await list("action=handoff")).toEqual([handoff]);
    expect(await list("outcome=blocked")).toEqual([blocked]);
    expect(await list(`leadId=${leadA}`)).toEqual(sorted(email, handoff));
    expect(await list("rating=good")).toEqual([good]);
    expect(await list("rating=bad")).toEqual([bad]);
    expect(await list("rating=unrated")).toEqual(sorted(email, handoff, blocked));
    expect(await list("hasOpenReport=true")).toEqual([email]);
    expect(await list("hasOpenReport=false")).toEqual(sorted(handoff, blocked, good, bad));
    expect(await list("from=2026-09-10&to=2026-09-20T00:00:00Z")).toEqual(sorted(handoff, blocked));
    expect((await api(owner, ws, "GET", "/agent/decisions?hasOpenReport=true")).body.data[0].openReports).toBe(1);
    expect((await api(owner, ws, "GET", "/agent/decisions?action=bogus")).status).toBe(400);
  });

  it("workspace isolation: another workspace's decisions, reports and leads are invisible", async () => {
    const wsA = await newWorkspace();
    const wsB = await newWorkspace();
    const leadB = await newLead(wsB);
    const decB = await decision(wsB, leadB);
    const reportB = (await api(owner, wsB, "POST", `/agent/decisions/${decB}/reports`, { note: "Odd" })).body.id;

    expect((await api(admin, wsA, "GET", "/agent/decisions")).body.data).toEqual([]);
    expect((await api(admin, wsA, "GET", `/agent/decisions?leadId=${leadB}`)).body.data).toEqual([]);
    expect((await api(admin, wsA, "GET", `/agent/decisions/${decB}`)).status).toBe(404);
    expect((await api(admin, wsA, "PUT", `/agent/decisions/${decB}/rating`, { rating: "good" })).status).toBe(404);
    expect((await api(admin, wsA, "POST", `/agent/decisions/${decB}/reports`, { note: "x" })).status).toBe(404);
    expect((await api(admin, wsA, "POST", `/agent/reports/${reportB}/resolve`, {})).status).toBe(404);
    expect((await api(admin, wsA, "GET", `/agent/leads/${leadB}`)).status).toBe(404);
    expect((await api(admin, wsA, "GET", "/agent/stats")).body).toMatchObject({ byAction: {}, failed: 0, openReports: 0, ratings: { rated: 0 } });
    expect((await api(admin, wsA, "GET", "/agent/decisions/not-a-uuid")).status).toBe(400);
  });

  it("detail: composed message with the display-name signature and opt-out; first WhatsApp only gets the opt-out; deleted chunk", async () => {
    const ws = await newWorkspace("MOTM Technologies");
    const leadId = await newLead(ws);
    const doc = await pool.query(`insert into public.kb_documents (workspace_id, title, doc_type, source, raw_text) values ($1, 'Pricing guide', 'pricing', 'text', 'x') returning id`, [ws]);
    const chunk = await pool.query(`insert into public.kb_chunks (workspace_id, document_id, chunk_index, content) values ($1, $2, 0, $3) returning id`, [
      ws,
      doc.rows[0].id,
      `Our plans start at ten seats. ${"More detail. ".repeat(40)}`,
    ]);
    const gone = randomUUID();
    const emailId = await decision(ws, leadId, { chunkIds: [chunk.rows[0].id, gone], createdAt: "2026-10-01T00:00:00Z" });

    const detail = await api(otherRep, ws, "GET", `/agent/decisions/${emailId}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ id: emailId, leadId, action: "send_email", outcome: "draft", rulesResult: { allowed: true }, reports: [], ratedByName: null });
    const settings = (await pool.query(`select email_opt_out_text, whatsapp_opt_out_text from public.agent_settings where workspace_id = $1`, [ws])).rows[0];
    expect(detail.body.composed.channel).toBe("email");
    expect(detail.body.composed.subject).toBe("Outbound for Acme Steel");
    expect(detail.body.composed.text).toContain(`Best regards,\n${owner.fullName}\nMOTM Technologies`);
    expect(detail.body.composed.text.endsWith(settings.email_opt_out_text)).toBe(true);
    expect(detail.body.chunks).toEqual([
      { id: chunk.rows[0].id, deleted: false, title: "Pricing guide", text: expect.stringMatching(/^Our plans start at ten seats\./) },
      { id: gone, deleted: true, title: "deleted", text: "deleted" },
    ]);
    expect(detail.body.chunks[0].text).toHaveLength(300);

    const firstWa = await decision(ws, leadId, { action: "send_whatsapp", createdAt: "2026-10-02T00:00:00Z" });
    const secondWa = await decision(ws, leadId, { action: "send_whatsapp", createdAt: "2026-10-05T00:00:00Z" });
    const first = (await api(owner, ws, "GET", `/agent/decisions/${firstWa}`)).body.composed;
    const second = (await api(owner, ws, "GET", `/agent/decisions/${secondWa}`)).body.composed;
    // E3b-1: "<first name>, <company>" on its own line, no dash.
    const firstName = owner.fullName.split(" ")[0];
    expect(first.text).toContain(`\n\n${firstName}, MOTM Technologies\n\n${settings.whatsapp_opt_out_text}`);
    expect(second.text.endsWith(`\n\n${firstName}, MOTM Technologies`)).toBe(true);

    const handoff = await decision(ws, leadId, { action: "handoff" });
    expect((await api(owner, ws, "GET", `/agent/decisions/${handoff}`)).body.composed).toBeNull();
  });

  it("rating: admin and the owner may rate, another rep 403, bad needs a reason, failed 422, re-rating overwrites", async () => {
    const ws = await newWorkspace();
    const leadId = await newLead(ws);
    const id = await decision(ws, leadId);
    const failed = await decision(ws, leadId, { action: "wait", outcome: "failed" });

    expect((await api(otherRep, ws, "PUT", `/agent/decisions/${id}/rating`, { rating: "good" })).status).toBe(403);
    expect((await api(owner, ws, "PUT", `/agent/decisions/${id}/rating`, { rating: "bad" })).status).toBe(400);
    expect((await api(owner, ws, "PUT", `/agent/decisions/${id}/rating`, { rating: "good", reason: "other" })).status).toBe(400);
    expect((await api(owner, ws, "PUT", `/agent/decisions/${id}/rating`, { rating: "meh" })).status).toBe(400);
    expect((await api(admin, ws, "PUT", `/agent/decisions/${failed}/rating`, { rating: "good" })).status).toBe(422);

    const byOwner = await api(owner, ws, "PUT", `/agent/decisions/${id}/rating`, { rating: "bad", reason: "made_up_fact", note: " Invented a client " });
    expect(byOwner.status).toBe(200);
    expect(byOwner.body).toMatchObject({ rating: "bad", ratingReason: "made_up_fact", ratingNote: "Invented a client", ratedBy: owner.id, ratedByName: owner.fullName });

    const byAdmin = await api(admin, ws, "PUT", `/agent/decisions/${id}/rating`, { rating: "good" });
    expect(byAdmin.status).toBe(200);
    expect(byAdmin.body).toMatchObject({ rating: "good", ratingReason: null, ratingNote: null, ratedBy: admin.id, ratedByName: admin.fullName });
    expect(new Date(byAdmin.body.ratedAt).getTime()).toBeGreaterThanOrEqual(new Date(byOwner.body.ratedAt).getTime());
  });

  it("reports: any CRM user reports, every active admin is notified; resolve is admin-only and once", async () => {
    const ws = await newWorkspace();
    const leadId = await newLead(ws);
    const id = await decision(ws, leadId);

    expect((await api(otherRep, ws, "POST", `/agent/decisions/${id}/reports`, { note: "  " })).status).toBe(400);
    const report = await api(otherRep, ws, "POST", `/agent/decisions/${id}/reports`, { note: "It promised a discount." });
    expect(report.status).toBe(201);
    expect(report.body).toMatchObject({ decisionId: id, reportedBy: otherRep.id, reportedByName: otherRep.fullName, note: "It promised a discount.", resolvedAt: null });

    const notes = (await pool.query(`select recipient_id, title, kind, lead_id, href, detail from public.notifications where workspace_id = $1`, [ws])).rows;
    const admins = (await pool.query(`select id from public.profiles where role = 'admin' and is_active`)).rows.map((r) => r.id);
    expect(notes.map((n) => n.recipient_id).sort()).toEqual(admins.sort());
    expect(notes.find((n) => n.recipient_id === admin.id)).toMatchObject({
      title: "AI message reported on Asha Rao",
      kind: "warning",
      lead_id: leadId,
      href: `/leads/${leadId}`,
      detail: `${otherRep.fullName}: It promised a discount.`,
    });
    expect(notes.some((n) => n.recipient_id === otherRep.id || n.recipient_id === owner.id)).toBe(false);

    expect((await api(admin, ws, "GET", `/agent/decisions/${id}`)).body.reports).toHaveLength(1);
    expect((await api(owner, ws, "POST", `/agent/reports/${report.body.id}/resolve`, {})).status).toBe(403);
    const resolved = await api(admin, ws, "POST", `/agent/reports/${report.body.id}/resolve`, { note: "Fixed the playbook." });
    expect(resolved.status).toBe(200);
    expect(resolved.body).toMatchObject({ resolvedBy: admin.id, resolutionNote: "Fixed the playbook." });
    expect(resolved.body.resolvedAt).toBeTruthy();
    expect((await api(admin, ws, "POST", `/agent/reports/${report.body.id}/resolve`, {})).status).toBe(409);
    expect((await api(admin, ws, "POST", `/agent/reports/${randomUUID()}/resolve`, {})).status).toBe(404);
  });

  it("stats and readiness on seeded decisions (failed excluded; this IST month's spend)", async () => {
    const ws = await newWorkspace();
    const leadId = await newLead(ws);
    await pool.query(`update public.agent_settings set monthly_budget_usd = 25 where workspace_id = $1`, [ws]);
    for (let i = 0; i < 45; i++) await decision(ws, leadId, { rating: "good", cost: 0.1 });
    for (let i = 0; i < 4; i++) await decision(ws, leadId, { action: "send_whatsapp", rating: "bad", reason: "wrong_tone" });
    await decision(ws, leadId, { action: "handoff", rating: "bad", reason: "made_up_fact" });
    await decision(ws, leadId, { action: "wait", outcome: "blocked" });
    await decision(ws, leadId, { action: "wait", outcome: "failed", cost: 0.5 });
    await decision(ws, leadId, { action: "wait", outcome: "failed" });
    await decision(ws, leadId, { cost: 3, createdAt: "2020-01-01T00:00:00Z" }); // an earlier month's spend
    await pool.query(`insert into public.agent_decision_reports (workspace_id, decision_id, note) select $1, id, 'x' from public.agent_decisions where workspace_id = $1 limit 2`, [ws]);

    const stats = await api(owner, ws, "GET", "/agent/stats");
    expect(stats.status).toBe(200);
    expect(stats.body).toMatchObject({
      mode: "shadow",
      byAction: { send_email: 46, send_whatsapp: 4, handoff: 1, wait: 1 },
      byOutcome: { draft: 51, blocked: 1 },
      failed: 2,
      ratings: { rated: 50, good: 45, bad: 5, badByReason: { made_up_fact: 1, internal_info_leak: 0, wrong_tone: 4, wrong_timing: 0, wrong_action: 0, other: 0 } },
      openReports: 2,
      spend: { budgetUsd: 25 },
      readiness: { ready: false, rated: 50, goodPct: 90, seriousBad: 1 },
    });
    expect(stats.body.spend.spentUsd).toBeCloseTo(5);
    // E3a: 50 sends (none regenerated), the handoff had no message; the two failed ones don't count.
    expect(stats.body.quality.sinceReadiness).toMatchObject({ sendDecisions: 50, passedFirstTry: 50, passedFirstTryPct: 100, regenerated: 0, checkHandoffs: 0, autoFixes: 0 });
    expect(stats.body.spend.month).toMatch(/^\d{4}-\d{2}$/);
    expect(stats.body.readiness.reasons).toHaveLength(1);

    await pool.query(`update public.agent_decisions set rating = 'good', rating_reason = null where workspace_id = $1 and rating_reason = 'made_up_fact'`, [ws]);
    expect((await api(owner, ws, "GET", "/agent/stats")).body.readiness).toMatchObject({ ready: true, goodPct: 92, seriousBad: 0, reasons: [] });
  });

  it("E3a: quality numbers: since the go-live count and over 7 days, by handoff reason, auto-fixes, cost, cached input", async () => {
    const ws = await newWorkspace();
    const leadId = await newLead(ws);
    await decision(ws, leadId, { cost: 9, createdAt: new Date(Date.now() - 3_600_000).toISOString() }); // before the count, inside 7 days
    await decision(ws, leadId, { cost: 9, createdAt: new Date(Date.now() - 10 * 86_400_000).toISOString() }); // before both
    await pool.query(`update public.agent_settings set readiness_since = now() - interval '1 minute' where workspace_id = $1`, [ws]);
    await decision(ws, leadId, { action: "handoff", body: "A draft the checks refused", cost: 0.02 });
    await decision(ws, leadId, { action: "wait", cost: 0.02 }); // wrote nothing
    await decision(ws, leadId, { action: "wait", outcome: "failed", cost: 5 });
    const regenerated = await decision(ws, leadId, { cost: 0.04 });
    await pool.query(`update public.agent_decisions set regenerated = true, quality_checks = $2 where id = $1`, [
      regenerated,
      JSON.stringify([{ problems: ["length: too long"], inputTokens: 1000, cachedInputTokens: 0 }, { problems: [], inputTokens: 1000, cachedInputTokens: 500, autoFixes: [{ rule: "dash", before: "a", after: "b" }, { rule: "spacing", before: "c", after: "d" }] }]),
    ]);
    const { quality } = (await api(owner, ws, "GET", "/agent/stats")).body;
    expect(quality.sinceReadiness).toMatchObject({
      sendDecisions: 2,
      passedFirstTry: 0,
      passedFirstTryPct: 0,
      regenerated: 1,
      checkHandoffs: 1,
      checkHandoffsByReason: { "Call her back": 1 },
      autoFixes: 2,
      cachedInputPct: 25,
    });
    expect(quality.sinceReadiness.avgCostUsd).toBeCloseTo(0.0267, 3);
    expect(quality.last7Days).toMatchObject({ sendDecisions: 3, passedFirstTry: 1, passedFirstTryPct: 33 });
  });

  it("E2f: Reset go-live count — admin only; only decisions created since then count; earlier ratings stay saved", async () => {
    const ws = await newWorkspace();
    const leadId = await newLead(ws);
    for (let i = 0; i < 3; i++) await decision(ws, leadId, { rating: "good", createdAt: new Date(Date.now() - 3_600_000).toISOString() });
    await decision(ws, leadId, { rating: "bad", reason: "made_up_fact", createdAt: new Date(Date.now() - 3_600_000).toISOString() });
    const before = (await api(owner, ws, "GET", "/agent/stats")).body;
    expect(before).toMatchObject({ readinessSince: null, readiness: { rated: 4, seriousBad: 1 } });
    expect((await api(admin, ws, "GET", "/agent/settings")).body.readinessSince).toBeNull();

    expect((await api(owner, ws, "POST", "/agent/settings/reset-readiness")).status).toBe(403);
    const reset = await api(admin, ws, "POST", "/agent/settings/reset-readiness");
    expect(reset.status).toBe(200);
    expect(Date.parse(reset.body.readinessSince)).toBeGreaterThan(Date.now() - 60_000);

    await decision(ws, leadId, { rating: "good" });
    const after = (await api(owner, ws, "GET", "/agent/stats")).body;
    expect(after.readinessSince).toBe(reset.body.readinessSince);
    expect(after.readiness).toMatchObject({ rated: 1, goodPct: 100, seriousBad: 0 });
    expect(after.ratings).toMatchObject({ rated: 1, good: 1, bad: 0 });
    // The gate in the live preview uses the same count; the old ratings are still stored.
    expect((await api(admin, ws, "GET", "/agent/settings/live-preview?scope=all")).body.readiness).toMatchObject({ rated: 1, seriousBad: 0 });
    expect((await pool.query(`select count(*)::int as n from public.agent_decisions where workspace_id = $1 and rating is not null`, [ws])).rows[0].n).toBe(5);
  });

  it("lead panel: agent status, the next pending wakeup and the last 10 decisions", async () => {
    const ws = await newWorkspace();
    const leadId = await newLead(ws);
    await pool.query(`update public.leads set agent_status_reason = 'enrolled', agent_status_changed_at = now(), agent_touch_count = 2 where id = $1`, [leadId]);
    const due = new Date(Date.now() + 86_400_000);
    await pool.query(`insert into public.agent_wakeups (workspace_id, lead_id, due_at, reason) values ($1, $2, $3, 'timer')`, [ws, leadId, due]);
    await pool.query(`insert into public.agent_wakeups (workspace_id, lead_id, due_at, reason, status) values ($1, $2, now(), 'enrolled', 'done')`, [ws, leadId]);
    const created: string[] = [];
    for (let i = 0; i < 12; i++) created.push(await decision(ws, leadId, { createdAt: new Date(Date.UTC(2026, 9, 1, i)).toISOString(), rating: i === 11 ? "good" : null }));

    const panel = await api(otherRep, ws, "GET", `/agent/leads/${leadId}`);
    expect(panel.status).toBe(200);
    expect(panel.body).toMatchObject({ leadId, status: "active", statusReason: "enrolled", touchCount: 2, nextWakeup: { reason: "timer" } });
    expect(new Date(panel.body.nextWakeup.dueAt).getTime()).toBe(due.getTime());
    expect(panel.body.decisions.map((d: { id: string }) => d.id)).toEqual(created.slice(2).reverse());
    expect(panel.body.decisions[0]).toMatchObject({
      action: "send_email",
      messageSubject: "Outbound for Acme Steel",
      rating: "good",
      rules: { allowed: true, outcome: "draft", violations: [], adjustments: [] },
      grounding: { supported: true, unsupportedClaims: [] },
    });
    expect(panel.body.decisions[0].messageBody.length).toBeGreaterThan(160);
    expect((await api(owner, ws, "GET", `/agent/leads/${randomUUID()}`)).status).toBe(404);
  });
});
