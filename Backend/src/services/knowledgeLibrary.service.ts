import { randomUUID } from "node:crypto";
import type { Actor } from "../authMiddleware.js";
import { pool, withTransaction } from "../db.js";
import type { Queryable } from "../dto.js";
import { ConflictError, NotFoundError } from "../errors.js";
import { supabaseAdmin } from "../supabaseAdmin.js";
import { recordAdminAudit } from "./admin-audit.service.js";

export const KB_DOCUMENTS_BUCKET = "kb-documents";
export const AGENT_ASSETS_BUCKET = "agent-assets";
/** Types an admin can pick; 'asset' is reserved for documents created by the asset library. */
export const USER_DOC_TYPES = ["service", "case_study", "faq", "objection", "pricing", "process", "company", "other"] as const;
export const ALL_DOC_TYPES = [...USER_DOC_TYPES, "asset"] as const;
export const ASSET_CHANNELS = ["email", "whatsapp"] as const;
const PREVIEW_CHARS = 5_000;
const SIGNED_URL_TTL_SECONDS = 300;

export interface UploadedFile {
  buffer: Buffer;
  originalName: string;
  mimeType: string;
  size: number;
}

function sanitizeFileName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? name;
  return base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-150) || "file";
}

async function uploadObject(bucket: string, workspaceId: string, file: UploadedFile): Promise<string> {
  const path = `${workspaceId}/${randomUUID()}-${sanitizeFileName(file.originalName)}`;
  const { error } = await supabaseAdmin.storage.from(bucket).upload(path, file.buffer, { contentType: file.mimeType, upsert: false });
  if (error) throw new Error(`Failed to upload the file: ${error.message}`);
  return path;
}

/** Best effort: a leftover object is harmless, a failed request after the DB change is not worth surfacing. */
async function removeObject(bucket: string, path: string | null) {
  if (!path) return;
  const { error } = await supabaseAdmin.storage.from(bucket).remove([path]);
  if (error) console.warn(JSON.stringify({ event: "storage_remove_failed", bucket, path, message: error.message }));
}

/** Uploads, then runs `write`; if the write fails the uploaded object is removed (no orphans). */
async function withUploadedObject<T>(bucket: string, workspaceId: string, file: UploadedFile, write: (path: string) => Promise<T>): Promise<T> {
  const path = await uploadObject(bucket, workspaceId, file);
  try {
    return await write(path);
  } catch (error) {
    await removeObject(bucket, path);
    throw error;
  }
}

// --- Documents ----------------------------------------------------------------

const DOCUMENT_COLUMNS = `d.id, d.title, d.doc_type, d.tags, d.source, d.file_name, d.mime_type, d.size_bytes, d.status, d.error,
  d.chunk_count, d.attempt_count, d.is_active, d.processed_at, d.next_attempt_at, d.created_by_name, d.created_at, d.updated_at,
  a.id as asset_id`;

interface DocumentRow {
  id: string;
  title: string;
  doc_type: string;
  tags: string[];
  source: "upload" | "text";
  file_name: string | null;
  mime_type: string | null;
  size_bytes: string | null;
  status: string;
  error: string | null;
  chunk_count: number;
  attempt_count: number;
  is_active: boolean;
  processed_at: Date | null;
  next_attempt_at: Date | null;
  created_by_name: string | null;
  created_at: Date;
  updated_at: Date;
  asset_id: string | null;
}

