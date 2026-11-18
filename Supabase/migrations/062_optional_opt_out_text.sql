-- =============================================================================
-- Northbeam CRM -- HOTFIX-1: the workspace opt-out texts are optional
-- =============================================================================
--
-- agent_settings.email_opt_out_text / whatsapp_opt_out_text may now be empty ('' = no opt-out line is appended to
-- the email footer / the first WhatsApp message; services/agentSettings.service.ts stores a blank value as '').
-- Drops the two non-blank checks from 024; the columns stay NOT NULL. STOP replies still opt the lead out.
-- Re-runnable.
-- =============================================================================

alter table public.agent_settings drop constraint if exists agent_settings_email_opt_out_text_check;
alter table public.agent_settings drop constraint if exists agent_settings_whatsapp_opt_out_text_check;
