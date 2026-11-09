/**
 * E3b-2b rule 14: one fact row per message that really went out (never on queue, never on a dry
 * run), and its outcomes by last touch: the most recent sent message to the lead before the event,
 * within 14 days, each outcome set once. Every outcome also marks the lead's hot score for the
 * sweeper (rule 17). No backfill of older messages.
 */
import type { Queryable } from "../dto.js";

export type OutcomeKind = "reply" | "meeting_booked" | "deal_created" | "deal_won";
const OUTCOME_COLUMN: Record<OutcomeKind, string> = {
  reply: "replied_at",
  meeting_booked: "meeting_booked_at",
  deal_created: "deal_created_at",
  deal_won: "deal_won_at",
};
const SOURCE_SQL = (column: string) => `case ${column} when 'scheduled_action' then 'workflow' else ${column} end`;
// shortcut: count + 1 can repeat under two simultaneous sends to one lead (each channel is serialised per workspace today); a sequence per lead if that changes.
const MESSAGE_NUMBER = `(select count(*)::int + 1 from public.message_facts f where f.lead_id = x.lead_id)`;

/** Inside markSent's transaction: a real (not dry-run) email to a contact. Test emails have no lead. */
export async function recordEmailFact(db: Queryable, emailOutboundId: string): Promise<void> {
  await db.query(
    `insert into public.message_facts (workspace_id, lead_id, source, channel, agent_decision_id, email_outbound_id, stage_key, angle, message_number, sent_at)
     select x.workspace_id, x.lead_id, ${SOURCE_SQL("x.source")}, 'email', d.id, x.id, d.stage_key, d.angle, ${MESSAGE_NUMBER}, x.sent_at
       from public.email_outbound_messages x
       left join public.agent_decisions d on x.source = 'agent' and d.id = x.source_id
      where x.id = $1 and x.status = 'sent' and not x.dry_run and x.lead_id is not null and x.source <> 'test'
     on conflict do nothing`,
    [emailOutboundId],
  );
}

/** Inside performSend's transaction, right after the row became `sent` (every WhatsApp source). */
export async function recordWhatsAppFact(db: Queryable, whatsappOutboundId: string): Promise<void> {
  await db.query(
    `insert into public.message_facts (workspace_id, lead_id, source, channel, agent_decision_id, whatsapp_outbound_id, stage_key, angle, message_number, whatsapp_connection_id, whatsapp_number_id, sent_at)
     select x.workspace_id, x.lead_id, x.source, 'whatsapp', x.agent_decision_id, x.id, d.stage_key, d.angle, ${MESSAGE_NUMBER}, c.id, x.whatsapp_number_id, x.sent_at
       from (select o.id, o.workspace_id, o.agent_decision_id, o.sent_at, o.whatsapp_number_id,
                    coalesce(sa.lead_id, p.lead_id, m.lead_id, ad.lead_id, r.lead_id) as lead_id,
                    case when o.scheduled_action_id is not null then 'workflow' when o.proposal_id is not null then 'proposal'
                         when o.meeting_id is not null then 'meeting' when o.agent_decision_id is not null then 'agent' else 'reply_draft' end as source
               from public.whatsapp_outbound_messages o
               left join public.scheduled_actions sa on sa.id = o.scheduled_action_id
               left join public.proposals p on p.id = o.proposal_id
               left join public.meetings m on m.id = o.meeting_id
               left join public.agent_decisions ad on ad.id = o.agent_decision_id
               left join public.reply_drafts r on r.id = o.reply_draft_id
              where o.id = $1 and o.status = 'sent') x
       left join public.agent_decisions d on d.id = x.agent_decision_id
       left join public.whatsapp_connection c on c.workspace_id = x.workspace_id
      where x.lead_id is not null
     on conflict do nothing`,
    [whatsappOutboundId],
  );
}

/** The last message sent to the lead at or before `at` (default now), within 14 days, gets the outcome once; the lead's score is marked. */
export async function attributeOutcome(db: Queryable, leadId: string, kind: OutcomeKind, at?: Date): Promise<void> {
  const column = OUTCOME_COLUMN[kind];
  await db.query(
    `update public.message_facts set ${column} = coalesce($2::timestamptz, now())
      where id = (select id from public.message_facts
                   where lead_id = $1 and sent_at <= coalesce($2::timestamptz, now()) and sent_at >= coalesce($2::timestamptz, now()) - interval '14 days'
                   order by sent_at desc limit 1)
        and ${column} is null`,
    [leadId, at ?? null],
  );
  await markHotScore(db, leadId);
}

/** D4a label of a reply: on the fact that got the latest reply (set once; a rep's correction never changes it). */
export async function attributeReplyLabel(db: Queryable, leadId: string, label: string): Promise<void> {
  await db.query(
    `update public.message_facts set reply_label = $2
      where id = (select id from public.message_facts where lead_id = $1 and replied_at is not null order by replied_at desc limit 1)
        and reply_label is null`,
    [leadId, label],
  );
  await markHotScore(db, leadId);
}

/** Rule 17: the lead's hot score is recomputed by the worker's next sweep (a no-op when already marked). */
export async function markHotScore(db: Queryable, leadId: string): Promise<void> {
  await db.query(`update public.leads set hot_score_dirty = true where id = $1 and not hot_score_dirty`, [leadId]);
}
