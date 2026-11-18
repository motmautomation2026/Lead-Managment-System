-- =============================================================================
-- Northbeam CRM -- AI agent daily decision cap (cost safety)
-- =============================================================================
--
-- agent_settings.max_decisions_per_day: the runner makes no model call for a
-- workspace once it has this many agent_decisions rows today (IST calendar day);
-- its wakeups wait until the next IST midnight + 5 min (no attempt burned).
--
-- agent_settings.daily_cap_alerted_on: the IST date on which admins were last
-- told "AI agent paused for today: daily decision limit reached", so the runner
-- notifies them at most once per day (it sets this atomically).
--
-- Additive and idempotent.
-- =============================================================================

alter table public.agent_settings
  add column if not exists max_decisions_per_day integer not null default 50,
  add column if not exists daily_cap_alerted_on date;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'agent_settings_max_decisions_per_day_check') then
    alter table public.agent_settings
      add constraint agent_settings_max_decisions_per_day_check check (max_decisions_per_day between 1 and 10000);
  end if;
end $$;

comment on column public.agent_settings.max_decisions_per_day is
  'Most agent_decisions per IST day; at the cap the runner defers wakeups to the next IST day.';
comment on column public.agent_settings.daily_cap_alerted_on is
  'IST date on which admins were last notified that the daily decision cap was reached.';
