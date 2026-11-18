-- =============================================================================
-- Northbeam CRM -- encrypted inbound WhatsApp reply text (Feature 4A)
-- =============================================================================
--
-- whatsapp_inbound_events.body_*: the text of a reply matched to exactly one
-- lead, AES-256-GCM with INTEGRATION_ENCRYPTION_KEY (security/encryption.ts),
-- AAD 'whatsapp:inbound:<message_id>'. Unmatched / ambiguous events and
-- non-text messages keep no body (all four body columns null).
-- body_truncated: the stored text was cut to 4,000 characters.
--
-- Additive and idempotent.
-- =============================================================================

alter table public.whatsapp_inbound_events
  add column if not exists body_ciphertext bytea,
  add column if not exists body_iv bytea,
  add column if not exists body_tag bytea,
  add column if not exists body_key_version integer,
  add column if not exists body_truncated boolean not null default false;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'whatsapp_inbound_body_complete') then
    alter table public.whatsapp_inbound_events
      add constraint whatsapp_inbound_body_complete check (
        (body_ciphertext is null and body_iv is null and body_tag is null and body_key_version is null)
        or
        (body_ciphertext is not null and body_iv is not null and body_tag is not null and body_key_version is not null)
      );
  end if;
end $$;

comment on column public.whatsapp_inbound_events.body_ciphertext is
  'Encrypted reply text (AAD whatsapp:inbound:<message_id>); only for replies matched to exactly one lead. Never log it.';
