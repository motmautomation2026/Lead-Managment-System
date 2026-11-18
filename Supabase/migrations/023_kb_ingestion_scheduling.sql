-- =============================================================================
-- Northbeam CRM -- knowledge-base ingestion: retry scheduling + file bucket
-- =============================================================================
--
-- next_attempt_at: when the worker may next claim a pending document. Set on
-- a deferral (e.g. OpenAI not configured or rate-limited, which does not use
-- up an attempt) and on a retryable failure (backoff). NULL = claim now.
-- Without it a deferred document would be re-claimed and re-extracted on
-- every worker tick.
--
-- storage_bucket: which private bucket holds an uploaded document's file.
-- Asset documents (doc_type 'asset') point at the asset's own file in
-- `agent-assets` instead of copying it into `kb-documents`.
--
-- Additive and idempotent; existing rows get NULL / 'kb-documents'.
-- =============================================================================

alter table public.kb_documents
  add column if not exists next_attempt_at timestamptz,
  add column if not exists storage_bucket text not null default 'kb-documents';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'kb_documents_storage_bucket_known') then
    alter table public.kb_documents
      add constraint kb_documents_storage_bucket_known check (storage_bucket in ('kb-documents', 'agent-assets'));
  end if;
end $$;

-- The worker's claim query: pending rows that are due, plus stuck processing rows.
create index if not exists kb_documents_claim_idx
  on public.kb_documents (status, next_attempt_at)
  where status in ('pending', 'processing');

comment on column public.kb_documents.next_attempt_at is
  'Earliest time the ingestion worker may claim this pending document again (deferral or retry backoff). NULL = now.';
comment on column public.kb_documents.storage_bucket is
  'Private storage bucket of storage_path: kb-documents (uploads) or agent-assets (asset files).';
