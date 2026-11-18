-- E3b-1: conversion core. Additive and re-runnable.
--
-- agent_decisions.stage_key / angle   the stage plan (agent/stagePlan.ts) the decision was made under; null = before E3b-1.
-- agent_settings.first_channel        the channel of a contact's first AI message when both are usable (whatsapp | email).
-- profiles.booking_url                the user's own booking page (https, ≤ 300 chars); the AI adds it when it asks for a call.

alter table public.agent_decisions add column if not exists stage_key text;
alter table public.agent_decisions add column if not exists angle text;

alter table public.agent_settings add column if not exists first_channel text not null default 'whatsapp';

alter table public.profiles add column if not exists booking_url text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'agent_settings_first_channel_check') then
    alter table public.agent_settings
      add constraint agent_settings_first_channel_check check (first_channel in ('whatsapp', 'email'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'profiles_booking_url_check') then
    alter table public.profiles
      add constraint profiles_booking_url_check check (booking_url is null or (booking_url ~ '^https://[^\s]+$' and char_length(booking_url) <= 300));
  end if;
end $$;
