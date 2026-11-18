# 08 — First-day watch (every hour on day 1, ~5 minutes each)

Run the query below in the Supabase SQL editor once an hour (read-only) and check **Settings → System health**.
Write the numbers in a shared sheet (time + each column). The table at the end lists the numbers that mean **pull the
kill switch now** (07-A).

```sql
-- REL-1 hourly watch (read-only). "1h" = the last 60 minutes.
with automated as (
  select l.id from public.leads l
   where coalesce(l.automation_enabled, l.created_at >= (select a.automation_since from public.agent_settings a where a.workspace_id = l.workspace_id))
)
select
  -- sends
  (select count(*) from public.whatsapp_outbound_messages where status = 'sent' and sent_at > now() - interval '1 hour') as wa_sent_1h,
  (select count(*) from public.whatsapp_outbound_messages where status = 'failed' and updated_at > now() - interval '1 hour') as wa_failed_1h,
  (select count(*) from public.email_outbound_messages where status = 'sent' and not dry_run and sent_at > now() - interval '1 hour') as email_sent_1h,
  (select count(*) from public.email_outbound_messages where status = 'failed' and updated_at > now() - interval '1 hour') as email_failed_1h,
  -- replies that stop us
  (select count(*) from public.whatsapp_inbound_events where reply_label = 'asked_to_stop' and received_at > now() - interval '1 hour') as wa_stop_1h,
  (select count(*) from public.email_inbound_events where kind = 'unsubscribe' and received_at > now() - interval '1 hour') as email_unsub_1h,
  -- AI
  (select count(*) from public.agent_decisions where created_at > now() - interval '1 hour') as ai_decisions_1h,
  (select count(*) from public.agent_decisions where action = 'handoff' and created_at > now() - interval '1 hour') as ai_handoffs_1h,
  (select count(*) from public.agent_decisions where send_status = 'sent' and sent_at > now() - interval '1 hour') as ai_sent_1h,
  (select round(coalesce(sum(cost_usd), 0)::numeric, 2) from public.agent_decisions where created_at >= date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata') as ai_cost_today_usd,
  -- automatic work: must ONLY touch automated leads
  (select count(*) from public.tasks t where t.created_at > now() - interval '1 hour' and t.origin <> 'manual' and t.lead_id in (select id from automated)) as auto_tasks_automated_1h,
  (select count(*) from public.tasks t where t.created_at > now() - interval '1 hour' and t.origin <> 'manual' and t.lead_id not in (select id from automated)) as auto_tasks_OLD_1h,
  (select count(*) from public.notifications n where n.created_at > now() - interval '1 hour' and n.lead_id in (select id from automated)) as bells_automated_1h,
  (select count(*) from public.notifications n where n.created_at > now() - interval '1 hour' and n.lead_id is not null and n.lead_id not in (select id from automated)) as bells_old_leads_1h,
  (select count(*) from public.whatsapp_outbound_messages o join public.scheduled_actions s on s.id = o.scheduled_action_id
    where o.status = 'sent' and o.sent_at > now() - interval '1 hour' and s.lead_id not in (select id from automated)) as workflow_wa_to_OLD_1h,
  (select count(*) from public.email_outbound_messages e where e.status = 'sent' and e.sent_at > now() - interval '1 hour'
      and e.source in ('scheduled_action', 'agent') and e.lead_id not in (select id from automated)) as auto_email_to_OLD_1h,
  -- worker
  (select max(last_finished_at) from public.worker_heartbeats) as worker_last_tick,
  (select string_agg(loop || ': ' || last_error, ', ') from public.worker_heartbeats where last_error_at > now() - interval '1 hour') as worker_errors_1h;
```

Also every hour: `https://<api>/health/worker` → `{"status":"ok"}`; Settings → WhatsApp: every number *Connected*,
none paused; Settings → System health: no red row.

Notes for reading it:
- `bells_old_leads_1h` may be above 0 for normal reasons: a rep's own task on an old lead ("Due now"), a WhatsApp or
  email **reply** from an old lead (the owner always gets the reply task + bell), and the batched "lead needs a next
  step" bell. `auto_tasks_OLD_1h` (tasks the system made, not a person) **must stay 0** for leads nobody switched on.
- `ai_decisions_1h` stays low: the daily cap is **10 decisions per workspace**.

## Pull the kill switch (07-A) when any of these is true

| Signal | Threshold | Why |
|---|---|---|
| `auto_tasks_OLD_1h`, `workflow_wa_to_OLD_1h`, `auto_email_to_OLD_1h` | **> 0** | Something automatic reached an old lead: the cutoff isn't holding. Kill switch, then send me the lead id. |
| `wa_stop_1h` | **≥ 2** in an hour (or ≥ 3 in a day) | People are asking us to stop. WhatsApp auto-pauses at 3 / 24 h anyway; don't wait for it. |
| `wa_failed_1h` | **≥ 5** | Number trouble (ban risk). WhatsApp auto-pauses at 5 failures / 30 min. |
| `email_failed_1h` or bounces | **≥ 5**, or any auto-pause banner in Settings → Email | Mailbox or reputation problem. |
| An AI message reads wrong | **any** made-up fact, wrong name, promise, price or a "!" | Mode → Off, then rate it in AI review as *bad* with the reason. |
| `ai_cost_today_usd` | above the day's budget agreed with management (suggest **$5** on day 1 with 10 decisions/day) | Runaway cost. |
| `worker_last_tick` | **older than 3 minutes**, or `/health/worker` returns 503 | The worker is stuck; nothing automatic runs. Restart the worker (ONE instance). |
| Two workers | heartbeats jumping, WhatsApp *Disconnected / Restarting* repeatedly | Stop all workers, start exactly one. |
| `ai_handoffs_1h` | **≥ 5** | The AI can't write safe messages for these leads. Not dangerous, but check the playbook / knowledge before continuing. |
