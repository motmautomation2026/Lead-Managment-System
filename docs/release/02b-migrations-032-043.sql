-- =============================================================================
-- REL-1 release: migrations 032-043 (part B of 4). Generated from Supabase/migrations; do not edit by hand.
-- Paste the WHOLE file into Supabase -> SQL editor -> Run. Every migration here is additive and re-runnable:
-- if a part fails, fix the cause and run the same part again. Parts A, B, C, D in order; 020 comes later (03-migration-020.sql).
-- Lines marked 'SLOW ON A BIG TABLE' build an index on a table production already has (see 00-READ-ME-FIRST, step 4).
-- Files: 032_crm_v2_foundation.sql, 033_crm_v2_list_indexes.sql, 034_contact_full_name_search.sql, 035_timeline_keyset_index.sql, 036_work_list_indexes.sql, 037_automation_list_indexes.sql, 038_agent_decision_context.sql, 039_inbound_message_views.sql, 040_reply_labels.sql, 041_whatsapp_safety.sql, 042_email_safety.sql, 043_email_inbound.sql
-- =============================================================================


-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
-- >>> 032_crm_v2_foundation.sql
-- >>> SLOW ON A BIG TABLE: leads_workspace_company_idx on public.leads; leads_company_link_unchecked_idx on public.leads; meetings_deal_idx on public.meetings; proposals_deal_idx on public.proposals; timeline_events_related_deal_idx on public.timeline_events
-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

-- =============================================================================
-- Northbeam CRM -- CRM v2 foundation: companies, deals, duplicate review, saved views
-- =============================================================================
--
-- docs/crm-v2/B2-design.md §1. A contact stays a row in `leads`; this adds:
--   * companies (+ leads.company_id, kept in sync with the leads.company text)
--   * deal_stage + deals (+ meetings/proposals.deal_id, timeline_events.related_deal_id);
--     no deal logic yet (B3b)
--   * company_duplicate_candidates: either a PAIR of companies (company_b_id set,
--     a < b) or ONE company + the contact whose company text/domain disagrees with
--     it (company_b_id null, lead_id set) -- e.g. contact "TML" linked to
--     "Tata Motors" by email domain.
--   * saved_views (used from B4)
--   * sweeper columns leads.company_link_checked_at / company_link_attempts and
--     workspaces.crm_deals_backfilled_at (B3b)
--
-- pg_trgm is enabled the Supabase way, in the `extensions` schema (like pgvector
-- in 022); operator classes are referenced schema-qualified.
--
-- RLS is enabled on every new table with no policies: only the backend (which
-- bypasses RLS) touches them. Purely additive and re-runnable.
-- =============================================================================

create extension if not exists pg_trgm with schema extensions;

-- --- companies ----------------------------------------------------------------

create table if not exists public.companies (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null,
  normalized_name text not null,
  domain text,
  website text,
  industry text,
  revenue_range text,
  revenue_min_cr numeric(12,2),
  revenue_max_cr numeric(12,2),
  city text,
  state text,
  country text,
  linkedin_url text,
  employee_range text,
  description text,
  owner_id uuid references public.profiles (id) on delete set null,
  merged_into_company_id uuid references public.companies (id) on delete set null,
  created_by uuid references public.profiles (id) on delete set null,
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint companies_name_not_blank check (length(trim(name)) > 0),
  constraint companies_normalized_name_not_blank check (length(normalized_name) > 0),
  constraint companies_domain_lowercase check (domain is null or (domain = lower(domain) and length(domain) > 0)),
  constraint companies_merge_target_not_self check (merged_into_company_id is null or merged_into_company_id <> id),
  constraint companies_revenue_min_le_max check (revenue_min_cr is null or revenue_max_cr is null or revenue_min_cr <= revenue_max_cr)
);

create unique index if not exists companies_workspace_normalized_name_key
  on public.companies (workspace_id, normalized_name) where merged_into_company_id is null;
create unique index if not exists companies_workspace_domain_key
  on public.companies (workspace_id, domain) where domain is not null and merged_into_company_id is null;
create index if not exists companies_workspace_name_idx on public.companies (workspace_id, name, id);
create index if not exists companies_workspace_created_idx on public.companies (workspace_id, created_at, id);
create index if not exists companies_workspace_updated_idx on public.companies (workspace_id, updated_at, id);
create index if not exists companies_merged_into_idx on public.companies (merged_into_company_id) where merged_into_company_id is not null;
create index if not exists companies_name_trgm_idx on public.companies using gin (name extensions.gin_trgm_ops);
create index if not exists companies_normalized_name_trgm_idx on public.companies using gin (normalized_name extensions.gin_trgm_ops);
create index if not exists companies_domain_trgm_idx on public.companies using gin (domain extensions.gin_trgm_ops);

drop trigger if exists companies_set_updated_at on public.companies;
create trigger companies_set_updated_at
  before update on public.companies
  for each row execute function public.set_updated_at();

alter table public.companies enable row level security;

-- --- leads -> companies ---------------------------------------------------------

