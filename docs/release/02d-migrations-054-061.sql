-- =============================================================================
-- REL-1 release: migrations 054-061 (part D of 4). Generated from Supabase/migrations; do not edit by hand.
-- Paste the WHOLE file into Supabase -> SQL editor -> Run. Every migration here is additive and re-runnable:
-- if a part fails, fix the cause and run the same part again. Parts A, B, C, D in order; 020 comes later (03-migration-020.sql).
-- Lines marked 'SLOW ON A BIG TABLE' build an index on a table production already has (see 00-READ-ME-FIRST, step 4).
-- Files: 054_whatsapp_numbers.sql, 055_workspace_members.sql, 056_database_lockdown.sql, 057_scalability_health.sql, 058_next_action_sweep.sql, 059_reminders_escalation.sql, 060_calls_recovery.sql, 061_automation_cutoff.sql
-- =============================================================================


-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
-- >>> 054_whatsapp_numbers.sql
-- >>> SLOW ON A BIG TABLE: leads_whatsapp_number_idx on public.leads; whatsapp_outbound_number_sent_at_idx on public.whatsapp_outbound_messages; whatsapp_outbound_number_jid_sent_idx on public.whatsapp_outbound_messages; whatsapp_outbound_number_prepared_idx on public.whatsapp_outbound_messages
-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

-- =============================================================================
-- Northbeam CRM -- E4a: several WhatsApp numbers per workspace (sticky number per lead)
-- =============================================================================
--
-- whatsapp_numbers                  one row per number: its own pairing (QR), status, socket control,
--                                   paired_at / warm-up, daily cap, spacing, new-chat limit, outbound
--                                   on/off and auto-pause (the E1 columns, per number), optional owner,
--                                   soft delete (removed_at).
-- whatsapp_number_auth_credentials  Baileys auth state keyed per number (replaces the per-workspace
-- whatsapp_number_auth_keys         whatsapp_auth_* tables, which are kept but no longer used).
-- whatsapp_connection               stays the per-WORKSPACE row: the send window, `outbound_enabled`
--                                   (master switch for all numbers) and `max_numbers` (default 5).
--                                   Its per-number columns (status, QR, paired_at, caps, pause …) are
--                                   legacy after 054: copied into number #1 and no longer read.
-- leads.whatsapp_number_id          the lead's sticky number (set on the first send / first inbound).
-- whatsapp_outbound_messages / whatsapp_inbound_events / whatsapp_safety_events .whatsapp_number_id
--                                   which number sent / received / signalled; per-number counters.
-- whatsapp_inbound_events.other_number  the reply arrived on another number than the lead's sticky one.
-- message_facts.whatsapp_number_id  the number used (funnel "number" grouping).
--
-- Backfill (rule 11): each workspace's existing connection becomes number #1 with THE SAME id
-- (message_facts.whatsapp_connection_id history keeps matching), the same paired_at and a copy of
-- its auth state (no re-pairing, no warm-up restart); every lead that ever had WhatsApp traffic
-- (a sent message or a matched reply) and every existing outbound / inbound / safety row get #1.
-- Additive and re-runnable: the backfill only touches workspaces whose #1 is created by this run.
-- Stop the worker before applying in production (its auth writes would go to the old tables).
-- =============================================================================

