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
