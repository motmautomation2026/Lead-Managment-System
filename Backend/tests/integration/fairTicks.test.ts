/**
 * P7 rule 4: worker claims are fair across workspaces — a workspace with a big backlog can't starve a
 * quiet one. Staging only (`[test]` workspaces); nothing is sent. Skipped unless TEST_DATABASE_URL is set.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createTestWorkspace, deleteCreatedTestWorkspaces } from "../helpers/testWorkspaces.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb("P7 fair worker ticks (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await deleteCreatedTestWorkspaces(pool);
    await pool.end();
  });

  async function lead(ws: string) {
    return (
      await pool.query<{ id: string }>(
        `insert into public.leads (workspace_id, first_name, company, source, email) values ($1, 'Fair', 'Fair Ltd', 'referral', $2) returning id`,
        [ws, `fair-${randomUUID()}@example.com`],
      )
    ).rows[0]!.id;
  }

  /** A sent email with a counted open not yet turned into a timeline event, opened `minutesAgo`. */
  async function openedEmail(ws: string, minutesAgo: number) {
    return (
      await pool.query<{ id: string }>(
        `insert into public.email_outbound_messages (workspace_id, source, source_id, lead_id, to_address, subject, html, text_body, status, sent_at, first_counted_open_at)
         values ($1, 'agent', gen_random_uuid(), $2, 'x@example.com', 'Fair', 'Fair', 'Fair', 'sent', now() - interval '1 day', now() - $3 * interval '1 minute')
         returning id`,
        [ws, await lead(ws), minutesAgo],
      )
    ).rows[0]!.id;
  }

  it("open events: a quiet workspace's open is recorded in the same tick as a busy workspace's backlog", async () => {
    const busy = await createTestWorkspace(pool, "fair-busy");
    const quiet = await createTestWorkspace(pool, "fair-quiet");
    // The busy workspace's opens are all older: oldest-first alone would take two of them.
    const busyIds = [await openedEmail(busy, 50), await openedEmail(busy, 40), await openedEmail(busy, 30)];
    const quietId = await openedEmail(quiet, 5);

    const { runOpenEvents } = await import("../../src/services/emailOpens.service.js");
    expect(await runOpenEvents({ limit: 2, workspaceIds: [busy, quiet] })).toBe(2);
    const recorded = (
      await pool.query<{ id: string }>(`select id from public.email_outbound_messages where workspace_id = any($1::uuid[]) and open_event_at is not null`, [[busy, quiet]])
    ).rows.map((r) => r.id);
    expect(recorded.sort()).toEqual([busyIds[0]!, quietId].sort());
  });

  it("email outbound: with more busy workspaces than the limit, the one waiting longest goes first", async () => {
    const a = await createTestWorkspace(pool, "fair-email-a");
    const b = await createTestWorkspace(pool, "fair-email-b");
    const queue = (ws: string, minutesDue: number) =>
      pool.query(
        `insert into public.email_outbound_messages (workspace_id, source, source_id, to_address, subject, html, text_body, status, next_attempt_at)
         values ($1, 'test', gen_random_uuid(), 'x@example.com', 'Fair', 'Fair', 'Fair', 'queued', now() - $2 * interval '1 minute')`,
        [ws, minutesDue],
      );
    await queue(a, 1);
    await queue(a, 2);
    await queue(b, 9);

    const { claimDueEmails } = await import("../../src/services/emailOutbound.service.js");
    const client = await pool.connect();
    try {
      await client.query("begin");
      const claimed = await claimDueEmails(client, 1, [a, b]);
      expect(claimed.map((r) => r.workspace_id)).toEqual([b]);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});
