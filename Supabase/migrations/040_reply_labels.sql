-- =============================================================================
-- Northbeam CRM -- D4a: what a WhatsApp reply says (label, never the text)
-- =============================================================================
--
-- whatsapp_inbound_events, for replies matched to exactly one lead:
--   lead_id                     the matched lead (null for older / unmatched rows).
--   reply_label                 asked_to_stop | not_interested | annoyed | positive |
--                               question | other | unclassified (null = not labelled yet).
--   reply_label_source          keyword | ai | rep.
--   reply_label_confidence      the model's 0-1 confidence (ai only).
--   classification_status       pending (waiting for the worker) | done | failed | skipped.
--   classification_attempts     worker claims so far (also the claim token).
--   classification_next_at      when the worker may (re)claim a pending row.
--   classified_at               when the label was first set.
--   label_corrected_by / _at    the rep who changed the label.
--   classification_model / _input_tokens / _output_tokens / _cost_usd
--                               the AI call's cost (counts toward the monthly AI budget).
--
-- No text columns: the reply text stays only in body_* (encrypted, 031).
-- Additive and idempotent.
-- =============================================================================

alter table public.whatsapp_inbound_events
  add column if not exists lead_id uuid references public.leads (id) on delete set null,
  add column if not exists reply_label text,
  add column if not exists reply_label_source text,
  add column if not exists reply_label_confidence numeric(4, 3),
  add column if not exists classification_status text,
  add column if not exists classification_attempts integer not null default 0,
  add column if not exists classification_next_at timestamptz,
  add column if not exists classified_at timestamptz,
  add column if not exists label_corrected_by uuid references public.profiles (id) on delete set null,
  add column if not exists label_corrected_at timestamptz,
  add column if not exists classification_model text,
  add column if not exists classification_input_tokens integer,
  add column if not exists classification_output_tokens integer,
  add column if not exists classification_cost_usd numeric(12, 6);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'whatsapp_inbound_reply_label_valid') then
    alter table public.whatsapp_inbound_events
      add constraint whatsapp_inbound_reply_label_valid check (
        reply_label is null or reply_label in ('asked_to_stop', 'not_interested', 'annoyed', 'positive', 'question', 'other', 'unclassified')
      );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'whatsapp_inbound_reply_label_source_valid') then
    alter table public.whatsapp_inbound_events
      add constraint whatsapp_inbound_reply_label_source_valid check (
        reply_label_source is null or reply_label_source in ('keyword', 'ai', 'rep')
      );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'whatsapp_inbound_classification_status_valid') then
    alter table public.whatsapp_inbound_events
      add constraint whatsapp_inbound_classification_status_valid check (
        classification_status is null or classification_status in ('pending', 'done', 'failed', 'skipped')
      );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'whatsapp_inbound_reply_confidence_range') then
    alter table public.whatsapp_inbound_events
      add constraint whatsapp_inbound_reply_confidence_range check (
        reply_label_confidence is null or (reply_label_confidence >= 0 and reply_label_confidence <= 1)
      );
  end if;
end $$;

-- The worker's queue.
create index if not exists whatsapp_inbound_classification_pending_idx
  on public.whatsapp_inbound_events (classification_next_at)
  where classification_status = 'pending';

-- Monthly AI spend / stats per workspace.
create index if not exists whatsapp_inbound_classified_idx
  on public.whatsapp_inbound_events (workspace_id, classified_at)
  where classified_at is not null;

comment on column public.whatsapp_inbound_events.reply_label is
  'What the reply says (D4a); never the text or a quote of it.';