alter table public.leads
  add column if not exists company_id uuid references public.companies (id) on delete set null,
  add column if not exists company_link_checked_at timestamptz,
  add column if not exists company_link_attempts smallint not null default 0;

create index if not exists leads_workspace_company_idx on public.leads (workspace_id, company_id);
-- The company sweeper's queue: unchecked contacts, oldest first.
create index if not exists leads_company_link_unchecked_idx
  on public.leads (created_at, id) where company_link_checked_at is null;

-- --- deals --------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_type where typname = 'deal_stage' and typnamespace = 'public'::regnamespace) then
    create type public.deal_stage as enum (
      'qualified', 'meeting_scheduled', 'meeting_follow_up', 'proposal_preparation',
      'proposal_sent', 'negotiation', 'won', 'lost'
    );
  end if;
end $$;

create table if not exists public.deals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null,
  lead_id uuid not null references public.leads (id) on delete cascade,
  company_id uuid references public.companies (id) on delete set null,
  owner_id uuid references public.profiles (id) on delete set null,
  stage public.deal_stage not null,
  amount numeric(14,2),
  currency text not null default 'INR',
  expected_close_date date,
  service_interest text,
  source text not null,
  loss_reason public.lead_loss_reason,
  loss_notes text,
  closed_at timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint deals_name_not_blank check (length(trim(name)) > 0),
  constraint deals_amount_non_negative check (amount is null or amount >= 0),
  constraint deals_currency_not_blank check (length(trim(currency)) > 0),
  constraint deals_source_valid check (source in ('meeting', 'proposal', 'manual', 'backfill')),
  constraint deals_lost_has_reason check (stage <> 'lost' or loss_reason is not null),
  constraint deals_closed_at_matches_stage check ((closed_at is not null) = (stage in ('won', 'lost')))
);

create index if not exists deals_workspace_stage_updated_idx on public.deals (workspace_id, stage, updated_at, id);
create index if not exists deals_workspace_created_idx on public.deals (workspace_id, created_at, id);
create index if not exists deals_workspace_amount_idx on public.deals (workspace_id, amount, id);
create index if not exists deals_workspace_close_date_idx on public.deals (workspace_id, expected_close_date, id);
create index if not exists deals_lead_idx on public.deals (lead_id);
create index if not exists deals_company_idx on public.deals (company_id);
create index if not exists deals_name_trgm_idx on public.deals using gin (name extensions.gin_trgm_ops);

drop trigger if exists deals_set_updated_at on public.deals;
create trigger deals_set_updated_at
  before update on public.deals
  for each row execute function public.set_updated_at();

alter table public.deals enable row level security;

alter table public.meetings add column if not exists deal_id uuid references public.deals (id) on delete set null;
alter table public.proposals add column if not exists deal_id uuid references public.deals (id) on delete set null;
alter table public.timeline_events add column if not exists related_deal_id uuid references public.deals (id) on delete set null;
create index if not exists meetings_deal_idx on public.meetings (deal_id) where deal_id is not null;
create index if not exists proposals_deal_idx on public.proposals (deal_id) where deal_id is not null;
create index if not exists timeline_events_related_deal_idx on public.timeline_events (related_deal_id) where related_deal_id is not null;

alter table public.workspaces add column if not exists crm_deals_backfilled_at timestamptz;

-- --- company_duplicate_candidates ---------------------------------------------

create table if not exists public.company_duplicate_candidates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  company_a_id uuid not null references public.companies (id) on delete cascade,
  company_b_id uuid references public.companies (id) on delete cascade,
  -- Contact-level rows only: the contact whose company text/domain disagrees with company_a.
  lead_id uuid references public.leads (id) on delete cascade,
  observed_name text,
  observed_domain text,
  reason text not null,
  score numeric(5,4),
  status text not null default 'open',
  resolved_by uuid references public.profiles (id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  constraint company_duplicate_candidates_reason_valid
    check (reason in ('similar_name', 'same_domain_different_name', 'name_domain_conflict')),
  constraint company_duplicate_candidates_status_valid check (status in ('open', 'merged', 'dismissed')),
  constraint company_duplicate_candidates_shape check (
    (company_b_id is not null and company_a_id < company_b_id and lead_id is null)
    or (company_b_id is null and lead_id is not null)
  ),
  constraint company_duplicate_candidates_resolved_matches_status check ((status = 'open') = (resolved_at is null))
);

create unique index if not exists company_duplicate_candidates_pair_key
  on public.company_duplicate_candidates (company_a_id, company_b_id) where company_b_id is not null;
create unique index if not exists company_duplicate_candidates_contact_key
  on public.company_duplicate_candidates (company_a_id, lead_id) where company_b_id is null;
create index if not exists company_duplicate_candidates_workspace_status_idx
  on public.company_duplicate_candidates (workspace_id, status, created_at desc);
create index if not exists company_duplicate_candidates_company_b_idx
  on public.company_duplicate_candidates (company_b_id) where company_b_id is not null;
