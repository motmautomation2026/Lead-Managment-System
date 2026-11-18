# 07 — Kill switch and rollback

Read this **before** starting the release. It has two parts: stopping every AI send in under a minute, and going back to
the previous build.

## A. Stop all AI sends in under a minute (do 1; then 2 and 3 if anything still looks wrong)

1. **Settings → AI agent → Mode: Off** (or Shadow) → confirm. Takes effect at once: every queued AI message is cancelled
   at its send-time re-check ("The contact is no longer live"), and nothing new is decided while Off.
   SQL instead of the UI (Supabase SQL editor, all workspaces):
   ```sql
   update public.agent_settings set mode = 'off';
   ```
2. **Worker:** set `AGENT_RUNNER_ENABLED=false` and restart the worker (the one worker). AI decisions, AI WhatsApp
   sends, reply labels and reply drafts stop. Workflows, reminders and rep sends keep working.
3. **WhatsApp, everything (AI, workflows, reminders, "we tried calling", rep sends):** Settings → WhatsApp → each number
   → **Pause sending** → confirm. Paused sends wait, nothing is lost or failed. SQL, all numbers at once:
   ```sql
   update public.whatsapp_connection set outbound_enabled = false;   -- master switch: every number waits
   ```
   Undo: `update public.whatsapp_connection set outbound_enabled = true;` (and Resume on any number paused in Settings).
   **Email, everything:** SQL only (Settings → Email has *Resume sending* but no pause button). The email then shows as
   *Paused* there:
   ```sql
   update public.integration_connections set enabled = false, paused_reason = 'Kill switch', paused_at = now() where id = 'email';
   ```
   Undo: Settings → Email → **Resume sending** (admin).

**Check that nothing is queued** (read-only; OK = AI rows 0 after step 1, the rest only waiting):
```sql
select 'ai decisions queued' as what, count(*) from public.agent_decisions where send_status in ('queued', 'sending')
union all select 'emails queued/sending', count(*) from public.email_outbound_messages where status in ('queued', 'sending')
union all select 'whatsapp prepared (not sent yet)', count(*) from public.whatsapp_outbound_messages where status = 'prepared'
union all select 'tried-calling queued', count(*) from public.tried_calling_messages where status in ('queued', 'sending')
union all select 'meeting reminders queued', count(*) from public.meeting_reminders where status in ('queued', 'sending')
union all select 'workflow steps due', count(*) from public.scheduled_actions where status in ('pending', 'due') and scheduled_for <= now();
```
After step 1 the queued AI decisions are cancelled when the worker reaches them (within one tick, about 10 s). With
WhatsApp / email paused, the rest stay queued until you resume.

**Stop automation for some contacts only:** Contacts list → select → **Automation → Turn off automation**, or the
contact page switch. Their workflow runs are paused and no new automatic task, reminder or message starts.

## B. Rollback (previous build)

1. Pull the kill switch (A1–A3).
2. Stop the **new worker** and confirm it is gone. In the SQL editor, `select loop, last_finished_at from
   public.worker_heartbeats order by last_finished_at desc limit 3;` must stop moving within 2 minutes.
3. Deploy the previous API, worker and frontend images (the ones running before step 6), all three from the same commit.
4. **Do not undo migrations.** All of them are additive: they add tables, columns, indexes and triggers and never drop
   your data. Leave the database as it is.

**Does the old build still work on the new schema?** Mostly yes, but this was **not tested by running the old build**:
- The old code never reads the new tables or columns. New columns all have defaults or allow empty values, so the old
  code's inserts still work.
- **Migration 056 (SEC-1)** removes the browser's direct database access. The old frontend does not use it (checked: no
  `supabase.from(…)` in the current `main` frontend), so login and screens still go through the API.
- **WhatsApp (054):** the new code keeps each number's session in new per-number tables; the old worker reads the old
  per-workspace tables, which 054 copied but which the new worker never updated. After the new worker has run, the old
  worker may log in with an outdated session. **Expect to re-pair (scan the QR) after a rollback, and keep WhatsApp
  outbound paused until it is connected.**
- **020** (run after the new code) lets a Do Not Contact lead leave DNC only back to *active*, with a reason. If the old
  build moves a DNC lead anywhere else, the database now refuses: the user sees an error and nothing is changed. Nothing
  is lost, but that one action fails until the new build is back.
- Rows written by the new build that the old build doesn't know (new call outcomes such as *Not interested*, deals,
  AI decisions) are ignored or shown as plain text by the old screens.
- Forward again later: deploy the new build again. Run no migration again (they are re-runnable anyway).
