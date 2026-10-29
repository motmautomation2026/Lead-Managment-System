import { createHash } from "node:crypto";
import { pool, withTransaction } from "../db.js";
import type { Queryable } from "../dto.js";
import { CHUNKER_VERSION, chunkText, type TextChunk } from "../knowledge/chunkText.js";
import { detectKind, extractText, TextExtractionError, type TextSection } from "../knowledge/extractText.js";
import type { Embedder } from "../providers/openai.provider.js";
import { PermanentProviderError, ProviderDeferredError } from "../providers/provider-errors.js";
import { supabaseAdmin } from "../supabaseAdmin.js";
import { toVectorLiteral } from "./knowledge.service.js";

export const INGEST_BATCH_SIZE = 2;
export const STUCK_AFTER_MINUTES = 15;
export const MAX_INGEST_ATTEMPTS = 3;
const RETRY_BASE_MS = 60_000;
const INSERT_BATCH = 100;

export interface ClaimedDocument {
  id: string;
  workspace_id: string;
  title: string;
  source: "upload" | "text";
  storage_bucket: string;
  storage_path: string | null;
  file_name: string | null;
  mime_type: string | null;
  raw_text: string | null;
  content_hash: string | null;
  embedding_model: string | null;
  chunk_count: number;
  chunker_version: number | null;
  attempt_count: number;
  /** claimed_at as text (microsecond-exact): the final write only lands while the row is still ours. */
  claim_token: string;
  asset_title: string | null;
  asset_use_when: string | null;
}

export type DownloadFile = (bucket: string, path: string) => Promise<Buffer>;

export const downloadFromStorage: DownloadFile = async (bucket, path) => {
  const { data, error } = await supabaseAdmin.storage.from(bucket).download(path);
  if (error || !data) throw new Error(`Couldn't download the file from storage: ${error?.message ?? "no data"}`);
  return Buffer.from(await data.arrayBuffer());
};

/**
 * Claims up to `limit` documents: pending ones that are due, ready ones
 * chunked by an older chunker (re-chunked once, E2b), and processing ones
 * stuck for 15+ minutes (a reclaim uses up an attempt, so a file that
 * keeps killing the worker ends up failed). SKIP LOCKED, inside the caller's
 * transaction. `workspaceId` narrows the claim (tests).
 */
export async function claimKnowledgeDocuments(db: Queryable, { limit = INGEST_BATCH_SIZE, workspaceId }: { limit?: number; workspaceId?: string } = {}): Promise<ClaimedDocument[]> {
  const stuck = `status = 'processing' and claimed_at < now() - make_interval(mins => ${STUCK_AFTER_MINUTES})`;
  await db.query(
    `update public.kb_documents
        set status = 'failed', claimed_at = null,
            error = 'Processing kept stalling (${MAX_INGEST_ATTEMPTS} attempts). Reprocess to try again.'
      where ${stuck} and attempt_count + 1 >= $1 and ($2::uuid is null or workspace_id = $2)`,
    [MAX_INGEST_ATTEMPTS, workspaceId ?? null],
  );
  const claimed = await db.query<ClaimedDocument>(
    `with picked as (
       select id from public.kb_documents
        where ((status = 'pending' and (next_attempt_at is null or next_attempt_at <= now())) or (${stuck})
               or (status = 'ready' and coalesce(chunker_version, 1) < $3))
          and ($2::uuid is null or workspace_id = $2)
        order by created_at
        limit $1
        for update skip locked
     )
     update public.kb_documents d
        set status = 'processing', claimed_at = now(), next_attempt_at = null,
            attempt_count = d.attempt_count + (case when d.status = 'processing' then 1 else 0 end)
       from picked
      where d.id = picked.id
     returning d.id, d.workspace_id, d.title, d.source, d.storage_bucket, d.storage_path, d.file_name, d.mime_type,
               d.raw_text, d.content_hash, d.embedding_model, d.chunk_count, d.chunker_version, d.attempt_count, d.claimed_at::text as claim_token,
               (select a.title from public.agent_assets a where a.kb_document_id = d.id) as asset_title,
               (select a.use_when from public.agent_assets a where a.kb_document_id = d.id) as asset_use_when`,
    [limit, workspaceId ?? null, CHUNKER_VERSION],
  );
  return claimed.rows;
}

/** The sections to chunk. An asset's text starts with "Asset: <title>. Use when: <use_when>." and its file text is optional (images have none). */
async function loadSections(doc: ClaimedDocument, download: DownloadFile): Promise<TextSection[]> {
  const isAsset = doc.asset_title !== null;
  let sections: TextSection[] = [];
  if (doc.source === "text") {
    sections = (await extractText(Buffer.from(doc.raw_text ?? "", "utf8"), "text/markdown", null)).sections;
  } else if (!isAsset || detectKind(doc.mime_type, doc.file_name)) {
    const buffer = await download(doc.storage_bucket, doc.storage_path!);
    try {
      sections = (await extractText(buffer, doc.mime_type, doc.file_name)).sections;
    } catch (error) {
      // An asset stays findable by its title and "use when" even if its file has no readable text.
      if (!(isAsset && error instanceof TextExtractionError)) throw error;
    }
  }
  if (!isAsset) return sections;
  const prefix = `Asset: ${doc.asset_title}. Use when: ${doc.asset_use_when}.`;
  const [first, ...rest] = sections;
  return first ? [{ ...first, text: `${prefix}\n\n${first.text}` }, ...rest] : [{ text: prefix }];
}

export type IngestOutcome = "ready" | "unchanged" | "failed" | "deferred" | "retry" | "stale";