create index if not exists company_duplicate_candidates_lead_idx
  on public.company_duplicate_candidates (lead_id) where lead_id is not null;

alter table public.company_duplicate_candidates enable row level security;

-- --- saved_views ----------------------------------------------------------------

create table if not exists public.saved_views (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  owner_id uuid references public.profiles (id) on delete cascade,
  object text not null,
  name text not null,
  filters jsonb not null default '{}'::jsonb,
  sort text,
  columns jsonb,
  is_shared boolean not null default false,
  position int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint saved_views_object_valid check (object in ('contacts', 'companies', 'deals')),
  constraint saved_views_name_not_blank check (length(trim(name)) > 0)
);

create index if not exists saved_views_workspace_object_idx on public.saved_views (workspace_id, object, position);

drop trigger if exists saved_views_set_updated_at on public.saved_views;
create trigger saved_views_set_updated_at
  before update on public.saved_views
  for each row execute function public.set_updated_at();

alter table public.saved_views enable row level security;


-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
-- >>> 033_crm_v2_list_indexes.sql
-- >>> SLOW ON A BIG TABLE: leads_workspace_created_idx on public.leads; leads_workspace_last_activity_idx on public.leads; leads_workspace_updated_idx on public.leads; leads_workspace_name_idx on public.leads; leads_workspace_company_name_idx on public.leads; leads_first_name_trgm_idx on public.leads; leads_last_name_trgm_idx on public.leads; leads_company_trgm_idx on public.leads; leads_email_trgm_idx on public.leads; leads_phone_trgm_idx on public.leads
-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

-- =============================================================================
-- Northbeam CRM -- CRM v2 list indexes (B4)
-- =============================================================================
--
-- docs/crm-v2/B2-design.md §4: every whitelisted list sort has a
-- (workspace_id, <sort column(s)>, id) index; contact search (`q`, escaped ilike)
-- gets trigram GIN indexes. Additive and re-runnable; indexes only.
--
-- Not indexable: companies `contactCount` (computed per page).
-- Already covered by 032: companies name/created_at/updated_at, deals created_at/
-- amount/expected_close_date, company/deal trigram search.

-- Contacts (leads) sorts: createdAt, lastActivityAt, updatedAt, name, company.
create index if not exists leads_workspace_created_idx on public.leads (workspace_id, created_at, id);
create index if not exists leads_workspace_last_activity_idx on public.leads (workspace_id, last_activity_at, id);
create index if not exists leads_workspace_updated_idx on public.leads (workspace_id, updated_at, id);
create index if not exists leads_workspace_name_idx on public.leads (workspace_id, last_name, first_name, id);
create index if not exists leads_workspace_company_name_idx on public.leads (workspace_id, company, id);

-- Contacts search.
create index if not exists leads_first_name_trgm_idx on public.leads using gin (first_name extensions.gin_trgm_ops);
create index if not exists leads_last_name_trgm_idx on public.leads using gin (last_name extensions.gin_trgm_ops);
create index if not exists leads_company_trgm_idx on public.leads using gin (company extensions.gin_trgm_ops);
create index if not exists leads_email_trgm_idx on public.leads using gin (email extensions.gin_trgm_ops);
create index if not exists leads_phone_trgm_idx on public.leads using gin (phone extensions.gin_trgm_ops);

-- Deals sorts: updatedAt (default, without a stage filter) and name.
create index if not exists deals_workspace_updated_idx on public.deals (workspace_id, updated_at, id);
create index if not exists deals_workspace_name_idx on public.deals (workspace_id, name, id);


-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
-- >>> 034_contact_full_name_search.sql
-- >>> SLOW ON A BIG TABLE: leads_full_name_trgm_idx on public.leads
-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

-- =============================================================================
-- Northbeam CRM -- contact full-name search (C2)
-- =============================================================================
--
-- "Asha Rao" (first + last name together) matches a contact in /contacts?q=,
-- /search and the old /leads?search=. The queries use exactly this expression
-- (Backend/src/lists/listQuery.ts `LEAD_FULL_NAME_SQL`) so the planner can use it.
-- Additive and re-runnable; one index only.

create index if not exists leads_full_name_trgm_idx
  on public.leads using gin ((first_name || ' ' || last_name) extensions.gin_trgm_ops);


-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
-- >>> 035_timeline_keyset_index.sql
-- >>> SLOW ON A BIG TABLE: timeline_events_lead_occurred_id_idx on public.timeline_events
-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

-- =============================================================================
-- Northbeam CRM -- paginated timelines (C3)
-- =============================================================================
--
-- GET /contacts/:id/timeline and /companies/:id/timeline page newest first on
-- (occurred_at, id) (Backend/src/services/timeline.service.ts). The existing
-- (lead_id, occurred_at desc) index has no id tie-break. related_deal_id is
-- already indexed (032). Additive and re-runnable; one index only.

create index if not exists timeline_events_lead_occurred_id_idx
  on public.timeline_events (lead_id, occurred_at, id);


