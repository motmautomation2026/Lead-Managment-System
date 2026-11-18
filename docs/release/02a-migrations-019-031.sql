-- =============================================================================
-- REL-1 release: migrations 019-031 (part A of 4). Generated from Supabase/migrations; do not edit by hand.
-- Paste the WHOLE file into Supabase -> SQL editor -> Run. Every migration here is additive and re-runnable:
-- if a part fails, fix the cause and run the same part again. Parts A, B, C, D in order; 020 comes later (03-migration-020.sql).
-- Lines marked 'SLOW ON A BIG TABLE' build an index on a table production already has (see 00-READ-ME-FIRST, step 4).
-- Files: 019_workspace_default_meeting_templates.sql, 021_lead_revenue_and_assignment_rules.sql, 022_knowledge_base_and_assets.sql, 023_kb_ingestion_scheduling.sql, 024_ai_agent_foundation.sql, 025_agent_enrollment_settings.sql, 026_agent_stop_on_lifecycle.sql, 027_agent_budget_alert.sql, 028_agent_company_display_name.sql, 029_agent_decision_review.sql, 030_agent_daily_decision_cap.sql, 031_whatsapp_inbound_body.sql
-- =============================================================================


-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
-- >>> 019_workspace_default_meeting_templates.sql
-- >>> SLOW ON A BIG TABLE: message_templates_one_default_meeting_email_per_workspace on public.message_templates; message_templates_one_default_meeting_whatsapp_per_workspace on public.message_templates
-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

-- =============================================================================
-- Northbeam CRM -- default "Meeting Scheduled" templates per workspace
-- =============================================================================
--
-- 006_google_calendar_meeting_sync.sql allowed at most ONE default
-- meeting-scheduled template per channel across the whole database, so
-- choosing a default in one workspace cleared another workspace's default,
-- and every workspace sent the same workspace's template (audit B3).
--
-- This RELAXES that constraint from global to per workspace: at most one
-- default email and one default WhatsApp template per workspace. No data
-- change. Every row that satisfied the global indexes also satisfies the
-- per-workspace ones, so the new indexes always build.
--
-- Deploy order: apply this BEFORE the backend code that scopes the "clear
-- the previous default" UPDATE by workspace. Old code stays correct on the
-- relaxed indexes (it only ever clears more rows than needed).
-- REL-1: made re-runnable (if not exists / if exists); same indexes.
-- =============================================================================

begin;

create unique index if not exists message_templates_one_default_meeting_email_per_workspace
  on public.message_templates (workspace_id)
  where is_default_meeting_scheduled_email;

create unique index if not exists message_templates_one_default_meeting_whatsapp_per_workspace
  on public.message_templates (workspace_id)
  where is_default_meeting_scheduled_whatsapp;

drop index if exists public.message_templates_one_default_meeting_email;
drop index if exists public.message_templates_one_default_meeting_whatsapp;

commit;


-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
-- >>> 021_lead_revenue_and_assignment_rules.sql
-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

-- =============================================================================
-- Northbeam CRM -- lead company revenue + revenue-based owner assignment rules
-- =============================================================================
--
-- leads.revenue_range keeps the revenue exactly as entered/received (e.g.
-- "₹1–5 Cr"); revenue_min_cr / revenue_max_cr are the backend's parse of it,
-- in crore (NULL bound = open-ended, both NULL = unknown/unparseable).
--
-- lead_assignment_rules: per-workspace, admin-managed rules that pick the
-- owner of a NEW lead from its revenue. Evaluated in `position` order; the
-- first active rule with value > min_cr (when set) and value <= max_cr (when
-- set) wins. When nothing matches (or revenue is unknown) the backend uses
-- workspaces.default_lead_owner_id (migration 018) as the fallback owner.
--
-- Purely additive and idempotent: nullable columns, a new table, no backfill.
-- Existing leads keep their owner. Must be applied BEFORE the backend that
-- reads these columns is deployed; safe to leave applied on a rollback.
--
-- RLS is enabled with no policies: only the backend (which bypasses RLS)
-- reads or writes the rules.
-- =============================================================================

