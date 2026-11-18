-- =============================================================================
-- REL-1 release: migrations 044-053 (part C of 4). Generated from Supabase/migrations; do not edit by hand.
-- Paste the WHOLE file into Supabase -> SQL editor -> Run. Every migration here is additive and re-runnable:
-- if a part fails, fix the cause and run the same part again. Parts A, B, C, D in order; 020 comes later (03-migration-020.sql).
-- Lines marked 'SLOW ON A BIG TABLE' build an index on a table production already has (see 00-READ-ME-FIRST, step 4).
-- Files: 044_agent_live_mode.sql, 045_agent_message_quality.sql, 046_agent_readiness_since.sql, 047_agent_asset_rules.sql, 048_agent_writing_quality.sql, 049_agent_conversion_core.sql, 050_agent_whatsapp_length.sql, 051_reply_drafts.sql, 052_reminders_since.sql, 053_tracking_score_funnel.sql
-- =============================================================================


-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
-- >>> 044_agent_live_mode.sql
-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

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
-- A plain unique constraint (NULLs don't collide), like proposal_id / meeting_id, so the send path's
-- `on conflict (agent_decision_id)` works: one WhatsApp per decision.
drop index if exists public.whatsapp_outbound_agent_decision_unique;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'whatsapp_outbound_agent_decision_id_key') then
    alter table public.whatsapp_outbound_messages
      add constraint whatsapp_outbound_agent_decision_id_key unique (agent_decision_id);
  end if;
end $$;

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


-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
-- >>> 045_agent_message_quality.sql
-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

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


-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
-- >>> 046_agent_readiness_since.sql
-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

-- E2f: reset the go-live count.
--
-- agent_settings.readiness_since  the go-live gate (and /agent/stats readiness) counts only rated
--                                 decisions created on/after this time; null = all time. An admin
--                                 sets it to now() ("Reset go-live count") so ratings of drafts made
--                                 by older code or playbooks stay saved but no longer count.
-- Additive only.

alter table public.agent_settings add column if not exists readiness_since timestamptz;

comment on column public.agent_settings.readiness_since is
  'Go-live gate counts rated decisions created on/after this time; null = all time (E2f).';


-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
-- >>> 047_agent_asset_rules.sql
-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

-- E2g: AI attachments (asset library) made safe.
--
-- agent_assets.channels             gets a default of email only for new uploads (the column exists since 022;
--                                   existing rows keep their channels).
-- agent_decisions.sent_asset_ids    the assets that really went out with this decision's send (null = no
--                                   attachment sent, a draft, a dry run, or before E2g). "No double-sending"
--                                   reads it.
-- agent_decisions.attachment_issues send-time problems with the decision's attachments, e.g. the asset was
--                                   deleted before sending: [{assetId, title, reason}] (null = none). The
--                                   message went out without them.
-- Additive only.

alter table public.agent_assets alter column channels set default array['email']::text[];

alter table public.agent_decisions
  add column if not exists sent_asset_ids uuid[],
  add column if not exists attachment_issues jsonb;

comment on column public.agent_decisions.sent_asset_ids is
  'Assets really sent with this decision (E2g); null = none / not sent / dry run.';
comment on column public.agent_decisions.attachment_issues is
  'Attachments dropped at send time, [{assetId, title, reason}] (E2g); the message was sent without them.';


-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
-- >>> 048_agent_writing_quality.sql
-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

-- E3a: AI writing quality. Additive and re-runnable.
--
-- agent_settings.style_examples     admin-written examples of the style (≤ 6,000 characters; empty = no block).
-- agent_settings.banned_phrases     adds the "AI tone" clichés to every workspace (only those missing; admin edits stay).
-- agent_settings.email_max_words /  defaults 160/75 → 120/50; rows still on the old defaults move, admin-changed values stay.
--   whatsapp_max_words
-- email_outbound_messages           index for "this contact's latest AI email" (threading).

alter table public.agent_settings add column if not exists style_examples text not null default '';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'agent_settings_style_examples_length') then
    alter table public.agent_settings
      add constraint agent_settings_style_examples_length check (char_length(style_examples) <= 6000);
  end if;
end $$;

alter table public.agent_settings alter column email_max_words set default 120;
alter table public.agent_settings alter column whatsapp_max_words set default 50;
update public.agent_settings set email_max_words = 120 where email_max_words = 160;
update public.agent_settings set whatsapp_max_words = 50 where whatsapp_max_words = 75;

