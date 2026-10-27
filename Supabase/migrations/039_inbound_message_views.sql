-- =============================================================================
-- Northbeam CRM -- audit of who read an inbound WhatsApp reply (D2)
-- =============================================================================
--
-- One row per GET /contacts/:id/replies/:messageId that reached a matched reply
-- of the contact: shown, denied (not the owner or an admin), no_text (nothing
-- stored) or decrypt_failed. Never holds the text. Backend only: RLS on, no
-- policies (the API uses a BYPASSRLS role).
--
-- Additive and idempotent.
-- =============================================================================

create table if not exists public.inbound_message_views (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id),
  lead_id uuid not null references public.leads (id) on delete cascade,
  message_id text not null references public.whatsapp_inbound_events (message_id),
  viewer_id uuid references public.profiles (id) on delete set null,
  outcome text not null,
  viewed_at timestamptz not null default now(),
  constraint inbound_message_views_outcome_valid check (outcome in ('shown', 'denied', 'no_text', 'decrypt_failed'))
);

create index if not exists inbound_message_views_lead_idx
  on public.inbound_message_views (workspace_id, lead_id, viewed_at);

alter table public.inbound_message_views enable row level security;

comment on table public.inbound_message_views is
  'Audit of reads of inbound WhatsApp reply text (D2). Never stores the text.';
