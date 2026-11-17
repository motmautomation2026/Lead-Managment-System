import type { Queryable } from "../dto.js";

/** agent_wakeups.reason values (migration 024). */
export type WakeupReason =
  | "lead_created"
  | "call_logged"
  | "note_added"
  | "meeting_booked"
  | "meeting_rescheduled"
  | "meeting_cancelled"
  | "meeting_outcome"
  | "proposal_status"
  | "timer"
  | "enrolled"
  | "manual_wake"
  | "resumed";

/**
 * LL-3 rule 5: 09:30 IST on the lead's interested-later restart date (alias `l` = leads), null when none. No AI
 * wake-up is due before it (enqueueWakeups) and no queued AI send goes out before it (agentSendRecheck).
 */
export const RESTART_AT_SQL = `(case when l.interested_later_restart_at is not null
    then (l.interested_later_restart_at + time '09:30') at time zone 'Asia/Kolkata' end)`;

export type EnqueueOutcome = "inserted" | "merged" | "skipped";

const MAX_EVENTS = 20;

export interface EnqueueWakeupInput {
  workspaceId: string;
  leadId: string;
  reason: WakeupReason;
  dueAt: Date;
  payload?: Record<string, unknown>;
}

/**
 * Queues "look at this lead again". At most one pending wakeup per lead
 * (migration 025): a second enqueue merges into it — the earlier due_at wins,
 * an event reason replaces 'timer', and the event is appended to
 * payload.events (last 20 kept). A no-op ('skipped') when the workspace's
 * agent mode is off or the lead isn't agent_status 'active'. LL-3: never due before the
 * lead's interested-later restart date (RESTART_AT_SQL).
 */
export async function enqueueWakeup(db: Queryable, input: EnqueueWakeupInput): Promise<EnqueueOutcome> {
  return (await enqueueWakeups(db, input.workspaceId, [{ leadId: input.leadId, dueAt: input.dueAt }], input.reason, input.payload))[0]!;
}

/** enqueueWakeup for many leads in one statement (same reason and payload); outcomes in input order. */
export async function enqueueWakeups(
  db: Queryable,
  workspaceId: string,
  items: { leadId: string; dueAt: Date }[],
  reason: WakeupReason,
  payload: Record<string, unknown> = {},
): Promise<EnqueueOutcome[]> {
  if (items.length === 0) return [];
  const result = await db.query<{ lead_id: string; inserted: boolean }>(
    `with input as (
       -- ON CONFLICT can't touch the same row twice in one statement.
       select distinct on (lead_id) * from unnest($2::uuid[], $3::timestamptz[]) as t(lead_id, due_at) order by lead_id, due_at
     )
     insert into public.agent_wakeups as w (workspace_id, lead_id, due_at, reason, payload)
     select $1, i.lead_id, greatest(i.due_at, ${RESTART_AT_SQL}), $4,
            jsonb_build_object('events', jsonb_build_array($5::jsonb || jsonb_build_object('reason', $4::text, 'at', now())))
       from input i
       join public.leads l on l.id = i.lead_id and l.workspace_id = $1 and l.agent_status = 'active'
       join public.agent_settings s on s.workspace_id = $1 and s.mode <> 'off'
     on conflict (lead_id) where status = 'pending' do update
       set due_at = greatest(least(w.due_at, excluded.due_at), (select ${RESTART_AT_SQL} from public.leads l where l.id = w.lead_id)),
           reason = case when w.reason = 'timer' then excluded.reason else w.reason end,
           payload = coalesce(w.payload, '{}'::jsonb) || jsonb_build_object('events', (
             select coalesce(jsonb_agg(e order by n), '[]'::jsonb)
               from (
                 select e, n
                   from jsonb_array_elements(coalesce(w.payload -> 'events', '[]'::jsonb) || (excluded.payload -> 'events'))
                        with ordinality as t(e, n)
                  order by n desc
                  limit ${MAX_EVENTS}
               ) kept
           ))
     returning lead_id, (xmax = 0) as inserted`,
    [workspaceId, items.map((i) => i.leadId), items.map((i) => i.dueAt), reason, JSON.stringify(payload)],
  );
  const byLead = new Map(result.rows.map((r) => [r.lead_id, r.inserted ? ("inserted" as const) : ("merged" as const)]));
  return items.map((i) => byLead.get(i.leadId) ?? "skipped");
}

/** Cancels the lead's pending wakeup (if any), recording why in payload.cancel_reason. Returns how many were cancelled. */
export async function cancelPendingWakeups(db: Queryable, leadId: string, why: string): Promise<number> {
  const result = await db.query(
    `update public.agent_wakeups
        set status = 'cancelled', processed_at = now(),
            payload = coalesce(payload, '{}'::jsonb) || jsonb_build_object('cancel_reason', $2::text)
      where lead_id = $1 and status = 'pending'`,
    [leadId, why],
  );
  return result.rowCount ?? 0;
}
