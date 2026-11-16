-- =============================================================================
-- Northbeam CRM -- LL-2 reminders, escalation and email alerts to staff
-- =============================================================================
--
-- agent_settings.task_reminders_since      due bells and overdue / first-call escalation only for tasks due at or
--                                          after it (default = when this migration is applied: no flood on release).
-- agent_settings.meeting_reminders_enabled 24 h + 1 h reminders to the lead (fixed text, email + WhatsApp). Default on.
-- profiles.email_alerts_enabled            "Email me urgent alerts" (Settings → Profile; admins in Users). Default on.
-- profiles.email_digest_enabled            "Morning digest" 09:00 IST Mon–Sat. Default on.
-- workspace_members.digest_sent_on         the IST day the member's digest went out (once per day).
-- tasks.due_notified_at                    the "due now" bell went out (once). tasks.escalated_at (051) is reused
--                                          for the overdue / first-call escalation of non-reply tasks.
-- meetings.reminders_from                  reminders are planned only for times after it: the booking / last
--                                          reschedule (existing meetings: now, so no reminder whose time passed).
-- meeting_reminders                        one row per meeting × kind (24h, 1h, updated, rep_1h) × channel × meeting
--                                          time: the source of each reminder message (WhatsApp `meeting_reminder_id`,
--                                          email source `meeting_reminder`) and the once-only marker. A new meeting
--                                          time gets new rows (reschedule = reset).
-- notifications.email_status               null = bell only; 'pending' = also emailed to the recipient (batched per
--                                          person per tick) → 'sent' | 'skipped' (toggle off / no mailbox) | 'failed'.
-- system_health_alerts.problem             + 'staff_email_no_mailbox' (one admin warning per workspace).
--
-- Additive and re-runnable.
-- =============================================================================

alter table public.agent_settings add column if not exists task_reminders_since timestamptz not null default now();
alter table public.agent_settings add column if not exists meeting_reminders_enabled boolean not null default true;

alter table public.profiles add column if not exists email_alerts_enabled boolean not null default true;
alter table public.profiles add column if not exists email_digest_enabled boolean not null default true;

alter table public.workspace_members add column if not exists digest_sent_on date;

alter table public.tasks add column if not exists due_notified_at timestamptz;
create index if not exists tasks_due_reminder_idx on public.tasks (workspace_id, due_at)
  where status = 'open' and due_notified_at is null;
create index if not exists tasks_overdue_escalation_idx on public.tasks (workspace_id, due_at)
  where status = 'open' and escalated_at is null;

alter table public.meetings add column if not exists reminders_from timestamptz not null default now();
create index if not exists meetings_upcoming_idx on public.meetings (workspace_id, scheduled_at) where status = 'scheduled';

create table if not exists public.meeting_reminders (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  meeting_id uuid not null references public.meetings (id) on delete cascade,
  lead_id uuid not null references public.leads (id) on delete cascade,
  kind text not null check (kind in ('24h', '1h', 'updated', 'rep_1h')),
  channel text not null check (channel in ('email', 'whatsapp', 'staff')),
  meeting_at timestamptz not null,
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'skipped', 'failed', 'cancelled')),
  body text,
  error text,
  next_attempt_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique (meeting_id, kind, channel, meeting_at)
);
alter table public.meeting_reminders enable row level security;
revoke all on public.meeting_reminders from anon, authenticated, public;
create index if not exists meeting_reminders_whatsapp_queue_idx on public.meeting_reminders (next_attempt_at)
  where channel = 'whatsapp' and status in ('queued', 'sending');

-- The 6th WhatsApp source.
alter table public.whatsapp_outbound_messages
  add column if not exists meeting_reminder_id uuid references public.meeting_reminders (id) on delete cascade;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'whatsapp_outbound_meeting_reminder_id_key') then
    alter table public.whatsapp_outbound_messages
      add constraint whatsapp_outbound_meeting_reminder_id_key unique (meeting_reminder_id);
  end if;
end $$;
alter table public.whatsapp_outbound_messages drop constraint if exists whatsapp_outbound_exactly_one_source;
alter table public.whatsapp_outbound_messages
  add constraint whatsapp_outbound_exactly_one_source check (
    ((scheduled_action_id is not null)::int + (proposal_id is not null)::int + (meeting_id is not null)::int
      + (agent_decision_id is not null)::int + (reply_draft_id is not null)::int + (meeting_reminder_id is not null)::int) = 1
  );

alter table public.email_outbound_messages drop constraint if exists email_outbound_source_valid;
alter table public.email_outbound_messages
  add constraint email_outbound_source_valid check (source in ('scheduled_action', 'proposal', 'meeting', 'test', 'agent', 'reply_draft', 'meeting_reminder'));

alter table public.notifications add column if not exists email_status text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'notifications_email_status_valid') then
    alter table public.notifications
      add constraint notifications_email_status_valid check (email_status is null or email_status in ('pending', 'sent', 'skipped', 'failed'));
  end if;
end $$;
create index if not exists notifications_email_pending_idx on public.notifications (workspace_id, recipient_id) where email_status = 'pending';

alter table public.system_health_alerts drop constraint if exists system_health_alerts_problem_check;
alter table public.system_health_alerts
  add constraint system_health_alerts_problem_check check (problem in ('stuck_queue', 'paused_channel', 'ai_budget', 'staff_email_no_mailbox'));
