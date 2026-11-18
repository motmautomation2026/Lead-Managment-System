-- =============================================================================
-- Northbeam CRM -- D3: email replies, bounces and unsubscribes read over IMAP
-- =============================================================================
--
-- email_inbound_events: one row per message the worker read from the workspace mailbox
-- (read-only; nothing in the mailbox is changed). Unique per (workspace, Message-ID header);
-- messages without one use (workspace, uidvalidity, uid).
--   kind           reply | bounce (5.x.x) | bounce_temporary (4.x.x / delayed) | auto_reply |
--                  unsubscribe | ignored (our own address, no-reply senders).
--   match_status   matched | unmatched | ambiguous;  match_method in_reply_to | references |
--                  sender | original_message (a bounce's original Message-ID) | recipient
--                  (a bounce's Final-Recipient).
--   body_*         a matched reply's subject + text, AES-256-GCM, AAD 'email:inbound:<id>'
--                  (all-or-none). Never HTML, never attachments. text_truncated: cut to 4,000.
--   reply_label…, classification_…   the D4a label columns (same meaning as on
--                  whatsapp_inbound_events, migration 040).
-- email_imap_state: per workspace polling state (uidvalidity + last_uid, last check/error).
-- email_outbound_messages.bounced_at / bounce_status: a DSN for that email.
-- inbound_message_views.channel (+ email_event_id): reads of email reply text are audited too.
--
-- Additive and idempotent.
-- =============================================================================

create table if not exists public.email_inbound_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  message_id_header text,
  uidvalidity bigint not null,
  uid bigint not null,
  from_address text,
  received_at timestamptz not null,
  kind text not null,
  match_status text not null default 'unmatched',
  match_method text,
  lead_id uuid references public.leads (id) on delete set null,
  outbound_id uuid references public.email_outbound_messages (id) on delete set null,
  bounce_status text,
  bounce_detail text,
  body_ciphertext bytea,
  body_iv bytea,
  body_tag bytea,
  body_key_version integer,
  text_truncated boolean not null default false,
  reply_label text,
  reply_label_source text,
  reply_label_confidence numeric(4, 3),
  classification_status text,
  classification_attempts integer not null default 0,
  classification_next_at timestamptz,
  classified_at timestamptz,
  label_corrected_by uuid references public.profiles (id) on delete set null,
  label_corrected_at timestamptz,
  classification_model text,
  classification_input_tokens integer,
  classification_output_tokens integer,
  classification_cost_usd numeric(12, 6),
  created_at timestamptz not null default now(),
  constraint email_inbound_kind_valid check (kind in ('reply', 'bounce', 'bounce_temporary', 'auto_reply', 'unsubscribe', 'ignored')),
  constraint email_inbound_match_status_valid check (match_status in ('matched', 'unmatched', 'ambiguous')),
  constraint email_inbound_match_method_valid check (
    match_method is null or match_method in ('in_reply_to', 'references', 'sender', 'original_message', 'recipient')
  ),
  constraint email_inbound_body_complete check (
    (body_ciphertext is null and body_iv is null and body_tag is null and body_key_version is null)
    or (body_ciphertext is not null and body_iv is not null and body_tag is not null and body_key_version is not null)
  ),
  constraint email_inbound_reply_label_valid check (
    reply_label is null or reply_label in ('asked_to_stop', 'not_interested', 'annoyed', 'positive', 'question', 'other', 'unclassified')
  ),
  constraint email_inbound_reply_label_source_valid check (reply_label_source is null or reply_label_source in ('keyword', 'ai', 'rep')),
  constraint email_inbound_classification_status_valid check (
    classification_status is null or classification_status in ('pending', 'done', 'failed', 'skipped')
  ),
  constraint email_inbound_reply_confidence_range check (
    reply_label_confidence is null or (reply_label_confidence >= 0 and reply_label_confidence <= 1)
  )
);
alter table public.email_inbound_events enable row level security;

create unique index if not exists email_inbound_message_id_unique
  on public.email_inbound_events (workspace_id, message_id_header) where message_id_header is not null;
create unique index if not exists email_inbound_uid_unique
  on public.email_inbound_events (workspace_id, uidvalidity, uid) where message_id_header is null;
-- Settings counts (today by kind, bounces 24 h).
create index if not exists email_inbound_ws_created_idx on public.email_inbound_events (workspace_id, created_at);
create index if not exists email_inbound_lead_idx on public.email_inbound_events (lead_id) where lead_id is not null;
-- The D4a worker queue and monthly AI spend.
create index if not exists email_inbound_classification_pending_idx
  on public.email_inbound_events (classification_next_at) where classification_status = 'pending';
create index if not exists email_inbound_classified_idx
  on public.email_inbound_events (workspace_id, classified_at) where classified_at is not null;

create table if not exists public.email_imap_state (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  uidvalidity bigint,
  last_uid bigint,
  -- When the IMAP login was (re)saved: the first poll reads only mail after it.
  imap_saved_at timestamptz,
  last_poll_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  next_poll_at timestamptz not null default now(),
  -- An IMAP login rejection notifies admins once per IST day.
  login_alerted_on date,
  updated_at timestamptz not null default now()
);
alter table public.email_imap_state enable row level security;

drop trigger if exists email_imap_state_set_updated_at on public.email_imap_state;
create trigger email_imap_state_set_updated_at
  before update on public.email_imap_state
  for each row execute function public.set_updated_at();

alter table public.email_outbound_messages
  add column if not exists bounced_at timestamptz,
  add column if not exists bounce_status text;

-- D3 matches In-Reply-To / References / a bounce's original Message-ID to our emails.
create index if not exists email_outbound_ws_message_id_idx
  on public.email_outbound_messages (workspace_id, message_id) where message_id is not null;

alter table public.inbound_message_views
  add column if not exists channel text not null default 'whatsapp',
  add column if not exists email_event_id uuid references public.email_inbound_events (id) on delete cascade;
alter table public.inbound_message_views alter column message_id drop not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'inbound_message_views_channel_valid') then
    alter table public.inbound_message_views
      add constraint inbound_message_views_channel_valid check (
        (channel = 'whatsapp' and message_id is not null and email_event_id is null)
        or (channel = 'email' and email_event_id is not null and message_id is null)
      );
  end if;
end $$;

comment on table public.email_inbound_events is
  'D3: messages read (read-only) from the workspace mailbox over IMAP. Reply text only encrypted in body_*.';
comment on table public.email_imap_state is
  'D3: per-workspace IMAP polling state (uidvalidity, last_uid, last check / error).';
