-- =============================================================================
-- Northbeam CRM -- Do Not Contact can only be left by reactivation (audit B5)
-- =============================================================================
--
-- Database defence for the backend rule: a lead in do_not_contact may move
-- ONLY to active (reactivateFromDnc, which requires a reason). Previously the
-- trigger let it move to won/lost/discarded/long_term_nurture/merged as long
-- as dnc_reason was still set, which recorded a dnc_events 'reactivated' row
-- carrying the ORIGINAL suppression reason and silently lifted the
-- suppression.
--
-- The function body is copied verbatim from 002_fix_bugs_and_constraints.sql
-- (the current definition); the only change is the one check marked "020"
-- at the start of the "Leaving Do Not Contact" branch. The trigger itself
-- (leads_cascade_lifecycle_change, BEFORE INSERT OR UPDATE) is unchanged and
-- keeps pointing at this function, so it is not recreated here.
--
-- Tightens a constraint; no data change. Existing DNC leads are unaffected
-- until something tries to move them. Safe to apply before or after the
-- backend code that adds the matching service guards (the code refuses the
-- same moves first with a clearer 409).
-- =============================================================================

begin;

create or replace function public.cascade_lead_lifecycle_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_lifecycle public.lead_lifecycle_state;
  v_reason text;
begin
  if tg_op = 'INSERT' then
    v_old_lifecycle := null;
  else
    v_old_lifecycle := old.lifecycle_state;
  end if;

  -- Entering a terminal state: invalidate whatever automation was still
  -- pending for this lead instead of letting it fire later.
  if new.lifecycle_state in ('won', 'lost', 'discarded', 'do_not_contact', 'merged')
     and v_old_lifecycle is distinct from new.lifecycle_state then
    v_reason := 'Lead lifecycle changed to ' || new.lifecycle_state;

    update public.workflow_runs
    set status = 'cancelled', cancelled_at = now(), cancel_reason = v_reason
    where lead_id = new.id
      and status in ('running', 'waiting', 'paused');

    update public.scheduled_actions
    set status = 'cancelled', cancelled_at = now(), cancel_reason = v_reason
    where lead_id = new.id
      and status in ('pending', 'due', 'paused');
  end if;

  -- Entering Do Not Contact: record the suppression permanently.
  if new.lifecycle_state = 'do_not_contact'
     and v_old_lifecycle is distinct from 'do_not_contact' then
    insert into public.dnc_events (lead_id, action, reason, actor_id, actor_name)
    values (new.id, 'suppressed', new.dnc_reason, new.dnc_by, new.dnc_by_name);
  end if;

  -- Leaving Do Not Contact: this must be an explicit, reasoned action, not
  -- an incidental side effect of some other bulk update — require a reason
  -- to be present on the row being written, and record the reactivation
  -- permanently. dnc_events already preserves the original suppression
  -- record from above, so reactivating never erases that history.
  if v_old_lifecycle = 'do_not_contact' and new.lifecycle_state <> 'do_not_contact' then
    -- 020: Do Not Contact may only be left to 'active' (reactivateFromDnc).
    -- Moving straight to won/lost/discarded/long_term_nurture/merged would
    -- lift the suppression with the old suppression reason recorded as the
    -- reactivation reason.
    if new.lifecycle_state <> 'active' then
      raise exception 'A Do Not Contact lead can only be reactivated to active (with a reason), not moved to %.', new.lifecycle_state
        using errcode = '23514';
    end if;

    if new.dnc_reason is null then
      raise exception 'Reactivating a Do Not Contact lead requires dnc_reason to explain why.'
        using errcode = '23514';
    end if;

    insert into public.dnc_events (lead_id, action, reason, actor_id, actor_name)
    values (new.id, 'reactivated', new.dnc_reason, new.dnc_by, new.dnc_by_name);

    -- Fix: previously left in place forever, so an active/contactable lead's
    -- "DNC reason" field kept showing why it was un-suppressed rather than
    -- why (or whether) it had been suppressed. dnc_events above is the
    -- permanent record of both the original suppression and this
    -- reactivation, so clearing the working column here loses no history.
    new.dnc_reason := null;
  end if;

  return new;
end;
$$;

commit;
