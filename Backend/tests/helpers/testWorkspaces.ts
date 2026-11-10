/**
 * Test workspaces: created with a recognisable name, deleted completely.
 * Also used by scripts/cleanup-test-workspaces.ts. Every failure throws.
 */
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { isNetworkError, withNetworkRetry } from "./networkRetry.js";

/** Every test-created workspace is named `[test] <label> <uuid>`. */
export const TEST_WORKSPACE_PREFIX = "[test] ";

// Workspaces created by this test file (vitest isolates modules per file).
const created = new Set<string>();
// E4b rule 8: test users of this file that join every [test] workspace it creates (their role there = their test role).
const trackedMembers = new Map<string, "admin" | "salesperson">();

/** E4b rule 8: makes a test user a member of every [test] workspace this file created or will create. */
export async function trackTestMember(db: Pool | PoolClient, userId: string, role: "admin" | "salesperson"): Promise<void> {
  trackedMembers.set(userId, role);
  for (const id of created) await addTestMember(db, id, userId, role);
}

export async function createTestWorkspace(
  db: Pool | PoolClient,
  label: string,
  options: { id?: string; isActive?: boolean; defaultLeadOwnerId?: string | null } = {},
): Promise<string> {
  const id = options.id ?? randomUUID();
  await db.query(`insert into public.workspaces (id, name, slug, is_active, default_lead_owner_id) values ($1, $2, $3, $4, $5)`, [
    id,
    `${TEST_WORKSPACE_PREFIX}${label} ${id}`,
    `test-${label}-${id}`,
    options.isActive ?? true,
    options.defaultLeadOwnerId ?? null,
  ]);
  created.add(id);
  for (const [userId, role] of trackedMembers) await addTestMember(db, id, userId, role);
  return id;
}

/**
 * E4b rule 8: makes a test user a member of a `[test]` workspace (role in that workspace; an existing
 * membership gets the new role). Refuses any other workspace.
 */
export async function addTestMember(db: Pool | PoolClient, workspaceId: string, userId: string, role: "admin" | "salesperson"): Promise<void> {
  const added = await db.query(
    `insert into public.workspace_members (workspace_id, user_id, role)
     select w.id, $2, $3 from public.workspaces w where w.id = $1 and w.name like '[test] %'
     on conflict (workspace_id, user_id) do update set role = excluded.role, updated_at = now()`,
    [workspaceId, userId, role],
  );
  if (added.rowCount !== 1) throw new Error(`addTestMember: ${workspaceId} is not a [test] workspace.`);
}

/**
 * afterAll: deletes every workspace this file created (before its test users). A network error that
 * outlasts the retries is logged and left to the global teardown's sweep (tests/global-setup.ts);
 * any other failure throws.
 */
export async function deleteCreatedTestWorkspaces(pool: Pool): Promise<void> {
  for (const id of created) {
    try {
      await deleteTestWorkspace(pool, id);
    } catch (error) {
      if (!isNetworkError(error)) throw error;
      console.error(`[test cleanup] workspace ${id} not deleted (network); the global teardown sweeps it: ${error instanceof Error ? error.message : String(error)}`);
    }
    created.delete(id);
  }
}

export interface StorageObject {
  bucket: string;
  path: string;
}

// Tables whose workspace_id reference does NOT cascade, children before parents.
// Most lead children cascade from leads; these are deleted by workspace_id for rows
// that outlive their lead link (or have none).
const NO_CASCADE_TABLES = [
  "whatsapp_outbound_messages",
  "whatsapp_inbound_events",
  "scheduled_actions",
  "tasks",
  "workflow_runs",
  "calls",
  "meetings",
  "proposals",
  "notifications",
  "deleted_leads_audit",
] as const;
const CONNECTION_TABLES = [
  "integration_connections",
  "google_calendar_connection",
  "whatsapp_number_auth_keys",
  "whatsapp_number_auth_credentials",
  "whatsapp_numbers",
  "whatsapp_connection",
  "whatsapp_auth_credentials",
  "whatsapp_auth_keys",
] as const;