create table if not exists public.whatsapp_numbers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  label text not null,
  owner_user_id uuid references public.profiles (id) on delete set null,
  enabled boolean not null default true,
  desired_state text not null default 'disconnected',
  status text not null default 'disconnected',
  command_version bigint not null default 0,
  connected_jid text,
  connected_phone text,
  display_name text,
  qr_ciphertext bytea,
  qr_iv bytea,
  qr_tag bytea,
  qr_key_version integer not null default 1,
  qr_expires_at timestamptz,
  last_error text,
  reachout_lock jsonb,
  new_chat_cap jsonb,
  worker_heartbeat_at timestamptz,
  last_connected_at timestamptz,
  last_disconnected_at timestamptz,
  daily_cap integer not null default 200,
  min_delay_seconds integer not null default 45,
  max_delay_seconds integer not null default 120,
  paired_at timestamptz,
  max_new_chats_per_day integer not null default 20,
  next_send_at timestamptz,
  paused_reason text,
  paused_at timestamptz,
  paused_by uuid references public.profiles (id) on delete set null,
  resumed_at timestamptz,
  removed_at timestamptz,
  removed_by uuid references public.profiles (id) on delete set null,
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whatsapp_number_label_valid check (length(trim(label)) between 1 and 60),
  constraint whatsapp_number_desired_state_valid check (desired_state in ('connected', 'disconnected', 'restart')),
  constraint whatsapp_number_status_valid check (
    status in ('disconnected', 'connecting', 'qr_ready', 'connected', 'reconnecting', 'reauth_required', 'error')
  ),
  constraint whatsapp_number_qr_complete check (
    (qr_ciphertext is null and qr_iv is null and qr_tag is null and qr_expires_at is null)
    or (qr_ciphertext is not null and qr_iv is not null and qr_tag is not null and qr_expires_at is not null)
  ),
  constraint whatsapp_number_daily_cap_valid check (daily_cap between 1 and 10000),
  constraint whatsapp_number_delay_valid check (min_delay_seconds between 1 and 300 and max_delay_seconds between min_delay_seconds and 600),
  constraint whatsapp_number_new_chats_valid check (max_new_chats_per_day between 0 and 1000)
);
alter table public.whatsapp_numbers enable row level security;

-- Registry scan (rule 12) and the per-workspace list / choice.
create index if not exists whatsapp_numbers_workspace_idx on public.whatsapp_numbers (workspace_id) where removed_at is null;

