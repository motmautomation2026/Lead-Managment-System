-- =============================================================================
-- Northbeam CRM -- stop the AI agent when a lead's lifecycle ends (Feature 3B-2)
-- =============================================================================
--
-- BEFORE UPDATE OF lifecycle_state on leads, only when the lifecycle actually
-- changes and agent_status is active / paused / handed_off:
--   - new lifecycle won / lost / discarded / do_not_contact / merged, or
--     long_term_nurture while the workspace's agent_settings.nurture_long_term
--     is false
--   → agent_status 'stopped', agent_status_reason 'lifecycle_changed',
--     pending agent_wakeups cancelled, timeline "AI Agent Stopped"
--     (kind automation, actor 'AI Agent' / automation, detail = new lifecycle).
--
-- Leaving DNC (or any lifecycle) never restarts the agent: a stopped lead
-- stays stopped until an admin re-enrolls it.
--
-- Trigger order: BEFORE triggers on one table fire in name order, so this runs
-- first: leads_agent_lifecycle_stop, leads_cascade_lifecycle_change,
-- leads_enforce_terminal_automation, leads_set_updated_at. It writes only
-- agent_* columns, agent_wakeups and timeline_events, none of which the others
-- read or write, so the order has no effect on their behaviour. If a later
-- trigger raises (e.g. a DNC exit without a reason), the whole statement and
-- these writes roll back together.
--
-- Additive and idempotent (create or replace / drop if exists).
-- =============================================================================

create or replace function public.stop_agent_on_lifecycle_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.lifecycle_state in ('won', 'lost', 'discarded', 'do_not_contact', 'merged')
     or (new.lifecycle_state = 'long_term_nurture'
         and not coalesce((select s.nurture_long_term from public.agent_settings s where s.workspace_id = new.workspace_id), false)) then
    new.agent_status := 'stopped';
    new.agent_status_reason := 'lifecycle_changed';
    new.agent_status_changed_at := now();

    update public.agent_wakeups
       set status = 'cancelled', processed_at = now(),
           payload = coalesce(payload, '{}'::jsonb) || jsonb_build_object('cancel_reason', 'lifecycle_changed')
     where lead_id = new.id and status = 'pending';

    insert into public.timeline_events (lead_id, event_kind, title, detail, actor_name, actor_source, metadata)
    values (
      new.id, 'automation', 'AI Agent Stopped', new.lifecycle_state::text, 'AI Agent', 'automation',
      jsonb_build_object('agentStatusFrom', old.agent_status, 'agentStatusTo', 'stopped', 'reason', 'lifecycle_changed')
    );
  end if;
  return new;
end;
$$;

comment on function public.stop_agent_on_lifecycle_change() is
  'Stops the AI agent (agent_status stopped, reason lifecycle_changed) when a managed lead becomes terminal, '
  'or long-term nurture while the workspace does not nurture long-term. Never restarts it.';

drop trigger if exists leads_agent_lifecycle_stop on public.leads;
create trigger leads_agent_lifecycle_stop
  before update of lifecycle_state on public.leads
  for each row
  when (old.lifecycle_state is distinct from new.lifecycle_state
        and new.agent_status in ('active', 'paused', 'handed_off'))
  execute function public.stop_agent_on_lifecycle_change();
