-- =============================================================================
-- Northbeam CRM -- reply drafts for reps, 2-hour escalation, meeting-outcome task (E3b-2a)
-- =============================================================================
--
-- reply_drafts                          ONE suggested reply per matched lead reply (WhatsApp or email),
--                                       written by the worker for the owner; the rep sends (edited or not)
--                                       or discards it. Never holds the lead's reply text. Backend only:
--                                       RLS on, no policies.
-- whatsapp_inbound_events / email_inbound_events.draft_status / draft_attempts / draft_next_at
--                                       the draft step's queue (pending | done | skipped | failed; null =
--                                       not asked for); draft_attempts is the claim token.
-- whatsapp_outbound_messages.reply_draft_id   the 5th WhatsApp source: a rep's Send of a reply draft.
-- email_outbound_messages.source 'reply_draft' (source_id = the draft id).
-- tasks.escalated_at                    the admins were told once that this reply task is unanswered (2 working h).
-- meetings.outcome_task_created_at      the "Log the meeting outcome" task was created for this meeting.
--
-- Additive and re-runnable.
-- =============================================================================

create table if not exists public.reply_drafts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id),
  lead_id uuid not null references public.leads (id) on delete cascade,
  channel text not null,
  whatsapp_message_id text references public.whatsapp_inbound_events (message_id) on delete cascade,
  email_event_id uuid references public.email_inbound_events (id) on delete cascade,
  -- Ours, never the lead's: the email subject we will use (the thread we started) and the model's body.
  subject text,
  body text,
  -- The lead's Message-ID header, for In-Reply-To / References (metadata, not text).
  in_reply_to text,
  status text not null default 'open',
  -- Names of the checks that failed (a failed draft), never quotes.
  problems text[],
  model text,
  input_tokens integer,
  output_tokens integer,
  cost_usd numeric(12, 6),
  -- The rep's Send: final body (as edited), who, when, whether it differs from the draft.
  sent_body text,
  edited boolean,
  sent_by uuid references public.profiles (id) on delete set null,
  sent_by_name text,
  queued_at timestamptz,
  discarded_by uuid references public.profiles (id) on delete set null,
  discarded_at timestamptz,
  -- Delivery of a WhatsApp send (an email's lives in email_outbound_messages, mirrored here).
  send_status text,
  send_attempts integer not null default 0,
  send_next_at timestamptz,
  send_claimed_at timestamptz,
  sent_at timestamptz,
  send_error text,
  provider_message_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reply_drafts_channel_valid check (channel in ('whatsapp', 'email')),
  constraint reply_drafts_one_reply check (
    (channel = 'whatsapp' and whatsapp_message_id is not null and email_event_id is null)
    or (channel = 'email' and email_event_id is not null and whatsapp_message_id is null)
  ),
  constraint reply_drafts_status_valid check (status in ('open', 'sent', 'discarded', 'superseded', 'failed')),
  constraint reply_drafts_send_status_valid check (send_status is null or send_status in ('queued', 'sending', 'sent', 'failed', 'cancelled')),
  constraint reply_drafts_body_when_open check (status = 'failed' or body is not null),
  constraint reply_drafts_whatsapp_unique unique (whatsapp_message_id),
  constraint reply_drafts_email_unique unique (email_event_id)
);

alter table public.reply_drafts enable row level security;

create index if not exists reply_drafts_lead_idx on public.reply_drafts (lead_id, created_at);
create index if not exists reply_drafts_ws_created_idx on public.reply_drafts (workspace_id, created_at);
create index if not exists reply_drafts_send_due_idx on public.reply_drafts (send_next_at) where send_status in ('queued', 'sending');

drop trigger if exists reply_drafts_set_updated_at on public.reply_drafts;
create trigger reply_drafts_set_updated_at
  before update on public.reply_drafts
  for each row execute function public.set_updated_at();

alter table public.whatsapp_inbound_events
  add column if not exists draft_status text,
  add column if not exists draft_attempts integer not null default 0,
  add column if not exists draft_next_at timestamptz;
alter table public.email_inbound_events
  add column if not exists draft_status text,
  add column if not exists draft_attempts integer not null default 0,
  add column if not exists draft_next_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'whatsapp_inbound_draft_status_valid') then
    alter table public.whatsapp_inbound_events
      add constraint whatsapp_inbound_draft_status_valid check (draft_status is null or draft_status in ('pending', 'done', 'skipped', 'failed'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'email_inbound_draft_status_valid') then
    alter table public.email_inbound_events
      add constraint email_inbound_draft_status_valid check (draft_status is null or draft_status in ('pending', 'done', 'skipped', 'failed'));
  end if;
end $$;

create index if not exists whatsapp_inbound_draft_pending_idx on public.whatsapp_inbound_events (draft_next_at) where draft_status = 'pending';
create index if not exists email_inbound_draft_pending_idx on public.email_inbound_events (draft_next_at) where draft_status = 'pending';

-- The 5th WhatsApp source.
alter table public.whatsapp_outbound_messages
  add column if not exists reply_draft_id uuid references public.reply_drafts (id) on delete cascade;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'whatsapp_outbound_reply_draft_id_key') then
    alter table public.whatsapp_outbound_messages
      add constraint whatsapp_outbound_reply_draft_id_key unique (reply_draft_id);
  end if;
end $$;
alter table public.whatsapp_outbound_messages drop constraint if exists whatsapp_outbound_exactly_one_source;
alter table public.whatsapp_outbound_messages
  add constraint whatsapp_outbound_exactly_one_source check (
    ((scheduled_action_id is not null)::int + (proposal_id is not null)::int + (meeting_id is not null)::int
      + (agent_decision_id is not null)::int + (reply_draft_id is not null)::int) = 1
  );

alter table public.email_outbound_messages drop constraint if exists email_outbound_source_valid;
alter table public.email_outbound_messages
  add constraint email_outbound_source_valid check (source in ('scheduled_action', 'proposal', 'meeting', 'test', 'agent', 'reply_draft'));

alter table public.tasks add column if not exists escalated_at timestamptz;
create index if not exists tasks_reply_escalation_idx on public.tasks (workspace_id, created_at)
  where status = 'open' and origin = 'agent' and escalated_at is null;

alter table public.meetings add column if not exists outcome_task_created_at timestamptz;
create index if not exists meetings_outcome_due_idx on public.meetings (scheduled_at)
  where outcome is null and outcome_task_created_at is null;

comment on table public.reply_drafts is
  'E3b-2a: one AI-suggested reply per matched lead reply, for the owner to send (edited or not) or discard. Never stores the lead''s text.';
comment on column public.tasks.escalated_at is
  'E3b-2a: admins were notified that this reply task was not done 2 working hours after the reply (once).';
comment on column public.meetings.outcome_task_created_at is
  'E3b-2a: the "Log the meeting outcome" task was created (once per meeting, 2 days after it with no outcome).';
