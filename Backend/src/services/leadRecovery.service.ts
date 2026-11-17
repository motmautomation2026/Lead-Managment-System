/**
 * LL-3 rule 6: Lost recovery. Every SQL query of the feature lives here; the dates and texts are pure
 * (domain/recovery.ts). markLost sets `leads.recover_at` by loss reason (a new loss resets it, reopening clears it);
 * on that date (09:30 IST) the worker moves the lead to long-term nurture and gives the responsible person a
 * "Re-engage: …" task + bell (+ LL-2 urgent email). Once per loss (`recovered_at`). Never for DNC (lifecycle or phone)
 * or leads opted out on both WhatsApp and email (marked done, no task). The AI is never restarted here.
 */
import { pool, withTransaction } from "../db.js";
import type { Queryable } from "../dto.js";
import type { LeadLossReason } from "../domain/enums.js";
import { recoveryTaskTitle } from "../domain/recovery.js";
import { fairPickSql } from "./fairPick.js";
import { createResponsibleTask } from "./nextAction.service.js";
import { moveToLongTermNurture } from "./leads.service.js";
import { addTimelineEvent, SYSTEM_ACTOR } from "./timeline.service.js";

/** P7: per tick, round-robin across workspaces. */
const TICK_LIMIT = 100;

/** $1 now, $2 workspace ids (null = all), $3 limit. */
export const RECOVERY_DUE_SQL = `select l.id, l.workspace_id from public.leads l where l.id in (${fairPickSql({
  from: "public.leads x",
  where: `x.lifecycle_state = 'lost' and x.recovered_at is null and x.recover_at is not null and x.recover_at <= $1::timestamptz
    and ($2::uuid[] is null or x.workspace_id = any($2::uuid[]))`,
  order: "x.recover_at",
  limit: "$3",
})})`;

/** $1 lead, $2 now: the locked re-check + what the task needs. lost_at = the latest "Lost" timeline row. */
export const RECOVERY_LEAD_SQL = `select l.id, l.workspace_id, l.first_name, l.last_name, l.loss_reason, l.loss_competitor_name,
       coalesce((select max(t.occurred_at) from public.timeline_events t where t.lead_id = l.id and t.title = 'Lost'), l.updated_at) as lost_at,
       exists (select 1 from public.lead_contact_channels c where c.lead_id = l.id and c.status = 'do_not_contact') as dnc_channel,
       (exists (select 1 from public.lead_contact_channels c where c.lead_id = l.id and c.channel = 'whatsapp' and c.status = 'opted_out')
        and exists (select 1 from public.lead_contact_channels c where c.lead_id = l.id and c.channel = 'email' and c.status = 'unsubscribed')) as opted_out_both
  from public.leads l
 where l.id = $1 and l.lifecycle_state = 'lost' and l.recovered_at is null and l.recover_at <= $2::timestamptz
 for update of l`;

interface RecoveryLeadRow {
  id: string;
  workspace_id: string;
  first_name: string | null;
  last_name: string | null;
  loss_reason: LeadLossReason;
  loss_competitor_name: string | null;
  lost_at: Date;
  dnc_channel: boolean;
  opted_out_both: boolean;
}

/** One lead in its own transaction. Returns the outcome (null = no longer due). */
export async function recoverLead(db: Queryable, leadId: string, now: Date): Promise<"recovered" | "skipped" | null> {
  const lead = (await db.query<RecoveryLeadRow>(RECOVERY_LEAD_SQL, [leadId, now])).rows[0];
  if (!lead) return null;
  await db.query(`update public.leads set recovered_at = $2 where id = $1`, [leadId, now]);
  if (lead.dnc_channel || lead.opted_out_both) {
    await addTimelineEvent(db, {
      leadId,
      kind: "system",
      title: "Lost recovery skipped",
      detail: lead.dnc_channel ? "Do Not Contact" : "Opted out on WhatsApp and email",
      ...SYSTEM_ACTOR,
    });
    return "skipped";
  }
  await moveToLongTermNurture(db, null, lead.workspace_id, leadId, "Lost recovery date reached");
  const name = [lead.first_name, lead.last_name].filter(Boolean).join(" ").trim() || "A contact";
  const title = recoveryTaskTitle(name, lead.lost_at, lead.loss_reason, lead.loss_competitor_name);
  await createResponsibleTask(db, lead.workspace_id, leadId, { type: "re_engage", title, dueAt: now, marker: "lost_recovery" }, { title, kind: "warning", email: true });
  return "recovered";
}

/** Worker step `lost_recovery`. */
export async function runLostRecovery(opts: { now?: Date; workspaceIds?: string[] } = {}): Promise<{ leadId: string; outcome: string }[]> {
  const now = opts.now ?? new Date();
  const due = (await pool.query<{ id: string }>(RECOVERY_DUE_SQL, [now, opts.workspaceIds ?? null, TICK_LIMIT])).rows;
  const done: { leadId: string; outcome: string }[] = [];
  for (const row of due) {
    const outcome = await withTransaction((db) => recoverLead(db, row.id, now));
    if (outcome) done.push({ leadId: row.id, outcome });
  }
  return done;
}