alter table public.leads
  add column if not exists revenue_range text,
  add column if not exists revenue_min_cr numeric(12,2),
  add column if not exists revenue_max_cr numeric(12,2);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'leads_revenue_min_le_max') then
    alter table public.leads
      add constraint leads_revenue_min_le_max
      check (revenue_min_cr is null or revenue_max_cr is null or revenue_min_cr <= revenue_max_cr);
  end if;
end $$;

comment on column public.leads.revenue_range is 'Company revenue as entered or received (free text).';
comment on column public.leads.revenue_min_cr is 'Parsed lower bound of revenue_range, in crore. NULL = open or unknown.';
comment on column public.leads.revenue_max_cr is 'Parsed upper bound of revenue_range, in crore. NULL = open or unknown.';

create table if not exists public.lead_assignment_rules (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  position int not null check (position >= 0),
  min_cr numeric(12,2) check (min_cr >= 0),
  max_cr numeric(12,2) check (max_cr >= 0),
  -- CASCADE: a deleted profile's rules disappear; a deactivated owner's rule is skipped by the backend.
  owner_id uuid not null references public.profiles (id) on delete cascade,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) on delete set null,
  updated_by uuid references public.profiles (id) on delete set null,
  constraint lead_assignment_rules_min_lt_max check (min_cr is null or max_cr is null or min_cr < max_cr)
);

create unique index if not exists lead_assignment_rules_workspace_position_idx
  on public.lead_assignment_rules (workspace_id, position);

drop trigger if exists lead_assignment_rules_set_updated_at on public.lead_assignment_rules;
create trigger lead_assignment_rules_set_updated_at
  before update on public.lead_assignment_rules
  for each row execute function public.set_updated_at();

alter table public.lead_assignment_rules enable row level security;

comment on table public.lead_assignment_rules is
  'Admin-managed rules that assign new leads to an owner by company revenue (crore). '
  'min_cr is exclusive, max_cr inclusive; first active rule by position wins. '
  'Fallback owner: workspaces.default_lead_owner_id.';


-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
-- >>> 022_knowledge_base_and_assets.sql
-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

-- =============================================================================
-- Northbeam CRM -- knowledge base (documents + embedded chunks) and asset library
-- =============================================================================
--
-- Foundation for the AI nurture agent: it may only state facts found in a
-- workspace's knowledge base (kb_documents -> kb_chunks, embedded with OpenAI
-- text-embedding-3-small, 1536 dims) and only attach files from its asset
-- library (agent_assets). Nothing here sends anything to leads.
--
-- pgvector is enabled the Supabase way, in the `extensions` schema; the type
-- and operator class are referenced schema-qualified.
--
-- Two private storage buckets: `kb-documents` (uploaded knowledge files) and
-- `agent-assets` (files the agent may attach). As with 004/005, only the
-- backend's service-role client reads or writes them, so no storage policies.
--
-- RLS is enabled on all three tables with no policies: only the backend
-- (which bypasses RLS) touches them. Purely additive and idempotent.
-- =============================================================================

create extension if not exists vector with schema extensions;

-- --- kb_documents -------------------------------------------------------------

create table if not exists public.kb_documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  title text not null check (btrim(title) <> ''),
  doc_type text not null check (doc_type in ('service', 'case_study', 'faq', 'objection', 'pricing', 'process', 'company', 'asset', 'other')),
  tags text[] not null default '{}',
  source text not null check (source in ('upload', 'text')),
  -- Upload metadata; null for pasted text.
  storage_path text,
  file_name text,
  mime_type text,
  size_bytes bigint check (size_bytes >= 0),
  raw_text text,
  extracted_text text,
  content_hash text,
  status text not null default 'pending' check (status in ('pending', 'processing', 'ready', 'failed')),
  error text,
  attempt_count int not null default 0,
  claimed_at timestamptz,
  processed_at timestamptz,
  chunk_count int not null default 0,
  embedding_model text,
  is_active boolean not null default true,
  created_by uuid references public.profiles (id) on delete set null,
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint kb_documents_source_has_content check (
    (source = 'upload' and storage_path is not null) or (source = 'text' and raw_text is not null)
  )
);

