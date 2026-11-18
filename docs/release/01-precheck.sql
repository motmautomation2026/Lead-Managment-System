-- =============================================================================
-- REL-1 release: PRE-CHECK. READ-ONLY: every statement is a SELECT, nothing is changed.
-- Paste the whole file into Supabase -> SQL editor -> Run. The editor shows the LAST result only, so run one
-- block at a time (select the block's text, then Run selected). Each block says which number is OK.
-- Tables that don't exist yet return NULL (not an error).
-- =============================================================================


-- ---------------------------------------------------------------------------------------------------------------
-- 1. Which migrations are already there (production has no history table: each is detected by an object it creates).
--    EXPECTED TODAY (production at 018): every row present = false.
--    A few rows true = an earlier partial apply. That is fine (every migration is re-runnable); write down which.
-- ---------------------------------------------------------------------------------------------------------------
with col(t, c) as (select table_name::text, column_name::text from information_schema.columns where table_schema = 'public')
select m.migration, m.present
  from (values
    ('019', to_regclass('public.message_templates_one_default_meeting_email_per_workspace') is not null),
    ('020 (runs AFTER the code)', coalesce(pg_get_functiondef('public.cascade_lead_lifecycle_change'::regproc) like '%can only be reactivated to active%', false)),
    ('021', to_regclass('public.lead_assignment_rules') is not null),
    ('022', to_regclass('public.kb_documents') is not null),
    ('023', to_regclass('public.kb_documents_claim_idx') is not null),
    ('024', to_regclass('public.agent_settings') is not null),
    ('025', to_regclass('public.agent_wakeups_one_pending_per_lead') is not null),
    ('026', exists (select 1 from pg_trigger where tgname = 'leads_agent_lifecycle_stop')),
    ('027', exists (select 1 from col where t = 'agent_settings' and c = 'budget_alerted_month')),
    ('028', exists (select 1 from col where t = 'agent_settings' and c = 'company_display_name')),
    ('029', to_regclass('public.agent_decision_reports') is not null),
    ('030', exists (select 1 from col where t = 'agent_settings' and c = 'max_decisions_per_day')),
    ('031', exists (select 1 from col where t = 'whatsapp_inbound_events' and c = 'body_ciphertext')),
    ('032', to_regclass('public.companies') is not null),
    ('033', to_regclass('public.leads_workspace_created_idx') is not null),
    ('034', to_regclass('public.leads_full_name_trgm_idx') is not null),
    ('035', to_regclass('public.timeline_events_lead_occurred_id_idx') is not null),
    ('036', to_regclass('public.tasks_workspace_due_idx') is not null),
    ('037', to_regclass('public.workflow_runs_workspace_started_idx') is not null),
    ('038', exists (select 1 from col where t = 'agent_decisions' and c = 'context_company_id')),
    ('039', to_regclass('public.inbound_message_views') is not null),
    ('040', exists (select 1 from col where t = 'whatsapp_inbound_events' and c = 'reply_label')),
    ('041', to_regclass('public.whatsapp_safety_events') is not null),
    ('042', to_regclass('public.email_outbound_messages') is not null),
    ('043', to_regclass('public.email_inbound_events') is not null),
    ('044', exists (select 1 from col where t = 'agent_settings' and c = 'live_scope')),
    ('045', exists (select 1 from col where t = 'agent_settings' and c = 'banned_phrases')),
    ('046', exists (select 1 from col where t = 'agent_settings' and c = 'readiness_since')),
    ('047', exists (select 1 from col where t = 'agent_decisions' and c = 'sent_asset_ids')),
    ('048', exists (select 1 from col where t = 'agent_settings' and c = 'style_examples')),
    ('049', exists (select 1 from col where t = 'agent_decisions' and c = 'stage_key')),
    ('050', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'agent_settings'
                     and column_name = 'whatsapp_max_words' and column_default like '60%')),
    ('051', to_regclass('public.reply_drafts') is not null),
    ('052', exists (select 1 from col where t = 'agent_settings' and c = 'reminders_since')),
    ('053', to_regclass('public.message_facts') is not null),
    ('054', to_regclass('public.whatsapp_numbers') is not null),
    ('055', to_regclass('public.workspace_members') is not null),
    ('056 (no policies left in public)', not exists (select 1 from pg_policies where schemaname = 'public')),
    ('057', to_regclass('public.worker_heartbeats') is not null),
    ('058', exists (select 1 from col where t = 'agent_settings' and c = 'next_action_sweep_since')),
    ('059', to_regclass('public.meeting_reminders') is not null),
    ('060', to_regclass('public.tried_calling_messages') is not null),
    ('061', exists (select 1 from col where t = 'agent_settings' and c = 'automation_since'))
  ) as m(migration, present)
 order by m.migration;


-- ---------------------------------------------------------------------------------------------------------------
-- 2. Extensions. OK: vector available with default_version >= 0.8.0, pg_trgm available.
--    installed_version may be NULL today (migrations 022 / 032 install them in the `extensions` schema).
--    STOP if vector is missing or below 0.8.0 (Supabase -> Database -> Extensions).
-- ---------------------------------------------------------------------------------------------------------------
select name, default_version, installed_version from pg_available_extensions where name in ('vector', 'pg_trgm') order by name;