-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
-- >>> 036_work_list_indexes.sql
-- >>> SLOW ON A BIG TABLE: tasks_workspace_due_idx on public.tasks; tasks_workspace_created_idx on public.tasks; tasks_workspace_updated_idx on public.tasks; meetings_workspace_scheduled_idx on public.meetings; meetings_workspace_created_idx on public.meetings; proposals_workspace_updated_idx on public.proposals; proposals_workspace_sent_idx on public.proposals; proposals_workspace_amount_idx on public.proposals
-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

-- =============================================================================
-- Northbeam CRM -- Tasks, Meetings, Proposals lists (C6a)
-- =============================================================================
--
-- GET /tasks/list, /meetings/list and /proposals/list follow the CRM v2 list
-- standard (Backend/src/lists/listQuery.ts): every whitelisted sort needs a
-- (workspace_id, field, id) index. Saved views gain the three objects.
-- Additive and re-runnable.

create index if not exists tasks_workspace_due_idx on public.tasks (workspace_id, due_at, id);
create index if not exists tasks_workspace_created_idx on public.tasks (workspace_id, created_at, id);
create index if not exists tasks_workspace_updated_idx on public.tasks (workspace_id, updated_at, id);

create index if not exists meetings_workspace_scheduled_idx on public.meetings (workspace_id, scheduled_at, id);
create index if not exists meetings_workspace_created_idx on public.meetings (workspace_id, created_at, id);

create index if not exists proposals_workspace_updated_idx on public.proposals (workspace_id, updated_at, id);
create index if not exists proposals_workspace_sent_idx on public.proposals (workspace_id, sent_at, id);
create index if not exists proposals_workspace_amount_idx on public.proposals (workspace_id, amount, id);

alter table public.saved_views drop constraint if exists saved_views_object_valid;
alter table public.saved_views add constraint saved_views_object_valid
  check (object in ('contacts', 'companies', 'deals', 'tasks', 'meetings', 'proposals'));


-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
-- >>> 037_automation_list_indexes.sql
-- >>> SLOW ON A BIG TABLE: workflow_runs_workspace_started_idx on public.workflow_runs; scheduled_actions_workspace_scheduled_idx on public.scheduled_actions
-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

-- Northbeam CRM -- C6b: keyset indexes for the Runs and Scheduled steps lists
-- (GET /runs/list, GET /scheduled-actions/list; docs/crm-v2/B4-api.md §7b).
-- Additive and re-runnable.

create index if not exists workflow_runs_workspace_started_idx
  on public.workflow_runs (workspace_id, started_at, id);

create index if not exists scheduled_actions_workspace_scheduled_idx
  on public.scheduled_actions (workspace_id, scheduled_for, id);


-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
-- >>> 038_agent_decision_context.sql
-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

-- =============================================================================
-- Northbeam CRM -- D1: which company and deal an AI decision saw
-- =============================================================================
--
-- agent_decisions.context_company_id   the contact's company (after following a
--                                      merge once) when the decision was made.
-- agent_decisions.context_deal_id      the contact's open deal at that time.
-- agent_decisions.context_deal_stage   that deal's stage at that time.
--
-- All nullable: old rows and decisions without a company / open deal stay null.
-- Additive and idempotent.
-- =============================================================================

alter table public.agent_decisions
  add column if not exists context_company_id uuid references public.companies (id) on delete set null,
  add column if not exists context_deal_id uuid references public.deals (id) on delete set null,
  add column if not exists context_deal_stage public.deal_stage;

comment on column public.agent_decisions.context_company_id is
  'The company the decision saw (D1); null = none or a row from before D1.';
comment on column public.agent_decisions.context_deal_id is
  'The open deal the decision saw (D1); null = none or a row from before D1.';
comment on column public.agent_decisions.context_deal_stage is
  'The open deal''s stage when the decision was made (D1).';


-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
-- >>> 039_inbound_message_views.sql
-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

-- =============================================================================
-- Northbeam CRM -- audit of who read an inbound WhatsApp reply (D2)
-- =============================================================================
--
-- One row per GET /contacts/:id/replies/:messageId that reached a matched reply
-- of the contact: shown, denied (not the owner or an admin), no_text (nothing
-- stored) or decrypt_failed. Never holds the text. Backend only: RLS on, no
-- policies (the API uses a BYPASSRLS role).
--
-- Additive and idempotent.
-- =============================================================================

create table if not exists public.inbound_message_views (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id),
  lead_id uuid not null references public.leads (id) on delete cascade,
  message_id text not null references public.whatsapp_inbound_events (message_id),
  viewer_id uuid references public.profiles (id) on delete set null,
  outcome text not null,
  viewed_at timestamptz not null default now(),
  constraint inbound_message_views_outcome_valid check (outcome in ('shown', 'denied', 'no_text', 'decrypt_failed'))
);

create index if not exists inbound_message_views_lead_idx
  on public.inbound_message_views (workspace_id, lead_id, viewed_at);

alter table public.inbound_message_views enable row level security;