create index if not exists kb_documents_workspace_status_idx on public.kb_documents (workspace_id, status);
create index if not exists kb_documents_workspace_active_idx on public.kb_documents (workspace_id, is_active);

drop trigger if exists kb_documents_set_updated_at on public.kb_documents;
create trigger kb_documents_set_updated_at
  before update on public.kb_documents
  for each row execute function public.set_updated_at();

alter table public.kb_documents enable row level security;

comment on table public.kb_documents is
  'Per-workspace knowledge base documents (uploaded files or pasted text). The AI agent may only state facts found in their ready, active chunks.';

-- --- kb_chunks ----------------------------------------------------------------

create table if not exists public.kb_chunks (
  id uuid primary key default gen_random_uuid(),
  -- Denormalised from the document so searches filter by workspace first.
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  document_id uuid not null references public.kb_documents (id) on delete cascade,
  chunk_index int not null check (chunk_index >= 0),
  content text not null,
  token_count int,
  embedding extensions.vector(1536),
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  constraint kb_chunks_document_chunk_unique unique (document_id, chunk_index)
);

create index if not exists kb_chunks_workspace_idx on public.kb_chunks (workspace_id);
create index if not exists kb_chunks_embedding_hnsw_idx
  on public.kb_chunks using hnsw (embedding extensions.vector_cosine_ops);

alter table public.kb_chunks enable row level security;

comment on table public.kb_chunks is
  'Embedded chunks of kb_documents (OpenAI text-embedding-3-small, 1536 dims). metadata: page / slide / heading.';

-- --- agent_assets -------------------------------------------------------------

create table if not exists public.agent_assets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  title text not null check (btrim(title) <> ''),
  use_when text not null check (btrim(use_when) <> ''),
  tags text[] not null default '{}',
  channels text[] not null check (cardinality(channels) > 0 and channels <@ array['email', 'whatsapp']::text[]),
  storage_path text not null unique,
  file_name text,
  mime_type text,
  size_bytes bigint check (size_bytes >= 0),
  kb_document_id uuid references public.kb_documents (id) on delete set null,
  is_active boolean not null default true,
  created_by uuid references public.profiles (id) on delete set null,
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists agent_assets_workspace_active_idx on public.agent_assets (workspace_id, is_active);

drop trigger if exists agent_assets_set_updated_at on public.agent_assets;
create trigger agent_assets_set_updated_at
  before update on public.agent_assets
  for each row execute function public.set_updated_at();

alter table public.agent_assets enable row level security;

comment on table public.agent_assets is
  'Files the AI agent may attach (and only these), with when to use them and on which channels.';

-- --- storage buckets (private, service-role only) -----------------------------

insert into storage.buckets (id, name, public)
values ('kb-documents', 'kb-documents', false)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('agent-assets', 'agent-assets', false)
on conflict (id) do nothing;


-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
-- >>> 023_kb_ingestion_scheduling.sql
-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

-- =============================================================================
-- Northbeam CRM -- knowledge-base ingestion: retry scheduling + file bucket
-- =============================================================================
--
-- next_attempt_at: when the worker may next claim a pending document. Set on
-- a deferral (e.g. OpenAI not configured or rate-limited, which does not use
-- up an attempt) and on a retryable failure (backoff). NULL = claim now.
-- Without it a deferred document would be re-claimed and re-extracted on
-- every worker tick.
--
-- storage_bucket: which private bucket holds an uploaded document's file.
-- Asset documents (doc_type 'asset') point at the asset's own file in
-- `agent-assets` instead of copying it into `kb-documents`.
--
-- Additive and idempotent; existing rows get NULL / 'kb-documents'.
-- =============================================================================

