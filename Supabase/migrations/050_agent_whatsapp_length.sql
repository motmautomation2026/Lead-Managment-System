-- E3b-1b: WhatsApp messages are mostly first messages now (welcome), and 50 words was too tight
-- (the 2026-11-03 model test failed drafts at 51–61 words). The hard limit becomes 60; the writer
-- aims for about 40 (two thirds, in the prompt). Additive and re-runnable.
--
-- agent_settings.whatsapp_max_words   default 50 → 60; rows still on 50 move, admin-changed values stay.

alter table public.agent_settings alter column whatsapp_max_words set default 60;
update public.agent_settings set whatsapp_max_words = 60 where whatsapp_max_words = 50;
