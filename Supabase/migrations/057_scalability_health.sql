-- =============================================================================
-- Northbeam CRM -- P7: scalability review + system health
-- =============================================================================
--
-- Additive and re-runnable (`if not exists` everywhere).
--
-- 1. Indexes found missing by the load measurements (20,000 contacts in 10 workspaces,
--    docs/perf/P7-baseline.md):
--    * email_outbound_messages (lead_id): the hot-score sweeper reads each contact's counted
--      opens (a sequential scan of the table per contact: 157 ms per 200-contact batch), and
--      reply drafts / the agent read a contact's emails.
--    Production: on a big table build it in a quiet window, or run the same statement by hand
--    with `create index concurrently if not exists …` first (it cannot run inside a transaction,
--    so not through a migration runner that wraps one); this file then finds it and skips it.
--
-- 2. System health (super-admin only; nothing here sends anything):
--    * worker_heartbeats: one row per worker loop, updated every tick (never a row per tick).
--    * system_health_alerts: one row per workspace × red problem × IST day, so the daily admin
--      notification is sent at most once per problem per day.
--    Both keep RLS on with no policies and no anon/authenticated grants (SEC-1, migration 056).
-- =============================================================================

create index if not exists email_outbound_lead_idx on public.email_outbound_messages (lead_id) where lead_id is not null;

create table if not exists public.worker_heartbeats (
  loop text primary key,
  last_started_at timestamptz not null,
  last_finished_at timestamptz,
  -- An error code or class name only (never a message: it can quote names or addresses).
  last_error text,
  last_error_at timestamptz,
  items_processed integer not null default 0,
  -- The loop is healthy while it finishes at least this often; /health/worker allows 3x.
  expected_seconds integer not null default 60 check (expected_seconds > 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.system_health_alerts (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  problem text not null check (problem in ('stuck_queue', 'paused_channel', 'ai_budget')),
  alerted_on date not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, problem, alerted_on)
);

alter table public.worker_heartbeats enable row level security;
alter table public.system_health_alerts enable row level security;
revoke all on public.worker_heartbeats from anon, authenticated, public;
revoke all on public.system_health_alerts from anon, authenticated, public;
