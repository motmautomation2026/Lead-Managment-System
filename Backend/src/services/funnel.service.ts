/**
 * E3b-2b rule 19: funnel numbers for one workspace and period. Lead numbers follow the leads
 * created in the period (the cohort); channel / WhatsApp number / angle groups count the messages
 * sent in the period and their outcomes attributed by last touch (message_facts, rule 14). Email
 * opens are a soft signal. Facts exist only for messages sent since E3b-2b (no backfill).
 */
import { z } from "zod";
import type { Queryable } from "../dto.js";
import { ValidationError } from "../errors.js";
import { ANGLE_LABELS } from "../agent/stagePlan.js";
import { REPLY_TASK_TITLES } from "../agent/replyClassification.js";

const DAY = 86_400_000;
export const MAX_FUNNEL_DAYS = 180;
const DEFAULT_DAYS = 30;
const WEBSITE_SOURCES = ["website", "inbound_form"];

export const funnelQuerySchema = z
  .object({
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    groupBy: z.enum(["source", "channel", "number", "angle"]).optional(),
  })
  .strict();
export type FunnelQuery = z.infer<typeof funnelQuerySchema>;

/** Default: the last 30 days; at most 180 days. */
export function funnelPeriod(query: FunnelQuery, now = new Date()): { from: Date; to: Date } {
  const to = query.to ? new Date(query.to) : now;
  const from = query.from ? new Date(query.from) : new Date(to.getTime() - DEFAULT_DAYS * DAY);
  if (from >= to) throw new ValidationError("`from` must be before `to`.");
  if (to.getTime() - from.getTime() > MAX_FUNNEL_DAYS * DAY) throw new ValidationError(`The period can be at most ${MAX_FUNNEL_DAYS} days.`);
  return { from, to };
}

interface LeadRow {
  key: string | null;
  is_total: boolean;
  leads_created: number;
  contacted: number;
  fast: number;
  median_minutes: number | null;
  emails_sent: number;
  counted_opens: number;
  replies: number;
  positive_replies: number;
  meetings_14d: number;
  proposals: number;
  won: number;
  website_leads: number;
  website_booked_14d: number;
}

interface MessageRow {
  key: string | null;
  label: string | null;
  messages_sent: number;
  emails_sent: number;
  counted_opens: number;
  replies: number;
  positive_replies: number;
  meetings_booked: number;
  deals_created: number;
  won: number;
}

const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 10 : null);
const minutes = (value: number | null) => (value === null ? null : Math.round(Number(value) * 10) / 10);

function leadMetrics(r: LeadRow) {
  return {
    leadsCreated: r.leads_created,
    contacted: r.contacted,
    firstMessageWithin15Min: { count: r.fast, pct: pct(r.fast, r.leads_created) },
    medianMinutesToFirstMessage: minutes(r.median_minutes),
    emailsSent: r.emails_sent,
    /** Soft signal: some mail apps load images without the email being read. */
    countedOpens: r.counted_opens,
    replies: r.replies,
    positiveReplies: r.positive_replies,
    meetingsBookedWithin14Days: r.meetings_14d,
    proposals: r.proposals,
    won: r.won,
  };
}

const LEAD_SQL = (groupColumn: string | null) => `
  with cohort as (
    select l.id, l.source::text as source, l.created_at, l.lifecycle_state::text as lifecycle_state
      from public.leads l
     where l.workspace_id = $1 and l.created_at >= $2 and l.created_at < $3 and l.lifecycle_state <> 'merged'
  ), facts as (
    select c.*,
           (select min(f.sent_at) from public.message_facts f where f.lead_id = c.id) as first_sent,
           (select count(*) from public.message_facts f where f.lead_id = c.id and f.channel = 'email')::int as emails,
           (select count(*) from public.message_facts f where f.lead_id = c.id and f.first_counted_open_at is not null)::int as opens,
           (exists (select 1 from public.whatsapp_inbound_events w where w.lead_id = c.id and w.disposition = 'matched')
             or exists (select 1 from public.email_inbound_events e where e.lead_id = c.id and e.kind = 'reply' and e.match_status = 'matched')) as replied,
           (exists (select 1 from public.whatsapp_inbound_events w where w.lead_id = c.id and w.disposition = 'matched' and w.reply_label = 'positive')
             or exists (select 1 from public.email_inbound_events e where e.lead_id = c.id and e.match_status = 'matched' and e.reply_label = 'positive')) as positive,
           exists (select 1 from public.meetings m where m.lead_id = c.id and m.status <> 'cancelled' and m.created_at <= c.created_at + interval '14 days') as booked_14d,
           exists (select 1 from public.proposals p where p.lead_id = c.id and p.sent_at is not null) as proposal,
           (c.lifecycle_state = 'won' or exists (select 1 from public.deals d where d.lead_id = c.id and d.stage = 'won')) as won
      from cohort c
  )
  select ${groupColumn ?? "null::text"} as key, ${groupColumn ? `grouping(${groupColumn}) = 1` : "true"} as is_total,
         count(*)::int as leads_created, count(first_sent)::int as contacted,
         count(*) filter (where first_sent <= created_at + interval '15 minutes')::int as fast,
         (percentile_cont(0.5) within group (order by extract(epoch from first_sent - created_at) / 60) filter (where first_sent is not null))::float8 as median_minutes,
         coalesce(sum(emails), 0)::int as emails_sent, coalesce(sum(opens), 0)::int as counted_opens,
         count(*) filter (where replied)::int as replies, count(*) filter (where positive)::int as positive_replies,
         count(*) filter (where booked_14d)::int as meetings_14d, count(*) filter (where proposal)::int as proposals, count(*) filter (where won)::int as won,
         count(*) filter (where source = any($4::text[]))::int as website_leads,
         count(*) filter (where source = any($4::text[]) and booked_14d)::int as website_booked_14d
    from facts
   ${groupColumn ? `group by grouping sets ((${groupColumn}), ())` : ""}`;

