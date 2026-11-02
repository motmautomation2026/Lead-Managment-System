-- E2g: AI attachments (asset library) made safe.
--
-- agent_assets.channels             gets a default of email only for new uploads (the column exists since 022;
--                                   existing rows keep their channels).
-- agent_decisions.sent_asset_ids    the assets that really went out with this decision's send (null = no
--                                   attachment sent, a draft, a dry run, or before E2g). "No double-sending"
--                                   reads it.
-- agent_decisions.attachment_issues send-time problems with the decision's attachments, e.g. the asset was
--                                   deleted before sending: [{assetId, title, reason}] (null = none). The
--                                   message went out without them.
-- Additive only.

alter table public.agent_assets alter column channels set default array['email']::text[];

alter table public.agent_decisions
  add column if not exists sent_asset_ids uuid[],
  add column if not exists attachment_issues jsonb;

comment on column public.agent_decisions.sent_asset_ids is
  'Assets really sent with this decision (E2g); null = none / not sent / dry run.';
comment on column public.agent_decisions.attachment_issues is
  'Attachments dropped at send time, [{assetId, title, reason}] (E2g); the message was sent without them.';
