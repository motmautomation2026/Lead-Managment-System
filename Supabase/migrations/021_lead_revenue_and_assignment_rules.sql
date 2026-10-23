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