create table if not exists public.whatsapp_number_auth_credentials (
  number_id uuid primary key references public.whatsapp_numbers (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  ciphertext bytea not null,
  iv bytea not null,
  tag bytea not null,
  key_version integer not null default 1,
  updated_at timestamptz not null default now()
);
alter table public.whatsapp_number_auth_credentials enable row level security;

create table if not exists public.whatsapp_number_auth_keys (
  number_id uuid not null references public.whatsapp_numbers (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  key_type text not null,
  key_id text not null,
  ciphertext bytea not null,
  iv bytea not null,
  tag bytea not null,
  key_version integer not null default 1,
  updated_at timestamptz not null default now(),
  primary key (number_id, key_type, key_id)
);
alter table public.whatsapp_number_auth_keys enable row level security;

alter table public.whatsapp_connection
  add column if not exists outbound_enabled boolean not null default true,
  add column if not exists max_numbers integer not null default 5;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'whatsapp_max_numbers_valid') then
    alter table public.whatsapp_connection add constraint whatsapp_max_numbers_valid check (max_numbers between 1 and 20);
  end if;
end $$;

alter table public.leads add column if not exists whatsapp_number_id uuid references public.whatsapp_numbers (id) on delete set null;
create index if not exists leads_whatsapp_number_idx on public.leads (whatsapp_number_id) where whatsapp_number_id is not null;

alter table public.whatsapp_outbound_messages add column if not exists whatsapp_number_id uuid references public.whatsapp_numbers (id) on delete set null;
alter table public.whatsapp_inbound_events
  add column if not exists whatsapp_number_id uuid references public.whatsapp_numbers (id) on delete set null,
  add column if not exists other_number boolean not null default false;
alter table public.whatsapp_safety_events add column if not exists whatsapp_number_id uuid references public.whatsapp_numbers (id) on delete set null;
alter table public.message_facts add column if not exists whatsapp_number_id uuid;

-- Per-number counters (the 041 indexes, keyed by number): sent today / new chats / 24 h sends,
-- "never messaged / never heard from" on this number, STOPs, failures and reconnects.
create index if not exists whatsapp_outbound_number_sent_at_idx
  on public.whatsapp_outbound_messages (whatsapp_number_id, sent_at) where status = 'sent';
create index if not exists whatsapp_outbound_number_jid_sent_idx
  on public.whatsapp_outbound_messages (whatsapp_number_id, remote_jid) where status = 'sent';
create index if not exists whatsapp_outbound_number_prepared_idx
  on public.whatsapp_outbound_messages (whatsapp_number_id) where status = 'prepared';
create index if not exists whatsapp_inbound_number_phone_idx
  on public.whatsapp_inbound_events (whatsapp_number_id, sender_phone_e164);
create index if not exists whatsapp_inbound_number_stop_idx
  on public.whatsapp_inbound_events (whatsapp_number_id, received_at) where reply_label = 'asked_to_stop';
create index if not exists whatsapp_safety_events_number_idx
  on public.whatsapp_safety_events (whatsapp_number_id, created_at desc);

-- Rule 11 backfill: number #1 per existing connection (same id), only where it doesn't exist yet.
do $$
declare
  r record;
begin
  for r in
    insert into public.whatsapp_numbers (
      id, workspace_id, label, enabled, desired_state, status, command_version, connected_jid, connected_phone, display_name,
      qr_ciphertext, qr_iv, qr_tag, qr_key_version, qr_expires_at, last_error, reachout_lock, new_chat_cap,
      worker_heartbeat_at, last_connected_at, last_disconnected_at, daily_cap, min_delay_seconds, max_delay_seconds,
      paired_at, max_new_chats_per_day, next_send_at, paused_reason, paused_at, paused_by, resumed_at, updated_by, created_at
    )
    select c.id, c.workspace_id, '#1', c.enabled, c.desired_state, c.status, c.command_version, c.connected_jid, c.connected_phone, c.display_name,
           c.qr_ciphertext, c.qr_iv, c.qr_tag, c.qr_key_version, c.qr_expires_at, c.last_error, c.reachout_lock, c.new_chat_cap,
           c.worker_heartbeat_at, c.last_connected_at, c.last_disconnected_at, c.daily_cap, c.min_delay_seconds, c.max_delay_seconds,
           c.paired_at, c.max_new_chats_per_day, c.next_send_at, c.paused_reason, c.paused_at, c.paused_by, c.resumed_at, c.updated_by, c.created_at
      from public.whatsapp_connection c
     where not exists (select 1 from public.whatsapp_numbers n where n.id = c.id)
    returning id, workspace_id
  loop
    insert into public.whatsapp_number_auth_credentials (number_id, workspace_id, ciphertext, iv, tag, key_version, updated_at)
    select r.id, a.workspace_id, a.ciphertext, a.iv, a.tag, a.key_version, a.updated_at
      from public.whatsapp_auth_credentials a where a.workspace_id = r.workspace_id
    on conflict do nothing;
    insert into public.whatsapp_number_auth_keys (number_id, workspace_id, key_type, key_id, ciphertext, iv, tag, key_version, updated_at)
    select r.id, k.workspace_id, k.key_type, k.key_id, k.ciphertext, k.iv, k.tag, k.key_version, k.updated_at
      from public.whatsapp_auth_keys k where k.workspace_id = r.workspace_id
    on conflict do nothing;

    update public.whatsapp_outbound_messages set whatsapp_number_id = r.id where workspace_id = r.workspace_id and whatsapp_number_id is null;
    update public.whatsapp_inbound_events set whatsapp_number_id = r.id where workspace_id = r.workspace_id and whatsapp_number_id is null;
    update public.whatsapp_safety_events set whatsapp_number_id = r.id where workspace_id = r.workspace_id and whatsapp_number_id is null;
    update public.message_facts set whatsapp_number_id = r.id
     where workspace_id = r.workspace_id and channel = 'whatsapp' and whatsapp_number_id is null;

    update public.leads l set whatsapp_number_id = r.id
     where l.workspace_id = r.workspace_id and l.whatsapp_number_id is null
       and l.id in (
         select i.lead_id from public.whatsapp_inbound_events i where i.workspace_id = r.workspace_id and i.lead_id is not null
         union
         select coalesce(sa.lead_id, p.lead_id, m.lead_id, ad.lead_id, rd.lead_id)
           from public.whatsapp_outbound_messages o
           left join public.scheduled_actions sa on sa.id = o.scheduled_action_id
           left join public.proposals p on p.id = o.proposal_id
           left join public.meetings m on m.id = o.meeting_id
           left join public.agent_decisions ad on ad.id = o.agent_decision_id
           left join public.reply_drafts rd on rd.id = o.reply_draft_id
          where o.workspace_id = r.workspace_id and o.status = 'sent'
       );
  end loop;
end $$;

comment on column public.whatsapp_connection.outbound_enabled is
  'E4a: workspace master switch for WhatsApp outbound (all numbers). Per-number pause lives on whatsapp_numbers.enabled.';
comment on column public.leads.whatsapp_number_id is
  'E4a: sticky WhatsApp number; set on the first send or first inbound, changed only by an admin (rule 6) or number removal (rule 10).';


-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
-- >>> 055_workspace_members.sql
-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

-- =============================================================================
-- Northbeam CRM -- E4b: users assigned to workspaces (membership, per-workspace role, super-admin)
-- =============================================================================
--
-- workspace_members         one row per (workspace, user): the user's role IN THAT workspace
--                           ('admin' | 'salesperson', the same values as profiles.role). Every
--                           workspace-scoped API request checks it (requireWorkspace).
-- profiles.is_super_admin   opens every workspace with admin rights and manages every membership.
--                           Set only by `npm run admin:set-super-admin`, never by the UI.
-- workspace_member_events   audit of every membership change (who, what, when).
--
-- Backfill (rule 8, behaviour unchanged on deploy): every ACTIVE user becomes a member of every
-- existing workspace except `[test] …` ones, with their current global role. Deactivated users
-- get nothing. Additive and re-runnable: the backfill only runs while workspace_members is empty,
-- so a re-run never re-adds members that management removed afterwards.
-- RLS on with no policies: the browser never reads these tables (only the backend does).
-- =============================================================================

create table if not exists public.workspace_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role text not null,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint workspace_members_role_valid check (role in ('admin', 'salesperson')),
  constraint workspace_members_unique unique (workspace_id, user_id)
);
create index if not exists workspace_members_user_idx on public.workspace_members (user_id, workspace_id);
create index if not exists workspace_members_workspace_role_idx on public.workspace_members (workspace_id, role);
alter table public.workspace_members enable row level security;

