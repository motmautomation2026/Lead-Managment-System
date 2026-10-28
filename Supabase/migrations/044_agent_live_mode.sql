-- =============================================================================
-- Northbeam CRM -- E2: AI Live mode (Feature 6)
-- =============================================================================
--
-- agent_settings.live_scope   which AI contacts are live in a 'live' workspace:
--                             test_contacts (only contacts marked "AI live test"),
--                             new_leads (created at/after live_since), all.
-- agent_settings.live_since   when the new_leads scope was switched on.
-- leads.agent_live_test       an admin marked this contact as an AI live test contact.
-- agent_decisions.send_*      the real send of a live send decision (null = draft / not a send):
--                             queued | sending | sent | failed | cancelled | dry_run.
-- whatsapp_outbound_messages.agent_decision_id   the AI's WhatsApp sends (one per decision).
--
-- Defaults keep production safe: no workspace is live, scope test_contacts, no contact marked.
-- Additive and idempotent.
-- =============================================================================

alter table public.agent_settings
  add column if not exists live_scope text not null default 'test_contacts',
  add column if not exists live_since timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'agent_settings_live_scope_valid') then
    alter table public.agent_settings
      add constraint agent_settings_live_scope_valid check (live_scope in ('test_contacts', 'new_leads', 'all'));
  end if;
end $$;

alter table public.leads
  add column if not exists agent_live_test boolean not null default false,
  add column if not exists agent_live_test_by uuid references public.profiles (id) on delete set null,
  add column if not exists agent_live_test_at timestamptz;

alter table public.agent_decisions
  add column if not exists send_status text,
  add column if not exists send_attempts int not null default 0,
  add column if not exists send_next_at timestamptz,
  add column if not exists send_claimed_at timestamptz,
  add column if not exists sent_at timestamptz,
  add column if not exists send_error text,
  add column if not exists cancel_reason text,
  add column if not exists provider_message_id text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'agent_decisions_send_status_valid') then
    alter table public.agent_decisions
      add constraint agent_decisions_send_status_valid
      check (send_status is null or send_status in ('queued', 'sending', 'sent', 'failed', 'cancelled', 'dry_run'));
  end if;
end $$;

-- The WhatsApp send claim loop (email sends go through email_outbound_messages).
create index if not exists agent_decisions_send_due_idx
  on public.agent_decisions (send_next_at) where send_status in ('queued', 'sending');
-- Real sends per contact (touches, limits, "sent today / this month").
create index if not exists agent_decisions_lead_sent_idx
  on public.agent_decisions (lead_id, sent_at) where send_status = 'sent';
create index if not exists agent_decisions_ws_sent_idx
  on public.agent_decisions (workspace_id, sent_at) where send_status = 'sent';

alter table public.whatsapp_outbound_messages
  add column if not exists agent_decision_id uuid references public.agent_decisions (id) on delete cascade;
create unique index if not exists whatsapp_outbound_agent_decision_unique
  on public.whatsapp_outbound_messages (agent_decision_id) where agent_decision_id is not null;

-- 'agent' joins the WhatsApp sources (email_outbound_messages already allows it, migration 042).
alter table public.whatsapp_outbound_messages drop constraint if exists whatsapp_outbound_exactly_one_source;
alter table public.whatsapp_outbound_messages
  add constraint whatsapp_outbound_exactly_one_source check (
    ((scheduled_action_id is not null)::int + (proposal_id is not null)::int + (meeting_id is not null)::int
      + (agent_decision_id is not null)::int) = 1
  );

comment on column public.agent_settings.live_scope is
  'E2: in a live workspace, which AI contacts are live: test_contacts | new_leads (created >= live_since) | all. Others run as shadow.';
comment on column public.leads.agent_live_test is
  'E2: an admin marked this contact as an AI live test contact (live in a live workspace without the go-live gate).';
comment on column public.agent_decisions.send_status is
  'E2: the real send of a live send decision: queued | sending | sent | failed | cancelled | dry_run; null for drafts.';
