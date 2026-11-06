-- =============================================================================
-- Northbeam CRM -- no old-task flood on deploy (E3b-2a-2 rule 2)
-- =============================================================================
--
-- agent_settings.reminders_since   the 2-hour reply escalation and the "Log the meeting outcome"
--                                  task act only on reply tasks / meetings created at or after it.
--                                  Existing workspaces get the time this migration is applied (a
--                                  fixed cut-off: older open tasks and meetings are never acted on);
--                                  new workspaces get their creation time.
--
-- Additive and re-runnable.
-- =============================================================================

alter table public.agent_settings add column if not exists reminders_since timestamptz not null default now();

comment on column public.agent_settings.reminders_since is
  'E3b-2a-2: escalation and meeting-outcome tasks only for reply tasks / meetings created at or after this (set when migration 052 was applied).';
