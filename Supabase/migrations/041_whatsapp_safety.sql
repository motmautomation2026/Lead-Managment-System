-- =============================================================================
-- Northbeam CRM -- E1: WhatsApp safety (slower, capped, windowed sending + auto-pause)
-- =============================================================================
--
-- whatsapp_connection (per workspace, admin-adjustable):
--   min/max_delay_seconds   new defaults 45-120 s; rows still on the old 5/15 defaults move too.
--   paired_at               when this number was paired (QR scan). Null = paired before E1,
--                           counted as fully warmed up. Cleared on logout.
--   max_new_chats_per_day   first messages to never-contacted phones per IST day (20).
--   send_window_days        ISO weekdays (1 = Monday) automated sends may go out (Mon-Sat).
--   send_window_start/_end  IST wall-clock window for automated sends (09:30-19:00).
--   next_send_at            earliest time the next send may go out (spacing).
--   paused_reason/_at/_by   why outbound was turned off (`enabled` = false); _by null = auto-pause.
--   resumed_at              last admin resume; auto-pause signals count only after it.
--
-- whatsapp_outbound_messages.new_chat: the send was this workspace's first message to the phone.
-- whatsapp_safety_events: signals (send failures, reconnect failures, disconnects) and pauses.
-- Additive and idempotent.
-- =============================================================================

alter table public.whatsapp_connection
  add column if not exists paired_at timestamptz,
  add column if not exists max_new_chats_per_day integer not null default 20,
  add column if not exists send_window_days smallint[] not null default '{1,2,3,4,5,6}',
  add column if not exists send_window_start time not null default '09:30',
  add column if not exists send_window_end time not null default '19:00',
  add column if not exists next_send_at timestamptz,
  add column if not exists paused_reason text,
  add column if not exists paused_at timestamptz,
  add column if not exists paused_by uuid references public.profiles (id) on delete set null,
  add column if not exists resumed_at timestamptz;

alter table public.whatsapp_connection alter column min_delay_seconds set default 45;
alter table public.whatsapp_connection alter column max_delay_seconds set default 120;
update public.whatsapp_connection set min_delay_seconds = 45, max_delay_seconds = 120
 where min_delay_seconds = 5 and max_delay_seconds = 15;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'whatsapp_new_chats_valid') then
    alter table public.whatsapp_connection
      add constraint whatsapp_new_chats_valid check (max_new_chats_per_day between 0 and 1000);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'whatsapp_send_window_valid') then
    alter table public.whatsapp_connection
      add constraint whatsapp_send_window_valid check (
        send_window_start < send_window_end
        and cardinality(send_window_days) between 1 and 7
        and send_window_days <@ '{1,2,3,4,5,6,7}'::smallint[]
      );
  end if;
end $$;

alter table public.whatsapp_outbound_messages
  add column if not exists new_chat boolean not null default false;

create table if not exists public.whatsapp_safety_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  kind text not null,
  detail text,
  created_at timestamptz not null default now(),
  constraint whatsapp_safety_event_kind_valid check (
    kind in ('send_failed', 'reconnect_failed', 'disconnected', 'restricted', 'paused', 'resumed')
  )
);
alter table public.whatsapp_safety_events enable row level security;

create index if not exists whatsapp_safety_events_ws_idx
  on public.whatsapp_safety_events (workspace_id, created_at desc);

-- Rule 4/6 "never messaged / never heard from this phone".
create index if not exists whatsapp_outbound_ws_jid_sent_idx
  on public.whatsapp_outbound_messages (workspace_id, remote_jid)
  where status = 'sent';
create index if not exists whatsapp_inbound_ws_phone_idx
  on public.whatsapp_inbound_events (workspace_id, sender_phone_e164);

-- Daily counts (sent today, new chats today) and the 24 h STOP signal.
create index if not exists whatsapp_outbound_ws_sent_at_idx
  on public.whatsapp_outbound_messages (workspace_id, sent_at)
  where status = 'sent';
create index if not exists whatsapp_inbound_ws_stop_idx
  on public.whatsapp_inbound_events (workspace_id, received_at)
  where reply_label = 'asked_to_stop';

comment on column public.whatsapp_connection.paired_at is
  'E1: when this number was paired; null = paired before E1 (fully warmed up).';
