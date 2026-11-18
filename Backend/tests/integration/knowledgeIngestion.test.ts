/**
 * Knowledge-base ingestion (the worker step) against the staging database and
 * Storage, with the deterministic fake embedder: never calls OpenAI. Claims
 * are limited to this run's workspace so real staging documents are never
 * touched. Uploaded objects are removed afterwards.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestWorkspace, deleteCreatedTestWorkspaces, removeStorageObjects } from "../helpers/testWorkspaces.js";
import { Pool } from "pg";
import type { Embedder } from "../../src/providers/openai.provider.js";
import { ProviderDeferredError } from "../../src/providers/provider-errors.js";
import { fakeEmbedder } from "../helpers/fakeEmbedder.js";
import { withNetworkRetry } from "../helpers/networkRetry.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const fixture = (name: string) => readFileSync(new URL(`../fixtures/knowledge/${name}`, import.meta.url));

describeIfDb("knowledge ingestion (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let WORKSPACE: string;
  const uploaded: { bucket: string; path: string }[] = [];

  async function upload(bucket: string, name: string, contentType: string) {
    const { supabaseAdmin } = await import("../../src/supabaseAdmin.js");
    const path = `${WORKSPACE}/${randomUUID()}-${name}`;
    await withNetworkRetry(async () => {
      const { error } = await supabaseAdmin.storage.from(bucket).upload(path, fixture(name), { contentType, upsert: true });
      if (error) throw new Error(error.message);
    });
    uploaded.push({ bucket, path });
    return path;
  }

  async function textDoc(text: string) {
    const row = await pool.query<{ id: string }>(
      `insert into public.kb_documents (workspace_id, title, doc_type, source, raw_text) values ($1, 'Pasted', 'faq', 'text', $2) returning id`,
      [WORKSPACE, text],
    );
    return row.rows[0]!.id;
  }

  async function fileDoc(name: string, mime: string) {
    const path = await upload("kb-documents", name, mime);
    const row = await pool.query<{ id: string }>(
      `insert into public.kb_documents (workspace_id, title, doc_type, source, storage_path, file_name, mime_type) values ($1, $2, 'process', 'upload', $3, $2, $4) returning id`,
      [WORKSPACE, name, path, mime],
    );
    return row.rows[0]!.id;
  }

  async function ingest(embedder: Embedder = fakeEmbedder) {
    const { runKnowledgeIngestion } = await import("../../src/services/knowledgeIngestion.service.js");
    return runKnowledgeIngestion({ embedder, workspaceId: WORKSPACE, limit: 10 });
  }

  const docRow = async (id: string) =>
    (await pool.query(`select status, error, chunk_count, attempt_count, next_attempt_at, content_hash, embedding_model, extracted_text, claimed_at from public.kb_documents where id = $1`, [id])).rows[0];
  const chunks = async (id: string) =>
    (await pool.query(`select id, chunk_index, content, metadata, embedding is not null as embedded from public.kb_chunks where document_id = $1 order by chunk_index`, [id])).rows;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    WORKSPACE = randomUUID();
    await createTestWorkspace(pool, "kb-ingest", { id: WORKSPACE });
  });

  afterAll(async () => {
    await deleteCreatedTestWorkspaces(pool);
    await removeStorageObjects(uploaded);
    await pool.end();
  });

  it("pasted text becomes ready with embedded chunks", async () => {
    const id = await textDoc("# Pricing\n\nPlans start at fifty thousand rupees.\n\n# Process\n\nWe research, then call.");
    expect(await ingest()).toEqual([{ id, outcome: "ready" }]);
    expect(await docRow(id)).toMatchObject({ status: "ready", error: null, chunk_count: 1, embedding_model: "fake-embedding", claimed_at: null });
    // E2b: both sections are under 60 tokens, so the first merges into the second (which keeps its heading).
    expect(await chunks(id)).toMatchObject([
      { chunk_index: 0, content: "Pricing\n\nPlans start at fifty thousand rupees.\n\nProcess\n\nWe research, then call.", metadata: { heading: "Process" }, embedded: true },
    ]);
  });

  it("an uploaded PDF becomes ready with page metadata on its chunks", async () => {
    const id = await fileDoc("sample.pdf", "application/pdf");
    expect(await ingest()).toEqual([{ id, outcome: "ready" }]);
    expect((await docRow(id)).extracted_text).toContain("Then we run outreach campaigns.");
    // E2b: the three short pages merge forward into the last page's chunk.
    expect((await chunks(id)).map((c) => c.metadata)).toEqual([{ page: 3 }]);
  });

  it("a scanned PDF fails with the clear message and is not retried", async () => {
    const id = await fileDoc("scanned.pdf", "application/pdf");
    expect(await ingest()).toEqual([{ id, outcome: "failed" }]);
    expect(await docRow(id)).toMatchObject({ status: "failed", error: "No readable text found — the PDF may be scanned images.", attempt_count: 0 });
    expect(await ingest()).toEqual([]);
  });

  it("a deferral goes back to pending later without using an attempt", async () => {
    const id = await textDoc("Deferred document text.");
    const deferring: Embedder = { model: "fake-embedding", embed: async () => Promise.reject(new ProviderDeferredError("OpenAI is not configured", 600_000)) };
    expect(await ingest(deferring)).toEqual([{ id, outcome: "deferred" }]);
    const row = await docRow(id);
    expect(row).toMatchObject({ status: "pending", attempt_count: 0, error: "Waiting: OpenAI is not configured" });
    expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 500_000);
    expect(await ingest()).toEqual([]); // not due yet
  });

  it("other errors retry with backoff and fail after 3 attempts", async () => {
    const id = await textDoc("Flaky document text.");
    const broken: Embedder = { model: "fake-embedding", embed: async () => Promise.reject(new Error("socket closed")) };
    expect(await ingest(broken)).toEqual([{ id, outcome: "retry" }]);
    expect(await docRow(id)).toMatchObject({ status: "pending", attempt_count: 1, error: "socket closed" });
    await pool.query(`update public.kb_documents set next_attempt_at = null, attempt_count = 2 where id = $1`, [id]);
    expect(await ingest(broken)).toEqual([{ id, outcome: "failed" }]);
    expect(await docRow(id)).toMatchObject({ status: "failed", attempt_count: 3, error: "Failed after 3 attempts: socket closed" });
  });

  it("E2b: a ready document from an older chunker is re-chunked and re-embedded once", async () => {
    const id = await textDoc("# Title only\n\n# Section\n\nThe body of the section.");
    await ingest();
    const merged = ["Title only\n\nSection\n\nThe body of the section."];
    expect((await chunks(id)).map((c) => c.content)).toEqual(merged);
    // As if chunked before E2b: no chunker version, old chunk text.
    await pool.query(`update public.kb_documents set chunker_version = null where id = $1`, [id]);
    await pool.query(`update public.kb_chunks set content = 'old' where document_id = $1`, [id]);
    const calls = fakeEmbedder.calls.length;
    expect(await ingest()).toEqual([{ id, outcome: "ready" }]);
    expect(fakeEmbedder.calls.length).toBe(calls + 1);
    expect((await chunks(id)).map((c) => c.content)).toEqual(merged);
    expect((await pool.query(`select chunker_version from public.kb_documents where id = $1`, [id])).rows[0]).toEqual({ chunker_version: 2 });
    expect(await ingest()).toEqual([]);
  });

  it("reprocessing unchanged text keeps the chunks; changed text replaces them", async () => {
    const id = await textDoc("Original text about cold calling.");
    await ingest();
    const before = await chunks(id);
    const calls = fakeEmbedder.calls.length;

    await pool.query(`update public.kb_documents set status = 'pending', attempt_count = 0 where id = $1`, [id]);
    expect(await ingest()).toEqual([{ id, outcome: "unchanged" }]);
    expect(fakeEmbedder.calls.length).toBe(calls);
    expect(await chunks(id)).toEqual(before);
    expect((await docRow(id)).status).toBe("ready");

    await pool.query(`update public.kb_documents set status = 'pending', raw_text = 'New text about pricing.' where id = $1`, [id]);
    expect(await ingest()).toEqual([{ id, outcome: "ready" }]);
    expect(fakeEmbedder.calls.length).toBe(calls + 1);
    const after = await chunks(id);
    expect(after.map((c) => c.content)).toEqual(["New text about pricing."]);
    expect(after[0]!.id).not.toBe(before[0]!.id);
  });

  it("reclaims a document stuck in processing (using an attempt)", async () => {
    const id = await textDoc("Stuck document text.");
    await pool.query(`update public.kb_documents set status = 'processing', claimed_at = now() - interval '20 minutes' where id = $1`, [id]);
    expect(await ingest()).toEqual([{ id, outcome: "ready" }]);
    expect(await docRow(id)).toMatchObject({ status: "ready", attempt_count: 1 });
  });

  it("a stale claim (reprocessed meanwhile) never overwrites the newer state", async () => {
    const { claimKnowledgeDocuments, processKnowledgeDocument } = await import("../../src/services/knowledgeIngestion.service.js");
    const { withTransaction } = await import("../../src/db.js");
    const id = await textDoc("Racing document text.");
    const [claimed] = await withTransaction((db) => claimKnowledgeDocuments(db, { workspaceId: WORKSPACE }));
    await pool.query(`update public.kb_documents set status = 'pending', claimed_at = null where id = $1`, [id]);
    expect(await processKnowledgeDocument(claimed!, { embedder: fakeEmbedder })).toBe("stale");
    expect(await docRow(id)).toMatchObject({ status: "pending", chunk_count: 0 });
    expect(await chunks(id)).toEqual([]);
    await pool.query(`delete from public.kb_documents where id = $1`, [id]);
  });

  it("an asset's linked document is ingested from the asset's own file with the Asset/Use when prefix", async () => {
    const mime = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    const path = await upload("agent-assets", "sample.pptx", mime);
    const doc = await pool.query<{ id: string }>(
      `insert into public.kb_documents (workspace_id, title, doc_type, source, storage_bucket, storage_path, file_name, mime_type)
       values ($1, 'Results deck', 'asset', 'upload', 'agent-assets', $2, 'sample.pptx', $3) returning id`,
      [WORKSPACE, path, mime],
    );
    const id = doc.rows[0]!.id;
    await pool.query(
      `insert into public.agent_assets (workspace_id, title, use_when, channels, storage_path, file_name, mime_type, kb_document_id)
       values ($1, 'Results deck', 'the lead asks for proof', '{email}', $2, 'sample.pptx', $3, $4)`,
      [WORKSPACE, path, mime, id],
    );
    expect(await ingest()).toEqual([{ id, outcome: "ready" }]);
    const assetChunks = await chunks(id);
    // E2b: both short slides merge into one chunk with the last slide's metadata.
    expect(assetChunks[0]!.content).toBe("Asset: Results deck. Use when: the lead asks for proof.\n\nWhy Northbeam\nSenior callers,\nno scripts.\n\nOur results\n3x reply rates\n<30 day ramp");
    expect(assetChunks.map((c) => c.metadata.slide)).toEqual([2]);
  });
});
