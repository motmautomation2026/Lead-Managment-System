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