comment on table public.inbound_message_views is
  'Audit of reads of inbound WhatsApp reply text (D2). Never stores the text.';


-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
-- >>> 040_reply_labels.sql
-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

-- =============================================================================
-- Northbeam CRM -- D4a: what a WhatsApp reply says (label, never the text)
-- =============================================================================
--
-- whatsapp_inbound_events, for replies matched to exactly one lead:
--   lead_id                     the matched lead (null for older / unmatched rows).
--   reply_label                 asked_to_stop | not_interested | annoyed | positive |
--                               question | other | unclassified (null = not labelled yet).
--   reply_label_source          keyword | ai | rep.
--   reply_label_confidence      the model's 0-1 confidence (ai only).
--   classification_status       pending (waiting for the worker) | done | failed | skipped.
--   classification_attempts     worker claims so far (also the claim token).
--   classification_next_at      when the worker may (re)claim a pending row.
--   classified_at               when the label was first set.
--   label_corrected_by / _at    the rep who changed the label.
--   classification_model / _input_tokens / _output_tokens / _cost_usd
--                               the AI call's cost (counts toward the monthly AI budget).
--
-- No text columns: the reply text stays only in body_* (encrypted, 031).
-- Additive and idempotent.
-- =============================================================================

alter table public.whatsapp_inbound_events
  add column if not exists lead_id uuid references public.leads (id) on delete set null,
  add column if not exists reply_label text,
  add column if not exists reply_label_source text,
  add column if not exists reply_label_confidence numeric(4, 3),
  add column if not exists classification_status text,
  add column if not exists classification_attempts integer not null default 0,
  add column if not exists classification_next_at timestamptz,
  add column if not exists classified_at timestamptz,
  add column if not exists label_corrected_by uuid references public.profiles (id) on delete set null,
  add column if not exists label_corrected_at timestamptz,
  add column if not exists classification_model text,
  add column if not exists classification_input_tokens integer,
  add column if not exists classification_output_tokens integer,
  add column if not exists classification_cost_usd numeric(12, 6);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'whatsapp_inbound_reply_label_valid') then
    alter table public.whatsapp_inbound_events
      add constraint whatsapp_inbound_reply_label_valid check (
        reply_label is null or reply_label in ('asked_to_stop', 'not_interested', 'annoyed', 'positive', 'question', 'other', 'unclassified')
      );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'whatsapp_inbound_reply_label_source_valid') then
    alter table public.whatsapp_inbound_events
      add constraint whatsapp_inbound_reply_label_source_valid check (
        reply_label_source is null or reply_label_source in ('keyword', 'ai', 'rep')
      );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'whatsapp_inbound_classification_status_valid') then
    alter table public.whatsapp_inbound_events
      add constraint whatsapp_inbound_classification_status_valid check (
        classification_status is null or classification_status in ('pending', 'done', 'failed', 'skipped')
      );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'whatsapp_inbound_reply_confidence_range') then
    alter table public.whatsapp_inbound_events
      add constraint whatsapp_inbound_reply_confidence_range check (
        reply_label_confidence is null or (reply_label_confidence >= 0 and reply_label_confidence <= 1)
      );
  end if;
end $$;

-- The worker's queue.
create index if not exists whatsapp_inbound_classification_pending_idx
  on public.whatsapp_inbound_events (classification_next_at)
  where classification_status = 'pending';

-- Monthly AI spend / stats per workspace.
create index if not exists whatsapp_inbound_classified_idx
  on public.whatsapp_inbound_events (workspace_id, classified_at)
  where classified_at is not null;

comment on column public.whatsapp_inbound_events.reply_label is
  'What the reply says (D4a); never the text or a quote of it.';


-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
-- >>> 041_whatsapp_safety.sql
-- >>> SLOW ON A BIG TABLE: whatsapp_outbound_ws_jid_sent_idx on public.whatsapp_outbound_messages; whatsapp_outbound_ws_sent_at_idx on public.whatsapp_outbound_messages
-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

-- =============================================================================
-- Northbeam CRM -- E1: WhatsApp safety (slower, capped, windowed sending + auto-pause)
-- =============================================================================
--
-- whatsapp_connection (per workspace, admin-adjustable):
--   min/max_delay_seconds   new defaults 45-120 s; rows still on the old 5/15 defaults move too.
--   paired_at               when this number was paired (QR scan). Null = paired before E1,
--                           counted as fully warmed up. Cleared on logout.
--   max_new_chats_per_day   first messages to never-contacted phones per IST day (20).
--   send_window_days        ISO weekdays (1 = Monday) automated sends may go out (Mon-Sat).
--   send_window_start/_end  IST wall-clock window for automated sends (09:30-19:00).
--   next_send_at            earliest time the next send may go out (spacing).
--   paused_reason/_at/_by   why outbound was turned off (`enabled` = false); _by null = auto-pause.
--   resumed_at              last admin resume; auto-pause signals count only after it.
--
-- whatsapp_outbound_messages.new_chat: the send was this workspace's first message to the phone.
-- whatsapp_safety_events: signals (send failures, reconnect failures, disconnects) and pauses.
-- Additive and idempotent.
-- =============================================================================

