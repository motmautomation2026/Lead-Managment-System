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
