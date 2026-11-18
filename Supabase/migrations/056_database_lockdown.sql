-- =============================================================================
-- Northbeam CRM -- SEC-1: no direct database access from the browser
-- =============================================================================
--
-- The browser talks only to the backend (which connects as `postgres`, BYPASSRLS, and uses the
-- service-role key for Storage/Auth). The frontend uses Supabase only for login. So the anon and
-- authenticated roles (the public anon key, with or without a user's login token) get nothing:
--   * every policy on a `public` table is dropped (the 001-era is_active_salesperson() policies
--     let any signed-in active user read/change every workspace through PostgREST);
--   * RLS stays enabled on every `public` table (enabled here if one ever lacks it);
--   * table/view, sequence and function privileges of anon/authenticated (and function EXECUTE of
--     PUBLIC) in `public` are revoked, also for objects created later by `postgres` (default privileges);
--   * no Storage policy for anon/authenticated/public on the private buckets (none exist today).
-- The only non-additive change allowed: policies and privileges. No table, column, function or row
-- is deleted. Triggers keep working (EXECUTE is not checked when a trigger fires). Re-runnable.
-- Guarded by `npm run db:security-check` (also an integration test).
-- =============================================================================

do $$
declare r record;
begin
  for r in select tablename, policyname from pg_policies where schemaname = 'public' loop
    execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename);
  end loop;

  for r in
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity
  loop
    execute format('alter table public.%I enable row level security', r.relname);
  end loop;

  -- Storage: the four private buckets are only read/written by the backend's service role. A policy
  -- for these roles is dropped when it names a private bucket or names no bucket (= every bucket).
  for r in
    select policyname, coalesce(qual, '') || ' ' || coalesce(with_check, '') as expr from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and roles && array['anon', 'authenticated', 'public']::name[]
  loop
    continue when r.expr ~ 'bucket_id' and r.expr !~ '(template-attachments|proposal-documents|kb-documents|agent-assets)';
    execute format('drop policy if exists %I on storage.objects', r.policyname);
  end loop;
end $$;

revoke all on all tables in schema public from anon, authenticated, public;
revoke all on all sequences in schema public from anon, authenticated, public;
revoke all on all functions in schema public from anon, authenticated, public;

-- Objects created later by migrations (owner postgres) start without these grants too.
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated;
-- PUBLIC's EXECUTE on new functions is a global default (a per-schema default can't remove it).
alter default privileges for role postgres revoke execute on functions from public;