alter table public.agent_settings alter column banned_phrases set default array[
  'thanks for connecting', 'just following up', 'just checking in', 'any update', 'this week', 'today', 'free',
  'guarantee', 'guaranteed', 'revolutionary', 'skyrocket', '100+', '140+',
  'hope this message finds you well', 'hope this email finds you well', 'hope you are doing well', 'hope you''re doing well',
  'I wanted to reach out', 'touch base', 'circle back', 'delve', 'leverage', 'seamless', 'seamlessly', 'unlock', 'elevate',
  'game-changer', 'cutting-edge', 'in today''s fast-paced', 'I came across your', 'please do not hesitate', 'don''t hesitate',
  'feel free to', 'at your earliest convenience', 'synergy', 'revolutionize', 'supercharge'
]::text[];

-- Only the phrases a workspace doesn't have (ignoring case), never past the limit of 100.
update public.agent_settings s
   set banned_phrases = s.banned_phrases || coalesce((
     select array_agg(a.phrase order by a.ord)
       from (
         select n.phrase, n.ord
           from unnest(array[
             'hope this message finds you well', 'hope this email finds you well', 'hope you are doing well', 'hope you''re doing well',
             'I wanted to reach out', 'just following up', 'just checking in', 'touch base', 'circle back', 'delve', 'leverage',
             'seamless', 'seamlessly', 'unlock', 'elevate', 'game-changer', 'cutting-edge', 'in today''s fast-paced',
             'I came across your', 'please do not hesitate', 'don''t hesitate', 'feel free to', 'at your earliest convenience',
             'synergy', 'revolutionize', 'supercharge'
           ]) with ordinality n(phrase, ord)
          where not exists (select 1 from unnest(s.banned_phrases) e where lower(e) = lower(n.phrase))
          order by n.ord
          limit greatest(0, 100 - cardinality(s.banned_phrases))
       ) a
   ), '{}');

create index if not exists email_outbound_agent_thread_idx
  on public.email_outbound_messages (lead_id, sent_at desc)
  where source = 'agent' and status = 'sent';


-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
-- >>> 049_agent_conversion_core.sql
-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

-- E3b-1: conversion core. Additive and re-runnable.
--
-- agent_decisions.stage_key / angle   the stage plan (agent/stagePlan.ts) the decision was made under; null = before E3b-1.
-- agent_settings.first_channel        the channel of a contact's first AI message when both are usable (whatsapp | email).
-- profiles.booking_url                the user's own booking page (https, ≤ 300 chars); the AI adds it when it asks for a call.

alter table public.agent_decisions add column if not exists stage_key text;
alter table public.agent_decisions add column if not exists angle text;

alter table public.agent_settings add column if not exists first_channel text not null default 'whatsapp';

