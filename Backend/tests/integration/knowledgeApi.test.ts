/**
 * Knowledge-base API through the real HTTP stack (createApp, login bypassed)
 * against the staging database and Storage. The server's embedder is replaced
 * with the deterministic fake (or an unconfigured one): never calls OpenAI.
 * Uploaded objects are removed afterwards.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import type { Actor } from "../../src/authMiddleware.js";
import type { Embedder } from "../../src/providers/openai.provider.js";
import { fakeEmbedder } from "../helpers/fakeEmbedder.js";

const mocks = vi.hoisted(() => ({ embedder: null as Embedder | null }));
vi.mock("../../src/providers/openai.provider.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/providers/openai.provider.js")>()),
  getDefaultEmbedder: () => mocks.embedder,
}));

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const fixture = (name: string) => readFileSync(new URL(`../fixtures/knowledge/${name}`, import.meta.url));

describeIfDb("knowledge API (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  const authUserIds: string[] = [];
  let admin: Actor;
  let rep: Actor;
  let actor: Actor;
  let WORKSPACE: string;
  let server: Server;
  let base: string;

  async function newUser(role: "admin" | "salesperson"): Promise<Actor> {
    const auth = await pool.query(`insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`, [`kb-${role}-${randomUUID()}@example.com`]);
    authUserIds.push(auth.rows[0].id);
    const profile = await pool.query(`update public.profiles set role = $2 where id = $1 returning id, full_name, email`, [auth.rows[0].id, role]);
    return { id: profile.rows[0].id, fullName: profile.rows[0].full_name, email: profile.rows[0].email, isActive: true, role };
  }

  async function api(as: Actor, method: string, path: string, body?: unknown) {
    actor = as;
    const isForm = body instanceof FormData;
    const res = await fetch(`${base}/api/v1/knowledge${path}`, {
      method,
      headers: { "X-Workspace-Id": WORKSPACE, ...(body !== undefined && !isForm ? { "Content-Type": "application/json" } : {}) },
      ...(body !== undefined ? { body: isForm ? body : JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  }

  const form = (fields: Record<string, string>, file?: { name: string; type: string }) => {
    const data = new FormData();
    for (const [key, value] of Object.entries(fields)) data.append(key, value);
    if (file) data.append("file", new Blob([fixture(file.name)], { type: file.type }), file.name);
    return data;
  };

  async function ingest() {
    const { runKnowledgeIngestion } = await import("../../src/services/knowledgeIngestion.service.js");
    return runKnowledgeIngestion({ embedder: fakeEmbedder, workspaceId: WORKSPACE, limit: 10 });
  }

  async function objectExists(bucket: string, path: string) {
    const { supabaseAdmin } = await import("../../src/supabaseAdmin.js");
    const { data } = await supabaseAdmin.storage.from(bucket).download(path);
    return Boolean(data);
  }

  const chunkCount = async (documentId: string) => (await pool.query(`select count(*)::int as n from public.kb_chunks where document_id = $1`, [documentId])).rows[0].n as number;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    mocks.embedder = fakeEmbedder;
    admin = await newUser("admin");
    rep = await newUser("salesperson");
    WORKSPACE = randomUUID();
    await pool.query(`insert into public.workspaces (id, name, slug) values ($1, $2, $2)`, [WORKSPACE, `kb-api-${WORKSPACE}`]);

    const { createApp } = await import("../../src/app.js");
    const app = express();
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use(createApp());
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const { supabaseAdmin } = await import("../../src/supabaseAdmin.js");
    const leftovers = await pool.query<{ bucket: string; path: string }>(
      `select storage_bucket as bucket, storage_path as path from public.kb_documents where workspace_id = $1 and storage_path is not null
       union select 'agent-assets', storage_path from public.agent_assets where workspace_id = $1`,
      [WORKSPACE],
    );
    for (const { bucket, path } of leftovers.rows) await supabaseAdmin.storage.from(bucket).remove([path]);
    await pool.query(`delete from public.workspaces where id = $1`, [WORKSPACE]).catch((error: Error) => console.warn(`[knowledgeApi] cleanup failed: ${error.message}`));
    // Users with append-only admin_audit_events rows can't be deleted; that must not block the others.
    for (const id of authUserIds) await pool.query(`delete from auth.users where id = $1`, [id]).catch(() => undefined);
    await pool.end();
  });

  it("an admin pastes text; the worker makes it ready; the detail shows a preview", async () => {
    const created = await api(admin, "POST", "/documents", { title: "Pricing FAQ", docType: "faq", tags: "Pricing, commercial, pricing", text: "# Plans\n\nPlans start at fifty thousand rupees." });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ title: "Pricing FAQ", docType: "faq", tags: ["pricing", "commercial"], source: "text", status: "pending", chunkCount: 0, assetId: null });
    expect(await ingest()).toEqual([{ id: created.body.id, outcome: "ready" }]);

    const list = await api(rep, "GET", "/documents");
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual([expect.objectContaining({ id: created.body.id, status: "ready", chunkCount: 1 })]);
    expect(list.body.data[0]).not.toHaveProperty("extractedTextPreview");
    const detail = await api(rep, "GET", `/documents/${created.body.id}`);
    expect(detail.body).toMatchObject({ extractedTextPreview: "Plans\n\nPlans start at fifty thousand rupees.", extractedTextLength: 44, chunkCount: 1 });

    const audit = await pool.query(`select action from public.admin_audit_events where target_id = $1`, [created.body.id]);
    expect(audit.rows).toEqual([{ action: "knowledge.document.created" }]);
  });

  it("an admin uploads a PDF; delete removes the row, its chunks and the stored file", async () => {
    const created = await api(admin, "POST", "/documents", form({ docType: "process", tags: "process" }, { name: "sample.pdf", type: "application/pdf" }));
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ title: "sample", fileName: "sample.pdf", mimeType: "application/pdf", source: "upload", status: "pending" });
    await ingest();
    expect(await chunkCount(created.body.id)).toBe(3);
    const { path } = (await pool.query(`select storage_path as path from public.kb_documents where id = $1`, [created.body.id])).rows[0];
    expect(await objectExists("kb-documents", path)).toBe(true);

    expect((await api(admin, "DELETE", `/documents/${created.body.id}`)).status).toBe(204);
    expect(await chunkCount(created.body.id)).toBe(0);
    expect((await api(admin, "GET", `/documents/${created.body.id}`)).status).toBe(404);
    expect(await objectExists("kb-documents", path)).toBe(false);
  });

  it("reprocess and patch documents", async () => {
    const created = await api(admin, "POST", "/documents", { title: "Process", docType: "process", text: "We research, then call." });
    await ingest();
    const patched = await api(admin, "PATCH", `/documents/${created.body.id}`, { title: "Our process", isActive: false });
    expect(patched.body).toMatchObject({ title: "Our process", isActive: false, docType: "process", tags: [] });
    const again = await api(admin, "POST", `/documents/${created.body.id}/reprocess`);
    expect(again.body).toMatchObject({ status: "pending", attemptCount: 0, error: null });
    expect(await ingest()).toEqual([{ id: created.body.id, outcome: "unchanged" }]);
  });

  it("validates uploads and pasted text", async () => {
    const pngAsDoc = new FormData();
    pngAsDoc.append("docType", "faq");
    pngAsDoc.append("file", new Blob([Buffer.from("png")], { type: "image/png" }), "photo.png");
    const cases: [unknown, string][] = [
      [form({ docType: "faq" }), "Attach a file or paste text."],
      [pngAsDoc, "Unsupported file type. Upload a PDF, DOCX, PPTX, Markdown or text file."],
      [{ title: "x", docType: "faq", text: "  " }, "Paste some text."],
      [{ title: "x", docType: "asset", text: "hi" }, "docType"],
    ];
    for (const [body, message] of cases) {
      const res = await api(admin, "POST", "/documents", body);
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body.error)).toContain(message);
    }
  });

  it("assets: create ingests a linked document with the prefix; its document can't be deleted directly; delete cleans up everything", async () => {
    const created = await api(
      admin,
      "POST",
      "/assets",
      form({ title: "Process one-pager", useWhen: "the lead asks how we work", tags: "process", channels: "email,whatsapp" }, { name: "sample.pdf", type: "application/pdf" }),
    );
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ title: "Process one-pager", channels: ["email", "whatsapp"], tags: ["process"], fileName: "sample.pdf", status: "pending", isActive: true });
    expect(created.body.downloadUrl).toMatch(/^https:\/\//);
    const docId = created.body.kbDocumentId as string;
    expect((await api(rep, "GET", `/documents/${docId}`)).body).toMatchObject({ docType: "asset", assetId: created.body.id, title: "Process one-pager" });

    await ingest();
    const first = await pool.query(`select content from public.kb_chunks where document_id = $1 order by chunk_index limit 1`, [docId]);
    expect(first.rows[0].content).toBe("Asset: Process one-pager. Use when: the lead asks how we work.\n\nOur process starts with research.");
    const listed = await api(rep, "GET", "/assets");
    expect(listed.body.data).toEqual([expect.objectContaining({ id: created.body.id, status: "ready", chunkCount: 3, downloadUrl: expect.stringMatching(/^https:\/\//) })]);

    expect(await api(admin, "DELETE", `/documents/${docId}`)).toMatchObject({ status: 409, body: { error: { message: "This document belongs to an asset. Delete the asset instead." } } });
    expect((await api(admin, "PATCH", `/documents/${docId}`, { title: "x" })).status).toBe(409);

    const patched = await api(admin, "PATCH", `/assets/${created.body.id}`, { useWhen: "the lead wants proof", channels: ["email"] });
    expect(patched.body).toMatchObject({ useWhen: "the lead wants proof", channels: ["email"], status: "pending" });
    await ingest();
    const reingested = await pool.query(`select content from public.kb_chunks where document_id = $1 order by chunk_index limit 1`, [docId]);
    expect(reingested.rows[0].content).toContain("Use when: the lead wants proof.");

    const { path } = (await pool.query(`select storage_path as path from public.agent_assets where id = $1`, [created.body.id])).rows[0];
    expect((await api(admin, "DELETE", `/assets/${created.body.id}`)).status).toBe(204);
    expect((await pool.query(`select 1 from public.kb_documents where id = $1`, [docId])).rowCount).toBe(0);
    expect(await chunkCount(docId)).toBe(0);
    expect(await objectExists("agent-assets", path)).toBe(false);
  });

  it("assets validate their channels and file type", async () => {
    const noChannel = await api(admin, "POST", "/assets", form({ title: "x", useWhen: "y", channels: "sms" }, { name: "sample.pdf", type: "application/pdf" }));
    expect(noChannel.status).toBe(400);
    const textFile = await api(admin, "POST", "/assets", form({ title: "x", useWhen: "y", channels: "email" }, { name: "sample.txt", type: "text/plain" }));
    expect(textFile).toMatchObject({ status: 400, body: { error: { message: "Unsupported file type. Upload a PDF, PPTX, DOCX, PNG or JPEG file." } } });
  });

  it("salespeople can read and search but every write is 403", async () => {
    const doc = (await pool.query<{ id: string }>(`select id from public.kb_documents where workspace_id = $1 limit 1`, [WORKSPACE])).rows[0]!.id;
    const writes: [string, string, unknown?][] = [
      ["POST", "/documents", { title: "x", docType: "faq", text: "y" }],
      ["POST", "/documents", form({ docType: "faq" }, { name: "sample.txt", type: "text/plain" })],
      ["PATCH", `/documents/${doc}`, { title: "x" }],
      ["POST", `/documents/${doc}/reprocess`],
      ["DELETE", `/documents/${doc}`],
      ["POST", "/assets", form({ title: "x", useWhen: "y", channels: "email" }, { name: "sample.pdf", type: "application/pdf" })],
      ["PATCH", `/assets/${randomUUID()}`, { title: "x" }],
      ["DELETE", `/assets/${randomUUID()}`],
    ];
    for (const [method, path, body] of writes) expect((await api(rep, method, path, body)).status).toBe(403);
    for (const path of ["/documents", `/documents/${doc}`, "/assets"]) expect((await api(rep, "GET", path)).status).toBe(200);

    const search = await api(rep, "POST", "/search", { query: "fifty thousand rupees plans", limit: 3 });
    expect(search.status).toBe(200);
    expect(search.body.data[0]).toMatchObject({ documentTitle: "Pricing FAQ", docType: "faq" });
  });

  it("search returns 503 when the server has no OpenAI key", async () => {
    const { createOpenAIEmbedder } = await import("../../src/providers/openai.provider.js");
    mocks.embedder = createOpenAIEmbedder({ apiKey: "" });
    try {
      expect(await api(rep, "POST", "/search", { query: "pricing" })).toEqual({
        status: 503,
        body: { error: { code: "provider_unavailable", message: "Knowledge search needs an OpenAI API key on the server." } },
      });
    } finally {
      mocks.embedder = fakeEmbedder;
    }
    expect((await api(rep, "POST", "/search", { query: "pricing", limit: 21 })).status).toBe(400);
  });
});
