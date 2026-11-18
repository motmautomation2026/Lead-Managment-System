/**
 * LL-3 rule 3: the "We tried calling" WhatsApp after a No answer. Every SQL query of the feature lives here.
 * - The call request only queues a row (`tried_calling_messages`, one per lead per IST day = the once-per-day marker);
 *   the worker sends it on the lead's sticky number (or picks one, which then sticks) through `sendWhatsApp` → the
 *   automated WhatsApp safety rules (send window, spacing, caps, warm-up, pause, opt-out, DNC).
 * - Fixed text (domain/recovery.ts `triedCallingText`), never AI. Exempt from the AI's 48 h gap and total limit, but it counts
 *   toward the 7-day limit shared with the AI (agentSendState / agentContext add these sends). Own cap: 3 per lead, ever (LL-3b).
 * - Dropped when the lead was reached meanwhile (connected call, matched reply, meeting booked) or the setting is off.
 */
import { pool } from "../db.js";
import type { Queryable } from "../dto.js";
import { istDate } from "../domain/workingTime.js";
import { triedCallingCheck } from "../domain/callAttempts.js";
import { triedCallingText } from "../domain/recovery.js";
import { fairPickSql } from "./fairPick.js";
import { sendWhatsApp } from "../providers/whatsapp.provider.js";
import { ProviderDeferredError } from "../providers/provider-errors.js";
import { addTimelineEvent, SYSTEM_ACTOR } from "./timeline.service.js";
import { AUTOMATED_SQL } from "./leadAutomation.service.js";

/** $1 workspace, $2 lead, $3 call, $4 IST day, $5 rep name. Only for a live, automated (REL-1) lead with a usable WhatsApp and the setting on. */
export const ENQUEUE_SQL = `insert into public.tried_calling_messages (workspace_id, lead_id, call_id, ist_day, rep_name)
  select l.workspace_id, l.id, $3, $4, $5
    from public.leads l
    left join public.agent_settings s on s.workspace_id = l.workspace_id
   where l.id = $2 and l.workspace_id = $1 and l.phone_e164 is not null and l.merged_into_lead_id is null
     and l.lifecycle_state in ('active', 'long_term_nurture') and coalesce(s.tried_calling_whatsapp_enabled, true)
     and ${AUTOMATED_SQL("l")}
     and not exists (select 1 from public.lead_contact_channels c
                      where c.lead_id = l.id and ((c.channel = 'whatsapp' and c.status in ('opted_out', 'invalid', 'do_not_contact'))
                                                  or (c.channel = 'phone' and c.status = 'do_not_contact')))
  on conflict (lead_id, ist_day) do nothing
  returning id`;

/** Queues today's message for the lead (inside the call's transaction). Returns its id, or null (not eligible / already queued today). */
export async function enqueueTriedCalling(db: Queryable, workspaceId: string, leadId: string, callId: string, repName: string | null, now = new Date()): Promise<string | null> {
  return (await db.query<{ id: string }>(ENQUEUE_SQL, [workspaceId, leadId, callId, istDate(now), repName])).rows[0]?.id ?? null;
}

/** SKIP LOCKED claim (15-minute reclaim), round-robin across workspaces. $1 limit. */
export const CLAIM_SQL = `update public.tried_calling_messages
    set status = 'sending', next_attempt_at = now() + interval '15 minutes'
  where id in (
    select id from public.tried_calling_messages
     where id in (${fairPickSql({
       from: "public.tried_calling_messages x",
       where: "x.status in ('queued', 'sending') and x.next_attempt_at <= now()",
       order: "x.next_attempt_at",
       limit: "$1",
     })})
       and status in ('queued', 'sending') and next_attempt_at <= now()
     for update skip locked)
  returning id, workspace_id, lead_id, created_at`;

