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
