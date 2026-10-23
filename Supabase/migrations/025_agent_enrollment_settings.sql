-- =============================================================================
-- Northbeam CRM -- AI agent settings + enrollment (Feature 3B-1)
-- =============================================================================
--
-- agent_wakeups    at most one pending wakeup per lead (partial unique index);
--                  enqueueWakeup merges into it with ON CONFLICT. Existing
--                  duplicates are collapsed first: the earliest due_at stays
--                  pending, the rest become cancelled.
-- agent_settings   rep_quiet_hours (agent waits this long after a rep logs a
--                  call or note) and auto_enroll_new_leads (used in 3B-2).
--
-- Timeline: no change. timeline_events.event_kind is free text; agent status
-- events use kind 'automation'.
--
-- Additive and idempotent.
-- =============================================================================

with ranked as (
  select id, row_number() over (partition by lead_id order by due_at, created_at, id) as rn
    from public.agent_wakeups
   where status = 'pending'
)
update public.agent_wakeups w
   set status = 'cancelled', processed_at = now()
  from ranked r
 where r.id = w.id and r.rn > 1;

create unique index if not exists agent_wakeups_one_pending_per_lead
  on public.agent_wakeups (lead_id) where status = 'pending';

alter table public.agent_settings
  add column if not exists rep_quiet_hours int not null default 24
    check (rep_quiet_hours between 0 and 168),
  add column if not exists auto_enroll_new_leads boolean not null default false;
