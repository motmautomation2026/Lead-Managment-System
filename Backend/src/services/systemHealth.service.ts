/**
 * P7 system health (super-admin only; nothing here sends anything):
 * - the worker writes one heartbeat row per loop (`worker_heartbeats`, updated, never inserted twice);
 * - `GET /health/worker` (public, no data): 200 `ok` while every critical loop finished within its
 *   expected interval × 3, else 503 `stale` with the stale loop names;
 * - Settings → System health: loop ages and per-workspace queues, pauses, failures, AI budget and cap;
 * - one admin notification per workspace per IST day per red problem (stuck queue, paused channel,
 *   AI budget ≥ 90 %), deduplicated in `system_health_alerts`.
 */
import { pool } from "../db.js";
import type { Queryable } from "../dto.js";
import { DAY_DECISIONS_SQL, MONTH_SPEND_SQL } from "./agentRunner.service.js";
import { WORKSPACE_ADMIN_IDS_SQL } from "./profiles.service.js";

/** Every step of the worker tick. `critical` ones decide /health/worker. */
export const WORKER_LOOPS = {
  workflow_actions: { critical: true },
  email_outbound: { critical: true },
  email_inbound: { critical: true },
  proposal_whatsapp: { critical: true },
  meeting_whatsapp: { critical: true },
  knowledge_ingestion: { critical: false },
  company_sweep: { critical: false },
  deal_sweep: { critical: false },
  hot_score_sweep: { critical: false },
  reply_classification: { critical: true },
  open_events: { critical: false },
  reply_drafts: { critical: true },
  reply_draft_sends: { critical: true },
  reply_escalation: { critical: true },
  meeting_outcome_tasks: { critical: false },
  agent_sends: { critical: true },
  agent_tick: { critical: true },
  health_alerts: { critical: false },
  next_action_sweep: { critical: false },
  task_reminders: { critical: true },
  meeting_reminders: { critical: true },
  meeting_reminder_whatsapp: { critical: true },
  whatsapp_managers: { critical: true },
} as const;
export type WorkerLoop = keyof typeof WORKER_LOOPS;
export const CRITICAL_LOOPS = (Object.keys(WORKER_LOOPS) as WorkerLoop[]).filter((loop) => WORKER_LOOPS[loop].critical);

export interface Heartbeat {
  loop: WorkerLoop;
  startedAt: Date;
  finishedAt: Date;
  /** An error code or class name only (never a message: it can quote names or addresses). */
  error: string | null;
  items: number;
}

/** One upsert per tick for every loop that ran. `expectedSeconds`: how often a loop should finish. */
export async function recordHeartbeats(beats: Heartbeat[], expectedSeconds: number, db: Queryable = pool): Promise<void> {
  if (!beats.length) return;
  await db.query(
    `insert into public.worker_heartbeats as h (loop, last_started_at, last_finished_at, last_error, last_error_at, items_processed, expected_seconds, updated_at)
     select b.loop, b.started_at, b.finished_at, b.error, case when b.error is not null then b.finished_at end, b.items, $2, now()
       from jsonb_to_recordset($1::jsonb) as b(loop text, started_at timestamptz, finished_at timestamptz, error text, items int)
     on conflict (loop) do update set
       last_started_at = excluded.last_started_at, last_finished_at = excluded.last_finished_at,
       -- last_error is the latest run's (null after a success); last_error_at keeps when the loop last failed.
       last_error = excluded.last_error, last_error_at = coalesce(excluded.last_error_at, h.last_error_at),
       items_processed = excluded.items_processed, expected_seconds = excluded.expected_seconds, updated_at = now()`,
    [JSON.stringify(beats.map((b) => ({ loop: b.loop, started_at: b.startedAt, finished_at: b.finishedAt, error: b.error, items: b.items }))), expectedSeconds],
  );
}

export interface HeartbeatRow {
  loop: string;
  last_started_at: Date;
  last_finished_at: Date | null;
  last_error: string | null;
  last_error_at: Date | null;
  items_processed: number;
  expected_seconds: number;
}

/** Pure: a critical loop is stale when it has no row or hasn't finished within expected × 3. */
export function healthVerdict(rows: Pick<HeartbeatRow, "loop" | "last_finished_at" | "expected_seconds">[], now: Date) {
  const byLoop = new Map(rows.map((r) => [r.loop, r]));
  const stale = CRITICAL_LOOPS.filter((loop) => {
    const row = byLoop.get(loop);
    return !row?.last_finished_at || now.getTime() - row.last_finished_at.getTime() > row.expected_seconds * 3 * 1000;
  });
  return { status: stale.length ? ("stale" as const) : ("ok" as const), stale };
}