comment on table public.workspace_members is
  'E4b: which users may open which workspace, and their role there. Checked by the API on every workspace request.';

alter table public.profiles add column if not exists is_super_admin boolean not null default false;
comment on column public.profiles.is_super_admin is
  'E4b: opens every workspace as admin and manages memberships. Set only by npm run admin:set-super-admin.';
comment on column public.profiles.role is
  'E4b: the global role is only the default for the 055 backfill and gates /admin user management; workspace roles live in workspace_members.';

create table if not exists public.workspace_member_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid references public.profiles (id) on delete set null,
  action text not null,
  old_role text,
  new_role text,
  actor_id uuid references public.profiles (id) on delete set null,
  actor_email text not null,
  created_at timestamptz not null default now(),
  constraint workspace_member_events_action_valid check (action in ('added', 'role_changed', 'removed', 'workspace_created'))
);
create index if not exists workspace_member_events_workspace_idx on public.workspace_member_events (workspace_id, created_at desc);
alter table public.workspace_member_events enable row level security;

-- Rule 8 backfill: only while the table is empty (first apply).
insert into public.workspace_members (workspace_id, user_id, role)
select w.id, p.id, p.role
  from public.workspaces w
  cross join public.profiles p
 where p.is_active
   and w.name not like '[test] %'
   and not exists (select 1 from public.workspace_members)
on conflict (workspace_id, user_id) do nothing;


-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
-- >>> 056_database_lockdown.sql
-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

