-- =============================================================================
-- Northbeam CRM -- AI decision review: ratings and problem reports (Feature 3D-1)
-- =============================================================================
--
-- agent_decisions.rating_reason   why a decision was rated bad. Required when
--                                 rating = 'bad', NULL otherwise (good or
--                                 unrated). The go-live gate counts
--                                 made_up_fact + internal_info_leak as serious.
-- agent_decision_reports          "something's wrong with this AI message"
--                                 reports from any CRM user; admins resolve.
--
-- Nothing here sends anything. Additive and idempotent. RLS on, no policies
-- (the backend bypasses RLS).
-- =============================================================================

alter table public.agent_decisions
  add column if not exists rating_reason text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'agent_decisions_rating_reason_check') then
    alter table public.agent_decisions
      add constraint agent_decisions_rating_reason_check
      check (rating_reason in ('made_up_fact', 'internal_info_leak', 'wrong_tone', 'wrong_timing', 'wrong_action', 'other'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'agent_decisions_rating_reason_matches') then
    alter table public.agent_decisions
      add constraint agent_decisions_rating_reason_matches
      check ((rating_reason is not null) = (rating is not distinct from 'bad'));
  end if;
end $$;

create index if not exists agent_decisions_workspace_rating_idx on public.agent_decisions (workspace_id, rating);

create table if not exists public.agent_decision_reports (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  decision_id uuid not null references public.agent_decisions (id) on delete cascade,
  reported_by uuid references public.profiles (id) on delete set null,
  reported_by_name text,
  note text not null check (length(trim(note)) between 1 and 2000),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.profiles (id) on delete set null,
  resolution_note text
);

create index if not exists agent_decision_reports_workspace_open_idx
  on public.agent_decision_reports (workspace_id, resolved_at, created_at desc);
create index if not exists agent_decision_reports_decision_idx on public.agent_decision_reports (decision_id);

alter table public.agent_decision_reports enable row level security;
