-- E2f: reset the go-live count.
--
-- agent_settings.readiness_since  the go-live gate (and /agent/stats readiness) counts only rated
--                                 decisions created on/after this time; null = all time. An admin
--                                 sets it to now() ("Reset go-live count") so ratings of drafts made
--                                 by older code or playbooks stay saved but no longer count.
-- Additive only.

alter table public.agent_settings add column if not exists readiness_since timestamptz;

comment on column public.agent_settings.readiness_since is
  'Go-live gate counts rated decisions created on/after this time; null = all time (E2f).';
