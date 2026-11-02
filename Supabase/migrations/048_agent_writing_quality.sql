-- E3a: AI writing quality. Additive and re-runnable.
--
-- agent_settings.style_examples     admin-written examples of the style (≤ 6,000 characters; empty = no block).
-- agent_settings.banned_phrases     adds the "AI tone" clichés to every workspace (only those missing; admin edits stay).
-- agent_settings.email_max_words /  defaults 160/75 → 120/50; rows still on the old defaults move, admin-changed values stay.
--   whatsapp_max_words
-- email_outbound_messages           index for "this contact's latest AI email" (threading).

alter table public.agent_settings add column if not exists style_examples text not null default '';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'agent_settings_style_examples_length') then
    alter table public.agent_settings
      add constraint agent_settings_style_examples_length check (char_length(style_examples) <= 6000);
  end if;
end $$;

alter table public.agent_settings alter column email_max_words set default 120;
alter table public.agent_settings alter column whatsapp_max_words set default 50;
update public.agent_settings set email_max_words = 120 where email_max_words = 160;
update public.agent_settings set whatsapp_max_words = 50 where whatsapp_max_words = 75;

alter table public.agent_settings alter column banned_phrases set default array[
  'thanks for connecting', 'just following up', 'just checking in', 'any update', 'this week', 'today', 'free',
  'guarantee', 'guaranteed', 'revolutionary', 'skyrocket', '100+', '140+',
  'hope this message finds you well', 'hope this email finds you well', 'hope you are doing well', 'hope you''re doing well',
  'I wanted to reach out', 'touch base', 'circle back', 'delve', 'leverage', 'seamless', 'seamlessly', 'unlock', 'elevate',
  'game-changer', 'cutting-edge', 'in today''s fast-paced', 'I came across your', 'please do not hesitate', 'don''t hesitate',
  'feel free to', 'at your earliest convenience', 'synergy', 'revolutionize', 'supercharge'
]::text[];

-- Only the phrases a workspace doesn't have (ignoring case), never past the limit of 100.
update public.agent_settings s
   set banned_phrases = s.banned_phrases || coalesce((
     select array_agg(a.phrase order by a.ord)
       from (
         select n.phrase, n.ord
           from unnest(array[
             'hope this message finds you well', 'hope this email finds you well', 'hope you are doing well', 'hope you''re doing well',
             'I wanted to reach out', 'just following up', 'just checking in', 'touch base', 'circle back', 'delve', 'leverage',
             'seamless', 'seamlessly', 'unlock', 'elevate', 'game-changer', 'cutting-edge', 'in today''s fast-paced',
             'I came across your', 'please do not hesitate', 'don''t hesitate', 'feel free to', 'at your earliest convenience',
             'synergy', 'revolutionize', 'supercharge'
           ]) with ordinality n(phrase, ord)
          where not exists (select 1 from unnest(s.banned_phrases) e where lower(e) = lower(n.phrase))
          order by n.ord
          limit greatest(0, 100 - cardinality(s.banned_phrases))
       ) a
   ), '{}');

create index if not exists email_outbound_agent_thread_idx
  on public.email_outbound_messages (lead_id, sent_at desc)
  where source = 'agent' and status = 'sent';