export async function loadHeartbeats(db: Queryable = pool): Promise<HeartbeatRow[]> {
  return (
    await db.query<HeartbeatRow>(
      `select loop, last_started_at, last_finished_at, last_error, last_error_at, items_processed, expected_seconds from public.worker_heartbeats order by loop`,
    )
  ).rows;
}

export async function workerHealth(db: Queryable = pool, now = new Date()) {
  return healthVerdict(await loadHeartbeats(db), now);
}

// ---------------------------------------------------------------------------
// Per-workspace health

/** Queued sends: a row created > 15 min ago that is due for > 15 min is stuck; one whose next attempt is later is waiting (send window, spacing, warm-up, pause, backoff). */
const WHATSAPP_QUEUE_SQL = `
  select workspace_id, created_at, scheduled_for as next_at from public.scheduled_actions
   where action_type = 'send_whatsapp' and status in ('pending', 'due', 'executing')
  union all
  select workspace_id, created_at, send_next_at from public.agent_decisions where action = 'send_whatsapp' and send_status in ('queued', 'sending')
  union all
  select workspace_id, created_at, send_next_at from public.reply_drafts where channel = 'whatsapp' and send_status in ('queued', 'sending')
  union all
  select workspace_id, created_at, coalesce(whatsapp_next_attempt_at, created_at) from public.proposals where whatsapp_send_status in ('queued', 'sending')
  union all
  select workspace_id, created_at, coalesce(notify_whatsapp_next_attempt_at, created_at) from public.meetings where notify_whatsapp_status in ('queued', 'sending')`;

export interface WorkspaceHealth {
  workspaceId: string;
  name: string;
  emailStuck: number;
  emailWaiting: number;
  whatsappStuck: number;
  whatsappWaiting: number;
  overdueWakeups: number;
  pausedNumbers: number;
  emailPaused: boolean;
  failedSends24h: number;
  budgetUsedPct: number;
  decisionsToday: number;
  decisionCap: number;
  decisionCapUsedPct: number;
  red: RedProblem[];
}

export type RedProblem = "stuck_queue" | "paused_channel" | "ai_budget";
export const RED_PROBLEM_TEXT: Record<RedProblem, string> = {
  stuck_queue: "Messages are stuck in the send queue (due for more than 15 minutes).",
  paused_channel: "A WhatsApp number or email sending is paused.",
  ai_budget: "The AI has used 90 % or more of this month's budget.",
};

/** Pure: what makes a workspace red. */
export function redProblems(h: Omit<WorkspaceHealth, "red" | "workspaceId" | "name">): RedProblem[] {
  const out: RedProblem[] = [];
  if (h.emailStuck + h.whatsappStuck > 0) out.push("stuck_queue");
  if (h.pausedNumbers > 0 || h.emailPaused) out.push("paused_channel");
  if (h.budgetUsedPct >= 90) out.push("ai_budget");
  return out;
}

