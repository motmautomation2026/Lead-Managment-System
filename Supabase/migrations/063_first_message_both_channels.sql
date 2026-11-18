-- =============================================================================
-- Northbeam CRM -- HOTFIX-2: the first AI message on both channels
-- =============================================================================
--
-- agent_settings.first_channel        may now also be 'both': the contact's first AI message goes as one WhatsApp
--                                     AND one email (each written and checked for its channel).
-- agent_decisions.paired_decision_id  the second message of a 'both' first message points to the first one's
--                                     decision: the pair counts as ONE touch (48 h gap, 2 per week, 8 in total)
--                                     and ONE decision toward the daily cap. Null = a normal decision.
-- Additive and re-runnable.
-- =============================================================================

alter table public.agent_settings drop constraint if exists agent_settings_first_channel_check;
alter table public.agent_settings
  add constraint agent_settings_first_channel_check check (first_channel in ('whatsapp', 'email', 'both'));

alter table public.agent_decisions
  add column if not exists paired_decision_id uuid references public.agent_decisions (id) on delete cascade;

create index if not exists agent_decisions_paired_idx
  on public.agent_decisions (paired_decision_id) where paired_decision_id is not null;