alter table public.kb_documents
  add column if not exists next_attempt_at timestamptz,
  add column if not exists storage_bucket text not null default 'kb-documents';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'kb_documents_storage_bucket_known') then
    alter table public.kb_documents
      add constraint kb_documents_storage_bucket_known check (storage_bucket in ('kb-documents', 'agent-assets'));
  end if;
end $$;

-- The worker's claim query: pending rows that are due, plus stuck processing rows.
create index if not exists kb_documents_claim_idx
  on public.kb_documents (status, next_attempt_at)
  where status in ('pending', 'processing');

comment on column public.kb_documents.next_attempt_at is
  'Earliest time the ingestion worker may claim this pending document again (deferral or retry backoff). NULL = now.';
comment on column public.kb_documents.storage_bucket is
  'Private storage bucket of storage_path: kb-documents (uploads) or agent-assets (asset files).';


-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
-- >>> 024_ai_agent_foundation.sql
-- >>> SLOW ON A BIG TABLE: leads_workspace_agent_status_idx on public.leads
-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

-- =============================================================================
-- Northbeam CRM -- AI agent foundation (Feature 3A): tables only, nothing sends
-- =============================================================================
--
-- agent_settings   one row per workspace (mode off/shadow/live, send window,
--                  touch limits, word limits, opt-out texts). Seeded for every
--                  existing workspace and by an AFTER INSERT trigger on
--                  workspaces, so createWorkspace needs no change.
-- agent_playbooks  versioned free-text playbook per workspace (append-only).
-- agent_wakeups    queue of "look at this lead again" events for the worker.
-- agent_decisions  every decision the agent made, its validation, cost and
--                  outcome (shadow decisions are drafts; nothing is sent).
-- leads.agent_*    per-lead agent state and touch counters.
-- task_origin      + 'agent' (handoff tasks; 'automation' requires a workflow
--                  run). Not used anywhere in this migration: a value added by
--                  ALTER TYPE cannot be used in the same transaction.
--
-- Timeline: agent events use actor_source 'automation' + actor_name 'AI Agent';
-- the actor_source check is unchanged.
--
-- Additive and idempotent. RLS on, no policies (the backend bypasses RLS).
-- =============================================================================

alter type public.task_origin add value if not exists 'agent';

-- ---------------------------------------------------------------------------
-- agent_settings
-- ---------------------------------------------------------------------------
create table if not exists public.agent_settings (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  mode text not null default 'off' check (mode in ('off', 'shadow', 'live')),
  -- ISO weekdays, Mon=1 .. Sun=7. The window is Asia/Kolkata local time.
  send_days int[] not null default '{1,2,3,4,5,6}'
    check (cardinality(send_days) > 0 and send_days <@ array[1,2,3,4,5,6,7]),
  send_window_start time not null default '09:30',
  send_window_end time not null default '19:00',
  min_gap_hours int not null default 48 check (min_gap_hours > 0),
  max_touches_7d int not null default 2 check (max_touches_7d > 0),
  max_touches_total int not null default 8 check (max_touches_total > 0),
  email_max_words int not null default 250 check (email_max_words > 0),
  whatsapp_max_words int not null default 80 check (whatsapp_max_words > 0),
  wake_min_days int not null default 1 check (wake_min_days > 0),
  wake_max_days int not null default 30 check (wake_max_days > 0),
  nurture_long_term boolean not null default false,
  monthly_budget_usd numeric(10,2) not null default 100 check (monthly_budget_usd > 0),
  decision_model text,
  grounding_model text,
  email_opt_out_text text not null default 'If you''d prefer not to hear from us, just reply "stop".'
    check (length(trim(email_opt_out_text)) > 0),
  whatsapp_opt_out_text text not null default 'Reply STOP to opt out.'
    check (length(trim(whatsapp_opt_out_text)) > 0),
  current_playbook_version int,
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agent_settings_window_order check (send_window_start < send_window_end),
  constraint agent_settings_wake_order check (wake_min_days <= wake_max_days)
);

