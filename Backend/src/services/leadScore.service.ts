/**
 * E3b-2b rule 17: the hot-score sweeper. Services only set `leads.hot_score_dirty`; each worker
 * tick recomputes up to `limit` marked leads, then leads whose score is older than 24 h (decay),
 * which also backfills every lead after deploy (the mark defaults to true). The claim clears the
 * mark first (SKIP LOCKED), so a mark set while computing is picked up next tick. No request
 * handler recomputes.
 */
import { pool } from "../db.js";
import { leadScore } from "../domain/leadScore.js";
import { WEBSITE_TITLES } from "./agentContext.service.js";

interface ScoreInputRow {
  id: string;
  lifecycle_state: string;
  email: string | null;
  company: string | null;
  industry: string | null;
  revenue_range: string | null;
  target_keywords: string[] | null;
  enquiry: string | null;
  opens: Date[];
  replies: { label: string; at: string }[] | null;
  meetings: Date[];
  proposals: Date[];
}

const CLAIM_SQL = (where: string, order: string) =>
  `update public.leads set hot_score_dirty = false, hot_score_at = now()
    where id in (select id from public.leads where ${where} and ($2::uuid is null or workspace_id = $2) order by ${order} limit $1 for update skip locked)
    returning id`;

export async function runLeadScoreSweep(options: { limit?: number; workspaceId?: string; now?: Date } = {}): Promise<number> {
  const limit = options.limit ?? 200;
  const ws = options.workspaceId ?? null;
  const ids = (await pool.query<{ id: string }>(CLAIM_SQL("hot_score_dirty", "id"), [limit, ws])).rows.map((r) => r.id);
  if (ids.length < limit) {
    const stale = await pool.query<{ id: string }>(CLAIM_SQL("hot_score_at < now() - interval '24 hours' and merged_into_lead_id is null", "hot_score_at"), [limit - ids.length, ws]);
    ids.push(...stale.rows.map((r) => r.id));
  }
  if (!ids.length) return 0;

  const rows = (
    await pool.query<ScoreInputRow>(
      `select l.id, l.lifecycle_state::text as lifecycle_state, l.email, l.company,
              coalesce(nullif(trim(c.industry), ''), l.industry) as industry, coalesce(nullif(trim(c.revenue_range), ''), l.revenue_range) as revenue_range,
              s.target_industry_keywords as target_keywords,
              (select t.metadata ->> 'rawMessage' from public.timeline_events t
                where t.lead_id = l.id and t.title = any($2::text[]) and t.metadata ? 'rawMessage' order by t.occurred_at desc limit 1) as enquiry,
              array(select e.first_counted_open_at from public.email_outbound_messages e
                     where e.lead_id = l.id and e.first_counted_open_at > now() - interval '14 days') as opens,
              (select json_agg(json_build_object('label', r.reply_label, 'at', r.received_at)) from (
                 select reply_label, received_at from public.whatsapp_inbound_events where lead_id = l.id and disposition = 'matched' and reply_label is not null
                 union all
                 select reply_label, received_at from public.email_inbound_events where lead_id = l.id and match_status = 'matched' and reply_label is not null) r) as replies,
              array(select m.created_at from public.meetings m where m.lead_id = l.id and m.status <> 'cancelled') as meetings,
              array(select p.sent_at from public.proposals p where p.lead_id = l.id and p.sent_at is not null) as proposals
         from public.leads l
         left join public.companies c on c.id = l.company_id
         left join public.agent_settings s on s.workspace_id = l.workspace_id
        where l.id = any($1::uuid[])`,
      [ids, WEBSITE_TITLES],
    )
  ).rows;

  const now = options.now ?? new Date();
  const scores = rows.map((r) => ({
    id: r.id,
    ...leadScore({
      lifecycleState: r.lifecycle_state,
      enquiry: r.enquiry,
      email: r.email,
      company: r.company,
      industry: r.industry,
      revenueRange: r.revenue_range,
      targetKeywords: r.target_keywords ?? [],
      opens: r.opens,
      replies: (r.replies ?? []).map((x) => ({ label: x.label, at: new Date(x.at) })),
      meetings: r.meetings,
      proposals: r.proposals,
      now,
    }),
  }));
  await pool.query(
    `update public.leads l set hot_score = x.score, hot_band = x.band, hot_reasons = array(select jsonb_array_elements_text(x.reasons))
       from jsonb_to_recordset($1::jsonb) as x(id uuid, score int, band text, reasons jsonb)
      where l.id = x.id
        and (l.hot_score, l.hot_band, l.hot_reasons) is distinct from (x.score, x.band, array(select jsonb_array_elements_text(x.reasons)))`,
    [JSON.stringify(scores)],
  );
  return scores.length;
}
