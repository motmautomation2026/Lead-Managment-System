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
