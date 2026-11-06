/**
 * E3b-2a-2 rule 4: `npm run staging:seed-reply-draft` — one open sample draft for a seeded test contact's
 * latest matched reply (no AI call), and its refusals. [test] workspaces only (scoped by workspaceId).
 * Skipped unless TEST_DATABASE_URL is set.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createTestWorkspace, deleteCreatedTestWorkspaces } from "../helpers/testWorkspaces.js";
import { assertStagingDatabase, SEED_MARKER } from "../../scripts/seed-ai-test-contacts.js";
import { removeSeededReplyDrafts, SAMPLE_BODY, SEED_DRAFT_MODEL, seedReplyDraft } from "../../scripts/seed-reply-draft.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb("E3b-2a-2 staging:seed-reply-draft (requires TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let ws: string;

  async function contact(first: string, opts: { seeded?: boolean } = {}) {
    const last = `Seed${randomUUID().slice(0, 8)}`;
    const row = await pool.query(
      `insert into public.leads (workspace_id, first_name, last_name, company, source, email, created_by_name)
       values ($1, $2, $3, 'Acme Steel', 'referral', $4, $5) returning id`,
      [ws, first, last, `seed-${randomUUID()}@example.com`, opts.seeded === false ? "Someone" : SEED_MARKER],
    );
    return { id: row.rows[0].id as string, name: `${first} ${last}` };
  }

  const whatsappReply = (leadId: string, minutesAgo = 0) =>
    pool.query(
      `insert into public.whatsapp_inbound_events (message_id, workspace_id, sender_jid, sender_phone_e164, message_type, received_at, disposition, match_count, lead_id)
       values ($1, $2, '919000000001@s.whatsapp.net', '+919000000001', 'conversation', now() - $4 * interval '1 minute', 'matched', 1, $3) returning message_id`,
      [`seed-${randomUUID()}`, ws, leadId, minutesAgo],
    );

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
    ws = await createTestWorkspace(pool, "seed-reply-draft");
  });

  afterAll(async () => {
    await deleteCreatedTestWorkspaces(pool);
    await pool.end();
  });

  it("refuses production / non-staging databases (checked before connecting)", () => {
    expect(() => assertStagingDatabase("postgres://postgres.jorxltfwboabyjiydyhu:x@pooler.supabase.com:5432/postgres")).toThrow(/production/);
    expect(() => assertStagingDatabase("postgres://localhost/postgres")).toThrow(/not the staging/);
  });

  it("refuses a contact that isn't seeded or has no matched reply; seeds one open draft on the latest reply; refuses a second; --remove deletes it", async () => {
    const other = await contact("Ravi", { seeded: false });
    await whatsappReply(other.id);
    await expect(seedReplyDraft(pool, { contact: other.name, workspaceId: ws })).rejects.toThrow(/is not a seeded AI test contact/);

    const quiet = await contact("Meera");
    await expect(seedReplyDraft(pool, { contact: quiet.name, workspaceId: ws })).rejects.toThrow(/has no matched reply/);

    const asha = await contact("Asha");
    await whatsappReply(asha.id, 10);
    const latest = (await whatsappReply(asha.id, 1)).rows[0].message_id as string;
    expect(await seedReplyDraft(pool, { contact: asha.name.toUpperCase(), workspaceId: ws })).toMatch(new RegExp(`^Seeded an open WhatsApp suggested reply .+ for ${asha.name}`));
    const rows = (await pool.query(`select whatsapp_message_id, status, body, model, cost_usd from public.reply_drafts where lead_id = $1`, [asha.id])).rows;
    expect(rows).toEqual([{ whatsapp_message_id: latest, status: "open", body: SAMPLE_BODY.whatsapp, model: SEED_DRAFT_MODEL, cost_usd: "0.000000" }]);
    await expect(seedReplyDraft(pool, { contact: asha.name, workspaceId: ws })).rejects.toThrow(/already has an open suggested reply/);

    // --remove deletes only the seeded drafts.
    await pool.query(`insert into public.reply_drafts (workspace_id, lead_id, channel, whatsapp_message_id, body, status, model) values ($1, $2, 'whatsapp', $3, 'real', 'superseded', 'm')`, [
      ws,
      asha.id,
      (await whatsappReply(asha.id, 20)).rows[0].message_id,
    ]);
    expect(await removeSeededReplyDrafts(pool, { contact: asha.name, workspaceId: ws })).toBe(1);
    expect((await pool.query(`select model from public.reply_drafts where lead_id = $1`, [asha.id])).rows).toEqual([{ model: "m" }]);
  });
});
