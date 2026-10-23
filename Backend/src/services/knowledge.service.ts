import { Pool, type PoolClient } from "pg";
import type { Queryable } from "../dto.js";
import type { ChunkMetadata } from "../knowledge/chunkText.js";
import type { Embedder } from "../providers/openai.provider.js";

export interface KnowledgeSearchOptions {
  /** Only documents of these kb_documents.doc_type values. */
  docTypes?: string[];
  /** Only documents sharing at least one of these tags. */
  tags?: string[];
  limit?: number;
}

export interface KnowledgeHit {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  docType: string;
  content: string;
  metadata: ChunkMetadata;
  /** Cosine similarity, 1 = identical direction. */
  score: number;
}

/** pgvector's text input format: "[0.1,0.2,...]". */
export const toVectorLiteral = (vector: number[]) => `[${vector.join(",")}]`;

async function inTransaction<T>(db: Queryable, fn: (client: Queryable) => Promise<T>): Promise<T> {
  // A caller's client is assumed to already be inside its own transaction.
  if (!(db instanceof Pool)) return fn(db);
  const client: PoolClient = await db.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * The workspace's knowledge-base chunks most similar to `queryText`, from
 * active, ready documents only, optionally limited to some doc types and/or
 * tags. Never returns another workspace's content.
 */
export async function searchKnowledge(
  db: Queryable,
  embedder: Embedder,
  workspaceId: string,
  queryText: string,
  { docTypes, tags, limit = 8 }: KnowledgeSearchOptions = {},
): Promise<KnowledgeHit[]> {
  const [vector] = await embedder.embed([queryText]);
  if (!vector) return [];
  const rows = await inTransaction(db, async (client) => {
    // The HNSW index spans every workspace; an iterative scan keeps going until
    // enough rows pass the workspace/status/filter conditions (pgvector >= 0.8).
    await client.query(`select set_config('hnsw.iterative_scan', 'strict_order', true)`);
    const result = await client.query<{
      chunk_id: string;
      document_id: string;
      title: string;
      doc_type: string;
      content: string;
      metadata: ChunkMetadata;
      score: number;
    }>(
      `select c.id as chunk_id, c.document_id, d.title, d.doc_type, c.content, c.metadata,
              1 - (c.embedding operator(extensions.<=>) $2::extensions.vector) as score
         from public.kb_chunks c
         join public.kb_documents d on d.id = c.document_id and d.workspace_id = c.workspace_id
        where c.workspace_id = $1
          and d.is_active
          and d.status = 'ready'
          and c.embedding is not null
          and ($3::text[] is null or d.doc_type = any($3::text[]))
          and ($4::text[] is null or d.tags && $4::text[])
        order by c.embedding operator(extensions.<=>) $2::extensions.vector
        limit $5`,
      [workspaceId, toVectorLiteral(vector), docTypes?.length ? docTypes : null, tags?.length ? tags : null, Math.max(1, Math.min(limit, 50))],
    );
    return result.rows;
  });
  return rows.map((row) => ({
    chunkId: row.chunk_id,
    documentId: row.document_id,
    documentTitle: row.title,
    docType: row.doc_type,
    content: row.content,
    metadata: row.metadata,
    score: Number(row.score),
  }));
}
