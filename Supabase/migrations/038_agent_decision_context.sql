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
