/**
 * E3b-2b rules 11–13: the public open pixel through the real HTTP stack and the worker's open
 * events. Emails are inserted as already sent (no SMTP). Skipped unless TEST_DATABASE_URL is set;
 * [test] workspaces only.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createTestWorkspace, deleteCreatedTestWorkspaces } from "../helpers/testWorkspaces.js";
import { startTestApi, type TestApi } from "../helpers/testApi.js";
import { newOpenToken, TRANSPARENT_GIF } from "../../src/domain/emailTracking.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb("E3b-2b email open tracking (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let api: TestApi;
  let ws: string;
  let leadId: string;

  /** A sent workflow email `sentAgo` ms ago with its token. */
  async function sentEmail(sentAgoMs: number, opts: { source?: string; subject?: string } = {}) {
    const token = newOpenToken();
    const row = await pool.query(
      `insert into public.email_outbound_messages (workspace_id, source, source_id, lead_id, to_address, to_contact, subject, html, text_body, status, sent_at, open_token)
       values ($1, $2, gen_random_uuid(), $3, 'asha@example.com', true, $4, '<p>Hi</p>', 'Hi', 'sent', now() - $5 * interval '1 millisecond', $6) returning id`,
      [ws, opts.source ?? "scheduled_action", leadId, opts.subject ?? "Buyers in Pune", sentAgoMs, token],
    );
    return { id: row.rows[0].id as string, token };
  }
  const pixel = async (path: string) => {
    const res = await fetch(`${api.origin}${path}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/gif");
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(Buffer.from(await res.arrayBuffer()).equals(TRANSPARENT_GIF)).toBe(true);
  };
  const row = async (id: string) =>
    (await pool.query(`select open_count, first_opened_at, last_opened_at, first_counted_open_at, open_event_at from public.email_outbound_messages where id = $1`, [id])).rows[0];
  const openEvents = async () => (await pool.query(`select title, metadata from public.timeline_events where lead_id = $1 and title like 'Email opened:%'`, [leadId])).rows;
  const runEvents = async () => {
    const { runOpenEvents } = await import("../../src/services/emailOpens.service.js");
    return runOpenEvents({ workspaceIds: [ws] });
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
    api = await startTestApi(pool, "email-opens");
    ws = await createTestWorkspace(pool, "email-opens");
    leadId = (
      await pool.query(
        `insert into public.leads (workspace_id, first_name, company, source, email, hot_score_dirty) values ($1, 'Asha', 'Acme Steel', 'referral', $2, false) returning id`,
        [ws, `opens-${randomUUID()}@example.com`],
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    await deleteCreatedTestWorkspaces(pool);
    await api.close();
    await pool.end();
  });

  it("unknown or malformed tokens get the same GIF and change nothing; an open within 60 s of sending only raises open_count", async () => {
    const fresh = await sentEmail(5_000);
    await pixel(`/t/o/${newOpenToken()}.gif`);
    await pixel("/t/o/not-a-token.gif");
    await pixel(`/t/o/${fresh.token}.png`);
    expect(await row(fresh.id)).toMatchObject({ open_count: 0, first_opened_at: null });
    await pixel(`/t/o/${fresh.token}.gif`);
    expect(await row(fresh.id)).toMatchObject({ open_count: 1, first_opened_at: expect.any(Date), first_counted_open_at: null });
    expect(await runEvents()).toBe(0);
  });

  it("the first counted open adds ONE timeline event, sets the message fact once and marks the lead's score; later opens only count", async () => {
    const old = await sentEmail(10 * 60_000, { subject: "Buyers in Nashik" });
    await pool.query(
      `insert into public.message_facts (workspace_id, lead_id, source, channel, email_outbound_id, message_number, sent_at) values ($1, $2, 'workflow', 'email', $3, 1, now() - interval '10 minutes')`,
      [ws, leadId, old.id],
    );
    await pixel(`/t/o/${old.token}.gif`);
    await pixel(`/t/o/${old.token}.gif`);
    const opened = await row(old.id);
    expect(opened).toMatchObject({ open_count: 2, first_counted_open_at: expect.any(Date), open_event_at: null });
    expect(await runEvents()).toBe(1);
    expect(await runEvents()).toBe(0);
    const events = await openEvents();
    expect(events).toEqual([{ title: "Email opened: Buyers in Nashik", metadata: { emailOutboundId: old.id, opened: true } }]);
    const fact = (await pool.query(`select first_counted_open_at from public.message_facts where email_outbound_id = $1`, [old.id])).rows[0];
    expect(fact.first_counted_open_at).toEqual(opened.first_counted_open_at);
    expect((await pool.query(`select hot_score_dirty from public.leads where id = $1`, [leadId])).rows[0].hot_score_dirty).toBe(true);

    // A third open: counted in open_count, no new event, first counted open unchanged.
    await pixel(`/t/o/${old.token}.gif`);
    expect(await runEvents()).toBe(0);
    expect(await openEvents()).toHaveLength(1);
    expect(await row(old.id)).toMatchObject({ open_count: 3, first_counted_open_at: opened.first_counted_open_at });
    // An open never wakes the agent or creates a task.
    expect((await pool.query(`select count(*)::int as n from public.agent_wakeups where lead_id = $1`, [leadId])).rows[0].n).toBe(0);
    expect((await pool.query(`select count(*)::int as n from public.tasks where lead_id = $1`, [leadId])).rows[0].n).toBe(0);
  });

  it("untracked sources are never recorded; no IP address or user agent is stored anywhere", async () => {
    const proposal = await sentEmail(10 * 60_000, { source: "proposal" });
    await pixel(`/t/o/${proposal.token}.gif`);
    expect(await row(proposal.id)).toMatchObject({ open_count: 0 });
    const columns = (
      await pool.query(
        `select column_name from information_schema.columns
          where table_schema = 'public' and table_name in ('email_outbound_messages', 'message_facts')
            and (column_name ~ '(^|_)ip(_|$)' or column_name like '%user_agent%' or column_name like '%useragent%')`,
      )
    ).rows;
    expect(columns).toEqual([]);
  });
});
