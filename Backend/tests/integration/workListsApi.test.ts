/**
 * C6a work lists through the HTTP stack: GET /tasks|/meetings|/proposals /list + /count,
 * /proposals/summary — paging, filters, IST day boundaries (DB clock), `me`, owner names
 * from profiles, allowedNextStatuses vs POST /proposals/:id/status, workspace isolation,
 * saved views for the new objects. Skipped unless TEST_DATABASE_URL is set; [test] workspaces only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createTestWorkspace, deleteCreatedTestWorkspaces } from "../helpers/testWorkspaces.js";
import { expectConsistentPaging, qs, startTestApi, type TestApi } from "../helpers/testApi.js";
import type { Actor } from "../../src/authMiddleware.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const IST_DAY = `(date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata')`;

describeIfDb("work lists API (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let api: TestApi;
  let admin: Actor;
  let rep: Actor;
  let ws: string;
  let otherWs: string;
  let contactA: string;
  let contactB: string;
  let otherContact: string;
  let companyA: string;
  let dealA: string;
  const tasks: Record<string, string> = {};
  const meetings: Record<string, string> = {};
  const proposals: Record<string, string> = {};
  let withTransaction: typeof import("../../src/db.js").withTransaction;
  let leads: typeof import("../../src/services/leads.service.js");

  const call = (method: string, path: string, body?: unknown, as: Actor = rep, workspace = ws) => api.call(as, workspace, method, path, body);
  const ids = async (path: string, params: Parameters<typeof qs>[0], as: Actor = rep) => {
    const res = await call("GET", `${path}${qs({ ...params, limit: 100 })}`, undefined, as);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return (res.body.data as { id: string }[]).map((r) => r.id).sort();
  };
  const count = async (path: string, params: Parameters<typeof qs>[0]) => {
    const res = await call("GET", `${path}${qs(params)}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.count as number;
  };
  const pick = (map: Record<string, string>, ...names: string[]) => names.map((n) => map[n]!).sort();
  const contact = (workspace: string, company: string, email: string, ownerId: string) =>
    withTransaction(async (client) => (await leads.createLead(client, rep, workspace, { firstName: "Work", lastName: company, company, email, source: "referral", ownerId })).id);

  /** Inserts a task whose due_at is a SQL expression on the DB clock. */
  const task = async (name: string, lead: string, dueSql: string, extra: { owner?: string | null; status?: string; type?: string; origin?: string; title?: string } = {}) => {
    const status = extra.status ?? "open";
    const { rows } = await pool.query(
      `insert into public.tasks (workspace_id, lead_id, owner_id, task_type, title, due_at, status, origin, completed_at, cancelled_at)
       select workspace_id, id, $2, $3::public.task_type, $4, ${dueSql}, $5::public.task_status, $6::public.task_origin,
              case when $5::text = 'completed' then now() end, case when $5::text = 'cancelled' then now() end
         from public.leads where id = $1 returning id`,
      [lead, extra.owner === undefined ? rep.id : extra.owner, extra.type ?? "follow_up", extra.title ?? `Task ${name}`, status, extra.origin ?? "manual"],
    );
    tasks[name] = rows[0].id;
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
    api = await startTestApi(pool, "work-lists");
    admin = await api.newUser("admin", { name: "Admin Work" });
    rep = await api.newUser("salesperson", { name: "Rep Work" });
    ({ withTransaction } = await import("../../src/db.js"));
    leads = await import("../../src/services/leads.service.js");
    ws = await createTestWorkspace(pool, "work-lists");
    otherWs = await createTestWorkspace(pool, "work-lists-other");
    contactA = await contact(ws, "Acme Work", "a@acmework.example.com", rep.id);
    contactB = await contact(ws, "Bolt Work", "b@boltwork.example.com", admin.id);
    otherContact = await contact(otherWs, "Other Work", "o@otherwork.example.com", rep.id);
    companyA = (await pool.query(`select company_id from public.leads where id = $1`, [contactA])).rows[0].company_id;
    dealA = (await call("POST", "/deals", { leadId: contactA, name: "Acme work deal" })).body.id;
    // createLead adds a "First call" task to every contact; start from a clean slate.
    await pool.query(`delete from public.tasks where lead_id = any($1::uuid[])`, [[contactA, contactB, otherContact]]);

    await task("overdue", contactA, `now() - interval '2 hours'`, { title: "Overdue chase" });
    await task("todayLate", contactA, `${IST_DAY} + interval '23 hours 59 minutes'`, { type: "call" });
    await task("tomorrowEarly", contactB, `${IST_DAY} + interval '1 day 1 minute'`, { owner: admin.id, origin: "agent" });
    await task("nextWeek", contactB, `now() + interval '7 days'`, { owner: null });
    await task("done", contactA, `now() - interval '1 day'`, { status: "completed" });
    await task("cancelled", contactB, `now()`, { status: "cancelled" });
    await task("foreign", otherContact, `now()`);

    const meeting = async (name: string, lead: string, atSql: string, status: string, outcome: string | null = null, dealId: string | null = null, owner: string = rep.id) => {
      const { rows } = await pool.query(
        `insert into public.meetings (workspace_id, lead_id, owner_id, title, scheduled_at, status, outcome, deal_id)
         select workspace_id, id, $2, $3, ${atSql}, $4, $5, $6 from public.leads where id = $1 returning id`,
        [lead, owner, `Meeting ${name}`, status, outcome, dealId],
      );
      meetings[name] = rows[0].id;
    };
    await meeting("future", contactA, `now() + interval '3 days'`, "scheduled", null, dealA);
    await meeting("pastOpen", contactA, `now() - interval '2 days'`, "confirmed");
    await meeting("pastDone", contactB, `now() - interval '3 days'`, "completed", "proposal_required", null, admin.id);
    await meeting("pastCancelled", contactB, `now() - interval '1 day'`, "cancelled");
    await meeting("foreign", otherContact, `now() + interval '1 day'`, "scheduled");

    const proposal = async (name: string, lead: string, status: string, amount: number | null, extra: { sent?: boolean; dealId?: string | null; lossReason?: string } = {}) => {
      const { rows } = await pool.query(
        `insert into public.proposals (workspace_id, lead_id, owner_id, title, status, amount, sent_at, deal_id, loss_reason)
         select workspace_id, id, $2, $3, $4, $5, case when $6::boolean then now() end, $7, $8 from public.leads where id = $1 returning id`,
        [lead, rep.id, `Proposal ${name}`, status, amount, extra.sent ?? false, extra.dealId ?? null, extra.lossReason ?? null],
      );
      proposals[name] = rows[0].id;
    };
    await proposal("draft", contactA, "draft", 1000, { dealId: dealA });
    await proposal("sent", contactA, "sent", 2500, { sent: true });
    await proposal("revised", contactB, "revised", null, { sent: true });
    await proposal("accepted", contactB, "accepted", 9000, { sent: true });
    await proposal("rejected", contactB, "rejected", 400, { sent: true, lossReason: "price_budget" });
    await proposal("foreign", otherContact, "sent", 77, { sent: true });
  });

  afterAll(async () => {
    await deleteCreatedTestWorkspaces(pool);
    await api?.close();
    await pool?.end();
  });

  describe("tasks", () => {
    it("pages with limit 3 without gaps or duplicates, for every sort", async () => {
      for (const sort of ["dueAt:asc", "dueAt:desc", "createdAt:desc", "updatedAt:asc"]) {
        const seen = await expectConsistentPaging((q) => call("GET", `/tasks/list${q}`), { status: "all", sort }, 3);
        expect(seen).toHaveLength(6);
      }
    });

    it("defaults to open tasks, due date ascending, with refs and owner names from profiles", async () => {
      const res = await call("GET", "/tasks/list");
      expect(res.status).toBe(200);
      const rows = res.body.data as { id: string; dueAt: string; ownerName: string | null; contact: { id: string; name: string }; company: { id: string } | null; deal: { id: string } | null }[];
      expect(rows.map((r) => r.id)).toEqual([tasks.overdue, tasks.todayLate, tasks.tomorrowEarly, tasks.nextWeek]);
      const overdue = rows[0]!;
      expect(overdue.ownerName).toBe("Rep Work");
      expect(overdue.contact).toEqual({ id: contactA, name: "Work Acme Work" });
      expect(overdue.company?.id).toBe(companyA);
      expect(overdue.deal).toEqual({ id: dealA, name: "Acme work deal" });
      expect(rows[2]!.ownerName).toBe("Admin Work");
      expect(rows[3]!.ownerName).toBeNull();
      // The denormalised column is empty for these rows; the name comes from the join (B25).
      expect((await pool.query(`select owner_name from public.tasks where id = $1`, [tasks.overdue])).rows[0].owner_name).toBeNull();
    });

    it("splits overdue / today / upcoming on IST days (23:59 IST today is today, 00:01 tomorrow is upcoming)", async () => {
      expect(await ids("/tasks/list", { due: "overdue" })).toEqual(pick(tasks, "overdue"));
      const today = await ids("/tasks/list", { due: "today" });
      expect(today).toContain(tasks.todayLate);
      expect(today).not.toContain(tasks.tomorrowEarly);
      expect(await ids("/tasks/list", { due: "upcoming" })).toEqual(pick(tasks, "tomorrowEarly", "nextWeek"));
      expect(await count("/tasks/count", { due: "overdue" })).toBe(1);
    });

    it("filters by status, owner (me / none / id), type, origin, contact, company, deal, due range and q", async () => {
      expect(await ids("/tasks/list", { status: "completed" })).toEqual(pick(tasks, "done"));
      expect(await ids("/tasks/list", { status: "cancelled" })).toEqual(pick(tasks, "cancelled"));
      expect(await ids("/tasks/list", { ownerId: "me" })).toEqual(pick(tasks, "overdue", "todayLate"));
      expect(await ids("/tasks/list", { ownerId: "me" }, admin)).toEqual(pick(tasks, "tomorrowEarly"));
      expect(await ids("/tasks/list", { ownerId: ["none", admin.id] })).toEqual(pick(tasks, "tomorrowEarly", "nextWeek"));
      expect(await ids("/tasks/list", { type: "call" })).toEqual(pick(tasks, "todayLate"));
      expect(await ids("/tasks/list", { origin: "agent" })).toEqual(pick(tasks, "tomorrowEarly"));
      expect(await ids("/tasks/list", { contactId: contactB })).toEqual(pick(tasks, "tomorrowEarly", "nextWeek"));
      expect(await ids("/tasks/list", { companyId: companyA })).toEqual(pick(tasks, "overdue", "todayLate"));
      expect(await ids("/tasks/list", { dealId: dealA, status: "all" })).toEqual(pick(tasks, "overdue", "todayLate", "done"));
      const from = new Date(Date.now() + 3 * 86_400_000).toISOString();
      expect(await ids("/tasks/list", { dueFrom: from })).toEqual(pick(tasks, "nextWeek"));
      expect(await ids("/tasks/list", { q: "chase" })).toEqual(pick(tasks, "overdue"));
      expect(await ids("/tasks/list", { q: "bolt work" })).toEqual(pick(tasks, "tomorrowEarly", "nextWeek"));
      expect(await ids("/tasks/list", { q: "50%" })).toEqual([]);
      expect(await count("/tasks/count", { status: "all" })).toBe(6);
    });

    it("rejects unknown params, bad sorts, due=none and sort on /count", async () => {
      for (const query of ["?foo=1", "?sort=title:asc", "?due=none", "?cursor=nope"]) expect((await call("GET", `/tasks/list${query}`)).status).toBe(400);
      expect((await call("GET", "/tasks/count?sort=dueAt:asc")).status).toBe(400);
    });

    it("keeps the old GET /tasks shape", async () => {
      const res = await call("GET", `/tasks?leadId=${contactA}`);
      expect(res.status).toBe(200);
      expect(res.body.nextCursor).toBeUndefined();
      expect(res.body.data.length).toBe(3);
    });
  });

  describe("meetings", () => {
    it("pages with limit 3 and filters by when / status / owner / contact / company / deal / range / q", async () => {
      await expectConsistentPaging((q) => call("GET", `/meetings/list${q}`), { sort: "at:desc" }, 3);
      await expectConsistentPaging((q) => call("GET", `/meetings/list${q}`), { sort: "createdAt:asc" }, 3);
      expect(await ids("/meetings/list", {})).toEqual(pick(meetings, "future", "pastOpen", "pastDone", "pastCancelled"));
      expect(await ids("/meetings/list", { when: "upcoming" })).toEqual(pick(meetings, "future"));
      expect(await ids("/meetings/list", { when: "past" })).toEqual(pick(meetings, "pastOpen", "pastDone", "pastCancelled"));
      expect(await ids("/meetings/list", { when: "needs_outcome" })).toEqual(pick(meetings, "pastOpen"));
      expect(await ids("/meetings/list", { status: ["completed", "cancelled"] })).toEqual(pick(meetings, "pastDone", "pastCancelled"));
      expect(await ids("/meetings/list", { ownerId: "me" }, admin)).toEqual(pick(meetings, "pastDone"));
      expect(await ids("/meetings/list", { contactId: contactA })).toEqual(pick(meetings, "future", "pastOpen"));
      expect(await ids("/meetings/list", { companyId: companyA })).toEqual(pick(meetings, "future", "pastOpen"));
      expect(await ids("/meetings/list", { dealId: dealA })).toEqual(pick(meetings, "future"));
      expect(await ids("/meetings/list", { from: new Date().toISOString() })).toEqual(pick(meetings, "future"));
      expect(await ids("/meetings/list", { q: "pastdone" })).toEqual(pick(meetings, "pastDone"));
      expect(await count("/meetings/count", { when: "needs_outcome" })).toBe(1);
    });

    it("rows carry refs, owner name, outcome and sync/notify statuses", async () => {
      const res = await call("GET", `/meetings/list${qs({ dealId: dealA })}`);
      const row = res.body.data[0];
      expect(row).toMatchObject({ id: meetings.future, ownerName: "Rep Work", contact: { id: contactA }, company: { id: companyA }, deal: { id: dealA, name: "Acme work deal" } });
      expect(row).toHaveProperty("calendarSyncStatus");
      expect(row).toHaveProperty("notifyEmailStatus");
      expect(row).toHaveProperty("notifyWhatsappStatus");
    });

    it("counts a meeting at 23:59 IST today as today", async () => {
      const { rows } = await pool.query(
        `insert into public.meetings (workspace_id, lead_id, owner_id, title, scheduled_at, status)
         select workspace_id, id, $2, 'Late today', ${IST_DAY} + interval '23 hours 59 minutes', 'scheduled' from public.leads where id = $1 returning id`,
        [contactA, rep.id],
      );
      expect(await ids("/meetings/list", { when: "today" })).toContain(rows[0].id);
      await pool.query(`delete from public.meetings where id = $1`, [rows[0].id]);
    });
  });

  describe("proposals", () => {
    it("pages with limit 3 for every sort (NULL amounts last) and defaults to updatedAt desc", async () => {
      for (const sort of ["updatedAt:desc", "sentAt:asc", "sentAt:desc", "amount:asc", "amount:desc"]) {
        const seen = await expectConsistentPaging((q) => call("GET", `/proposals/list${q}`), { sort }, 3);
        expect(seen).toHaveLength(5);
      }
      const byAmount = await call("GET", "/proposals/list?sort=amount:desc&limit=100");
      expect(byAmount.body.data.at(-1).id).toBe(proposals.revised);
    });

    it("filters by group, status, owner, contact, company, deal, updated range and q", async () => {
      expect(await ids("/proposals/list", { group: "open" })).toEqual(pick(proposals, "draft", "sent", "revised"));
      expect(await ids("/proposals/list", { group: "awaiting_decision" })).toEqual(pick(proposals, "sent"));
      expect(await ids("/proposals/list", { group: "won" })).toEqual(pick(proposals, "accepted"));
      expect(await ids("/proposals/list", { group: "lost" })).toEqual(pick(proposals, "rejected"));
      expect(await ids("/proposals/list", { status: ["draft", "accepted"] })).toEqual(pick(proposals, "draft", "accepted"));
      expect(await ids("/proposals/list", { ownerId: "me" }, admin)).toEqual([]);
      expect(await ids("/proposals/list", { contactId: contactA })).toEqual(pick(proposals, "draft", "sent"));
      expect(await ids("/proposals/list", { companyId: companyA })).toEqual(pick(proposals, "draft", "sent"));
      expect(await ids("/proposals/list", { dealId: dealA })).toEqual(pick(proposals, "draft"));
      expect(await ids("/proposals/list", { updatedTo: "2000-01-01T00:00:00+05:30" })).toEqual([]);
      expect(await ids("/proposals/list", { q: "proposal rev" })).toEqual(pick(proposals, "revised"));
      expect(await count("/proposals/count", { group: "lost" })).toBe(1);
    });

    it("summary: open count, sent count and open INR value with the same filters", async () => {
      expect((await call("GET", "/proposals/summary")).body).toEqual({ openCount: 3, sentCount: 1, openValue: 3500 });
      expect((await call("GET", `/proposals/summary${qs({ contactId: contactB })}`)).body).toEqual({ openCount: 1, sentCount: 0, openValue: 0 });
      expect((await call("GET", "/proposals/summary?sort=amount:asc")).status).toBe(400);
    });

    it("rows carry owner names (B26) and allowedNextStatuses that match what POST /status accepts", async () => {
      const row = async (id: string) => (await call("GET", `/proposals/list?limit=100`)).body.data.find((r: { id: string }) => r.id === id);
      const draft = await row(proposals.draft!);
      expect(draft.ownerName).toBe("Rep Work");
      expect(draft.deal).toEqual({ id: dealA, name: "Acme work deal" });
      expect(draft.allowedNextStatuses).not.toContain("draft");
      expect(draft.allowedNextStatuses).toContain("ready_to_send");
      expect((await row(proposals.accepted!)).allowedNextStatuses).toEqual([]);

      expect((await call("POST", `/proposals/${proposals.draft}/status`, { status: "ready_to_send" })).status).toBe(200);
      // A loss status needs a reason (B4).
      expect((await call("POST", `/proposals/${proposals.sent}/status`, { status: "rejected" })).status).toBe(400);
      expect((await call("POST", `/proposals/${proposals.sent}/status`, { status: "rejected", lossReason: "no_urgency" })).status).toBe(200);
      const rejected = await row(proposals.sent!);
      expect(rejected.status).toBe("rejected");
      expect(rejected.allowedNextStatuses).toEqual([]);
      // Nothing the row does not list is accepted.
      expect((await call("POST", `/proposals/${proposals.sent}/status`, { status: "sent" })).status).toBe(409);
      expect((await call("POST", `/proposals/${proposals.accepted}/status`, { status: "draft" })).status).toBe(409);
    });
  });

  it("isolates workspaces", async () => {
    for (const path of ["/tasks/list", "/meetings/list", "/proposals/list"]) {
      const all = await ids(path, path === "/tasks/list" ? { status: "all" } : {});
      expect(all).not.toContain(tasks.foreign);
      expect(all).not.toContain(meetings.foreign);
      expect(all).not.toContain(proposals.foreign);
      expect(await ids(path, { contactId: otherContact })).toEqual([]);
    }
    const foreign = await api.call(rep, otherWs, "GET", "/tasks/list");
    expect(foreign.body.data.map((r: { id: string }) => r.id)).toEqual([tasks.foreign]);
  });

  it("saved views accept the new objects with their filters, sorts and columns", async () => {
    const ok = await call("POST", "/saved-views", { object: "tasks", name: "Mine today", filters: { ownerId: "me", due: "today" }, sort: "dueAt:asc", columns: ["title", "dueAt"] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect((await call("POST", "/saved-views", { object: "meetings", name: "Needs outcome", filters: { when: "needs_outcome" } })).status).toBe(201);
    expect((await call("POST", "/saved-views", { object: "proposals", name: "Lost", filters: { group: "lost" }, sort: "amount:desc" })).status).toBe(201);
    expect((await call("POST", "/saved-views", { object: "tasks", name: "Bad", filters: { due: "never" } })).status).toBe(400);
    expect((await call("POST", "/saved-views", { object: "meetings", name: "Bad", columns: ["nope"] })).status).toBe(400);
    expect((await call("GET", "/saved-views?object=proposals")).body.data).toHaveLength(1);
  });
});
