-- =============================================================================
-- Northbeam CRM -- E1b: email through SMTP only (queue, limits, auto-pause)
-- =============================================================================
--
-- integration_connections (the workspace's 'email' row, admin-adjustable):
--   configured_at           when SMTP was first saved under E1b (warm-up start). Null = never
--                           saved under E1b: no warm-up until an admin saves SMTP.
--   already_warmed          admin says the mailbox has sent normal email for months: no warm-up.
--   daily_cap / hourly_cap  100 per IST day / 20 per IST clock hour.
--   min/max_delay_seconds   random spacing between two emails of the workspace (30-90 s).
--   send_window_days        ISO weekdays (1 = Monday) automated email may go out (Mon-Sat).
--   send_window_start/_end  IST wall-clock window for automated email (09:30-19:00).
--   next_send_at            earliest time the next email may go out (spacing).
--   paused_reason/_at/_by   why sending was turned off (`enabled` = false); _by null = auto-pause.
--   resumed_at              last admin resume; auto-pause signals count only after it.
-- IMAP non-secret fields live in `settings` next to SMTP's; IMAP secrets in the same encrypted
-- blob. Rows whose provider is 'resend' stay untouched (the code treats them as not configured).
--
-- email_outbound_messages: every email (workflow step, proposal, meeting notification, test;
-- later the AI), one row per (source, source_id), sent only by the worker.
-- email_safety_events: signals and pauses.
-- Additive and idempotent.
-- =============================================================================

alter table public.integration_connections
  add column if not exists configured_at timestamptz,
  add column if not exists already_warmed boolean not null default false,
  add column if not exists daily_cap integer not null default 100,
  add column if not exists hourly_cap integer not null default 20,
  add column if not exists min_delay_seconds integer not null default 30,
  add column if not exists max_delay_seconds integer not null default 90,
  add column if not exists send_window_days smallint[] not null default '{1,2,3,4,5,6}',
  add column if not exists send_window_start time not null default '09:30',
  add column if not exists send_window_end time not null default '19:00',
  add column if not exists next_send_at timestamptz,
  add column if not exists paused_reason text,
  add column if not exists paused_at timestamptz,
  add column if not exists paused_by uuid references public.profiles (id) on delete set null,
  add column if not exists resumed_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'email_limits_valid') then
    alter table public.integration_connections
      add constraint email_limits_valid check (
        daily_cap between 1 and 10000
        and hourly_cap between 1 and 1000
        and min_delay_seconds between 1 and 3600
        and max_delay_seconds between min_delay_seconds and 3600
      );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'email_send_window_valid') then
    alter table public.integration_connections
      add constraint email_send_window_valid check (
        send_window_start < send_window_end
        and cardinality(send_window_days) between 1 and 7
        and send_window_days <@ '{1,2,3,4,5,6,7}'::smallint[]
      );
  end if;
end $$;

create table if not exists public.email_outbound_messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  source text not null,
  source_id uuid not null,
  lead_id uuid references public.leads (id) on delete set null,
  to_address text not null,
  -- Null = the mailbox's default from name at send time.
  from_name text,
  -- Emails to a contact get List-Unsubscribe.
  to_contact boolean not null default false,
  subject text not null,
  html text not null,
  text_body text not null,
  -- [{bucket, path, fileName, mimeType, size}], downloaded by the worker at send time.
  attachments jsonb not null default '[]'::jsonb,
  status text not null default 'queued',
  attempts integer not null default 0,
  -- Queued: when it may be tried. Sending: the reclaim time (claim + 15 min).
  next_attempt_at timestamptz not null default now(),
  last_error text,
  smtp_response text,
  message_id text,
  dry_run boolean not null default false,
  sent_at timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint email_outbound_source_valid check (source in ('scheduled_action', 'proposal', 'meeting', 'test', 'agent')),
  constraint email_outbound_status_valid check (status in ('queued', 'sending', 'sent', 'failed', 'cancelled')),
  constraint email_outbound_source_unique unique (source, source_id)
);
alter table public.email_outbound_messages enable row level security;

drop trigger if exists email_outbound_messages_set_updated_at on public.email_outbound_messages;
create trigger email_outbound_messages_set_updated_at
  before update on public.email_outbound_messages
  for each row execute function public.set_updated_at();

-- The claim (due queued/sending rows) and the counts (sent today / this hour / 24 h).
create index if not exists email_outbound_due_idx
  on public.email_outbound_messages (next_attempt_at)
  where status in ('queued', 'sending');
create index if not exists email_outbound_ws_sent_at_idx
  on public.email_outbound_messages (workspace_id, sent_at)
  where status = 'sent' and not dry_run;

create table if not exists public.email_safety_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  kind text not null,
  detail text,
  created_at timestamptz not null default now(),
  constraint email_safety_event_kind_valid check (
    kind in ('send_failed', 'recipient_rejected', 'login_rejected', 'rate_limited', 'paused', 'resumed')
  )
);
alter table public.email_safety_events enable row level security;

create index if not exists email_safety_events_ws_idx
  on public.email_safety_events (workspace_id, created_at desc);

comment on column public.integration_connections.configured_at is
  'E1b: when SMTP was first saved under E1b (warm-up start); null = no warm-up until then.';