alter table public.profiles add column if not exists booking_url text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'agent_settings_first_channel_check') then
    alter table public.agent_settings
      add constraint agent_settings_first_channel_check check (first_channel in ('whatsapp', 'email'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'profiles_booking_url_check') then
    alter table public.profiles
      add constraint profiles_booking_url_check check (booking_url is null or (booking_url ~ '^https://[^\s]+$' and char_length(booking_url) <= 300));
  end if;
end $$;


-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
-- >>> 050_agent_whatsapp_length.sql
-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

-- E3b-1b: WhatsApp messages are mostly first messages now (welcome), and 50 words was too tight
-- (the 2026-11-03 model test failed drafts at 51–61 words). The hard limit becomes 60; the writer
-- aims for about 40 (two thirds, in the prompt). Additive and re-runnable.
--
-- agent_settings.whatsapp_max_words   default 50 → 60; rows still on 50 move, admin-changed values stay.

alter table public.agent_settings alter column whatsapp_max_words set default 60;
update public.agent_settings set whatsapp_max_words = 60 where whatsapp_max_words = 50;


-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
-- >>> 051_reply_drafts.sql
-- >>> SLOW ON A BIG TABLE: tasks_reply_escalation_idx on public.tasks; meetings_outcome_due_idx on public.meetings
-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

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


-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
-- >>> 052_reminders_since.sql
-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

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


-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
-- >>> 053_tracking_score_funnel.sql
-- >>> SLOW ON A BIG TABLE: leads_workspace_hot_score_idx on public.leads; leads_hot_score_dirty_idx on public.leads; leads_hot_score_at_idx on public.leads
-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

-- =============================================================================
-- Northbeam CRM -- E3b-2b: draft marker, email open tracking, per-message facts, hot-lead score
-- =============================================================================
--
-- reply_drafts.newer_reply_at          rule 2: the contact wrote again after this open draft while the
--                                      daily draft limit (3) was reached; the draft stays open.
-- email_outbound_messages.open_*       rules 8–12: a random URL-safe token per queued email (no personal
--                                      data), the open count and first / last / first counted open
--                                      (an open within 60 s of sending is not counted). Soft signal only.
-- integration_connections.track_opens  rule 10: the workspace's "Track email opens" (email row), default
--                                      OFF everywhere; the pixel also needs PUBLIC_API_BASE_URL.
-- whatsapp_connection.id               rule 14: a stable id per WhatsApp connection (one per workspace
--                                      today; multi-number E4a), recorded on each message fact.
-- message_facts                        rule 14: one row per message that really went out (not queued, not
--                                      dry run), with its outcomes attributed by last touch (≤ 14 days).
-- agent_settings.target_industry_keywords  rule 16: the workspace's buyer industries (MOTM gets a default).
-- leads.hot_*                          rules 15, 17: the hot-lead score, recomputed by the worker sweeper;
--                                      hot_score_dirty marks a lead for recompute (default true: every
--                                      existing lead is backfilled after deploy).
--
-- Additive and re-runnable. RLS on message_facts with no policies (backend service role only).
-- =============================================================================

alter table public.reply_drafts add column if not exists newer_reply_at timestamptz;

comment on column public.reply_drafts.newer_reply_at is
  'E3b-2b rule 2: a newer matched reply arrived after the daily draft limit; the open draft was kept.';

-- --- Email open tracking -------------------------------------------------------

alter table public.email_outbound_messages
  add column if not exists open_token text,
  add column if not exists open_count integer not null default 0,
  add column if not exists first_opened_at timestamptz,
  add column if not exists last_opened_at timestamptz,
  add column if not exists first_counted_open_at timestamptz,
  add column if not exists open_event_at timestamptz;

create unique index if not exists email_outbound_open_token_idx on public.email_outbound_messages (open_token) where open_token is not null;

comment on column public.email_outbound_messages.open_token is 'E3b-2b: random URL-safe token (128 bits) for the open pixel; no personal data.';
-- The worker's queue of counted opens not yet turned into the timeline event / attribution / score mark.
create index if not exists email_outbound_open_events_idx on public.email_outbound_messages (first_counted_open_at)
  where first_counted_open_at is not null and open_event_at is null;
comment on column public.email_outbound_messages.open_event_at is 'E3b-2b: when the worker recorded the first counted open (timeline event, attribution, score mark); the pixel route only updates counts.';
comment on column public.email_outbound_messages.first_counted_open_at is 'E3b-2b: first open more than 60 s after sending (earlier ones are prefetches: counted in open_count only).';

alter table public.integration_connections add column if not exists track_opens boolean not null default false;

comment on column public.integration_connections.track_opens is
  'E3b-2b: "Track email opens" (email row; admin-only; default off). Needs PUBLIC_API_BASE_URL too.';

-- --- Per-message facts -------------------------------------------------------------

alter table public.whatsapp_connection add column if not exists id uuid not null default gen_random_uuid();
create unique index if not exists whatsapp_connection_id_idx on public.whatsapp_connection (id);

create table if not exists public.message_facts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  lead_id uuid not null references public.leads (id) on delete cascade,
  source text not null,
  channel text not null,
  agent_decision_id uuid references public.agent_decisions (id) on delete set null,
  email_outbound_id uuid references public.email_outbound_messages (id) on delete set null,
  whatsapp_outbound_id uuid references public.whatsapp_outbound_messages (id) on delete set null,
  stage_key text,
  angle text,
  message_number integer not null,
  whatsapp_connection_id uuid,
  sent_at timestamptz not null,
  first_counted_open_at timestamptz,
  replied_at timestamptz,
  reply_label text,
  meeting_booked_at timestamptz,
  deal_created_at timestamptz,
  deal_won_at timestamptz,
  created_at timestamptz not null default now(),
  constraint message_facts_channel_valid check (channel in ('email', 'whatsapp')),
  constraint message_facts_source_valid check (source in ('agent', 'workflow', 'reply_draft', 'proposal', 'meeting')),
  constraint message_facts_email_unique unique (email_outbound_id),
  constraint message_facts_whatsapp_unique unique (whatsapp_outbound_id)
);