/**
 * Deletes one workspace and everything that belongs to it, inside the
 * caller's transaction. Returns the Storage objects to remove after commit.
 */
export async function deleteWorkspaceRows(client: PoolClient, workspaceId: string): Promise<StorageObject[]> {
  const storage = (
    await client.query<StorageObject>(
      `select storage_bucket as bucket, storage_path as path from public.kb_documents where workspace_id = $1 and storage_path is not null
       union all
       select 'agent-assets', storage_path from public.agent_assets where workspace_id = $1 and storage_path is not null
       union all
       select 'proposal-documents', document_storage_path from public.proposals where workspace_id = $1 and document_storage_path is not null
       union all
       select 'template-attachments', a.storage_path from public.template_attachments a
         join public.message_templates t on t.id = a.template_id where t.workspace_id = $1 and a.storage_path is not null`,
      [workspaceId],
    )
  ).rows;

  // Leads first: calls, notes, meetings, proposals, tasks, timeline, runs, scheduled actions,
  // agent rows and lead notifications cascade from them.
  await client.query(`delete from public.leads where workspace_id = $1`, [workspaceId]);
  for (const table of NO_CASCADE_TABLES) await client.query(`delete from public.${table} where workspace_id = $1`, [workspaceId]);

  // Workflows the way the app deletes them: a published version's steps can only be
  // removed once the version is flipped back to Draft (workflow_steps_draft_only_edit).
  const { deleteWorkflow } = await import("../../src/services/workflows.service.js");
  const workflows = await client.query<{ id: string }>(`select id from public.workflows where workspace_id = $1`, [workspaceId]);
  for (const { id } of workflows.rows) await deleteWorkflow(client, workspaceId, id, { force: true });

  await client.query(`delete from public.message_templates where workspace_id = $1`, [workspaceId]);
  for (const table of CONNECTION_TABLES) await client.query(`delete from public.${table} where workspace_id = $1`, [workspaceId]);
  // agent_* tables, kb_* tables and lead_assignment_rules cascade from the workspace.
  const deleted = await client.query(`delete from public.workspaces where id = $1`, [workspaceId]);
  if (deleted.rowCount !== 1) throw new Error(`Workspace ${workspaceId} was not deleted (not found).`);
  return storage;
}

/** Removes Storage objects collected by deleteWorkspaceRows. Throws on failure. */
export async function removeStorageObjects(objects: StorageObject[]): Promise<void> {
  if (!objects.length) return;
  const { supabaseAdmin } = await import("../../src/supabaseAdmin.js");
  const byBucket = new Map<string, string[]>();
  for (const { bucket, path } of objects) byBucket.set(bucket, [...(byBucket.get(bucket) ?? []), path]);
  for (const [bucket, paths] of byBucket) {
    // P7: removing is idempotent, so network errors are retried.
    await withNetworkRetry(async () => {
      const { error } = await supabaseAdmin.storage.from(bucket).remove(paths);
      if (error) throw new Error(`Couldn't remove ${paths.length} Storage object(s) from ${bucket}: ${error.message}`);
    });
  }
}

/**
 * Deletes a test workspace and everything in it, in one transaction, then its Storage objects.
 * Network errors are retried (P7); a retry after a commit whose reply was lost finds the workspace
 * gone and stops there. Throws on failure.
 */
export async function deleteTestWorkspace(pool: Pool, workspaceId: string): Promise<void> {
  const storage = await withNetworkRetry(async () => {
    const client = await pool.connect();
    let broken: Error | undefined;
    try {
      if (!(await client.query(`select 1 from public.workspaces where id = $1`, [workspaceId])).rowCount) return [];
      await client.query("begin");
      const objects = await deleteWorkspaceRows(client, workspaceId);
      await client.query("commit");
      return objects;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      broken = new Error(`Test workspace ${workspaceId} could not be deleted: ${error instanceof Error ? error.message : String(error)}`);
      throw broken;
    } finally {
      // A connection that failed is discarded, so the retry gets a fresh one.
      client.release(broken);
    }
  });
  await removeStorageObjects(storage);
}