-- ---------------------------------------------------------------------------------------------------------------
-- 3. Is the OLD worker still running? (run before AND after stopping it)
--    OK after stopping: seconds_since_heartbeat > 120 for every row (no worker writes its heartbeat any more).
--    Today's production worker writes whatsapp_connection.worker_heartbeat_at; after migration 057 the new worker
--    also writes public.worker_heartbeats.
-- ---------------------------------------------------------------------------------------------------------------
select c.workspace_id, w.name, c.status, c.desired_state,
       extract(epoch from now() - c.worker_heartbeat_at)::int as seconds_since_heartbeat
  from public.whatsapp_connection c join public.workspaces w on w.id = c.workspace_id
 order by w.name;


-- ---------------------------------------------------------------------------------------------------------------
-- 4. Rows stuck mid-send. OK: every number 0 (NULL = table not there yet).
--    Not 0 → the old worker stopped in the middle of a send. Note the number; the new worker reclaims them after
--    15 minutes. A stuck WhatsApp "prepared" row may have been delivered already — check that contact's phone before
--    the new worker starts if it is a real customer.
-- ---------------------------------------------------------------------------------------------------------------
select
  (select count(*) from public.scheduled_actions where status = 'executing') as workflow_steps_executing,
  (select count(*) from public.whatsapp_outbound_messages where status = 'prepared') as whatsapp_prepared_not_sent,
  case when to_regclass('public.email_outbound_messages') is null then null else
    (xpath('/row/c/text()', query_to_xml($q$select count(*) as c from public.email_outbound_messages where status = 'sending'$q$, false, true, '')))[1]::text::bigint end
    as emails_sending,
  case when to_regclass('public.agent_wakeups') is null then null else
    (xpath('/row/c/text()', query_to_xml($q$select count(*) as c from public.agent_wakeups where status = 'executing'$q$, false, true, '')))[1]::text::bigint end
    as ai_wakeups_executing;


-- ---------------------------------------------------------------------------------------------------------------
-- 5. Automatic sends waiting today, per workspace. Any number is OK here: at go-live (05-go-live-switches.sql) every
--    one of these belongs to an old (non-automated) lead and is PAUSED, nothing deleted. Write the numbers down:
--    05's verify block must show the same numbers as paused.
-- ---------------------------------------------------------------------------------------------------------------
select w.name,
       (select count(*) from public.workflow_runs r where r.workspace_id = w.id and r.status in ('running', 'waiting')) as workflow_runs_running_or_waiting,
       (select count(*) from public.scheduled_actions a where a.workspace_id = w.id and a.status in ('pending', 'due') and a.action_type::text = 'send_email') as pending_email_steps,
       (select count(*) from public.scheduled_actions a where a.workspace_id = w.id and a.status in ('pending', 'due') and a.action_type::text = 'send_whatsapp') as pending_whatsapp_steps,
       (select count(*) from public.scheduled_actions a where a.workspace_id = w.id and a.status in ('pending', 'due')) as pending_steps_all,
       (select min(a.scheduled_for) from public.scheduled_actions a where a.workspace_id = w.id and a.status in ('pending', 'due')) as next_step_due
  from public.workspaces w
 order by w.name;


-- ---------------------------------------------------------------------------------------------------------------
-- 6. SEC-1 (migration 056): browser access today. Before 056 every row must be a `public` policy, `rls_off`, or a
--    `storage` policy that 056 drops (names a private bucket or none). ANYTHING ELSE → STOP and send me the rows.
--    After 056 (step 4 done): expect no `public` rows at all (only storage policies for other buckets, if any).
-- ---------------------------------------------------------------------------------------------------------------
select 'policy' as kind, schemaname, tablename, policyname, roles::text, cmd from pg_policies where schemaname in ('public', 'storage')
union all
select 'rls_off', 'public', c.relname, null, null, null
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity
 order by 1, 2, 3, 4;


-- ---------------------------------------------------------------------------------------------------------------
-- 7. Table sizes (how long the index builds in step 4 take). OK: leads < 200,000 and timeline_events < 2,000,000:
--    run the migration parts as they are (seconds to a minute each). Bigger → read 00-READ-ME-FIRST step 4 first.
-- ---------------------------------------------------------------------------------------------------------------
select relname as table_name, n_live_tup as approx_rows, pg_size_pretty(pg_total_relation_size(relid)) as total_size
  from pg_stat_user_tables
 where schemaname = 'public' and relname in ('leads', 'timeline_events', 'tasks', 'notifications', 'scheduled_actions', 'workflow_runs',
                                             'whatsapp_outbound_messages', 'meetings', 'proposals', 'calls', 'message_templates')
 order by n_live_tup desc;


-- ---------------------------------------------------------------------------------------------------------------
-- 8. Who is who (for the super-admin step and the member lists). Informational.
-- ---------------------------------------------------------------------------------------------------------------
select w.name as workspace, w.id as workspace_id, w.is_active,
       (select count(*) from public.leads l where l.workspace_id = w.id) as leads
  from public.workspaces w order by w.name;
select email, full_name, role, is_active from public.profiles order by role, email;