/** $1 message id. Everything the send decision needs (7-day limit: real AI sends + earlier real tried-calling sends; own cap: tried-calling only). */
export const FACTS_SQL = `select t.id, t.workspace_id, t.lead_id, t.rep_name, t.created_at, coalesce(c.created_at, t.created_at) as called_at,
       l.first_name, l.phone_e164, l.lifecycle_state::text as lifecycle_state,
       coalesce(nullif(trim(s.company_display_name), ''), w.name) as workspace_name,
       coalesce(s.tried_calling_whatsapp_enabled, true) as enabled,
       ${AUTOMATED_SQL("l")} as automated,
       coalesce(s.max_touches_7d, 2) as max_touches_7d,
       (exists (select 1 from public.calls k where k.lead_id = l.id and k.connected and k.created_at > t.created_at)
        or exists (select 1 from public.whatsapp_inbound_events i where i.lead_id = l.id and i.received_at > t.created_at)
        or exists (select 1 from public.email_inbound_events e where e.lead_id = l.id and e.match_status = 'matched'
                    and e.kind in ('reply', 'unsubscribe') and e.received_at > t.created_at)
        or exists (select 1 from public.meetings m where m.lead_id = l.id and m.created_at > t.created_at)) as reached,
       -- HOTFIX-2: AI touches (a "both" first message is one).
       ((select count(distinct coalesce(d.paired_decision_id, d.id)) from public.agent_decisions d where d.lead_id = l.id and d.outcome = 'sent'
           and d.sent_at > now() - interval '7 days')
        + (select count(*) from public.tried_calling_messages x where x.lead_id = l.id and x.status = 'sent' and not x.dry_run
           and x.sent_at > now() - interval '7 days'))::int as touches_7d,
       (select count(*) from public.tried_calling_messages x where x.lead_id = l.id and x.status = 'sent' and not x.dry_run)::int as tried_calling_sent
  from public.tried_calling_messages t
  join public.leads l on l.id = t.lead_id and l.workspace_id = t.workspace_id
  join public.workspaces w on w.id = t.workspace_id
  left join public.agent_settings s on s.workspace_id = t.workspace_id
  left join public.calls c on c.id = t.call_id
 where t.id = $1`;

export interface TriedCallingFacts {
  id: string;
  workspace_id: string;
  lead_id: string;
  rep_name: string | null;
  created_at: Date;
  called_at: Date;
  first_name: string | null;
  phone_e164: string | null;
  lifecycle_state: string;
  workspace_name: string;
  enabled: boolean;
  automated: boolean;
  max_touches_7d: number;
  reached: boolean;
  touches_7d: number;
  tried_calling_sent: number;
}

export async function claimTriedCallingSends(db: Queryable, limit: number): Promise<{ id: string; workspace_id: string }[]> {
  return (await db.query<{ id: string; workspace_id: string }>(CLAIM_SQL, [limit])).rows;
}

/** Sends one claimed message. A deferral (window, spacing, caps, pause) waits without an attempt; the reached check runs each time. */
export async function processTriedCallingSend(id: string, deps: { send?: typeof sendWhatsApp; dryRun?: boolean; now?: () => Date } = {}): Promise<string> {
  const set = (status: string, error: string | null, extra = "", params: unknown[] = []) =>
    pool.query(`update public.tried_calling_messages set status = $2, error = $3${extra} where id = $1`, [id, status, error, ...params]);
  try {
    const f = (await pool.query<TriedCallingFacts>(FACTS_SQL, [id])).rows[0];
    if (!f) return "missing";
    const problem = triedCallingCheck({
      enabled: f.enabled,
      automated: f.automated,
      hasPhone: Boolean(f.phone_e164),
      lifecycle: f.lifecycle_state,
      reached: f.reached,
      touches7d: f.touches_7d,
      max7d: f.max_touches_7d,
      triedCallingSent: f.tried_calling_sent,
    });
    if (problem) {
      await set("cancelled", problem);
      return "cancelled";
    }
    const now = deps.now?.() ?? new Date();
    const body = triedCallingText({ firstName: f.first_name, repName: f.rep_name, workspaceName: f.workspace_name, calledAt: f.called_at, now });
    if (deps.dryRun) {
      console.log(`[worker] DRY RUN — would send the "we tried calling" WhatsApp ${id}.`);
      await set("sent", null, ", sent_at = now(), dry_run = true, body = $4", [body]);
      return "dry_run";
    }
    await (deps.send ?? sendWhatsApp)(f.workspace_id, { source: { type: "tried_calling", id }, to: f.phone_e164!, body });
    await set("sent", null, ", sent_at = now(), body = $4", [body]);
    await addTimelineEvent(pool, { leadId: f.lead_id, kind: "whatsapp", title: "WhatsApp sent: we tried calling", detail: "Fixed message after an unanswered call", ...SYSTEM_ACTOR });
    return "sent";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof ProviderDeferredError) {
      await pool.query(`update public.tried_calling_messages set status = 'queued', next_attempt_at = now() + ($2 || ' milliseconds')::interval, error = $3 where id = $1`, [
        id,
        String(err.retryAfterMs),
        message,
      ]);
      return "deferred";
    }
    // A permanent problem (not eligible any more, not on WhatsApp) or an unexpected error: no retry.
    await set("failed", message);
    return "failed";
  }
}

/** Worker step: claim and send (one at a time; the manager spaces them). */
export async function runTriedCallingSends(opts: { dryRun?: boolean; limit?: number } = {}): Promise<number> {
  const rows = await claimTriedCallingSends(pool, opts.limit ?? 10);
  for (const row of rows) await processTriedCallingSend(row.id, { dryRun: opts.dryRun });
  return rows.length;
}