-- =============================================================================
-- Northbeam CRM -- SEC-1: no direct database access from the browser
-- =============================================================================
--
-- The browser talks only to the backend (which connects as `postgres`, BYPASSRLS, and uses the
-- service-role key for Storage/Auth). The frontend uses Supabase only for login. So the anon and
-- authenticated roles (the public anon key, with or without a user's login token) get nothing:
--   * every policy on a `public` table is dropped (the 001-era is_active_salesperson() policies
--     let any signed-in active user read/change every workspace through PostgREST);
--   * RLS stays enabled on every `public` table (enabled here if one ever lacks it);
--   * table/view, sequence and function privileges of anon/authenticated (and function EXECUTE of
--     PUBLIC) in `public` are revoked, also for objects created later by `postgres` (default privileges);
--   * no Storage policy for anon/authenticated/public on the private buckets (none exist today).
-- The only non-additive change allowed: policies and privileges. No table, column, function or row
-- is deleted. Triggers keep working (EXECUTE is not checked when a trigger fires). Re-runnable.
-- Guarded by `npm run db:security-check` (also an integration test).
-- =============================================================================

do $$
declare r record;
begin
  for r in select tablename, policyname from pg_policies where schemaname = 'public' loop
    execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename);
  end loop;

  for r in
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity
  loop
    execute format('alter table public.%I enable row level security', r.relname);
  end loop;

  -- Storage: the four private buckets are only read/written by the backend's service role. A policy
  -- for these roles is dropped when it names a private bucket or names no bucket (= every bucket).
  for r in
    select policyname, coalesce(qual, '') || ' ' || coalesce(with_check, '') as expr from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and roles && array['anon', 'authenticated', 'public']::name[]
  loop
    continue when r.expr ~ 'bucket_id' and r.expr !~ '(template-attachments|proposal-documents|kb-documents|agent-assets)';
    execute format('drop policy if exists %I on storage.objects', r.policyname);
  end loop;
end $$;

revoke all on all tables in schema public from anon, authenticated, public;
revoke all on all sequences in schema public from anon, authenticated, public;
revoke all on all functions in schema public from anon, authenticated, public;

-- Objects created later by migrations (owner postgres) start without these grants too.
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated;
-- PUBLIC's EXECUTE on new functions is a global default (a per-schema default can't remove it).
alter default privileges for role postgres revoke execute on functions from public;


-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
-- >>> 057_scalability_health.sql
-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

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


-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
-- >>> 058_next_action_sweep.sql
-- >>> SLOW ON A BIG TABLE: tasks_lead_open_idx on public.tasks; leads_next_action_sweep_idx on public.leads
-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

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


-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
-- >>> 059_reminders_escalation.sql
-- >>> SLOW ON A BIG TABLE: tasks_due_reminder_idx on public.tasks; tasks_overdue_escalation_idx on public.tasks; meetings_upcoming_idx on public.meetings; notifications_email_pending_idx on public.notifications
-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

-- =============================================================================
-- Northbeam CRM -- LL-2 reminders, escalation and email alerts to staff
-- =============================================================================
--
-- agent_settings.task_reminders_since      due bells and overdue / first-call escalation only for tasks due at or
--                                          after it (default = when this migration is applied: no flood on release).
-- agent_settings.meeting_reminders_enabled 24 h + 1 h reminders to the lead (fixed text, email + WhatsApp). Default on.
-- profiles.email_alerts_enabled            "Email me urgent alerts" (Settings → Profile; admins in Users). Default on.
-- profiles.email_digest_enabled            "Morning digest" 09:00 IST Mon–Sat. Default on.
-- workspace_members.digest_sent_on         the IST day the member's digest went out (once per day).
-- tasks.due_notified_at                    the "due now" bell went out (once). tasks.escalated_at (051) is reused
--                                          for the overdue / first-call escalation of non-reply tasks.
-- meetings.reminders_from                  reminders are planned only for times after it: the booking / last
--                                          reschedule (existing meetings: now, so no reminder whose time passed).
-- meeting_reminders                        one row per meeting × kind (24h, 1h, updated, rep_1h) × channel × meeting
--                                          time: the source of each reminder message (WhatsApp `meeting_reminder_id`,
--                                          email source `meeting_reminder`) and the once-only marker. A new meeting
--                                          time gets new rows (reschedule = reset).
-- notifications.email_status               null = bell only; 'pending' = also emailed to the recipient (batched per
--                                          person per tick) → 'sending' → 'sent' | 'skipped' (toggle off / no mailbox /
--                                          dry run / older than a day) | 'failed'.
-- system_health_alerts.problem             + 'staff_email_no_mailbox' (one admin warning per workspace).
--
-- Additive and re-runnable.
-- =============================================================================

