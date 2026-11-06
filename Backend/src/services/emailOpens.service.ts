/**
 * E3b-2b rules 11–13: email opens, a soft signal only. The public pixel route records an open with
 * one small UPDATE; the worker turns the FIRST counted open of an email into one timeline event,
 * its message fact's open time and a hot-score recompute mark. An open never sends, never counts as
 * a reply, never wakes the agent and never reaches the writer prompt. No IP or user agent is stored.
 */
import { pool, withTransaction } from "../db.js";
import type { Queryable } from "../dto.js";
import { AGENT_ACTOR_NAME } from "../agent/constants.js";
import { PREFETCH_WINDOW_MS } from "../domain/emailTracking.js";
import { addTimelineEvent } from "./timeline.service.js";

/** Rule 12: every open raises open_count; only one more than 60 s after sending can be the first counted open. */
export async function recordEmailOpen(db: Queryable, token: string): Promise<void> {
  await db.query(
    `update public.email_outbound_messages
        set open_count = open_count + 1, first_opened_at = coalesce(first_opened_at, now()), last_opened_at = now(),
            first_counted_open_at = coalesce(first_counted_open_at, case when now() >= sent_at + $2 * interval '1 millisecond' then now() end)
      where open_token = $1 and status = 'sent' and source in ('agent', 'scheduled_action')`,
    [token, PREFETCH_WINDOW_MS],
  );
}

/** Worker tick: up to `limit` first counted opens not yet recorded, one short transaction each. */
export async function runOpenEvents(options: { limit?: number; workspaceIds?: string[] } = {}): Promise<number> {
  const due = await pool.query<{ id: string }>(
    `select id from public.email_outbound_messages
      where first_counted_open_at is not null and open_event_at is null and ($2::uuid[] is null or workspace_id = any($2::uuid[]))
      order by first_counted_open_at limit $1`,
    [options.limit ?? 50, options.workspaceIds ?? null],
  );
  let recorded = 0;
  for (const { id } of due.rows) {
    await withTransaction(async (db) => {
      const row = (
        await db.query<{ lead_id: string | null; source: string; subject: string; first_counted_open_at: Date }>(
          `update public.email_outbound_messages set open_event_at = now()
            where id = $1 and open_event_at is null
            returning lead_id, source, subject, first_counted_open_at`,
          [id],
        )
      ).rows[0];
      if (!row?.lead_id) return;
      await addTimelineEvent(db, {
        leadId: row.lead_id,
        occurredAt: row.first_counted_open_at,
        kind: "automation",
        title: `Email opened: ${row.subject}`.slice(0, 300),
        detail: "Soft signal: some mail apps load images without the email being read.",
        actorId: null,
        actorName: row.source === "agent" ? AGENT_ACTOR_NAME : "Automation",
        actorSource: "automation",
        metadata: { emailOutboundId: id, opened: true },
      });
      // The open belongs to this email's own message fact (set once).
      await db.query(`update public.message_facts set first_counted_open_at = $2 where email_outbound_id = $1 and first_counted_open_at is null`, [
        id,
        row.first_counted_open_at,
      ]);
      await db.query(`update public.leads set hot_score_dirty = true where id = $1`, [row.lead_id]);
      recorded++;
    });
  }
  return recorded;
}