alter table public.message_facts enable row level security;

-- Never both outbound ids; either may become null when its outbound row is deleted (on delete set null).
alter table public.message_facts drop constraint if exists message_facts_one_outbound;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'message_facts_not_both_outbound') then
    alter table public.message_facts add constraint message_facts_not_both_outbound
      check (email_outbound_id is null or whatsapp_outbound_id is null);
  end if;
end $$;
create index if not exists message_facts_decision_idx on public.message_facts (agent_decision_id) where agent_decision_id is not null;

-- Attribution (last message to the lead) and message_number; funnel by period.
create index if not exists message_facts_lead_sent_idx on public.message_facts (lead_id, sent_at desc);
create index if not exists message_facts_ws_sent_idx on public.message_facts (workspace_id, sent_at);

comment on table public.message_facts is
  'E3b-2b rule 14: one row per message that really went out; outcomes set once by attributeOutcome (last touch, 14 days).';

-- --- Hot-lead score ------------------------------------------------------------------

alter table public.agent_settings add column if not exists target_industry_keywords text[] not null default '{}';

comment on column public.agent_settings.target_industry_keywords is
  'E3b-2b rule 16: the workspace''s target buyer industries (lower case); empty = fit uses domain, company and revenue only.';

update public.agent_settings
   set target_industry_keywords = array['engineering', 'manufacturing', 'industrial', 'machinery', 'fabrication', 'castings', 'forgings',
     'pumps', 'valves', 'automation', 'chemicals', 'steel', 'polymers', 'plastics', 'packaging', 'electrical', 'hydraulics', 'conveyors',
     'tools', 'epc', 'water treatment']
 where workspace_id = '00000000-0000-0000-0000-000000000001' and target_industry_keywords = '{}';

alter table public.leads
  add column if not exists hot_score smallint,
  add column if not exists hot_band text,
  add column if not exists hot_reasons text[],
  add column if not exists hot_score_at timestamptz,
  add column if not exists hot_score_dirty boolean not null default true;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'leads_hot_band_valid') then
    alter table public.leads add constraint leads_hot_band_valid check (hot_band is null or hot_band in ('hot', 'warm', 'cold'));
  end if;
end $$;

-- Contacts list sort (B4: (workspace_id, field, id), NULLs last) and the sweeper's two queues.
create index if not exists leads_workspace_hot_score_idx on public.leads (workspace_id, hot_score desc nulls last, id desc);
create index if not exists leads_hot_score_dirty_idx on public.leads (id) where hot_score_dirty;
create index if not exists leads_hot_score_at_idx on public.leads (hot_score_at) where merged_into_lead_id is null;

comment on column public.leads.hot_score is 'E3b-2b rule 15: hot-lead score 0–100 (domain/leadScore.ts), recomputed by the worker; null = not computed yet.';
comment on column public.leads.hot_score_dirty is 'E3b-2b rule 17: set by services when an input changed; the worker sweeper recomputes and clears it.';

-- A score-only update (the sweeper, a recompute mark) keeps leads.updated_at: "recently updated"
-- stays about real changes. Runs after leads_set_updated_at (triggers fire in name order).
create or replace function public.leads_keep_updated_at_for_score()
returns trigger
language plpgsql
as $$
declare
  score_columns constant text[] := array['hot_score', 'hot_band', 'hot_reasons', 'hot_score_at', 'hot_score_dirty', 'updated_at'];
begin
  if (to_jsonb(new) - score_columns) = (to_jsonb(old) - score_columns) then
    new.updated_at := old.updated_at;
  end if;
  return new;
end;
$$;

drop trigger if exists leads_zz_keep_updated_at_for_score on public.leads;
create trigger leads_zz_keep_updated_at_for_score
  before update on public.leads
  for each row
  when (old.hot_score_dirty is distinct from new.hot_score_dirty or old.hot_score is distinct from new.hot_score
        or old.hot_score_at is distinct from new.hot_score_at or old.hot_band is distinct from new.hot_band
        or old.hot_reasons is distinct from new.hot_reasons)
  execute function public.leads_keep_updated_at_for_score();

-- Funnel (rule 19) and score inputs: replies by contact, email replies by period.
create index if not exists whatsapp_inbound_lead_idx on public.whatsapp_inbound_events (lead_id) where lead_id is not null;
create index if not exists email_inbound_ws_received_idx on public.email_inbound_events (workspace_id, received_at);
