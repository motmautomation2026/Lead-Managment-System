-- =============================================================================
-- Northbeam CRM -- E2b: AI message quality
-- =============================================================================
--
-- agent_settings.banned_phrases        phrases an AI message must never contain (admin-editable).
-- agent_settings.email_max_words /     the existing word limits (migration 024): defaults 250/80 → 160/75
--   whatsapp_max_words                 (the playbook's limits); rows still on the old defaults move; 1–500.
-- agent_decisions.quality_checks       the problems each drafting attempt failed (message checks, style,
--                                      grounding), for AI Activity. Null = before E2b.
-- kb_documents.chunker_version         the chunker that produced the document's chunks (null = before E2b).
--                                      The worker re-chunks and re-embeds ready documents on an older
--                                      version, so production re-chunks by itself after deploy.
--
-- Additive and idempotent. agent_decisions.playbook_version already exists (migration 024).
-- =============================================================================

alter table public.agent_settings
  add column if not exists banned_phrases text[] not null default array[
    'thanks for connecting', 'just following up', 'just checking in', 'any update', 'this week', 'today', 'free',
    'guarantee', 'guaranteed', 'revolutionary', 'skyrocket', '100+', '140+'
  ]::text[];

alter table public.agent_settings alter column email_max_words set default 160;
alter table public.agent_settings alter column whatsapp_max_words set default 75;
update public.agent_settings set email_max_words = 160 where email_max_words = 250;
update public.agent_settings set whatsapp_max_words = 75 where whatsapp_max_words = 80;
update public.agent_settings set email_max_words = 500 where email_max_words > 500;
update public.agent_settings set whatsapp_max_words = 500 where whatsapp_max_words > 500;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'agent_settings_max_words_range') then
    alter table public.agent_settings
      add constraint agent_settings_max_words_range check (email_max_words between 1 and 500 and whatsapp_max_words between 1 and 500);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'agent_settings_banned_phrases_valid') then
    alter table public.agent_settings
      add constraint agent_settings_banned_phrases_valid check (cardinality(banned_phrases) <= 100);
  end if;
end $$;

alter table public.agent_decisions
  add column if not exists quality_checks jsonb;

alter table public.kb_documents
  add column if not exists chunker_version int;