alter table public.whatsapp_connection
  add column if not exists paired_at timestamptz,
  add column if not exists max_new_chats_per_day integer not null default 20,
  add column if not exists send_window_days smallint[] not null default '{1,2,3,4,5,6}',
  add column if not exists send_window_start time not null default '09:30',
  add column if not exists send_window_end time not null default '19:00',
  add column if not exists next_send_at timestamptz,
  add column if not exists paused_reason text,
  add column if not exists paused_at timestamptz,
  add column if not exists paused_by uuid references public.profiles (id) on delete set null,
  add column if not exists resumed_at timestamptz;

alter table public.whatsapp_connection alter column min_delay_seconds set default 45;
alter table public.whatsapp_connection alter column max_delay_seconds set default 120;
update public.whatsapp_connection set min_delay_seconds = 45, max_delay_seconds = 120
 where min_delay_seconds = 5 and max_delay_seconds = 15;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'whatsapp_new_chats_valid') then
    alter table public.whatsapp_connection
      add constraint whatsapp_new_chats_valid check (max_new_chats_per_day between 0 and 1000);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'whatsapp_send_window_valid') then
    alter table public.whatsapp_connection
      add constraint whatsapp_send_window_valid check (
        send_window_start < send_window_end
        and cardinality(send_window_days) between 1 and 7
        and send_window_days <@ '{1,2,3,4,5,6,7}'::smallint[]
      );
  end if;
end $$;

alter table public.whatsapp_outbound_messages
  add column if not exists new_chat boolean not null default false;

create table if not exists public.whatsapp_safety_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  kind text not null,
  detail text,
  created_at timestamptz not null default now(),
  constraint whatsapp_safety_event_kind_valid check (
    kind in ('send_failed', 'reconnect_failed', 'disconnected', 'restricted', 'paused', 'resumed')
  )
);
alter table public.whatsapp_safety_events enable row level security;

create index if not exists whatsapp_safety_events_ws_idx
  on public.whatsapp_safety_events (workspace_id, created_at desc);

-- Rule 4/6 "never messaged / never heard from this phone".
create index if not exists whatsapp_outbound_ws_jid_sent_idx
  on public.whatsapp_outbound_messages (workspace_id, remote_jid)
  where status = 'sent';
create index if not exists whatsapp_inbound_ws_phone_idx
  on public.whatsapp_inbound_events (workspace_id, sender_phone_e164);

-- Daily counts (sent today, new chats today) and the 24 h STOP signal.
create index if not exists whatsapp_outbound_ws_sent_at_idx
  on public.whatsapp_outbound_messages (workspace_id, sent_at)
  where status = 'sent';
create index if not exists whatsapp_inbound_ws_stop_idx
  on public.whatsapp_inbound_events (workspace_id, received_at)
  where reply_label = 'asked_to_stop';

comment on column public.whatsapp_connection.paired_at is
  'E1: when this number was paired; null = paired before E1 (fully warmed up).';


-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
-- >>> 042_email_safety.sql
-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

-- =============================================================================
-- Northbeam CRM -- E1b: email through SMTP only (queue, limits, auto-pause)
-- =============================================================================
--
-- integration_connections (the workspace's 'email' row, admin-adjustable):
--   configured_at           when SMTP was first saved under E1b (warm-up start). Null = never
--                           saved under E1b: no warm-up until an admin saves SMTP.
--   already_warmed          admin says the mailbox has sent normal email for months: no warm-up.
--   daily_cap / hourly_cap  100 per IST day / 20 per IST clock hour.
--   min/max_delay_seconds   random spacing between two emails of the workspace (30-90 s).
--   send_window_days        ISO weekdays (1 = Monday) automated email may go out (Mon-Sat).
--   send_window_start/_end  IST wall-clock window for automated email (09:30-19:00).
--   next_send_at            earliest time the next email may go out (spacing).
--   paused_reason/_at/_by   why sending was turned off (`enabled` = false); _by null = auto-pause.
--   resumed_at              last admin resume; auto-pause signals count only after it.
-- IMAP non-secret fields live in `settings` next to SMTP's; IMAP secrets in the same encrypted
-- blob. Rows whose provider is 'resend' stay untouched (the code treats them as not configured).
--
-- email_outbound_messages: every email (workflow step, proposal, meeting notification, test;
-- later the AI), one row per (source, source_id), sent only by the worker.
-- email_safety_events: signals and pauses.
-- Additive and idempotent.
-- =============================================================================

alter table public.integration_connections
  add column if not exists configured_at timestamptz,
  add column if not exists already_warmed boolean not null default false,
  add column if not exists daily_cap integer not null default 100,
  add column if not exists hourly_cap integer not null default 20,
  add column if not exists min_delay_seconds integer not null default 30,
  add column if not exists max_delay_seconds integer not null default 90,
  add column if not exists send_window_days smallint[] not null default '{1,2,3,4,5,6}',
  add column if not exists send_window_start time not null default '09:30',
  add column if not exists send_window_end time not null default '19:00',
  add column if not exists next_send_at timestamptz,
  add column if not exists paused_reason text,
  add column if not exists paused_at timestamptz,
  add column if not exists paused_by uuid references public.profiles (id) on delete set null,
  add column if not exists resumed_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'email_limits_valid') then
    alter table public.integration_connections
      add constraint email_limits_valid check (
        daily_cap between 1 and 10000
        and hourly_cap between 1 and 1000
        and min_delay_seconds between 1 and 3600
        and max_delay_seconds between min_delay_seconds and 3600
      );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'email_send_window_valid') then
    alter table public.integration_connections
      add constraint email_send_window_valid check (
        send_window_start < send_window_end
        and cardinality(send_window_days) between 1 and 7
        and send_window_days <@ '{1,2,3,4,5,6,7}'::smallint[]
      );
  end if;
