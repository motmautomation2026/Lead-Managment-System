-- =============================================================================
-- Northbeam CRM -- LL-1 safety net: no active lead without a next action
-- =============================================================================
--
-- agent_settings.next_action_sweep_since   the worker's next-action sweep (every 15 min) only looks at
--                                          leads with activity at or after it (last_activity_at, an AI
--                                          status change or a task closed). Existing workspaces get the
--                                          time this migration is applied, so old leads don't flood the
--                                          team on release; new workspaces get their creation time.
--                                          Run `npm run ll:sweep -- --dry-run` before enabling in production.
--
-- Indexes for the sweep:
--   * tasks (lead_id) where status = 'open'       the "no open task" check per lead.
--   * leads (workspace_id, last_activity_at)      candidates per workspace (active / long-term nurture,
--     where lifecycle active|long_term_nurture     not merged).
-- Production: on a big table build the indexes in a quiet window, or run the same statements by hand
-- with `create index concurrently if not exists …` first; this file then finds them and skips them.
--
-- Additive and re-runnable.
-- =============================================================================

alter table public.agent_settings add column if not exists next_action_sweep_since timestamptz not null default now();

comment on column public.agent_settings.next_action_sweep_since is
  'LL-1: the next-action sweep only creates tasks for leads with activity at or after this (set when migration 058 was applied).';

create index if not exists tasks_lead_open_idx on public.tasks (lead_id) where status = 'open';

create index if not exists leads_next_action_sweep_idx on public.leads (workspace_id, last_activity_at)
  where lifecycle_state in ('active', 'long_term_nurture') and merged_into_lead_id is null;
