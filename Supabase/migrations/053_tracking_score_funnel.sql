-- =============================================================================
-- Northbeam CRM -- E3b-2b: draft marker, email open tracking, per-message facts, hot-lead score
-- =============================================================================
--
-- reply_drafts.newer_reply_at   E3b-2b rule 2: the contact wrote again after this open draft while the
--                               daily draft limit (3) was reached; the draft stays open (never superseded).
--
-- Additive and re-runnable.
-- =============================================================================

alter table public.reply_drafts add column if not exists newer_reply_at timestamptz;

comment on column public.reply_drafts.newer_reply_at is
  'E3b-2b rule 2: a newer matched reply arrived after the daily draft limit; the open draft was kept.';
