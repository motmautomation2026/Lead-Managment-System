-- =============================================================================
-- Northbeam CRM -- contact full-name search (C2)
-- =============================================================================
--
-- "Asha Rao" (first + last name together) matches a contact in /contacts?q=,
-- /search and the old /leads?search=. The queries use exactly this expression
-- (Backend/src/lists/listQuery.ts `LEAD_FULL_NAME_SQL`) so the planner can use it.
-- Additive and re-runnable; one index only.

create index if not exists leads_full_name_trgm_idx
  on public.leads using gin ((first_name || ' ' || last_name) extensions.gin_trgm_ops);