/** Updates the document only while this run still holds its claim. Returns false if it was reprocessed, deleted or reclaimed meanwhile. */
async function updateClaimed(db: Queryable, doc: ClaimedDocument, set: string, params: unknown[]): Promise<boolean> {
  const result = await db.query(
    `update public.kb_documents set ${set}, claimed_at = null
      where id = $1 and status = 'processing' and claimed_at = $2::timestamptz`,
    [doc.id, doc.claim_token, ...params],
  );
  return Boolean(result.rowCount);
}

async function saveChunks(doc: ClaimedDocument, chunks: TextChunk[], vectors: number[][] | null, text: string, hash: string, model: string): Promise<boolean> {
  return withTransaction(async (db) => {
    const ours = await db.query(
      `select 1 from public.kb_documents where id = $1 and status = 'processing' and claimed_at = $2::timestamptz for update`,
      [doc.id, doc.claim_token],
    );
    if (!ours.rowCount) return false;
    if (vectors) {
      await db.query(`delete from public.kb_chunks where document_id = $1`, [doc.id]);
      for (let start = 0; start < chunks.length; start += INSERT_BATCH) {
        const batch = chunks.slice(start, start + INSERT_BATCH);
        await db.query(
          `insert into public.kb_chunks (workspace_id, document_id, chunk_index, content, token_count, embedding, metadata)
           select $1, $2, u.chunk_index, u.content, u.token_count, u.embedding::extensions.vector, u.metadata
             from unnest($3::int[], $4::text[], $5::int[], $6::text[], $7::jsonb[]) as u(chunk_index, content, token_count, embedding, metadata)`,
          [
            doc.workspace_id,
            doc.id,
            batch.map((chunk) => chunk.index),
            batch.map((chunk) => chunk.content),
            batch.map((chunk) => chunk.tokenCount),
            batch.map((chunk) => toVectorLiteral(vectors[chunk.index]!)),
            batch.map((chunk) => JSON.stringify(chunk.metadata)),
          ],
        );
      }
    }
    await updateClaimed(
      db,
      doc,
      `status = 'ready', error = null, processed_at = now(), next_attempt_at = null, extracted_text = $3, content_hash = $4, embedding_model = $5, chunker_version = $6${vectors ? ", chunk_count = $7" : ""}`,
      vectors ? [text, hash, model, CHUNKER_VERSION, chunks.length] : [text, hash, model, CHUNKER_VERSION],
    );
    return true;
  });
}

/**
 * Extracts, chunks and embeds one claimed document, slow work outside any
 * transaction, then swaps its chunks in one transaction. Unchanged text with
 * the same model and chunker keeps the existing chunks (no re-embedding). Failures:
 * unreadable files and permanent provider errors fail the document; a
 * deferral (OpenAI not configured, rate limit) puts it back to pending later
 * without using an attempt; anything else retries with backoff, 3 attempts.
 */
export async function processKnowledgeDocument(doc: ClaimedDocument, { embedder, download = downloadFromStorage }: { embedder: Embedder; download?: DownloadFile }): Promise<IngestOutcome> {
  try {
    const sections = await loadSections(doc, download);
    const text = sections.map((section) => section.text).join("\n\n");
    const hash = createHash("sha256").update(text).digest("hex");
    const chunks = chunkText(sections);
    if (chunks.length === 0) throw new TextExtractionError("No readable text found in this file.");

    if (hash === doc.content_hash && embedder.model === doc.embedding_model && doc.chunker_version === CHUNKER_VERSION && doc.chunk_count > 0) {
      return (await saveChunks(doc, chunks, null, text, hash, embedder.model)) ? "unchanged" : "stale";
    }
    const vectors = await embedder.embed(chunks.map((chunk) => chunk.content));
    return (await saveChunks(doc, chunks, vectors, text, hash, embedder.model)) ? "ready" : "stale";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const db = pool;
    if (error instanceof TextExtractionError || error instanceof PermanentProviderError) {
      return (await updateClaimed(db, doc, `status = 'failed', error = $3`, [message])) ? "failed" : "stale";
    }
    if (error instanceof ProviderDeferredError) {
      const ok = await updateClaimed(db, doc, `status = 'pending', error = $3, next_attempt_at = now() + make_interval(secs => $4::double precision / 1000)`, [
        `Waiting: ${message}`,
        error.retryAfterMs,
      ]);
      return ok ? "deferred" : "stale";
    }
    const attempts = doc.attempt_count + 1;
    if (attempts >= MAX_INGEST_ATTEMPTS) {
      const ok = await updateClaimed(db, doc, `status = 'failed', attempt_count = $3, error = $4`, [attempts, `Failed after ${attempts} attempts: ${message}`]);
      return ok ? "failed" : "stale";
    }
    console.error(`[worker] Knowledge document ${doc.id} failed (attempt ${attempts}): ${message}`);
    const ok = await updateClaimed(db, doc, `status = 'pending', attempt_count = $3, error = $4, next_attempt_at = now() + make_interval(secs => $5::double precision / 1000)`, [
      attempts,
      message,
      RETRY_BASE_MS * 2 ** (attempts - 1),
    ]);
    return ok ? "retry" : "stale";
  }
}

/** One worker step: claim a small batch and process it. */
export async function runKnowledgeIngestion(options: { embedder: Embedder; download?: DownloadFile; workspaceId?: string; limit?: number }) {
  const claimed = await withTransaction((db) =>
    claimKnowledgeDocuments(db, { ...(options.limit ? { limit: options.limit } : {}), ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}) }),
  );
  const outcomes: { id: string; outcome: IngestOutcome }[] = [];
  for (const doc of claimed) {
    outcomes.push({ id: doc.id, outcome: await processKnowledgeDocument(doc, options) });
  }
  return outcomes;
}
