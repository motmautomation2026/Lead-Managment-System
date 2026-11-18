/**
 * npm run staging:load-seed [-- --confirm] [-- --remove [--confirm]] [-- --workspaces 10 --contacts 2000 --limit-mb 500]
 *
 * P7: realistic-size data on STAGING, in `[test] load-seed <uuid>` workspaces only (refuses anything but
 * the staging ref). Default is a dry run (sizes and the plan). Per workspace: 3 users (@example.com), a
 * WhatsApp connection with 2 fake numbers (disconnected: no worker ever starts a manager), the AI off
 * (no wake-up is ever claimed), N contacts with companies, deals, tasks, timeline events, meetings,
 * proposals; ~20 % with sent AI email + WhatsApp messages and their message facts, some opens, replies,
 * reply drafts, decisions and wake-ups. Sweeper markers are set (company linked, deals attached, score
 * fresh), so a running worker doesn't churn through it. Nothing is sent; nothing calls OpenAI.
 *
 * Size guard: stops before seeding when the database is already over 70 % of --limit-mb (default 500,
 * the Free plan), and after the first workspace when the projected total would be.
 * --remove deletes every load-seed workspace and user (dry run unless --confirm).
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { PoolClient } from "pg";
import { stagingProblem } from "./lib/stagingGuard.js";

export const LOAD_SEED_LABEL = "load-seed";
const USER_EMAIL_LIKE = `${LOAD_SEED_LABEL}-%@example.com`;

export interface LoadSeedArgs {
  confirm: boolean;
  remove: boolean;
  workspaces: number;
  contacts: number;
  limitMb: number;
}

export function parseLoadSeedArgs(argv: string[]): LoadSeedArgs | string {
  const out: LoadSeedArgs = { confirm: false, remove: false, workspaces: 10, contacts: 2000, limitMb: 500 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--confirm") out.confirm = true;
    else if (a === "--remove") out.remove = true;
    else if (a === "--workspaces" || a === "--contacts" || a === "--limit-mb") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) return `${a} needs a whole number.`;
      if (a === "--workspaces") out.workspaces = Math.min(n, 50);
      else if (a === "--contacts") out.contacts = Math.min(n, 10_000);
      else out.limitMb = n;
    } else return `Unknown option ${a}.`;
  }
  return out;
}

/** Projected size after seeding `total` workspaces, from the growth of the first one. Stop at 70 % of the limit. */
export function sizeVerdict(beforeBytes: number, perWorkspaceBytes: number, total: number, limitMb: number) {
  const projected = beforeBytes + perWorkspaceBytes * total;
  const ceiling = limitMb * 1024 * 1024 * 0.7;
  return { projected, ceiling, ok: projected <= ceiling };
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** One workspace and everything in it, set-based (a few dozen statements), inside the caller's transaction. */
async function seedWorkspace(db: PoolClient, index: number, contacts: number): Promise<string> {
  const ws = randomUUID();
  await db.query(`insert into public.workspaces (id, name, slug, is_active) values ($1, $2, $3, true)`, [ws, `[test] ${LOAD_SEED_LABEL} ${ws}`, `test-${LOAD_SEED_LABEL}-${ws}`]);
  const users: string[] = [];
  for (let u = 0; u < 3; u++) {
    const id = (await db.query<{ id: string }>(`insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`, [`${LOAD_SEED_LABEL}-${ws.slice(0, 8)}-${u}@example.com`])).rows[0]!.id;
    await db.query(`update public.profiles set role = $2, is_active = true, full_name = $3 where id = $1`, [id, u === 0 ? "admin" : "salesperson", `Load Seed ${index}.${u}`]);
    await db.query(`insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, $3)`, [ws, id, u === 0 ? "admin" : "salesperson"]);
    users.push(id);
  }
  await db.query(`insert into public.whatsapp_connection (workspace_id, status, desired_state) values ($1, 'disconnected', 'disconnected')`, [ws]);
  const numbers = (
    await db.query<{ id: string }>(
      `insert into public.whatsapp_numbers (workspace_id, label, enabled, status, desired_state, owner_user_id)
       select $1::uuid, 'Seed #' || g, true, 'disconnected', 'disconnected', ($2::uuid[])[g] from generate_series(1, 2) g returning id`,
      [ws, users],
    )
  ).rows.map((r) => r.id);
  const companies = Math.max(1, Math.round(contacts * 0.4));
  const p = [ws, users, numbers, contacts, companies];

  await db.query(
    `insert into public.companies (workspace_id, name, normalized_name, domain, industry, city, country, employee_range, created_at)
     select $1::uuid, 'Seed Company ' || g, 'seed company ' || g, 'seed-' || g || '-' || left($1::uuid::text, 8) || '.example.com',
            (array['Manufacturing','IT Services','Logistics','Pharma','Textiles','Construction'])[1 + g % 6],
            (array['Mumbai','Pune','Delhi','Bengaluru','Chennai'])[1 + g % 5], 'India', (array['11-50','51-200','201-500'])[1 + g % 3],
            now() - (g % 365) * interval '1 day'
       from generate_series(1, $2::int) g`,
    [ws, companies],
  );
  // Contacts: 70 % linked to a company; owners round-robin; lifecycle mostly active; ~20 % on a WhatsApp number (the messaged ones).
  await db.query(
    `with c as (select id, name, row_number() over (order by id) rn from public.companies where workspace_id = $1)
     insert into public.leads (workspace_id, first_name, last_name, company, company_id, email, phone, phone_e164, source, pipeline_stage,
                               lifecycle_state, loss_reason, dnc_reason, owner_id, industry, job_title, created_at, updated_at, last_activity_at,
                               hot_score, hot_band, hot_reasons, hot_score_at, hot_score_dirty, company_link_checked_at, agent_status, whatsapp_number_id)
     select $1::uuid, (array['Asha','Ravi','Meera','Karan','Divya','Arjun','Nisha','Vikram'])[1 + g % 8], 'Seed' || g,
            coalesce(c.name, 'Independent ' || g), c.id, 'seed' || g || '@example.com', '+9198' || lpad(g::text, 8, '0'), '+9198' || lpad(g::text, 8, '0'),
            (array['linkedin','email','website','cold_call','referral','event','inbound_form','other'])[1 + g % 8]::lead_source,
            (array['new','ready_for_first_call','contact_attempted','not_connected_nurture','maybe_nurture','meeting_scheduling','meeting_scheduled',
                   'meeting_follow_up','proposal_preparation','proposal_sent','connected_qualifying','interested_later','negotiation'])[1 + g % 13]::pipeline_stage,
            (case when g % 20 = 1 then 'won' when g % 20 = 2 then 'lost' when g % 33 = 3 then 'long_term_nurture' else 'active' end)::lead_lifecycle_state,
            case when g % 20 = 2 then 'no_response'::lead_loss_reason end, null,
            ($2::uuid[])[1 + g % 3], (array['Manufacturing','IT Services','Logistics'])[1 + g % 3], 'Director',
            now() - (g % 180) * interval '1 day' - (g % 24) * interval '1 hour', now() - (g % 90) * interval '1 day', now() - (g % 60) * interval '1 day',
            (g * 37) % 100, case when (g * 37) % 100 >= 60 then 'hot' when (g * 37) % 100 >= 30 then 'warm' else 'cold' end, array['Seed reason'],
            now(), false, now(), case when g % 10 < 3 then 'active' else 'none' end,
            case when g % 5 = 0 then ($3::uuid[])[1 + g % 2] end
       from generate_series(1, $4::int) g
       left join c on g % 10 < 7 and c.rn = 1 + g % $5::int`,
    p,
  );
  // Every later statement numbers the contacts the same way.
  const L = `(select id, company_id, owner_id, email, phone_e164, whatsapp_number_id, created_at, row_number() over (order by id) rn from public.leads where workspace_id = $1)`;
  await db.query(
    `insert into public.deals (workspace_id, name, lead_id, company_id, owner_id, stage, amount, currency, source, loss_reason, closed_at, created_at)
     select $1::uuid, 'Seed deal ' || l.rn, l.id, l.company_id, l.owner_id,
            (array['qualified','meeting_scheduled','meeting_follow_up','proposal_preparation','proposal_sent','negotiation','won','lost'])[1 + l.rn % 8]::deal_stage,
            50000 + (l.rn % 50) * 10000, 'INR', 'manual', case when l.rn % 8 = 7 then 'price_budget'::lead_loss_reason end,
            case when l.rn % 8 in (6, 7) then now() - (l.rn % 30) * interval '1 day' end, l.created_at
       from ${L} l where l.rn % 10 < 3`,
    [ws],
  );
  await db.query(
    `insert into public.tasks (workspace_id, lead_id, owner_id, task_type, title, due_at, status, origin, completed_at, cancelled_at, created_at)
     select $1::uuid, l.id, l.owner_id, (array['call','follow_up','send_information','schedule_meeting','general_task'])[1 + (l.rn + k) % 5]::task_type,
            case when (l.rn + k) % 50 = 0 then 'Lead replied on WhatsApp — respond today' else 'Seed task ' || l.rn || '.' || k end,
            now() + ((l.rn + k) % 60 - 30) * interval '1 day',
            (case when (l.rn + k) % 20 = 0 then 'cancelled' when (l.rn + k) % 20 < 8 then 'completed' else 'open' end)::task_status,
            (case when (l.rn + k) % 50 = 0 then 'agent' else 'manual' end)::task_origin,
            case when (l.rn + k) % 20 between 1 and 7 then now() - interval '1 day' end, case when (l.rn + k) % 20 = 0 then now() - interval '1 day' end,
            now() - ((l.rn + k) % 90) * interval '1 day'
       from ${L} l cross join generate_series(1, 2) k where k = 1 or l.rn % 2 = 0`,
    [ws],
  );
  await db.query(
    `insert into public.timeline_events (lead_id, occurred_at, event_kind, title, detail, actor_name, actor_source, created_at)
     select l.id, l.created_at + k * interval '3 days', (array['note','call','meeting','automation','stage_change'])[k],
            'Seed event ' || k, 'Seeded for load testing.', 'Load Seed', (array['manual','manual','manual','automation','system'])[k], l.created_at + k * interval '3 days'
       from ${L} l cross join generate_series(1, 5) k`,
    [ws],
  );
  await db.query(
    `insert into public.meetings (workspace_id, lead_id, owner_id, title, scheduled_at, status, outcome, deal_id, created_at)
     select $1::uuid, l.id, l.owner_id, 'Seed meeting ' || l.rn, now() + (l.rn % 40 - 20) * interval '1 day',
            (case when l.rn % 40 < 20 then 'completed' else 'scheduled' end)::meeting_status,
            case when l.rn % 40 < 20 and l.rn % 3 = 0 then 'follow_up_required'::meeting_outcome end, d.id, now() - interval '25 days'
       from ${L} l join public.deals d on d.lead_id = l.id where l.rn % 10 = 0`,
    [ws],
  );
  await db.query(
    `insert into public.proposals (workspace_id, lead_id, owner_id, title, amount, currency, status, sent_at, deal_id, created_at)
     select $1::uuid, l.id, l.owner_id, 'Seed proposal ' || l.rn, 250000, 'INR', 'sent', now() - (l.rn % 20) * interval '1 day', d.id, now() - interval '20 days'
       from ${L} l join public.deals d on d.lead_id = l.id where l.rn % 10 = 1`,
    [ws],
  );
  // AI: history decisions (wait, shadow) for half; ~20 % messaged on both channels (live, really sent).
  await db.query(
    `insert into public.agent_decisions (workspace_id, lead_id, mode, action, reasoning, outcome, input_tokens, output_tokens, cost_usd, created_at)
     select $1::uuid, l.id, 'shadow', 'wait', 'Seed: nothing to say yet.', 'draft', 1000, 100, 0.001, now() - (l.rn % 30) * interval '1 day'
       from ${L} l where l.rn % 2 = 0`,
    [ws],
  );
  await db.query(
    `insert into public.agent_decisions (workspace_id, lead_id, mode, action, reasoning, message_subject, message_body, outcome, send_status, sent_at,
                                         input_tokens, output_tokens, cost_usd, stage_key, angle, created_at)
     select $1::uuid, l.id, 'live', ch, 'Seed message.', case when ch = 'send_email' then 'Seed subject' end, 'Seed body text.', 'sent', 'sent',
            now() - (l.rn % 30) * interval '1 day' - (case when ch = 'send_email' then 2 else 0 end) * interval '1 day', 1200, 200, 0.0015,
            'new_no_contact', 'insight', now() - (l.rn % 30) * interval '1 day' - (case when ch = 'send_email' then 2 else 0 end) * interval '1 day'
       from ${L} l cross join unnest(array['send_email','send_whatsapp']) ch where l.rn % 5 = 0`,
    [ws],
  );
  await db.query(
    `insert into public.email_outbound_messages (workspace_id, source, source_id, lead_id, to_address, subject, html, text_body, status, attempts, sent_at,
                                                 message_id, open_token, first_opened_at, first_counted_open_at, open_event_at, open_count, created_at)
     select d.workspace_id, 'agent', d.id, d.lead_id, l.email, 'Seed subject', '<p>Seed body text.</p>', 'Seed body text.', 'sent', 1, d.sent_at,
            '<' || d.id || '@seed.example.com>', translate(rtrim(encode(decode(md5(d.id::text), 'hex'), 'base64'), '='), '+/', '-_'),
            case when l.rn % 4 = 0 then d.sent_at + interval '2 hours' end, case when l.rn % 4 = 0 then d.sent_at + interval '2 hours' end,
            case when l.rn % 4 = 0 then d.sent_at + interval '2 hours' end, case when l.rn % 4 = 0 then 1 else 0 end, d.created_at
       from public.agent_decisions d join ${L} l on l.id = d.lead_id where d.workspace_id = $1 and d.action = 'send_email'`,
    [ws],
  );
  await db.query(
    `insert into public.whatsapp_outbound_messages (workspace_id, message_id, remote_jid, status, prepared_at, sent_at, agent_decision_id, whatsapp_number_id, new_chat)
     select d.workspace_id, 'SEED' || replace(d.id::text, '-', ''), substr(l.phone_e164, 2) || '@s.whatsapp.net', 'sent', d.sent_at, d.sent_at, d.id, l.whatsapp_number_id, true
       from public.agent_decisions d join ${L} l on l.id = d.lead_id where d.workspace_id = $1 and d.action = 'send_whatsapp'`,
    [ws],
  );
  await db.query(
    `insert into public.message_facts (workspace_id, lead_id, source, channel, agent_decision_id, email_outbound_id, whatsapp_outbound_id, stage_key, angle,
                                       message_number, sent_at, first_counted_open_at, whatsapp_number_id)
     select d.workspace_id, d.lead_id, 'agent', case when d.action = 'send_email' then 'email' else 'whatsapp' end, d.id, e.id, w.id, d.stage_key, d.angle,
            case when d.action = 'send_email' then 1 else 2 end, d.sent_at, e.first_counted_open_at, w.whatsapp_number_id
       from public.agent_decisions d
       left join public.email_outbound_messages e on e.source = 'agent' and e.source_id = d.id
       left join public.whatsapp_outbound_messages w on w.agent_decision_id = d.id
      where d.workspace_id = $1 and d.outcome = 'sent'`,
    [ws],
  );
  // Replies: 30 % of the messaged contacts on WhatsApp, 15 % by email; drafts for half the WhatsApp ones.
  await db.query(
    `insert into public.whatsapp_inbound_events (workspace_id, message_id, sender_jid, sender_phone_e164, message_type, received_at, match_count, disposition,
                                                 lead_id, reply_label, reply_label_source, classification_status, draft_status, whatsapp_number_id)
     select $1::uuid, 'SEEDIN' || replace(l.id::text, '-', ''), substr(l.phone_e164, 2) || '@s.whatsapp.net', l.phone_e164, 'conversation',
            now() - (l.rn % 30) * interval '1 day' + interval '3 hours', 1, 'matched', l.id,
            (array['positive','question','other','not_interested'])[1 + l.rn % 4], 'ai', 'done', 'done', l.whatsapp_number_id
       from ${L} l where l.rn % 5 = 0 and l.rn % 10 = 0 and l.rn % 3 = 0`,
    [ws],
  );
  await db.query(
    `insert into public.email_inbound_events (workspace_id, message_id_header, uidvalidity, uid, from_address, received_at, kind, match_status, match_method,
                                              lead_id, reply_label, reply_label_source, classification_status, draft_status)
     select $1::uuid, '<seed-in-' || l.id || '@example.com>', 1, l.rn, l.email, now() - (l.rn % 30) * interval '1 day' + interval '5 hours', 'reply', 'matched',
            'in_reply_to', l.id, (array['positive','question','other'])[1 + l.rn % 3], 'ai', 'done', 'done'
       from ${L} l where l.rn % 5 = 0 and l.rn % 7 = 0`,
    [ws],
  );
  await db.query(
    `insert into public.reply_drafts (workspace_id, lead_id, channel, whatsapp_message_id, body, status, model, input_tokens, output_tokens, cost_usd, created_at)
     select e.workspace_id, e.lead_id, 'whatsapp', e.message_id, 'Seed suggested reply.', (array['open','sent','discarded'])[1 + abs(hashtext(e.message_id)) % 3],
            'seed', 1500, 150, 0.002, e.received_at + interval '5 minutes'
       from public.whatsapp_inbound_events e where e.workspace_id = $1 and abs(hashtext(e.message_id)) % 2 = 0`,
    [ws],
  );
  // Wake-ups: one pending per AI contact (5 % overdue), one done per contact with a decision.
  await db.query(
    `insert into public.agent_wakeups (workspace_id, lead_id, due_at, reason, status, created_at)
     select $1::uuid, l.id, now() + (l.rn % 14 - 1) * interval '1 day', 'timer', 'pending', now() - interval '1 day'
       from ${L} l join public.leads x on x.id = l.id and x.agent_status = 'active'`,
    [ws],
  );
  await db.query(
    `insert into public.agent_wakeups (workspace_id, lead_id, due_at, reason, status, processed_at, attempt_count, created_at)
     select $1::uuid, d.lead_id, d.created_at, 'timer', 'done', d.created_at, 1, d.created_at
       from public.agent_decisions d where d.workspace_id = $1`,
    [ws],
  );
  return ws;
}

async function dbSize(db: { query: PoolClient["query"] }) {
  return Number((await db.query<{ b: string }>(`select pg_database_size(current_database()) as b`)).rows[0]!.b);
}

async function counts(db: { query: PoolClient["query"] }) {
  return (
    await db.query(
      `select (select count(*) from public.workspaces where name like '[test] ${LOAD_SEED_LABEL} %')::int as workspaces,
              (select count(*) from public.leads l join public.workspaces w on w.id = l.workspace_id where w.name like '[test] ${LOAD_SEED_LABEL} %')::int as contacts,
              (select count(*) from auth.users where email like $1)::int as users`,
      [USER_EMAIL_LIKE],
    )
  ).rows[0] as { workspaces: number; contacts: number; users: number };
}

async function main() {
  const args = parseLoadSeedArgs(process.argv.slice(2));
  if (typeof args === "string") throw new Error(`${args} Usage: npm run staging:load-seed -- [--confirm] [--remove] [--workspaces n] [--contacts n] [--limit-mb n]`);
  const problem = stagingProblem(process.env.DATABASE_URL);
  if (problem) throw new Error(problem);

  process.env.NORTHBEAM_DB_ROLE = "script";
  const { pool } = await import("../src/db.js");
  const { deleteTestWorkspace } = await import("../tests/helpers/testWorkspaces.js");
  try {
    const before = await dbSize(pool);
    console.log(`Database size: ${mb(before)} (limit ${args.limitMb} MB, stop above ${mb(args.limitMb * 1024 * 1024 * 0.7)}). Load seed now:`, await counts(pool));

    if (args.remove) {
      const ids = (await pool.query<{ id: string }>(`select id from public.workspaces where name like '[test] ${LOAD_SEED_LABEL} %' order by created_at`)).rows.map((r) => r.id);
      console.log(`Remove: ${ids.length} workspace(s) and their users.`);
      if (!args.confirm) return console.log("Dry run. Re-run with `-- --remove --confirm`.");
      for (const id of ids) {
        await deleteTestWorkspace(pool, id);
        console.log(`Deleted workspace ${id}`);
      }
      const users = await pool.query(`delete from auth.users where email like $1`, [USER_EMAIL_LIKE]);
      console.log(`Deleted ${users.rowCount} user(s). Database size now ${mb(await dbSize(pool))}. Load seed now:`, await counts(pool));
      return;
    }

    if (!sizeVerdict(before, 0, 0, args.limitMb).ok) throw new Error(`The database is already over 70 % of ${args.limitMb} MB; not seeding.`);
    console.log(`Plan: ${args.workspaces} workspace(s) × ${args.contacts} contacts.`);
    if (!args.confirm) return console.log("Dry run. Re-run with `-- --confirm` to seed.");

    for (let i = 0; i < args.workspaces; i++) {
      const started = Date.now();
      const client = await pool.connect();
      let ws: string;
      try {
        await client.query("begin");
        ws = await seedWorkspace(client, i + 1, args.contacts);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      const size = await dbSize(pool);
      console.log(`Seeded ${i + 1}/${args.workspaces} (${ws}) in ${((Date.now() - started) / 1000).toFixed(1)} s; database ${mb(size)}.`);
      if (i === 0 && args.workspaces > 1) {
        const verdict = sizeVerdict(before, size - before, args.workspaces, args.limitMb);
        console.log(`First workspace grew the database by ${mb(size - before)}; projected ${mb(verdict.projected)} (stop above ${mb(verdict.ceiling)}).`);
        if (!verdict.ok) {
          await deleteTestWorkspace(pool, ws);
          await pool.query(`delete from auth.users where email like $1`, [USER_EMAIL_LIKE]);
          throw new Error("Projected size is over 70 % of the limit; the first workspace was removed. Use fewer --workspaces / --contacts.");
        }
      }
    }
    // Planner statistics for the new rows (the measurements read plans).
    await pool.query(`analyze`);
    console.log(`Done. Database ${mb(await dbSize(pool))} (was ${mb(before)}). Load seed now:`, await counts(pool));
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