drop trigger if exists agent_settings_set_updated_at on public.agent_settings;
create trigger agent_settings_set_updated_at
  before update on public.agent_settings
  for each row execute function public.set_updated_at();

alter table public.agent_settings enable row level security;

comment on table public.agent_settings is
  'Per-workspace AI agent settings. mode: off (nothing), shadow (drafts only, sends nothing), live. '
  'decision_model / grounding_model NULL = use the env default.';

insert into public.agent_settings (workspace_id)
select id from public.workspaces
on conflict (workspace_id) do nothing;

create or replace function public.seed_agent_settings_for_workspace()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.agent_settings (workspace_id) values (new.id)
  on conflict (workspace_id) do nothing;
  return new;
end;
$$;

drop trigger if exists workspaces_seed_agent_settings on public.workspaces;
create trigger workspaces_seed_agent_settings
  after insert on public.workspaces
  for each row execute function public.seed_agent_settings_for_workspace();

-- ---------------------------------------------------------------------------
-- agent_playbooks
-- ---------------------------------------------------------------------------
create table if not exists public.agent_playbooks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  version int not null check (version > 0),
  body text not null check (length(trim(body)) > 0),
  created_by uuid references public.profiles (id) on delete set null,
  created_by_name text,
  created_at timestamptz not null default now(),
  constraint agent_playbooks_workspace_version_unique unique (workspace_id, version)
);

alter table public.agent_playbooks enable row level security;

-- ---------------------------------------------------------------------------
-- agent_wakeups
-- ---------------------------------------------------------------------------
create table if not exists public.agent_wakeups (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  lead_id uuid not null references public.leads (id) on delete cascade,
  due_at timestamptz not null,
  reason text not null check (reason in (
    'lead_created', 'call_logged', 'note_added', 'meeting_booked', 'meeting_rescheduled',
    'meeting_cancelled', 'meeting_outcome', 'proposal_status', 'timer', 'enrolled',
    'manual_wake', 'resumed'
  )),
  payload jsonb,
  status text not null default 'pending' check (status in ('pending', 'executing', 'done', 'cancelled')),
  attempt_count int not null default 0 check (attempt_count >= 0),
  claimed_at timestamptz,
  processed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists agent_wakeups_pending_due_idx on public.agent_wakeups (due_at) where status = 'pending';
create index if not exists agent_wakeups_lead_status_idx on public.agent_wakeups (lead_id, status);

alter table public.agent_wakeups enable row level security;

-- ---------------------------------------------------------------------------
-- agent_decisions
-- ---------------------------------------------------------------------------
create table if not exists public.agent_decisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  lead_id uuid not null references public.leads (id) on delete cascade,
  wakeup_id uuid references public.agent_wakeups (id) on delete set null,
  mode text not null check (mode in ('shadow', 'live')),

  action text not null check (action in ('send_email', 'send_whatsapp', 'wait', 'handoff', 'update_stage', 'stop')),
  reasoning text,
  message_subject text,
  message_body text,
  asset_ids uuid[],
  send_at timestamptz,
  next_wake_at timestamptz,
  handoff_title text,
  handoff_urgency text check (handoff_urgency in ('low', 'normal', 'high')),
  new_stage text,
  stop_reason text,

  rules_result jsonb,
  grounding_result jsonb,
  regenerated boolean not null default false,
  chunk_ids uuid[],

  playbook_version int,
  decision_model text,
  grounding_model text,
  input_tokens int,
  output_tokens int,
  cost_usd numeric(10,4),

  outcome text not null check (outcome in ('draft', 'sent', 'skipped', 'blocked', 'executed', 'failed')),
  error text,

  rating text check (rating in ('good', 'bad')),
  rating_note text,
  rated_by uuid references public.profiles (id) on delete set null,
  rated_at timestamptz,

  created_at timestamptz not null default now()
);

