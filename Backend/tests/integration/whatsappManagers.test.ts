/**
 * The worker's WhatsApp manager scan against a real database: which
 * workspaces get a manager. BaileysManager is mocked (no WhatsApp socket, no
 * lock connection). Skipped unless TEST_DATABASE_URL is set.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestWorkspace, deleteCreatedTestWorkspaces } from "../helpers/testWorkspaces.js";
import { Pool } from "pg";

const mocks = vi.hoisted(() => ({ started: [] as string[] }));
vi.mock("../../src/providers/baileys.manager.js", () => ({
  BaileysManager: class {
    isStopped = false;
    constructor(readonly workspaceId: string) {}
    start = async () => {
      mocks.started.push(this.workspaceId);
    };
    stop = async () => undefined;
  },
}));

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb("WhatsApp manager scan (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  const workspaceIds: string[] = [];

  async function workspace(row: { desired: string; status: string } | null, active = true) {
    const id = randomUUID();
    await createTestWorkspace(pool, "wa-managers-test", { id: id, isActive: active });
    workspaceIds.push(id);
    if (row) {
      await pool.query(`insert into public.whatsapp_connection (workspace_id) values ($1)`, [id]);
      await pool.query(`insert into public.whatsapp_numbers (workspace_id, label, desired_state, status) values ($1, '#1', $2, $3)`, [id, row.desired, row.status]);
    }
    return id;
  }

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await deleteCreatedTestWorkspaces(pool);
    await pool.end();
  });

  it("starts managers only for numbers that need a socket, on active workspaces", async () => {
    const noRow = await workspace(null);
    const idle = await workspace({ desired: "disconnected", status: "disconnected" });
    const reauth = await workspace({ desired: "disconnected", status: "reauth_required" });
    const pairing = await workspace({ desired: "connected", status: "qr_ready" });
    const connected = await workspace({ desired: "connected", status: "connected" });
    const restart = await workspace({ desired: "restart", status: "connected" });
    const loggingOut = await workspace({ desired: "disconnected", status: "connected" });
    const inactive = await workspace({ desired: "connected", status: "connected" }, false);
    // E4a: a second, connected number of the same workspace → a second manager; a removed one → none.
    await pool.query(`insert into public.whatsapp_numbers (workspace_id, label, desired_state, status) values ($1, '#2', 'connected', 'connected')`, [connected]);
    const removed = await workspace({ desired: "disconnected", status: "disconnected" });
    await pool.query(`update public.whatsapp_numbers set removed_at = now(), desired_state = 'connected' where workspace_id = $1`, [removed]);

    const { BaileysManagerRegistry } = await import("../../src/providers/baileys-registry.js");
    const registry = new BaileysManagerRegistry() /* the session URL */;
    await registry.ensureManagers();

    const ours = mocks.started.filter((id) => workspaceIds.includes(id));
    expect(ours.sort()).toEqual([pairing, connected, connected, restart, loggingOut].sort());
    for (const id of [noRow, idle, reauth, inactive, removed]) expect(mocks.started).not.toContain(id);

    // Settings → Connect on an idle workspace: picked up by the next scan.
    await pool.query(`update public.whatsapp_numbers set desired_state = 'connected', command_version = command_version + 1 where workspace_id = $1`, [idle]);
    await registry.ensureManagers();
    expect(mocks.started).toContain(idle);
    await registry.stopAll();
  });
});
