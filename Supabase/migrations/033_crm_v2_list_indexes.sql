-- =============================================================================
-- Northbeam CRM -- CRM v2 list indexes (B4)
-- =============================================================================
--
-- docs/crm-v2/B2-design.md §4: every whitelisted list sort has a
-- (workspace_id, <sort column(s)>, id) index; contact search (`q`, escaped ilike)
-- gets trigram GIN indexes. Additive and re-runnable; indexes only.
--
-- Not indexable: companies `contactCount` (computed per page).
-- Already covered by 032: companies name/created_at/updated_at, deals created_at/
-- amount/expected_close_date, company/deal trigram search.

-- Contacts (leads) sorts: createdAt, lastActivityAt, updatedAt, name, company.
create index if not exists leads_workspace_created_idx on public.leads (workspace_id, created_at, id);
create index if not exists leads_workspace_last_activity_idx on public.leads (workspace_id, last_activity_at, id);
create index if not exists leads_workspace_updated_idx on public.leads (workspace_id, updated_at, id);
create index if not exists leads_workspace_name_idx on public.leads (workspace_id, last_name, first_name, id);
create index if not exists leads_workspace_company_name_idx on public.leads (workspace_id, company, id);

-- Contacts search.
create index if not exists leads_first_name_trgm_idx on public.leads using gin (first_name extensions.gin_trgm_ops);
create index if not exists leads_last_name_trgm_idx on public.leads using gin (last_name extensions.gin_trgm_ops);
create index if not exists leads_company_trgm_idx on public.leads using gin (company extensions.gin_trgm_ops);
create index if not exists leads_email_trgm_idx on public.leads using gin (email extensions.gin_trgm_ops);
create index if not exists leads_phone_trgm_idx on public.leads using gin (phone extensions.gin_trgm_ops);

-- Deals sorts: updatedAt (default, without a stage filter) and name.
create index if not exists deals_workspace_updated_idx on public.deals (workspace_id, updated_at, id);
create index if not exists deals_workspace_name_idx on public.deals (workspace_id, name, id);
