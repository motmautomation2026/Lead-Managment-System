-- =============================================================================
-- Northbeam CRM -- E4a: several WhatsApp numbers per workspace (sticky number per lead)
-- =============================================================================
--
-- whatsapp_numbers                  one row per number: its own pairing (QR), status, socket control,
--                                   paired_at / warm-up, daily cap, spacing, new-chat limit, outbound
--                                   on/off and auto-pause (the E1 columns, per number), optional owner,
--                                   soft delete (removed_at).
-- whatsapp_number_auth_credentials  Baileys auth state keyed per number (replaces the per-workspace
-- whatsapp_number_auth_keys         whatsapp_auth_* tables, which are kept but no longer used).
-- whatsapp_connection               stays the per-WORKSPACE row: the send window, `outbound_enabled`
--                                   (master switch for all numbers) and `max_numbers` (default 5).
--                                   Its per-number columns (status, QR, paired_at, caps, pause …) are
--                                   legacy after 054: copied into number #1 and no longer read.
-- leads.whatsapp_number_id          the lead's sticky number (set on the first send / first inbound).
-- whatsapp_outbound_messages / whatsapp_inbound_events / whatsapp_safety_events .whatsapp_number_id
--                                   which number sent / received / signalled; per-number counters.
-- whatsapp_inbound_events.other_number  the reply arrived on another number than the lead's sticky one.
-- message_facts.whatsapp_number_id  the number used (funnel "number" grouping).
--
-- Backfill (rule 11): each workspace's existing connection becomes number #1 with THE SAME id
-- (message_facts.whatsapp_connection_id history keeps matching), the same paired_at and a copy of
-- its auth state (no re-pairing, no warm-up restart); every lead that ever had WhatsApp traffic
-- (a sent message or a matched reply) and every existing outbound / inbound / safety row get #1.
-- Additive and re-runnable: the backfill only touches workspaces whose #1 is created by this run.
-- Stop the worker before applying in production (its auth writes would go to the old tables).
-- =============================================================================

create table if not exists public.whatsapp_numbers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  label text not null,
  owner_user_id uuid references public.profiles (id) on delete set null,
  enabled boolean not null default true,
  desired_state text not null default 'disconnected',
  status text not null default 'disconnected',
  command_version bigint not null default 0,
  connected_jid text,
  connected_phone text,
  display_name text,
  qr_ciphertext bytea,
  qr_iv bytea,
  qr_tag bytea,
  qr_key_version integer not null default 1,
  qr_expires_at timestamptz,
  last_error text,
  reachout_lock jsonb,
  new_chat_cap jsonb,
  worker_heartbeat_at timestamptz,
  last_connected_at timestamptz,
  last_disconnected_at timestamptz,
  daily_cap integer not null default 200,
  min_delay_seconds integer not null default 45,
  max_delay_seconds integer not null default 120,
  paired_at timestamptz,
  max_new_chats_per_day integer not null default 20,
  next_send_at timestamptz,
  paused_reason text,
  paused_at timestamptz,
  paused_by uuid references public.profiles (id) on delete set null,
  resumed_at timestamptz,
  removed_at timestamptz,
  removed_by uuid references public.profiles (id) on delete set null,
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whatsapp_number_label_valid check (length(trim(label)) between 1 and 60),
  constraint whatsapp_number_desired_state_valid check (desired_state in ('connected', 'disconnected', 'restart')),
  constraint whatsapp_number_status_valid check (
    status in ('disconnected', 'connecting', 'qr_ready', 'connected', 'reconnecting', 'reauth_required', 'error')
  ),
  constraint whatsapp_number_qr_complete check (
    (qr_ciphertext is null and qr_iv is null and qr_tag is null and qr_expires_at is null)
    or (qr_ciphertext is not null and qr_iv is not null and qr_tag is not null and qr_expires_at is not null)
  ),
  constraint whatsapp_number_daily_cap_valid check (daily_cap between 1 and 10000),
  constraint whatsapp_number_delay_valid check (min_delay_seconds between 1 and 300 and max_delay_seconds between min_delay_seconds and 600),
  constraint whatsapp_number_new_chats_valid check (max_new_chats_per_day between 0 and 1000)
);
alter table public.whatsapp_numbers enable row level security;