alter table public.agent_settings add column if not exists task_reminders_since timestamptz not null default now();
alter table public.agent_settings add column if not exists meeting_reminders_enabled boolean not null default true;

alter table public.profiles add column if not exists email_alerts_enabled boolean not null default true;
alter table public.profiles add column if not exists email_digest_enabled boolean not null default true;

alter table public.workspace_members add column if not exists digest_sent_on date;

alter table public.tasks add column if not exists due_notified_at timestamptz;
create index if not exists tasks_due_reminder_idx on public.tasks (workspace_id, due_at)
  where status = 'open' and due_notified_at is null;
create index if not exists tasks_overdue_escalation_idx on public.tasks (workspace_id, due_at)
  where status = 'open' and escalated_at is null;

alter table public.meetings add column if not exists reminders_from timestamptz not null default now();
create index if not exists meetings_upcoming_idx on public.meetings (workspace_id, scheduled_at) where status = 'scheduled';

create table if not exists public.meeting_reminders (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  meeting_id uuid not null references public.meetings (id) on delete cascade,
  lead_id uuid not null references public.leads (id) on delete cascade,
  kind text not null check (kind in ('24h', '1h', 'updated', 'rep_1h')),
  channel text not null check (channel in ('email', 'whatsapp', 'staff')),
  meeting_at timestamptz not null,
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'skipped', 'failed', 'cancelled')),
  body text,
  error text,
  next_attempt_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique (meeting_id, kind, channel, meeting_at)
);
alter table public.meeting_reminders enable row level security;
revoke all on public.meeting_reminders from anon, authenticated, public;
create index if not exists meeting_reminders_whatsapp_queue_idx on public.meeting_reminders (next_attempt_at)
  where channel = 'whatsapp' and status in ('queued', 'sending');

-- The 6th WhatsApp source.
alter table public.whatsapp_outbound_messages
  add column if not exists meeting_reminder_id uuid references public.meeting_reminders (id) on delete cascade;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'whatsapp_outbound_meeting_reminder_id_key') then
    alter table public.whatsapp_outbound_messages
      add constraint whatsapp_outbound_meeting_reminder_id_key unique (meeting_reminder_id);
  end if;
end $$;
alter table public.whatsapp_outbound_messages drop constraint if exists whatsapp_outbound_exactly_one_source;
alter table public.whatsapp_outbound_messages
  add constraint whatsapp_outbound_exactly_one_source check (
    ((scheduled_action_id is not null)::int + (proposal_id is not null)::int + (meeting_id is not null)::int
      + (agent_decision_id is not null)::int + (reply_draft_id is not null)::int + (meeting_reminder_id is not null)::int) = 1
  );

alter table public.email_outbound_messages drop constraint if exists email_outbound_source_valid;
alter table public.email_outbound_messages
  add constraint email_outbound_source_valid check (source in ('scheduled_action', 'proposal', 'meeting', 'test', 'agent', 'reply_draft', 'meeting_reminder'));

alter table public.notifications add column if not exists email_status text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'notifications_email_status_valid') then
    alter table public.notifications
      add constraint notifications_email_status_valid check (email_status is null or email_status in ('pending', 'sending', 'sent', 'skipped', 'failed'));
  end if;
end $$;
create index if not exists notifications_email_pending_idx on public.notifications (workspace_id, recipient_id) where email_status = 'pending';

alter table public.system_health_alerts drop constraint if exists system_health_alerts_problem_check;
alter table public.system_health_alerts
  add constraint system_health_alerts_problem_check check (problem in ('stuck_queue', 'paused_channel', 'ai_budget', 'staff_email_no_mailbox'));


-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
-- >>> 060_calls_recovery.sql
-- >>> SLOW ON A BIG TABLE: leads_recovery_due_idx on public.leads; proposals_sent_valid_until_idx on public.proposals
-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