end $$;

create table if not exists public.email_outbound_messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  source text not null,
  source_id uuid not null,
  lead_id uuid references public.leads (id) on delete set null,
  to_address text not null,
  -- Null = the mailbox's default from name at send time.
  from_name text,
  -- Emails to a contact get List-Unsubscribe.
  to_contact boolean not null default false,
  subject text not null,
  html text not null,
  text_body text not null,
  -- [{bucket, path, fileName, mimeType, size}], downloaded by the worker at send time.
  attachments jsonb not null default '[]'::jsonb,
  status text not null default 'queued',
  attempts integer not null default 0,
  -- Queued: when it may be tried. Sending: the reclaim time (claim + 15 min).
  next_attempt_at timestamptz not null default now(),
  last_error text,
  smtp_response text,
  message_id text,
  dry_run boolean not null default false,
  sent_at timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint email_outbound_source_valid check (source in ('scheduled_action', 'proposal', 'meeting', 'test', 'agent')),
  constraint email_outbound_status_valid check (status in ('queued', 'sending', 'sent', 'failed', 'cancelled')),
  constraint email_outbound_source_unique unique (source, source_id)
);
alter table public.email_outbound_messages enable row level security;

drop trigger if exists email_outbound_messages_set_updated_at on public.email_outbound_messages;
create trigger email_outbound_messages_set_updated_at
  before update on public.email_outbound_messages
  for each row execute function public.set_updated_at();

-- The claim (due queued/sending rows) and the counts (sent today / this hour / 24 h).
create index if not exists email_outbound_due_idx
  on public.email_outbound_messages (next_attempt_at)
  where status in ('queued', 'sending');
create index if not exists email_outbound_ws_sent_at_idx
  on public.email_outbound_messages (workspace_id, sent_at)
  where status = 'sent' and not dry_run;

create table if not exists public.email_safety_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  kind text not null,
  detail text,
  created_at timestamptz not null default now(),
  constraint email_safety_event_kind_valid check (
    kind in ('send_failed', 'recipient_rejected', 'login_rejected', 'rate_limited', 'paused', 'resumed')
  )
);
alter table public.email_safety_events enable row level security;

create index if not exists email_safety_events_ws_idx
  on public.email_safety_events (workspace_id, created_at desc);

comment on column public.integration_connections.configured_at is
  'E1b: when SMTP was first saved under E1b (warm-up start); null = no warm-up until then.';


-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
-- >>> 043_email_inbound.sql
-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

