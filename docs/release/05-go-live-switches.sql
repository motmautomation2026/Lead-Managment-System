-- =============================================================================
-- REL-1 release: GO-LIVE SWITCHES (00-READ-ME-FIRST step 9). Run ONCE, right after the new API + worker are up.
-- Part A changes data (one transaction: all or nothing). Part B is read-only: run it straight after A (one block at
-- a time: the SQL editor shows the last result only).
--
-- What A does, for EVERY workspace:
--   1. go-live cutoff = now(): every lead that exists now is "old" (not automated). New leads from now on are
--      automated. An admin or the owner can switch an old lead on later (contact page / Contacts list).
--   2. pauses every running / waiting workflow run of a non-automated lead and its pending steps (status 'paused',
--      nothing deleted). A paused run is resumed only by hand (Automations -> Runs), even after the lead is
--      switched on.
--   3. first-days settings: AI decision cap 10 / day; meeting reminders to leads OFF; "We tried calling" WhatsApp OFF;
--      email open tracking OFF; AI live scope = test contacts only. The AI mode itself is NOT changed here (it stays
--      as it is: off on a fresh production) — it goes to shadow / live in steps 11-13 from Settings -> AI agent.
-- =============================================================================


-- ============================== PART A (changes data) ==============================
begin;

update public.agent_settings
   set automation_since = now(),
       max_decisions_per_day = 10,
       meeting_reminders_enabled = false,
       tried_calling_whatsapp_enabled = false,
       live_scope = 'test_contacts';

update public.integration_connections set track_opens = false where id = 'email';

-- Pause the runs (and their pending steps) of every lead that is not automated, exactly like Automations -> Runs -> Pause.
with paused as (
  update public.workflow_runs r
     set status = 'paused'
    from public.leads l
   where l.id = r.lead_id
     and r.status in ('running', 'waiting')
     and not coalesce(l.automation_enabled, l.created_at >= (select a.automation_since from public.agent_settings a where a.workspace_id = l.workspace_id))
  returning r.id, r.lead_id
), steps as (
  update public.scheduled_actions s set status = 'paused'
   where s.workflow_run_id in (select id from paused) and s.status in ('pending', 'due')
  returning s.id
)
insert into public.timeline_events (lead_id, event_kind, title, detail, actor_name, actor_source)
select distinct p.lead_id, 'automation', 'Workflow paused at go-live',
       'This contact is from before go-live, so its automatic messages are paused. Switch automation on and resume the run by hand to continue.',
       'System', 'system'
  from paused p;

commit;


-- ============================== PART B (read-only verify) ==============================

-- B1. Settings per workspace. OK: cutoff = a few seconds ago, cap 10, the three switches false, scope test_contacts.
select w.name, s.automation_since, s.mode, s.live_scope, s.max_decisions_per_day,
       s.meeting_reminders_enabled, s.tried_calling_whatsapp_enabled,
       (select c.track_opens from public.integration_connections c where c.workspace_id = s.workspace_id and c.id = 'email') as track_opens
  from public.agent_settings s join public.workspaces w on w.id = s.workspace_id
 order by w.name;

-- B2. Nothing automatic can fire for an old lead. OK: EVERY number 0.
with old as (
  select l.id from public.leads l
   where not coalesce(l.automation_enabled, l.created_at >= (select a.automation_since from public.agent_settings a where a.workspace_id = l.workspace_id))
)
select
  (select count(*) from public.workflow_runs r where r.lead_id in (select id from old) and r.status in ('running', 'waiting')) as old_runs_running,
  (select count(*) from public.scheduled_actions s where s.lead_id in (select id from old) and s.status in ('pending', 'due', 'executing')) as old_steps_due,
  (select count(*) from public.email_outbound_messages e where e.lead_id in (select id from old)
      and e.status in ('queued', 'sending') and e.source in ('scheduled_action', 'agent')) as old_automatic_emails_queued,
  (select count(*) from public.whatsapp_outbound_messages o
     join public.scheduled_actions s on s.id = o.scheduled_action_id
    where s.lead_id in (select id from old) and o.status = 'prepared') as old_workflow_whatsapp_prepared,
  (select count(*) from public.tried_calling_messages t where t.lead_id in (select id from old) and t.status in ('queued', 'sending')) as old_tried_calling_queued,
  (select count(*) from public.meeting_reminders m where m.lead_id in (select id from old) and m.status in ('queued', 'sending')) as old_meeting_reminders_queued;

-- B3. What was paused, per workspace. OK: the same numbers as 01-precheck.sql block 5 (workflow_runs_running_or_waiting
--     and pending_steps_all), now as paused.
select w.name,
       (select count(*) from public.workflow_runs r where r.workspace_id = w.id and r.status = 'paused') as runs_paused,
       (select count(*) from public.scheduled_actions s where s.workspace_id = w.id and s.status = 'paused') as steps_paused,
       (select count(*) from public.timeline_events t join public.leads l on l.id = t.lead_id
         where l.workspace_id = w.id and t.title = 'Workflow paused at go-live') as contacts_told
  from public.workspaces w order by w.name;

-- B4. AI wake-ups of old leads stay pending and are never claimed (the worker skips them). Informational.
select count(*) as old_lead_ai_wakeups_pending
  from public.agent_wakeups x join public.leads l on l.id = x.lead_id
 where x.status = 'pending'
   and not coalesce(l.automation_enabled, l.created_at >= (select a.automation_since from public.agent_settings a where a.workspace_id = l.workspace_id));
