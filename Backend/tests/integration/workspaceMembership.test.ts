/**
 * E4b rules 5–7: assignment and notifications follow workspace membership. [test] workspaces only.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { Actor } from "../../src/authMiddleware.js";
import { startTestApi, type TestApi } from "../helpers/testApi.js";
import { addTestMember, createTestWorkspace, deleteCreatedTestWorkspaces } from "../helpers/testWorkspaces.js";
import { connectedNumber } from "../helpers/whatsappNumbers.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb("workspace membership in services and worker (E4b, requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let api: TestApi;
  let A: string;
  let B: string;
  let adminA: Actor;
  let adminB: Actor;
  let salesA: Actor;
  let outsider: Actor;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    api = await startTestApi(pool, "ws-members");
    A = await createTestWorkspace(pool, "members-a");
    B = await createTestWorkspace(pool, "members-b");
    adminA = await api.newUser("admin", { member: false });
    adminB = await api.newUser("admin", { member: false });
    salesA = await api.newUser("salesperson", { member: false });
    outsider = await api.newUser("salesperson", { member: false });
    await addTestMember(pool, A, adminA.id, "admin");
    await addTestMember(pool, A, salesA.id, "salesperson");
    await addTestMember(pool, B, adminB.id, "admin");
  });

  afterAll(async () => {
    await api?.close();
    await deleteCreatedTestWorkspaces(pool);
    await pool?.end();
  });

  it("an auto-pause alert reaches only that workspace's admins", async () => {
    const numberId = await connectedNumber(pool, A);
    const { autoPause } = await import("../../src/services/whatsappSafety.service.js");
    expect(await autoPause(pool, A, numberId, "Test restriction.")).toBe(true);
    const notes = await pool.query<{ recipient_id: string }>(`select recipient_id from public.notifications where workspace_id = $1 and title like 'WhatsApp number%paused%'`, [A]);
    expect(notes.rows.map((n) => n.recipient_id)).toEqual([adminA.id]);
  });

  it("revenue assignment never picks a non-member (rule or fallback)", async () => {
    const { assignOwnerForNewLead } = await import("../../src/services/leadAssignment.service.js");
    await pool.query(`update public.workspaces set default_lead_owner_id = $2 where id = $1`, [A, outsider.id]);
    await pool.query(`insert into public.lead_assignment_rules (workspace_id, position, min_cr, max_cr, owner_id) values ($1, 1, null, null, $2)`, [A, outsider.id]);
    expect((await assignOwnerForNewLead(pool, A, null)).ownerId).toBeNull();
    await addTestMember(pool, A, outsider.id, "salesperson");
    expect((await assignOwnerForNewLead(pool, A, null)).ownerId).toBe(outsider.id);
    await pool.query(`delete from public.workspace_members where workspace_id = $1 and user_id = $2`, [A, outsider.id]);
    await pool.query(`delete from public.lead_assignment_rules where workspace_id = $1`, [A]);
    await pool.query(`update public.workspaces set default_lead_owner_id = null where id = $1`, [A]);
  });

  it("pickers and assignment accept only members; a kept non-member owner can stay", async () => {
    const rules = await api.call(adminA, A, "PUT", "/assignment-rules", { rules: [{ position: 0, minCr: null, maxCr: null, ownerId: adminB.id }], fallbackOwnerId: null });
    expect(rules.status).toBe(400);
    expect(rules.body.error.message).toBe("Every owner must be an active member of this workspace.");

    const lead = await api.call(salesA, A, "POST", "/leads", { firstName: "Member", company: "Acme", source: "referral", email: `m-${randomUUID()}@example.com`, ownerId: adminB.id });
    expect(lead.status).toBe(400);
    expect(lead.body.error.message).toBe("The owner must be an active member of this workspace.");

    const created = await api.call(salesA, A, "POST", "/leads", { firstName: "Member", company: "Acme", source: "referral", email: `m-${randomUUID()}@example.com`, ownerId: salesA.id });
    expect(created.status).toBe(201);
    const bulk = await api.call(adminA, A, "POST", "/contacts/bulk", { ids: [created.body.id], action: "assignOwner", ownerId: adminB.id });
    expect(bulk.status).toBe(400);

    // A lead owned by a non-member keeps its owner on an unrelated edit.
    await pool.query(`update public.leads set owner_id = $2 where id = $1`, [created.body.id, adminB.id]);
    const edit = await api.call(adminA, A, "PATCH", `/leads/${created.body.id}`, { jobTitle: "CEO", ownerId: adminB.id });
    expect(edit.status).toBe(200);
  });
});
