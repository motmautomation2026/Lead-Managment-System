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