export async function workspaceHealth(db: Queryable = pool, workspaceIds: string[] | null = null): Promise<WorkspaceHealth[]> {
  // The shared spend / cap SQL reads workspace $1; here it is each row's workspace.
  const spend = MONTH_SPEND_SQL.replaceAll("$1", "w.id");
  const today = DAY_DECISIONS_SQL.replaceAll("$1", "w.id");
  const rows = (
    await db.query<{
      id: string;
      name: string;
      email_stuck: number;
      email_waiting: number;
      wa_stuck: number;
      wa_waiting: number;
      overdue_wakeups: number;
      paused_numbers: number;
      email_paused: boolean;
      failed_24h: number;
      spend: string;
      budget: string | null;
      decisions_today: number;
      decision_cap: number | null;
    }>(
      `with wa as (${WHATSAPP_QUEUE_SQL})
       select w.id, w.name,
              (select count(*) from public.email_outbound_messages e where e.workspace_id = w.id and e.status in ('queued', 'sending')
                 and e.created_at < now() - interval '15 minutes' and e.next_attempt_at <= now() - interval '15 minutes')::int as email_stuck,
              (select count(*) from public.email_outbound_messages e where e.workspace_id = w.id and e.status in ('queued', 'sending')
                 and e.created_at < now() - interval '15 minutes' and e.next_attempt_at > now() - interval '15 minutes')::int as email_waiting,
              (select count(*) from wa where wa.workspace_id = w.id and wa.created_at < now() - interval '15 minutes' and wa.next_at <= now() - interval '15 minutes')::int as wa_stuck,
              (select count(*) from wa where wa.workspace_id = w.id and wa.created_at < now() - interval '15 minutes' and wa.next_at > now() - interval '15 minutes')::int as wa_waiting,
              (select count(*) from public.agent_wakeups k where k.workspace_id = w.id and k.status = 'pending' and k.due_at < now() - interval '15 minutes'
                 and s.mode in ('shadow', 'live'))::int as overdue_wakeups,
              (select count(*) from public.whatsapp_numbers n where n.workspace_id = w.id and n.removed_at is null and not n.enabled)::int as paused_numbers,
              exists (select 1 from public.integration_connections c where c.workspace_id = w.id and c.id = 'email' and c.provider = 'smtp'
                        and not c.enabled and c.paused_reason is not null) as email_paused,
              ((select count(*) from public.email_outbound_messages e where e.workspace_id = w.id and e.status = 'failed' and e.updated_at > now() - interval '24 hours')
               + (select count(*) from public.whatsapp_outbound_messages o where o.workspace_id = w.id and o.status = 'failed' and o.updated_at > now() - interval '24 hours'))::int as failed_24h,
              ${spend} as spend, s.monthly_budget_usd as budget, ${today} as decisions_today, s.max_decisions_per_day as decision_cap
         from public.workspaces w
         left join public.agent_settings s on s.workspace_id = w.id
        where w.is_active and ($1::uuid[] is null or w.id = any($1::uuid[]))
        order by w.name`,
      [workspaceIds],
    )
  ).rows;
  return rows.map((r) => {
    const budget = Number(r.budget ?? 0);
    const metrics = {
      emailStuck: r.email_stuck,
      emailWaiting: r.email_waiting,
      whatsappStuck: r.wa_stuck,
      whatsappWaiting: r.wa_waiting,
      overdueWakeups: r.overdue_wakeups,
      pausedNumbers: r.paused_numbers,
      emailPaused: r.email_paused,
      failedSends24h: r.failed_24h,
      budgetUsedPct: budget > 0 ? Math.round((Number(r.spend) / budget) * 1000) / 10 : 0,
      decisionsToday: r.decisions_today,
      decisionCap: r.decision_cap ?? 0,
      decisionCapUsedPct: r.decision_cap ? Math.round((r.decisions_today / r.decision_cap) * 1000) / 10 : 0,
    };
    return { workspaceId: r.id, name: r.name, ...metrics, red: redProblems(metrics) };
  });
}

/** Settings → System health (super-admins). */
export async function getSystemHealth(db: Queryable = pool, now = new Date()) {
  const loops = await loadHeartbeats(db);
  const verdict = healthVerdict(loops, now);
  return {
    status: verdict.status,
    stale: verdict.stale,
    loops: loops.map((l) => ({
      loop: l.loop,
      critical: (WORKER_LOOPS as Record<string, { critical: boolean }>)[l.loop]?.critical ?? false,
      lastStartedAt: l.last_started_at.toISOString(),
      lastFinishedAt: l.last_finished_at?.toISOString() ?? null,
      ageSeconds: l.last_finished_at ? Math.max(0, Math.round((now.getTime() - l.last_finished_at.getTime()) / 1000)) : null,
      expectedSeconds: l.expected_seconds,
      lastError: l.last_error,
      lastErrorAt: l.last_error_at?.toISOString() ?? null,
      itemsProcessed: l.items_processed,
    })),
    workspaces: await workspaceHealth(db),
  };
}

/**
 * Worker (throttled by the caller): for every workspace with a red problem, records it once per IST day
 * (`system_health_alerts`) and sends that workspace's admins ONE notification naming the new problems.
 * Returns the workspaces notified.
 */
export async function runHealthAlerts(opts: { now?: Date; workspaceIds?: string[] } = {}): Promise<string[]> {
  const now = opts.now ?? new Date();
  const notified: string[] = [];
  for (const ws of await workspaceHealth(pool, opts.workspaceIds ?? null)) {
    if (!ws.red.length) continue;
    const client = await pool.connect();
    try {
      await client.query("begin");
      const fresh = (
        await client.query<{ problem: RedProblem }>(
          `insert into public.system_health_alerts (workspace_id, problem, alerted_on)
           select $1, p, ($3::timestamptz at time zone 'Asia/Kolkata')::date from unnest($2::text[]) p
           on conflict do nothing returning problem`,
          [ws.workspaceId, ws.red, now],
        )
      ).rows.map((r) => r.problem);
      if (fresh.length) {
        await client.query(
          `insert into public.notifications (workspace_id, recipient_id, title, detail, kind, href)
           select $1, a.user_id, $2, $3, 'danger', '/settings' from (${WORKSPACE_ADMIN_IDS_SQL}) a`,
          [ws.workspaceId, `${ws.name}: needs attention`, fresh.map((p) => RED_PROBLEM_TEXT[p]).join(" ")],
        );
        notified.push(ws.workspaceId);
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  return notified;
}