-- Registry scan (rule 12) and the per-workspace list / choice.
create index if not exists whatsapp_numbers_workspace_idx on public.whatsapp_numbers (workspace_id) where removed_at is null;

create table if not exists public.whatsapp_number_auth_credentials (
  number_id uuid primary key references public.whatsapp_numbers (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  ciphertext bytea not null,
  iv bytea not null,
  tag bytea not null,
  key_version integer not null default 1,
  updated_at timestamptz not null default now()
);
alter table public.whatsapp_number_auth_credentials enable row level security;

create table if not exists public.whatsapp_number_auth_keys (
  number_id uuid not null references public.whatsapp_numbers (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  key_type text not null,
  key_id text not null,
  ciphertext bytea not null,
  iv bytea not null,
  tag bytea not null,
  key_version integer not null default 1,
  updated_at timestamptz not null default now(),
  primary key (number_id, key_type, key_id)
);
alter table public.whatsapp_number_auth_keys enable row level security;

alter table public.whatsapp_connection
  add column if not exists outbound_enabled boolean not null default true,
  add column if not exists max_numbers integer not null default 5;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'whatsapp_max_numbers_valid') then
    alter table public.whatsapp_connection add constraint whatsapp_max_numbers_valid check (max_numbers between 1 and 20);
  end if;
end $$;

alter table public.leads add column if not exists whatsapp_number_id uuid references public.whatsapp_numbers (id) on delete set null;
create index if not exists leads_whatsapp_number_idx on public.leads (whatsapp_number_id) where whatsapp_number_id is not null;

alter table public.whatsapp_outbound_messages add column if not exists whatsapp_number_id uuid references public.whatsapp_numbers (id) on delete set null;
alter table public.whatsapp_inbound_events
  add column if not exists whatsapp_number_id uuid references public.whatsapp_numbers (id) on delete set null,
  add column if not exists other_number boolean not null default false;
alter table public.whatsapp_safety_events add column if not exists whatsapp_number_id uuid references public.whatsapp_numbers (id) on delete set null;
alter table public.message_facts add column if not exists whatsapp_number_id uuid;

-- Per-number counters (the 041 indexes, keyed by number): sent today / new chats / 24 h sends,
-- "never messaged / never heard from" on this number, STOPs, failures and reconnects.
create index if not exists whatsapp_outbound_number_sent_at_idx
  on public.whatsapp_outbound_messages (whatsapp_number_id, sent_at) where status = 'sent';
create index if not exists whatsapp_outbound_number_jid_sent_idx
  on public.whatsapp_outbound_messages (whatsapp_number_id, remote_jid) where status = 'sent';
create index if not exists whatsapp_outbound_number_prepared_idx
  on public.whatsapp_outbound_messages (whatsapp_number_id) where status = 'prepared';
create index if not exists whatsapp_inbound_number_phone_idx
  on public.whatsapp_inbound_events (whatsapp_number_id, sender_phone_e164);
create index if not exists whatsapp_inbound_number_stop_idx
  on public.whatsapp_inbound_events (whatsapp_number_id, received_at) where reply_label = 'asked_to_stop';
create index if not exists whatsapp_safety_events_number_idx
  on public.whatsapp_safety_events (whatsapp_number_id, created_at desc);

-- Rule 11 backfill: number #1 per existing connection (same id), only where it doesn't exist yet.
do $$
declare
  r record;
begin
  for r in
    insert into public.whatsapp_numbers (
      id, workspace_id, label, enabled, desired_state, status, command_version, connected_jid, connected_phone, display_name,
      qr_ciphertext, qr_iv, qr_tag, qr_key_version, qr_expires_at, last_error, reachout_lock, new_chat_cap,
      worker_heartbeat_at, last_connected_at, last_disconnected_at, daily_cap, min_delay_seconds, max_delay_seconds,
      paired_at, max_new_chats_per_day, next_send_at, paused_reason, paused_at, paused_by, resumed_at, updated_by, created_at
    )
    select c.id, c.workspace_id, '#1', c.enabled, c.desired_state, c.status, c.command_version, c.connected_jid, c.connected_phone, c.display_name,
           c.qr_ciphertext, c.qr_iv, c.qr_tag, c.qr_key_version, c.qr_expires_at, c.last_error, c.reachout_lock, c.new_chat_cap,
           c.worker_heartbeat_at, c.last_connected_at, c.last_disconnected_at, c.daily_cap, c.min_delay_seconds, c.max_delay_seconds,
           c.paired_at, c.max_new_chats_per_day, c.next_send_at, c.paused_reason, c.paused_at, c.paused_by, c.resumed_at, c.updated_by, c.created_at
      from public.whatsapp_connection c
     where not exists (select 1 from public.whatsapp_numbers n where n.id = c.id)
    returning id, workspace_id
  loop
    insert into public.whatsapp_number_auth_credentials (number_id, workspace_id, ciphertext, iv, tag, key_version, updated_at)
    select r.id, a.workspace_id, a.ciphertext, a.iv, a.tag, a.key_version, a.updated_at
      from public.whatsapp_auth_credentials a where a.workspace_id = r.workspace_id
    on conflict do nothing;
    insert into public.whatsapp_number_auth_keys (number_id, workspace_id, key_type, key_id, ciphertext, iv, tag, key_version, updated_at)
    select r.id, k.workspace_id, k.key_type, k.key_id, k.ciphertext, k.iv, k.tag, k.key_version, k.updated_at
      from public.whatsapp_auth_keys k where k.workspace_id = r.workspace_id
    on conflict do nothing;

    update public.whatsapp_outbound_messages set whatsapp_number_id = r.id where workspace_id = r.workspace_id and whatsapp_number_id is null;
    update public.whatsapp_inbound_events set whatsapp_number_id = r.id where workspace_id = r.workspace_id and whatsapp_number_id is null;
    update public.whatsapp_safety_events set whatsapp_number_id = r.id where workspace_id = r.workspace_id and whatsapp_number_id is null;
    update public.message_facts set whatsapp_number_id = r.id
     where workspace_id = r.workspace_id and channel = 'whatsapp' and whatsapp_number_id is null;

    update public.leads l set whatsapp_number_id = r.id
     where l.workspace_id = r.workspace_id and l.whatsapp_number_id is null
       and l.id in (
         select i.lead_id from public.whatsapp_inbound_events i where i.workspace_id = r.workspace_id and i.lead_id is not null
         union
         select coalesce(sa.lead_id, p.lead_id, m.lead_id, ad.lead_id, rd.lead_id)
           from public.whatsapp_outbound_messages o
           left join public.scheduled_actions sa on sa.id = o.scheduled_action_id
           left join public.proposals p on p.id = o.proposal_id
           left join public.meetings m on m.id = o.meeting_id
           left join public.agent_decisions ad on ad.id = o.agent_decision_id
           left join public.reply_drafts rd on rd.id = o.reply_draft_id
          where o.workspace_id = r.workspace_id and o.status = 'sent'
       );
  end loop;
end $$;

comment on column public.whatsapp_connection.outbound_enabled is
  'E4a: workspace master switch for WhatsApp outbound (all numbers). Per-number pause lives on whatsapp_numbers.enabled.';
comment on column public.leads.whatsapp_number_id is
  'E4a: sticky WhatsApp number; set on the first send or first inbound, changed only by an admin (rule 6) or number removal (rule 10).';
