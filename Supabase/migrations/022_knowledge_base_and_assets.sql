-- =============================================================================
-- Northbeam CRM -- knowledge base (documents + embedded chunks) and asset library
-- =============================================================================
--
-- Foundation for the AI nurture agent: it may only state facts found in a
-- workspace's knowledge base (kb_documents -> kb_chunks, embedded with OpenAI
-- text-embedding-3-small, 1536 dims) and only attach files from its asset
-- library (agent_assets). Nothing here sends anything to leads.
--
-- pgvector is enabled the Supabase way, in the `extensions` schema; the type
-- and operator class are referenced schema-qualified.
--
-- Two private storage buckets: `kb-documents` (uploaded knowledge files) and
-- `agent-assets` (files the agent may attach). As with 004/005, only the
-- backend's service-role client reads or writes them, so no storage policies.
--
-- RLS is enabled on all three tables with no policies: only the backend
-- (which bypasses RLS) touches them. Purely additive and idempotent.
-- =============================================================================

create extension if not exists vector with schema extensions;

-- --- kb_documents -------------------------------------------------------------

create table if not exists public.kb_documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  title text not null check (btrim(title) <> ''),
  doc_type text not null check (doc_type in ('service', 'case_study', 'faq', 'objection', 'pricing', 'process', 'company', 'asset', 'other')),
  tags text[] not null default '{}',
  source text not null check (source in ('upload', 'text')),
  -- Upload metadata; null for pasted text.
  storage_path text,
  file_name text,
  mime_type text,
  size_bytes bigint check (size_bytes >= 0),
  raw_text text,
  extracted_text text,
  content_hash text,
  status text not null default 'pending' check (status in ('pending', 'processing', 'ready', 'failed')),
  error text,
  attempt_count int not null default 0,
  claimed_at timestamptz,
  processed_at timestamptz,
  chunk_count int not null default 0,
  embedding_model text,
  is_active boolean not null default true,
  created_by uuid references public.profiles (id) on delete set null,
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint kb_documents_source_has_content check (
    (source = 'upload' and storage_path is not null) or (source = 'text' and raw_text is not null)
  )
);

create index if not exists kb_documents_workspace_status_idx on public.kb_documents (workspace_id, status);
create index if not exists kb_documents_workspace_active_idx on public.kb_documents (workspace_id, is_active);

drop trigger if exists kb_documents_set_updated_at on public.kb_documents;
create trigger kb_documents_set_updated_at
  before update on public.kb_documents
  for each row execute function public.set_updated_at();

alter table public.kb_documents enable row level security;

comment on table public.kb_documents is
  'Per-workspace knowledge base documents (uploaded files or pasted text). The AI agent may only state facts found in their ready, active chunks.';

-- --- kb_chunks ----------------------------------------------------------------

create table if not exists public.kb_chunks (
  id uuid primary key default gen_random_uuid(),
  -- Denormalised from the document so searches filter by workspace first.
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  document_id uuid not null references public.kb_documents (id) on delete cascade,
  chunk_index int not null check (chunk_index >= 0),
  content text not null,
  token_count int,
  embedding extensions.vector(1536),
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  constraint kb_chunks_document_chunk_unique unique (document_id, chunk_index)
);

create index if not exists kb_chunks_workspace_idx on public.kb_chunks (workspace_id);
create index if not exists kb_chunks_embedding_hnsw_idx
  on public.kb_chunks using hnsw (embedding extensions.vector_cosine_ops);

alter table public.kb_chunks enable row level security;

comment on table public.kb_chunks is
  'Embedded chunks of kb_documents (OpenAI text-embedding-3-small, 1536 dims). metadata: page / slide / heading.';

-- --- agent_assets -------------------------------------------------------------

create table if not exists public.agent_assets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  title text not null check (btrim(title) <> ''),
  use_when text not null check (btrim(use_when) <> ''),
  tags text[] not null default '{}',
  channels text[] not null check (cardinality(channels) > 0 and channels <@ array['email', 'whatsapp']::text[]),
  storage_path text not null unique,
  file_name text,
  mime_type text,
  size_bytes bigint check (size_bytes >= 0),
  kb_document_id uuid references public.kb_documents (id) on delete set null,
  is_active boolean not null default true,
  created_by uuid references public.profiles (id) on delete set null,
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists agent_assets_workspace_active_idx on public.agent_assets (workspace_id, is_active);

drop trigger if exists agent_assets_set_updated_at on public.agent_assets;
create trigger agent_assets_set_updated_at
  before update on public.agent_assets
  for each row execute function public.set_updated_at();

alter table public.agent_assets enable row level security;

comment on table public.agent_assets is
  'Files the AI agent may attach (and only these), with when to use them and on which channels.';

-- --- storage buckets (private, service-role only) -----------------------------

insert into storage.buckets (id, name, public)
values ('kb-documents', 'kb-documents', false)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('agent-assets', 'agent-assets', false)
on conflict (id) do nothing;