create index if not exists agent_decisions_workspace_created_idx on public.agent_decisions (workspace_id, created_at desc);
create index if not exists agent_decisions_lead_created_idx on public.agent_decisions (lead_id, created_at desc);
create index if not exists agent_decisions_workspace_outcome_idx on public.agent_decisions (workspace_id, outcome);

alter table public.agent_decisions enable row level security;

-- ---------------------------------------------------------------------------
-- leads: per-lead agent state
-- ---------------------------------------------------------------------------
alter table public.leads
  add column if not exists agent_status text not null default 'none'
    check (agent_status in ('none', 'active', 'paused', 'handed_off', 'stopped')),
  add column if not exists agent_status_reason text,
  add column if not exists agent_status_changed_at timestamptz,
  add column if not exists agent_touch_count int not null default 0,
  add column if not exists agent_last_touch_at timestamptz;

create index if not exists leads_workspace_agent_status_idx on public.leads (workspace_id, agent_status);

comment on column public.leads.agent_status is
  'AI agent state for this lead: none (never enrolled), active, paused, handed_off, stopped. '
  'Independent of lifecycle_state, pipeline_stage and automation_mode.';


-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
-- >>> 025_agent_enrollment_settings.sql
-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

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


-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
-- >>> 026_agent_stop_on_lifecycle.sql
-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

-- =============================================================================
-- Northbeam CRM -- stop the AI agent when a lead's lifecycle ends (Feature 3B-2)
-- =============================================================================
--
-- BEFORE UPDATE OF lifecycle_state on leads, only when the lifecycle actually
-- changes and agent_status is active / paused / handed_off:
--   - new lifecycle won / lost / discarded / do_not_contact / merged, or
--     long_term_nurture while the workspace's agent_settings.nurture_long_term
--     is false
--   → agent_status 'stopped', agent_status_reason 'lifecycle_changed',
--     pending agent_wakeups cancelled, timeline "AI Agent Stopped"
--     (kind automation, actor 'AI Agent' / automation, detail = new lifecycle).
--
-- Leaving DNC (or any lifecycle) never restarts the agent: a stopped lead
-- stays stopped until an admin re-enrolls it.
--
-- Trigger order: BEFORE triggers on one table fire in name order, so this runs
-- first: leads_agent_lifecycle_stop, leads_cascade_lifecycle_change,
-- leads_enforce_terminal_automation, leads_set_updated_at. It writes only
-- agent_* columns, agent_wakeups and timeline_events, none of which the others
-- read or write, so the order has no effect on their behaviour. If a later
-- trigger raises (e.g. a DNC exit without a reason), the whole statement and
-- these writes roll back together.
--
-- Additive and idempotent (create or replace / drop if exists).
-- =============================================================================

create or replace function public.stop_agent_on_lifecycle_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.lifecycle_state in ('won', 'lost', 'discarded', 'do_not_contact', 'merged')
     or (new.lifecycle_state = 'long_term_nurture'
         and not coalesce((select s.nurture_long_term from public.agent_settings s where s.workspace_id = new.workspace_id), false)) then
    new.agent_status := 'stopped';
    new.agent_status_reason := 'lifecycle_changed';
    new.agent_status_changed_at := now();

    update public.agent_wakeups
       set status = 'cancelled', processed_at = now(),
           payload = coalesce(payload, '{}'::jsonb) || jsonb_build_object('cancel_reason', 'lifecycle_changed')
     where lead_id = new.id and status = 'pending';

    insert into public.timeline_events (lead_id, event_kind, title, detail, actor_name, actor_source, metadata)
    values (
      new.id, 'automation', 'AI Agent Stopped', new.lifecycle_state::text, 'AI Agent', 'automation',
      jsonb_build_object('agentStatusFrom', old.agent_status, 'agentStatusTo', 'stopped', 'reason', 'lifecycle_changed')
    );
  end if;
  return new;
