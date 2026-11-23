-- =============================================================================
-- Northbeam CRM -- SUM-1: lead summary card
-- =============================================================================
--
-- lead_summaries          one row per lead: the worker's AI summary (staff only, never sent, never in a prompt)
--                         and its queue state.
--   activity_at           the lead's latest timeline event (set by the trigger below).
--   due_at                when the worker may (re)generate it; null = nothing queued. Every timeline event pushes
--                         it to now() + 2 min (the debounce); opening a stale lead in the UI / Refresh set now().
--   opened_at             set when someone opened the lead while its summary was missing or stale: lets the worker
--                         summarise a lead that is not automated (old leads only when opened). Cleared once done.
--   force                 a manual Refresh: skips the 10-minute limit and the input-hash check.
--   refresh_requested_at  the last Refresh (one per 5 minutes per lead).
--   checked_at            when the inputs were last read (generated, or the hash was unchanged).
--   status                ready | off (AI mode off) | paused_cap (summary_daily_cap) | paused_budget | failed.
-- lead_summary_runs       one row per model call: the daily cap count and the cost (part of the monthly AI spend).
-- agent_settings.summary_daily_cap  AI summaries per workspace per IST day (default 200), separate from the
--                         AI decision cap.
-- Every table keeps RLS on with no policies (SEC-1). Additive and re-runnable.
-- =============================================================================

alter table public.agent_settings add column if not exists summary_daily_cap integer not null default 200;
alter table public.agent_settings drop constraint if exists agent_settings_summary_daily_cap_check;
alter table public.agent_settings
  add constraint agent_settings_summary_daily_cap_check check (summary_daily_cap between 0 and 10000);

create table if not exists public.lead_summaries (
  lead_id uuid primary key references public.leads (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  activity_at timestamptz not null default now(),
  due_at timestamptz,
  opened_at timestamptz,
  force boolean not null default false,
  refresh_requested_at timestamptz,
  summary jsonb,
  input_hash text,
  model text,
  generated_at timestamptz,
  checked_at timestamptz,
  status text,
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lead_summaries_status_valid check (status is null or status in ('ready', 'off', 'paused_cap', 'paused_budget', 'failed'))
);

create index if not exists lead_summaries_due_idx on public.lead_summaries (due_at) where due_at is not null;
create index if not exists lead_summaries_workspace_idx on public.lead_summaries (workspace_id);
alter table public.lead_summaries enable row level security;

create table if not exists public.lead_summary_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  lead_id uuid references public.leads (id) on delete set null,
  model text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cost_usd numeric(12, 6),
  created_at timestamptz not null default now()
);

create index if not exists lead_summary_runs_ws_created_idx on public.lead_summary_runs (workspace_id, created_at);
create index if not exists lead_summary_runs_lead_idx on public.lead_summary_runs (lead_id) where lead_id is not null;
alter table public.lead_summary_runs enable row level security;

-- Every timeline event = new activity: record it and push the debounce. Which leads the worker
-- actually summarises (automated, or opened) is decided in the worker with AUTOMATED_SQL.
create or replace function public.lead_summary_mark_activity() returns trigger
language plpgsql
as $$
begin
  insert into public.lead_summaries as s (lead_id, workspace_id, activity_at, due_at)
  select new.lead_id, l.workspace_id, now(), now() + interval '2 minutes'
    from public.leads l where l.id = new.lead_id
  on conflict (lead_id) do update
    set activity_at = excluded.activity_at, due_at = excluded.due_at, updated_at = now();
  return null;
end;
$$;

revoke all on function public.lead_summary_mark_activity() from public, anon, authenticated;

drop trigger if exists timeline_events_lead_summary on public.timeline_events;
create trigger timeline_events_lead_summary
  after insert on public.timeline_events
  for each row execute function public.lead_summary_mark_activity();