-- =============================================================================
-- Northbeam CRM -- LL-3 calls & recovery ("a lead is never lost")
-- =============================================================================
--
-- call_connected_outcome          + 'not_interested' (reason required → the lead becomes Lost).
-- lead_loss_reason                + 'no_requirement', 'existing_supplier' (the LL-3 reason list).
-- calls.attempt_number            consecutive unanswered calls including this one (null = answered / wrong number):
--                                 the call attempt counter of the retry ladder (domain/callAttempts.ts).
-- tasks.marker / call_attempt     what created a task (LL-3 workers' once-only checks, the "Attempt N of 5" label);
--                                 an 'onboarding' task survives the lead being marked Won.
-- leads.recover_at / recovered_at Lost recovery: the date the lead comes back (by loss reason) and when it did (once
--                                 per loss; a new loss resets both, reopening clears recover_at).
-- leads.loss_competitor_name      optional, loss reason competitor_selected.
-- leads.loss_project_date         required for loss reason project_postponed (= the recovery date).
-- leads.discard_reason            spam | duplicate | wrong_person | not_a_sales_lead | other (+ text in the timeline).
-- proposals.valid_until           default sent date + 30 days (editable); expiry_warned_at / expired_task_at = the
--                                 once-only markers of the two proposal tasks.
-- deals.next_decision_date        required when a rep moves a deal into negotiation; decision_task_for = the date the
--                                 "decision date passed" task was created for.
-- deals.stage_changed_at          last stage move (the 10-day manager review; existing deals: apply time, so no review
--                                 flood on release); review_task_at = the last "Manager review" task.
-- agent_settings.tried_calling_whatsapp_enabled   the "We tried calling" WhatsApp after a No answer. Default on.
-- tried_calling_messages          one row per lead per IST day (the once-per-day marker + the WhatsApp queue);
--                                 whatsapp_outbound_messages.tried_calling_id = the 7th WhatsApp source.
--
-- Additive and re-runnable.
-- =============================================================================

alter type public.call_connected_outcome add value if not exists 'not_interested';
alter type public.lead_loss_reason add value if not exists 'no_requirement';
alter type public.lead_loss_reason add value if not exists 'existing_supplier';

alter table public.calls add column if not exists attempt_number smallint;

alter table public.tasks add column if not exists marker text;
alter table public.tasks add column if not exists call_attempt smallint;
alter table public.tasks drop constraint if exists tasks_marker_valid;
alter table public.tasks
  add constraint tasks_marker_valid check (marker is null or marker in (
    'call_attempt', 'fix_phone', 'interested_later_callback', 'lost_recovery', 'proposal_expiring', 'proposal_expired',
    'decision_overdue', 'manager_review', 'onboarding', 'call_ladder_end'));

alter table public.leads add column if not exists recover_at timestamptz;
alter table public.leads add column if not exists recovered_at timestamptz;
alter table public.leads add column if not exists loss_competitor_name text;
alter table public.leads add column if not exists loss_project_date date;
alter table public.leads add column if not exists discard_reason text;
alter table public.leads drop constraint if exists leads_discard_reason_valid;
alter table public.leads
  add constraint leads_discard_reason_valid check (discard_reason is null or discard_reason in ('spam', 'duplicate', 'wrong_person', 'not_a_sales_lead', 'other'));
create index if not exists leads_recovery_due_idx on public.leads (recover_at)
  where lifecycle_state = 'lost' and recovered_at is null and recover_at is not null;

alter table public.proposals add column if not exists valid_until date;
alter table public.proposals add column if not exists expiry_warned_at timestamptz;
alter table public.proposals add column if not exists expired_task_at timestamptz;
create index if not exists proposals_sent_valid_until_idx on public.proposals (workspace_id, valid_until)
  where status = 'sent' and valid_until is not null;

alter table public.deals add column if not exists next_decision_date date;
alter table public.deals add column if not exists decision_task_for date;
-- Existing deals get the apply time (an added column's default fills them without an update, so updated_at and its
-- trigger are untouched): no deal is idle for review until 10 days after release.
alter table public.deals add column if not exists stage_changed_at timestamptz not null default now();
alter table public.deals add column if not exists review_task_at timestamptz;
create index if not exists deals_open_review_idx on public.deals (workspace_id, stage_changed_at)
  where stage in ('proposal_sent', 'negotiation');
create index if not exists deals_decision_date_idx on public.deals (workspace_id, next_decision_date)
  where stage = 'negotiation' and next_decision_date is not null;

alter table public.agent_settings add column if not exists tried_calling_whatsapp_enabled boolean not null default true;

create table if not exists public.tried_calling_messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  lead_id uuid not null references public.leads (id) on delete cascade,
  call_id uuid references public.calls (id) on delete set null,
  ist_day date not null,
  rep_name text,
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'skipped', 'failed', 'cancelled')),
  body text,
  dry_run boolean not null default false,
  error text,
  next_attempt_at timestamptz not null default now(),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique (lead_id, ist_day)
);
alter table public.tried_calling_messages enable row level security;
revoke all on public.tried_calling_messages from anon, authenticated, public;
create index if not exists tried_calling_queue_idx on public.tried_calling_messages (next_attempt_at)
  where status in ('queued', 'sending');
