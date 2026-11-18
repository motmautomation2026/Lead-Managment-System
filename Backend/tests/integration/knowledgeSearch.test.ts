/**
 * Knowledge-base retrieval against a real database with pgvector (migration
 * 022), using the deterministic fake embedder: never calls OpenAI.
 * Skipped unless TEST_DATABASE_URL is set; commits rows in fresh workspaces.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestWorkspace, deleteCreatedTestWorkspaces } from "../helpers/testWorkspaces.js";
import { Pool } from "pg";
import { fakeEmbedder, fakeVector } from "../helpers/fakeEmbedder.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb("knowledge search (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let WORKSPACE: string;
  let OTHER: string;

  async function newWorkspace() {
    const id = randomUUID();
    await createTestWorkspace(pool, "kb-test", { id: id });
    return id;
  }

  /** A pasted-text document with one embedded chunk per given text. */
  async function doc(workspaceId: string, title: string, chunks: string[], { docType = "service", tags = [] as string[], status = "ready", isActive = true } = {}) {
    const inserted = await pool.query<{ id: string }>(
      `insert into public.kb_documents (workspace_id, title, doc_type, tags, source, raw_text, status, is_active, chunk_count, embedding_model)
       values ($1, $2, $3, $4, 'text', $5, $6, $7, $8, 'fake-embedding') returning id`,
      [workspaceId, title, docType, tags, chunks.join("\n\n"), status, isActive, chunks.length],
    );
    const id = inserted.rows[0]!.id;
    for (const [index, content] of chunks.entries()) {
      await pool.query(
        `insert into public.kb_chunks (workspace_id, document_id, chunk_index, content, token_count, embedding, metadata)
         values ($1, $2, $3, $4, $5, $6::extensions.vector, $7)`,
        [workspaceId, id, index, content, content.split(" ").length, `[${fakeVector(content).join(",")}]`, { heading: title }],
      );
    }
    return id;
  }

  async function search(query: string, options = {}, workspaceId = WORKSPACE) {
    const { searchKnowledge } = await import("../../src/services/knowledge.service.js");
    return searchKnowledge(pool, fakeEmbedder, workspaceId, query, options);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    WORKSPACE = await newWorkspace();
    OTHER = await newWorkspace();
    await doc(WORKSPACE, "Cold calling", ["We run cold calling campaigns with senior callers", "Cold calling scripts are tailored per industry"], { tags: ["outbound"] });
    await doc(WORKSPACE, "Pricing", ["Pricing plans start at fifty thousand rupees per month"], { docType: "pricing", tags: ["commercial"] });
    await doc(WORKSPACE, "Acme case study", ["Acme booked forty meetings from cold calling in ninety days"], { docType: "case_study", tags: ["outbound", "manufacturing"] });
    await doc(WORKSPACE, "Retired", ["Cold calling campaigns with senior callers retired offer"], { isActive: false });
    await doc(WORKSPACE, "Still processing", ["Cold calling campaigns with senior callers draft"], { status: "processing" });
    await doc(WORKSPACE, "Broken", ["Cold calling campaigns with senior callers failed"], { status: "failed" });
    await doc(OTHER, "Other workspace", ["We run cold calling campaigns with senior callers"]);
  });

  afterAll(async () => {
    await deleteCreatedTestWorkspaces(pool);
    // Cascades to kb_documents and kb_chunks.
    await pool.end();
  });

  it("returns this workspace's ready, active chunks ordered by similarity", async () => {
    const hits = await search("cold calling campaigns with senior callers");
    expect(hits.map((hit) => hit.documentTitle)).toEqual(["Cold calling", "Cold calling", "Acme case study", "Pricing"]);
    expect(hits[0]).toMatchObject({ content: "We run cold calling campaigns with senior callers", docType: "service", metadata: { heading: "Cold calling" } });
    expect(hits[0]!.score).toBeGreaterThan(0.8);
    const scores = hits.map((hit) => hit.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it("never returns another workspace's chunks", async () => {
    const hits = await search("cold calling campaigns with senior callers", {}, OTHER);
    expect(hits.map((hit) => hit.documentTitle)).toEqual(["Other workspace"]);
    expect((await search("cold calling", {}, await newWorkspace())).length).toBe(0);
  });

  it("excludes inactive and not-ready documents", async () => {
    const titles = (await search("cold calling campaigns with senior callers")).map((hit) => hit.documentTitle);
    for (const excluded of ["Retired", "Still processing", "Broken", "Other workspace"]) expect(titles).not.toContain(excluded);
  });

  it("filters by doc type and by tag overlap, and honours the limit", async () => {
    expect((await search("cold calling", { docTypes: ["case_study", "pricing"] })).map((hit) => hit.documentTitle)).toEqual(["Acme case study", "Pricing"]);
    expect((await search("cold calling", { tags: ["outbound"] })).map((hit) => hit.documentTitle)).toEqual(["Cold calling", "Cold calling", "Acme case study"]);
    expect((await search("cold calling", { tags: ["manufacturing", "nothing"], docTypes: ["case_study"] })).map((hit) => hit.documentTitle)).toEqual(["Acme case study"]);
    expect(await search("cold calling", { limit: 1 })).toHaveLength(1);
    expect(await search("cold calling", { docTypes: [] })).toHaveLength(4);
  });
});