function documentToDto(row: DocumentRow) {
  return {
    id: row.id,
    title: row.title,
    docType: row.doc_type,
    tags: row.tags,
    source: row.source,
    fileName: row.file_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    status: row.status,
    error: row.error,
    chunkCount: row.chunk_count,
    attemptCount: row.attempt_count,
    isActive: row.is_active,
    /** Set when this document is an asset's searchable copy: manage it through the asset. */
    assetId: row.asset_id,
    processedAt: row.processed_at?.toISOString() ?? null,
    nextAttemptAt: row.next_attempt_at?.toISOString() ?? null,
    createdBy: row.created_by_name,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function documentRowOr404(db: Queryable, workspaceId: string, id: string): Promise<DocumentRow & { storage_bucket: string; storage_path: string | null }> {
  const result = await db.query(
    `select ${DOCUMENT_COLUMNS}, d.storage_bucket, d.storage_path
       from public.kb_documents d left join public.agent_assets a on a.kb_document_id = d.id
      where d.id = $1 and d.workspace_id = $2`,
    [id, workspaceId],
  );
  if (!result.rows[0]) throw new NotFoundError("Knowledge document");
  return result.rows[0];
}

export async function listDocuments(workspaceId: string) {
  const result = await pool.query<DocumentRow>(
    `select ${DOCUMENT_COLUMNS}
       from public.kb_documents d left join public.agent_assets a on a.kb_document_id = d.id
      where d.workspace_id = $1
      order by d.updated_at desc`,
    [workspaceId],
  );
  return result.rows.map(documentToDto);
}

export async function getDocument(workspaceId: string, id: string) {
  const row = await documentRowOr404(pool, workspaceId, id);
  const text = await pool.query<{ preview: string | null; length: number | null }>(
    `select left(coalesce(extracted_text, raw_text), $2) as preview, length(coalesce(extracted_text, raw_text)) as length from public.kb_documents where id = $1`,
    [id, PREVIEW_CHARS],
  );
  return { ...documentToDto(row), extractedTextPreview: text.rows[0]?.preview ?? null, extractedTextLength: text.rows[0]?.length ?? 0 };
}

export interface DocumentFields {
  title: string;
  docType: string;
  tags: string[];
}

export async function createTextDocument(actor: Actor, workspaceId: string, input: DocumentFields & { text: string }) {
  const id = await withTransaction(async (db) => {
    const inserted = await db.query<{ id: string }>(
      `insert into public.kb_documents (workspace_id, title, doc_type, tags, source, raw_text, created_by, created_by_name)
       values ($1, $2, $3, $4, 'text', $5, $6, $7) returning id`,
      [workspaceId, input.title, input.docType, input.tags, input.text, actor.id, actor.fullName],
    );
    const id = inserted.rows[0]!.id;
    await recordAdminAudit(db, actor, "knowledge.document.created", "kb_document", id, { workspaceId, title: input.title, source: "text" });
    return id;
  });
  return getDocument(workspaceId, id);
}

export async function createFileDocument(actor: Actor, workspaceId: string, input: DocumentFields & { file: UploadedFile }) {
  const id = await withUploadedObject(KB_DOCUMENTS_BUCKET, workspaceId, input.file, (path) =>
    withTransaction(async (db) => {
      const inserted = await db.query<{ id: string }>(
        `insert into public.kb_documents (workspace_id, title, doc_type, tags, source, storage_bucket, storage_path, file_name, mime_type, size_bytes, created_by, created_by_name)
         values ($1, $2, $3, $4, 'upload', $5, $6, $7, $8, $9, $10, $11) returning id`,
        [workspaceId, input.title, input.docType, input.tags, KB_DOCUMENTS_BUCKET, path, input.file.originalName, input.file.mimeType, input.file.size, actor.id, actor.fullName],
      );
      const id = inserted.rows[0]!.id;
      await recordAdminAudit(db, actor, "knowledge.document.created", "kb_document", id, { workspaceId, title: input.title, source: "upload", fileName: input.file.originalName });
      return id;
    }),
  );
  return getDocument(workspaceId, id);
}

const ASSET_DOCUMENT_CONFLICT = "This document belongs to an asset. Edit or delete the asset instead.";

export async function updateDocument(actor: Actor, workspaceId: string, id: string, patch: Partial<DocumentFields> & { isActive?: boolean }) {
  await withTransaction(async (db) => {
    const row = await documentRowOr404(db, workspaceId, id);
    if (row.asset_id) throw new ConflictError(ASSET_DOCUMENT_CONFLICT, { assetId: row.asset_id });
    await db.query(
      `update public.kb_documents
          set title = coalesce($2, title), doc_type = coalesce($3, doc_type), tags = coalesce($4, tags), is_active = coalesce($5, is_active)
        where id = $1`,
      [id, patch.title ?? null, patch.docType ?? null, patch.tags ?? null, patch.isActive ?? null],
    );
    await recordAdminAudit(db, actor, "knowledge.document.updated", "kb_document", id, { workspaceId, ...patch });
  });
  return getDocument(workspaceId, id);
}

const REQUEUE = `status = 'pending', attempt_count = 0, next_attempt_at = null, error = null, claimed_at = null`;

export async function reprocessDocument(actor: Actor, workspaceId: string, id: string) {
  await withTransaction(async (db) => {
    await documentRowOr404(db, workspaceId, id);
    await db.query(`update public.kb_documents set ${REQUEUE} where id = $1`, [id]);
    await recordAdminAudit(db, actor, "knowledge.document.reprocessed", "kb_document", id, { workspaceId });
  });
  return getDocument(workspaceId, id);
}

export async function deleteDocument(actor: Actor, workspaceId: string, id: string) {
  const row = await withTransaction(async (db) => {
    const row = await documentRowOr404(db, workspaceId, id);
    if (row.asset_id) throw new ConflictError("This document belongs to an asset. Delete the asset instead.", { assetId: row.asset_id });
    await db.query(`delete from public.kb_documents where id = $1`, [id]);
    await recordAdminAudit(db, actor, "knowledge.document.deleted", "kb_document", id, { workspaceId, title: row.title });
    return row;
  });
  await removeObject(row.storage_bucket, row.storage_path);
}

// --- Assets -------------------------------------------------------------------

interface AssetRow {
  id: string;
  title: string;
  use_when: string;
  tags: string[];
  channels: string[];
  storage_path: string;
  file_name: string | null;
  mime_type: string | null;
  size_bytes: string | null;
  is_active: boolean;
  kb_document_id: string | null;
  status: string | null;
  error: string | null;
  chunk_count: number | null;
  created_by_name: string | null;
  created_at: Date;
  updated_at: Date;
}

const ASSET_SELECT = `select a.id, a.title, a.use_when, a.tags, a.channels, a.storage_path, a.file_name, a.mime_type, a.size_bytes,
    a.is_active, a.kb_document_id, d.status, d.error, d.chunk_count, a.created_by_name, a.created_at, a.updated_at
  from public.agent_assets a left join public.kb_documents d on d.id = a.kb_document_id`;

function assetToDto(row: AssetRow, downloadUrl: string | null) {
  return {
    id: row.id,
    title: row.title,
    useWhen: row.use_when,
    tags: row.tags,
    channels: row.channels,
    fileName: row.file_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    isActive: row.is_active,
    kbDocumentId: row.kb_document_id,
    /** Ingestion of the asset's searchable copy. */
    status: row.status,
    error: row.error,
    chunkCount: row.chunk_count ?? 0,
    downloadUrl,
    createdBy: row.created_by_name,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function assetRowOr404(db: Queryable, workspaceId: string, id: string): Promise<AssetRow> {
  const result = await db.query<AssetRow>(`${ASSET_SELECT} where a.id = $1 and a.workspace_id = $2`, [id, workspaceId]);
  if (!result.rows[0]) throw new NotFoundError("Asset");
  return result.rows[0];
}

/** 5-minute signed download URLs, in the order of `paths` (null where signing failed). */
async function signedUrls(paths: string[]): Promise<(string | null)[]> {
  if (paths.length === 0) return [];
  const { data, error } = await supabaseAdmin.storage.from(AGENT_ASSETS_BUCKET).createSignedUrls(paths, SIGNED_URL_TTL_SECONDS);
  if (error || !data) {
    console.warn(JSON.stringify({ event: "asset_signed_urls_failed", message: error?.message }));
    return paths.map(() => null);
  }
  const byPath = new Map(data.map((item) => [item.path, item.signedUrl]));
  return paths.map((path) => byPath.get(path) ?? null);
}

export async function listAssets(workspaceId: string) {
  const result = await pool.query<AssetRow>(`${ASSET_SELECT} where a.workspace_id = $1 order by a.updated_at desc`, [workspaceId]);
  const urls = await signedUrls(result.rows.map((row) => row.storage_path));
  return result.rows.map((row, i) => assetToDto(row, urls[i]!));
}

async function getAsset(workspaceId: string, id: string) {
  const row = await assetRowOr404(pool, workspaceId, id);
  const [url] = await signedUrls([row.storage_path]);
  return assetToDto(row, url ?? null);
}

/** E2h rule 3: a file's size from Storage metadata, for assets saved without one; null when unknown (never throws). */
export async function assetFileSize(storagePath: string): Promise<number | null> {
  const slash = storagePath.lastIndexOf("/");
  const name = storagePath.slice(slash + 1);
  try {
    const { data } = await supabaseAdmin.storage.from(AGENT_ASSETS_BUCKET).list(storagePath.slice(0, Math.max(slash, 0)), { search: name, limit: 100 });
    const size: unknown = data?.find((object) => object.name === name)?.metadata?.size;
    return typeof size === "number" ? size : null;
  } catch {
    return null;
  }
}

export interface AssetFields {
  title: string;
  useWhen: string;
  tags: string[];
  channels: string[];
}

/** Uploads the file once; the asset and its searchable kb_document (doc_type 'asset') both point at it. */
export async function createAsset(actor: Actor, workspaceId: string, input: AssetFields & { file: UploadedFile }) {
  const id = await withUploadedObject(AGENT_ASSETS_BUCKET, workspaceId, input.file, (path) =>
    withTransaction(async (db) => {
      const doc = await db.query<{ id: string }>(
        `insert into public.kb_documents (workspace_id, title, doc_type, tags, source, storage_bucket, storage_path, file_name, mime_type, size_bytes, created_by, created_by_name)
         values ($1, $2, 'asset', $3, 'upload', $4, $5, $6, $7, $8, $9, $10) returning id`,
        [workspaceId, input.title, input.tags, AGENT_ASSETS_BUCKET, path, input.file.originalName, input.file.mimeType, input.file.size, actor.id, actor.fullName],
      );
      const asset = await db.query<{ id: string }>(
        `insert into public.agent_assets (workspace_id, title, use_when, tags, channels, storage_path, file_name, mime_type, size_bytes, kb_document_id, created_by, created_by_name)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
        [workspaceId, input.title, input.useWhen, input.tags, input.channels, path, input.file.originalName, input.file.mimeType, input.file.size, doc.rows[0]!.id, actor.id, actor.fullName],
      );
      const id = asset.rows[0]!.id;
      await recordAdminAudit(db, actor, "knowledge.asset.created", "agent_asset", id, { workspaceId, title: input.title, fileName: input.file.originalName });
      return id;
    }),
  );
  return getAsset(workspaceId, id);
}

export async function updateAsset(actor: Actor, workspaceId: string, id: string, patch: Partial<AssetFields> & { isActive?: boolean }) {
  await withTransaction(async (db) => {
    const row = await assetRowOr404(db, workspaceId, id);
    await db.query(
      `update public.agent_assets
          set title = coalesce($2, title), use_when = coalesce($3, use_when), tags = coalesce($4, tags),
              channels = coalesce($5, channels), is_active = coalesce($6, is_active)
        where id = $1`,
      [id, patch.title ?? null, patch.useWhen ?? null, patch.tags ?? null, patch.channels ?? null, patch.isActive ?? null],
    );
    // The searchable copy starts with the title and "use when", so changing either re-ingests it.
    const reingest = (patch.title !== undefined && patch.title !== row.title) || (patch.useWhen !== undefined && patch.useWhen !== row.use_when);
    await db.query(
      `update public.kb_documents
          set title = coalesce($2, title), tags = coalesce($3, tags), is_active = coalesce($4, is_active)${reingest ? `, ${REQUEUE}` : ""}
        where id = $1`,
      [row.kb_document_id, patch.title ?? null, patch.tags ?? null, patch.isActive ?? null],
    );
    await recordAdminAudit(db, actor, "knowledge.asset.updated", "agent_asset", id, { workspaceId, ...patch, reingest });
  });
  return getAsset(workspaceId, id);
}

export async function deleteAsset(actor: Actor, workspaceId: string, id: string) {
  const row = await withTransaction(async (db) => {
    const row = await assetRowOr404(db, workspaceId, id);
    await db.query(`delete from public.agent_assets where id = $1`, [id]);
    if (row.kb_document_id) await db.query(`delete from public.kb_documents where id = $1`, [row.kb_document_id]);
    await recordAdminAudit(db, actor, "knowledge.asset.deleted", "agent_asset", id, { workspaceId, title: row.title });
    return row;
  });
  await removeObject(AGENT_ASSETS_BUCKET, row.storage_path);
}
