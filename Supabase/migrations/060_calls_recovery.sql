-- =============================================================================
-- Northbeam CRM -- LL-3 calls & recovery ("a lead is never lost")
-- =============================================================================
--
-- call_connected_outcome          + 'not_interested' (reason required → the lead becomes Lost).
-- lead_loss_reason                + 'no_requirement', 'existing_supplier' (the LL-3 reason list).
-- calls.attempt_number            consecutive unanswered calls including this one (null = answered / wrong number):
--                                 the call attempt counter of the retry ladder (domain/callAttempts.ts).
-- tasks.marker / call_attempt     what created a task (LL-3 workers' once-only checks, the "Attempt N of 5" label);
--                                 an 'onboarding' task survives the lead being marked Won.
-- leads.recover_at / recovered_at Lost recovery: the date the lead comes back (by loss reason) and when it did (once
--                                 per loss; a new loss resets both, reopening clears recover_at).
-- leads.loss_competitor_name      optional, loss reason competitor_selected.
-- leads.loss_project_date         required for loss reason project_postponed (= the recovery date).
-- leads.discard_reason            spam | duplicate | wrong_person | not_a_sales_lead | other (+ text in the timeline).
-- proposals.valid_until           default sent date + 30 days (editable); expiry_warned_at / expired_task_at = the
--                                 once-only markers of the two proposal tasks.
-- deals.next_decision_date        required when a rep moves a deal into negotiation; decision_task_for = the date the
--                                 "decision date passed" task was created for.
-- deals.stage_changed_at          last stage move (the 10-day manager review; existing deals: apply time, so no review
--                                 flood on release); review_task_at = the last "Manager review" task.
-- agent_settings.tried_calling_whatsapp_enabled   the "We tried calling" WhatsApp after a No answer. Default on.
-- tried_calling_messages          one row per lead per IST day (the once-per-day marker + the WhatsApp queue);
--                                 whatsapp_outbound_messages.tried_calling_id = the 7th WhatsApp source.
--
-- Additive and re-runnable.
-- =============================================================================

alter type public.call_connected_outcome add value if not exists 'not_interested';
alter type public.lead_loss_reason add value if not exists 'no_requirement';
alter type public.lead_loss_reason add value if not exists 'existing_supplier';

alter table public.calls add column if not exists attempt_number smallint;

alter table public.tasks add column if not exists marker text;
alter table public.tasks add column if not exists call_attempt smallint;
alter table public.tasks drop constraint if exists tasks_marker_valid;
alter table public.tasks
  add constraint tasks_marker_valid check (marker is null or marker in (
    'call_attempt', 'fix_phone', 'interested_later_callback', 'lost_recovery', 'proposal_expiring', 'proposal_expired',
    'decision_overdue', 'manager_review', 'onboarding', 'call_ladder_end'));

alter table public.leads add column if not exists recover_at timestamptz;
alter table public.leads add column if not exists recovered_at timestamptz;
alter table public.leads add column if not exists loss_competitor_name text;
alter table public.leads add column if not exists loss_project_date date;
alter table public.leads add column if not exists discard_reason text;
alter table public.leads drop constraint if exists leads_discard_reason_valid;
alter table public.leads
  add constraint leads_discard_reason_valid check (discard_reason is null or discard_reason in ('spam', 'duplicate', 'wrong_person', 'not_a_sales_lead', 'other'));
create index if not exists leads_recovery_due_idx on public.leads (recover_at)
  where lifecycle_state = 'lost' and recovered_at is null and recover_at is not null;

alter table public.proposals add column if not exists valid_until date;
alter table public.proposals add column if not exists expiry_warned_at timestamptz;
alter table public.proposals add column if not exists expired_task_at timestamptz;
create index if not exists proposals_sent_valid_until_idx on public.proposals (workspace_id, valid_until)
  where status = 'sent' and valid_until is not null;

alter table public.deals add column if not exists next_decision_date date;
alter table public.deals add column if not exists decision_task_for date;
-- Existing deals get the apply time (an added column's default fills them without an update, so updated_at and its
-- trigger are untouched): no deal is idle for review until 10 days after release.
alter table public.deals add column if not exists stage_changed_at timestamptz not null default now();
alter table public.deals add column if not exists review_task_at timestamptz;
create index if not exists deals_open_review_idx on public.deals (workspace_id, stage_changed_at)
  where stage in ('proposal_sent', 'negotiation');
create index if not exists deals_decision_date_idx on public.deals (workspace_id, next_decision_date)
  where stage = 'negotiation' and next_decision_date is not null;

alter table public.agent_settings add column if not exists tried_calling_whatsapp_enabled boolean not null default true;

create table if not exists public.tried_calling_messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  lead_id uuid not null references public.leads (id) on delete cascade,
  call_id uuid references public.calls (id) on delete set null,
  ist_day date not null,
  rep_name text,
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'skipped', 'failed', 'cancelled')),
  body text,
  dry_run boolean not null default false,
  error text,
  next_attempt_at timestamptz not null default now(),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique (lead_id, ist_day)
);
alter table public.tried_calling_messages enable row level security;
revoke all on public.tried_calling_messages from anon, authenticated, public;
create index if not exists tried_calling_queue_idx on public.tried_calling_messages (next_attempt_at)
  where status in ('queued', 'sending');
create index if not exists tried_calling_sent_lead_idx on public.tried_calling_messages (lead_id, sent_at)
  where status = 'sent' and not dry_run;

-- The 7th WhatsApp source.
alter table public.whatsapp_outbound_messages
  add column if not exists tried_calling_id uuid references public.tried_calling_messages (id) on delete cascade;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'whatsapp_outbound_tried_calling_id_key') then
    alter table public.whatsapp_outbound_messages
      add constraint whatsapp_outbound_tried_calling_id_key unique (tried_calling_id);
  end if;
end $$;
alter table public.whatsapp_outbound_messages drop constraint if exists whatsapp_outbound_exactly_one_source;
alter table public.whatsapp_outbound_messages
  add constraint whatsapp_outbound_exactly_one_source check (
    ((scheduled_action_id is not null)::int + (proposal_id is not null)::int + (meeting_id is not null)::int
      + (agent_decision_id is not null)::int + (reply_draft_id is not null)::int + (meeting_reminder_id is not null)::int
      + (tried_calling_id is not null)::int) = 1
  );