-- =============================================================================
-- Northbeam CRM -- D3: email replies, bounces and unsubscribes read over IMAP
-- =============================================================================
--
-- email_inbound_events: one row per message the worker read from the workspace mailbox
-- (read-only; nothing in the mailbox is changed). Unique per (workspace, Message-ID header);
-- messages without one use (workspace, uidvalidity, uid).
--   kind           reply | bounce (5.x.x) | bounce_temporary (4.x.x / delayed) | auto_reply |
--                  unsubscribe | ignored (our own address, no-reply senders).
--   match_status   matched | unmatched | ambiguous;  match_method in_reply_to | references |
--                  sender | original_message (a bounce's original Message-ID) | recipient
--                  (a bounce's Final-Recipient).
--   body_*         a matched reply's subject + text, AES-256-GCM, AAD 'email:inbound:<id>'
--                  (all-or-none). Never HTML, never attachments. text_truncated: cut to 4,000.
--   reply_label…, classification_…   the D4a label columns (same meaning as on
--                  whatsapp_inbound_events, migration 040).
-- email_imap_state: per workspace polling state (uidvalidity + last_uid, last check/error).
-- email_outbound_messages.bounced_at / bounce_status: a DSN for that email.
-- inbound_message_views.channel (+ email_event_id): reads of email reply text are audited too.
--
-- Additive and idempotent.
-- =============================================================================

create table if not exists public.email_inbound_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  message_id_header text,
  uidvalidity bigint not null,
  uid bigint not null,
  from_address text,
  received_at timestamptz not null,
  kind text not null,
  match_status text not null default 'unmatched',
  match_method text,
  lead_id uuid references public.leads (id) on delete set null,
  outbound_id uuid references public.email_outbound_messages (id) on delete set null,
  bounce_status text,
  bounce_detail text,
  body_ciphertext bytea,
  body_iv bytea,
  body_tag bytea,
  body_key_version integer,
  text_truncated boolean not null default false,
  reply_label text,
  reply_label_source text,
  reply_label_confidence numeric(4, 3),
  classification_status text,
  classification_attempts integer not null default 0,
  classification_next_at timestamptz,
  classified_at timestamptz,
  label_corrected_by uuid references public.profiles (id) on delete set null,
  label_corrected_at timestamptz,
  classification_model text,
  classification_input_tokens integer,
  classification_output_tokens integer,
  classification_cost_usd numeric(12, 6),
  created_at timestamptz not null default now(),
  constraint email_inbound_kind_valid check (kind in ('reply', 'bounce', 'bounce_temporary', 'auto_reply', 'unsubscribe', 'ignored')),
  constraint email_inbound_match_status_valid check (match_status in ('matched', 'unmatched', 'ambiguous')),
  constraint email_inbound_match_method_valid check (
    match_method is null or match_method in ('in_reply_to', 'references', 'sender', 'original_message', 'recipient')
  ),
  constraint email_inbound_body_complete check (
    (body_ciphertext is null and body_iv is null and body_tag is null and body_key_version is null)
    or (body_ciphertext is not null and body_iv is not null and body_tag is not null and body_key_version is not null)
  ),
  constraint email_inbound_reply_label_valid check (
    reply_label is null or reply_label in ('asked_to_stop', 'not_interested', 'annoyed', 'positive', 'question', 'other', 'unclassified')
  ),
  constraint email_inbound_reply_label_source_valid check (reply_label_source is null or reply_label_source in ('keyword', 'ai', 'rep')),
  constraint email_inbound_classification_status_valid check (
    classification_status is null or classification_status in ('pending', 'done', 'failed', 'skipped')
  ),
  constraint email_inbound_reply_confidence_range check (
    reply_label_confidence is null or (reply_label_confidence >= 0 and reply_label_confidence <= 1)
  )
);
alter table public.email_inbound_events enable row level security;

create unique index if not exists email_inbound_message_id_unique
  on public.email_inbound_events (workspace_id, message_id_header) where message_id_header is not null;
create unique index if not exists email_inbound_uid_unique
  on public.email_inbound_events (workspace_id, uidvalidity, uid) where message_id_header is null;
-- Settings counts (today by kind, bounces 24 h).
create index if not exists email_inbound_ws_created_idx on public.email_inbound_events (workspace_id, created_at);
create index if not exists email_inbound_lead_idx on public.email_inbound_events (lead_id) where lead_id is not null;
-- The D4a worker queue and monthly AI spend.
create index if not exists email_inbound_classification_pending_idx
  on public.email_inbound_events (classification_next_at) where classification_status = 'pending';
create index if not exists email_inbound_classified_idx
  on public.email_inbound_events (workspace_id, classified_at) where classified_at is not null;

create table if not exists public.email_imap_state (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  uidvalidity bigint,
  last_uid bigint,
  -- When the IMAP login was (re)saved: the first poll reads only mail after it.
  imap_saved_at timestamptz,
  last_poll_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  next_poll_at timestamptz not null default now(),
  -- An IMAP login rejection notifies admins once per IST day.
  login_alerted_on date,
  updated_at timestamptz not null default now()
);
alter table public.email_imap_state enable row level security;

drop trigger if exists email_imap_state_set_updated_at on public.email_imap_state;
create trigger email_imap_state_set_updated_at
  before update on public.email_imap_state
  for each row execute function public.set_updated_at();

alter table public.email_outbound_messages
  add column if not exists bounced_at timestamptz,
  add column if not exists bounce_status text;

-- D3 matches In-Reply-To / References / a bounce's original Message-ID to our emails.
create index if not exists email_outbound_ws_message_id_idx
  on public.email_outbound_messages (workspace_id, message_id) where message_id is not null;

alter table public.inbound_message_views
  add column if not exists channel text not null default 'whatsapp',
  add column if not exists email_event_id uuid references public.email_inbound_events (id) on delete cascade;
alter table public.inbound_message_views alter column message_id drop not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'inbound_message_views_channel_valid') then
    alter table public.inbound_message_views
      add constraint inbound_message_views_channel_valid check (
        (channel = 'whatsapp' and message_id is not null and email_event_id is null)
        or (channel = 'email' and email_event_id is not null and message_id is null)
      );
  end if;
end $$;

comment on table public.email_inbound_events is
  'D3: messages read (read-only) from the workspace mailbox over IMAP. Reply text only encrypted in body_*.';
comment on table public.email_imap_state is
  'D3: per-workspace IMAP polling state (uidvalidity, last_uid, last check / error).';