const MESSAGE_KEY: Record<"channel" | "number" | "angle", { key: string; label: string; where: string }> = {
  channel: { key: "f.channel", label: "null::text", where: "" },
  // Each WhatsApp connection (one per workspace today; several with E4a), labelled by its paired number.
  number: { key: "f.whatsapp_connection_id::text", label: "max(nullif(split_part(split_part(c.connected_jid, '@', 1), ':', 1), ''))", where: "and f.channel = 'whatsapp'" },
  angle: { key: "f.angle", label: "null::text", where: "" },
};

/** GET /analytics/funnel: any CRM user, workspace-scoped. */
export async function getFunnel(db: Queryable, workspaceId: string, query: FunnelQuery, now = new Date()) {
  const { from, to } = funnelPeriod(query, now);
  const base = [workspaceId, from, to, WEBSITE_SOURCES];
  const totalRow = (await db.query<LeadRow>(LEAD_SQL(null), base)).rows[0]!;

  let groups: Record<string, unknown>[] = [];
  if (query.groupBy === "source") {
    const rows = (await db.query<LeadRow>(LEAD_SQL("source"), base)).rows.filter((r) => !r.is_total);
    groups = rows.sort((a, b) => b.leads_created - a.leads_created).map((r) => ({ key: r.key, label: r.key, ...leadMetrics(r) }));
  } else if (query.groupBy) {
    const g = MESSAGE_KEY[query.groupBy];
    const rows = (
      await db.query<MessageRow>(
        `select ${g.key} as key, ${g.label} as label, count(*)::int as messages_sent,
                count(*) filter (where f.channel = 'email')::int as emails_sent, count(f.first_counted_open_at)::int as counted_opens,
                count(f.replied_at)::int as replies, count(*) filter (where f.reply_label = 'positive')::int as positive_replies,
                count(f.meeting_booked_at)::int as meetings_booked, count(f.deal_created_at)::int as deals_created, count(f.deal_won_at)::int as won
           from public.message_facts f
           left join public.whatsapp_connection c on c.id = f.whatsapp_connection_id
          where f.workspace_id = $1 and f.sent_at >= $2 and f.sent_at < $3 ${g.where}
          group by 1
          order by messages_sent desc`,
        [workspaceId, from, to],
      )
    ).rows;
    groups = rows.map((r) => ({
      key: r.key,
      label:
        query.groupBy === "angle"
          ? r.key
            ? (ANGLE_LABELS[r.key as keyof typeof ANGLE_LABELS] ?? r.key)
            : "Not an AI message"
          : query.groupBy === "number"
            ? r.label
              ? `+${r.label}`
              : "WhatsApp"
            : r.key === "email"
              ? "Email"
              : "WhatsApp",
      messagesSent: r.messages_sent,
      emailsSent: r.emails_sent,
      countedOpens: r.counted_opens,
      replies: r.replies,
      positiveReplies: r.positive_replies,
      meetingsBooked: r.meetings_booked,
      dealsCreated: r.deals_created,
      won: r.won,
    }));
  }

  // From a lead's matched reply to our answer: the first message we sent after it or the reply task done, whichever is first.
  const answer = (
    await db.query<{ median: number | null; answered: number }>(
      `select (percentile_cont(0.5) within group (order by m))::float8 as median, count(m)::int as answered from (
         select extract(epoch from least(
                  (select min(f.sent_at) from public.message_facts f where f.lead_id = r.lead_id and f.sent_at > r.at),
                  (select min(t.completed_at) from public.tasks t
                    where t.lead_id = r.lead_id and t.origin = 'agent' and t.title = any($4::text[]) and t.completed_at > r.at)) - r.at) / 60 as m
           from (select lead_id, received_at as at from public.whatsapp_inbound_events
                  where workspace_id = $1 and disposition = 'matched' and received_at >= $2 and received_at < $3
                 union all
                 select lead_id, received_at from public.email_inbound_events
                  where workspace_id = $1 and kind = 'reply' and match_status = 'matched' and received_at >= $2 and received_at < $3) r
       ) x`,
      [workspaceId, from, to, REPLY_TASK_TITLES],
    )
  ).rows[0]!;

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    groupBy: query.groupBy ?? null,
    totals: leadMetrics(totalRow),
    /** The main number: the share of new website leads that booked a meeting within 14 days. */
    websiteMeetingRate: { websiteLeads: totalRow.website_leads, bookedWithin14Days: totalRow.website_booked_14d, pct: pct(totalRow.website_booked_14d, totalRow.website_leads) },
    medianMinutesReplyToAnswer: minutes(answer.median),
    groups,
  };
}