end;
$$;

comment on function public.stop_agent_on_lifecycle_change() is
  'Stops the AI agent (agent_status stopped, reason lifecycle_changed) when a managed lead becomes terminal, '
  'or long-term nurture while the workspace does not nurture long-term. Never restarts it.';

drop trigger if exists leads_agent_lifecycle_stop on public.leads;
create trigger leads_agent_lifecycle_stop
  before update of lifecycle_state on public.leads
  for each row
  when (old.lifecycle_state is distinct from new.lifecycle_state
        and new.agent_status in ('active', 'paused', 'handed_off'))
  execute function public.stop_agent_on_lifecycle_change();


-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
-- >>> 027_agent_budget_alert.sql
-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

-- =============================================================================
-- Northbeam CRM -- AI agent monthly budget alert (Feature 3C-2)
-- =============================================================================
--
-- agent_settings.budget_alerted_month: the first day of the IST calendar month
-- in which admins were last told "AI agent paused: monthly budget reached", so
-- the runner notifies them at most once per month (it sets this atomically).
--
-- Notifications use the existing notification_kind 'warning'; no new value.
--
-- Additive and idempotent.
-- =============================================================================

alter table public.agent_settings
  add column if not exists budget_alerted_month date;

comment on column public.agent_settings.budget_alerted_month is
  'First day of the IST month in which admins were last notified that the AI agent budget was reached.';


-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
-- >>> 028_agent_company_display_name.sql
-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

-- =============================================================================
-- Northbeam CRM -- AI agent company display name (Feature 3C-3)
-- =============================================================================
--
-- agent_settings.company_display_name: the selling company's name the agent
-- uses in its persona, signatures and grounding allow-list (e.g. "MOTM
-- Technologies" for a workspace named "MOTM"). NULL = the workspace name.
--
-- Additive and idempotent.
-- =============================================================================

alter table public.agent_settings
  add column if not exists company_display_name text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'agent_settings_company_display_name_not_blank') then
    alter table public.agent_settings
      add constraint agent_settings_company_display_name_not_blank
      check (company_display_name is null or length(trim(company_display_name)) between 1 and 120);
  end if;
end $$;


-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
-- >>> 029_agent_decision_review.sql
-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

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


-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
-- >>> 030_agent_daily_decision_cap.sql
-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

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


-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
-- >>> 031_whatsapp_inbound_body.sql
-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

-- =============================================================================
-- Northbeam CRM -- encrypted inbound WhatsApp reply text (Feature 4A)
-- =============================================================================
--
-- whatsapp_inbound_events.body_*: the text of a reply matched to exactly one
-- lead, AES-256-GCM with INTEGRATION_ENCRYPTION_KEY (security/encryption.ts),
-- AAD 'whatsapp:inbound:<message_id>'. Unmatched / ambiguous events and
-- non-text messages keep no body (all four body columns null).
-- body_truncated: the stored text was cut to 4,000 characters.
--
-- Additive and idempotent.
-- =============================================================================

alter table public.whatsapp_inbound_events
  add column if not exists body_ciphertext bytea,
  add column if not exists body_iv bytea,
  add column if not exists body_tag bytea,
  add column if not exists body_key_version integer,
  add column if not exists body_truncated boolean not null default false;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'whatsapp_inbound_body_complete') then
    alter table public.whatsapp_inbound_events
      add constraint whatsapp_inbound_body_complete check (
        (body_ciphertext is null and body_iv is null and body_tag is null and body_key_version is null)
        or
        (body_ciphertext is not null and body_iv is not null and body_tag is not null and body_key_version is not null)
      );
  end if;
end $$;

comment on column public.whatsapp_inbound_events.body_ciphertext is
  'Encrypted reply text (AAD whatsapp:inbound:<message_id>); only for replies matched to exactly one lead. Never log it.';