create index if not exists tried_calling_sent_lead_idx on public.tried_calling_messages (lead_id, sent_at)
  where status = 'sent' and not dry_run;

-- The 7th WhatsApp source.
alter table public.whatsapp_outbound_messages
  add column if not exists tried_calling_id uuid references public.tried_calling_messages (id) on delete cascade;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'whatsapp_outbound_tried_calling_id_key') then
    alter table public.whatsapp_outbound_messages
      add constraint whatsapp_outbound_tried_calling_id_key unique (tried_calling_id);
  end if;
end $$;
alter table public.whatsapp_outbound_messages drop constraint if exists whatsapp_outbound_exactly_one_source;
alter table public.whatsapp_outbound_messages
  add constraint whatsapp_outbound_exactly_one_source check (
    ((scheduled_action_id is not null)::int + (proposal_id is not null)::int + (meeting_id is not null)::int
      + (agent_decision_id is not null)::int + (reply_draft_id is not null)::int + (meeting_reminder_id is not null)::int
      + (tried_calling_id is not null)::int) = 1
  );


-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
-- >>> 061_automation_cutoff.sql
-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

-- =============================================================================
-- Northbeam CRM -- REL-1 go-live: which leads are worked automatically
-- =============================================================================
--
-- A lead is "automated" (services/leadAutomation.service.ts AUTOMATED_SQL, pure domain/automation.ts isAutomated)
-- when leads.automation_enabled is true, or it is null and the lead was created at or after its workspace's
-- agent_settings.automation_since. Every automatic job (AI, workflow auto-enrol, LL-1 sweep, LL-2 reminders /
-- escalations / digest, LL-3 ladder / "we tried calling" / recovery / deal follow-ups) only works automated leads.
--
-- agent_settings.automation_since   the go-live cutoff. Existing workspaces get the time this migration is applied
--                                   (production: reset to now() at go-live by docs/release/05-go-live-switches.sql);
--                                   new workspaces get their creation time, so all their leads are automated.
-- leads.automation_enabled          null = the cutoff decides; true = switched on by an admin / the owner (or by a
--                                   manual AI / workflow enrolment); false = switched off.
-- leads.automation_set_at / _by     when and by whom the switch was last changed ("On since <date> by <name>").
--
-- Additive and re-runnable. Adding nullable columns without a default does not rewrite `leads`.
-- =============================================================================

alter table public.agent_settings add column if not exists automation_since timestamptz not null default now();

comment on column public.agent_settings.automation_since is
  'REL-1: leads created at or after this are automated (unless switched off); older leads only when switched on.';

alter table public.leads add column if not exists automation_enabled boolean;
alter table public.leads add column if not exists automation_set_at timestamptz;
alter table public.leads add column if not exists automation_set_by uuid;

alter table public.leads drop constraint if exists leads_automation_set_by_fkey;
alter table public.leads
  add constraint leads_automation_set_by_fkey foreign key (automation_set_by) references public.profiles (id) on delete set null;

comment on column public.leads.automation_enabled is
  'REL-1: null = automated when created at/after agent_settings.automation_since; true = switched on; false = switched off.';
