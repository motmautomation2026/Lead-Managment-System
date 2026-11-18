# INT-1 — integration checks owed

Phases that ran without the staging database list here what INT-1 must run once staging is back. Run everything on
**staging only** (`arejsxqjhzotmngrobhm`), local API/worker stopped, one suite at a time (CLAUDE.md "Tests"). Tick an item
only when it passed; a failure is fixed or reported in INT-1, never skipped.

## LL-1 — safety net (commits `e02bbcb`, `73372de`, `93e09b1` + docs)

1. [x] Apply `Supabase/migrations/058_next_action_sweep.sql` to staging; run it a second time (re-runnable); then
   `npm run db:security-check` (no new table, should stay green).
2. [x] `npm run ll:sweep -- --dry-run` on staging: record the per-workspace counts in `docs/HISTORY.md` (LL-1 entry). Expect ~0
   right after 058 (the setting = apply time); also `--since 2026-01-01` to see the size of the old backlog.
3. [x] New integration files: `tests/integration/nextActionSweep.test.ts` (completed task → task + one batched bell; live AI with
   touches → nothing; AI stopped / out of touches → task; shadow → task; workflow pending → nothing, completed → task, pending on a
   manual lead → task; future meeting → nothing; long-term nurture → re_engage; DNC / lost / before `since` → nothing; second tick →
   no duplicate; unowned → unowned task + admin bell; dry-run counts) and `tests/integration/nextActionDirectFixes.test.ts`
   (reply on a manual / unassigned / deactivated-owner lead, escalation "Nobody has answered", AI stop no_response → long-term
   nurture + task, AI stop on DNC → nothing, unassigned handoff, meeting no-show / cancel with another future meeting, meeting-outcome
   reminder unowned, website lead enrolled in `lead_created`).
4. [x] Changed expectations in existing files: `whatsappInbound.test.ts` (ownerless and non-AI replies now get the reply task),
   `emailInbound.test.ts` (unsubscribe → "Lead opted out on email — review" task; non-AI reply → reply task),
   `replyClassification.test.ts` (STOP on a non-AI contact → re-titled reply task).
5. [ ] **OPEN** The full staging suite (`npm run test:integration:staging`) twice in a row: LL-1 changed shared paths (reply handling,
   handoff, stop, meeting PATCH, website ingest), so other files may assert the old behaviour — likely candidates: `workListsApi`
   (Replies queue counts), `agentLive` / `agentRunner` (stop / handoff), `agentEvents` (meeting cancel), `leadIngest` (website
   enrolment when a `lead_created` workflow is published), `businessFlows`.
6. [~] SQL to verify with `explain (analyze)` on the load-seeded data (`npm run staging:load-seed -- --confirm`, P7 targets: < 500 ms
   per batch, no sequential scan on a table > 10,000 rows), all in `Backend/src/services/nextAction.service.ts`:
   `SWEEP_CANDIDATES_SQL`, `SWEEP_COUNTS_SQL`, `LEAD_FACTS_SQL`, `RESPONSIBLE_SQL`, `LIVE_LEAD_SQL`, the open-task check in
   `followUpAiStop`, the meeting/task check in `rescheduleAfterMeeting`, and the `unnest` notification insert in `notifyUsers`.
   The sweep should use `leads_next_action_sweep_idx` and `tasks_lead_open_idx`.
7. [x] One worker tick on staging with the worker running (`next_action_sweep` heartbeat appears in Settings → System health).

## LL-2 — reminders, escalation and staff email (commits `faae0b1`, `7703b02`, `9f11515`, `5f14906` + docs)

1. [x] Apply `Supabase/migrations/059_reminders_escalation.sql` to staging after 058; run it a second time (re-runnable); then
   `npm run db:security-check` (new table `meeting_reminders`: RLS on, no policies — must stay green).
2. [x] New integration files: `tests/integration/taskReminders.test.ts` (due bells batched + once, closed task / DNC → nothing,
   overdue → admins emailed once, reply task not escalated, first-call escalation, rollout guard, AI-failure bell → admins),
   `tests/integration/meetingReminders.test.ts` (24 h email queued as `meeting_reminder` + no AI touch / wake-up, 1 h rep bell + setting
   off, booked < 1 h / DNC → nothing, PATCH reschedule → cancelled + `reminders_from` reset, outcome task 2 h after the end) and
   `tests/integration/staffAlerts.test.ts` (`/me` toggles + 400 on empty PATCH, two bells → one email + `sent` + nothing in
   `email_outbound_messages`, no mailbox → one admin warning, admin Users toggle). Check the test helpers' raw inserts
   (`whatsapp_numbers`, `agent_decisions`) against the real columns and fix them if needed.
3. [x] Changed expectations: `leadIngest.test.ts` (first call due 1 working hour, bell title "… within 1 working hour",
   `email_status = 'pending'`). Likely affected by the shared changes, run and fix: `agentLive` / `agentRunner` (handoff now always
   bells the responsible person + email), `nextActionDirectFixes` (handoff bell title "<name>: AI handed off — please follow up"),
   `workReminders` / `replyDrafts` (meeting outcome task after 2 h, not 2 days; reply escalation `email_status`), `agentSettings` API
   (new `meetingRemindersEnabled`), `emailOutbound` (source `meeting_reminder`), `whatsappSafety` / Baileys send tests (6th source in
   `whatsapp_outbound_exactly_one_source`), `meProfile` / admin users tests (PATCH `/me` now partial; `{}` → 400).
4. [ ] **OPEN** The full staging suite (`npm run test:integration:staging`) twice in a row.
5. [~] SQL to verify with `explain (analyze)` on the load-seeded data (P7: < 500 ms per batch, no sequential scan on a table > 10,000
   rows): `taskReminders.service.ts` `DUE_CANDIDATES_SQL`, `ESCALATION_CANDIDATES_SQL` (expect `tasks_due_reminder_idx` /
   `tasks_overdue_escalation_idx`), `CLAIM_*`; `meetingReminders.service.ts` `PLAN_CANDIDATES_SQL` (`meetings_upcoming_idx`),
   `CLAIM_WHATSAPP_SQL`, `RESET_REMINDERS_SQL`; `staffAlerts.service.ts` `CLAIM_ALERTS_SQL` (`notifications_email_pending_idx`),
   `DIGEST_CANDIDATES_SQL` (per-member counts), `WARN_NO_MAILBOX_SQL`; the changed `runMeetingOutcomeTasks` window.
6. [x] One worker tick with the worker running and `WORKER_DRY_RUN=true`: heartbeats `task_reminders`, `meeting_reminders`,
   `meeting_reminder_whatsapp`, `staff_alert_emails`, `morning_digest` appear in Settings → System health; staff emails log
   "DRY RUN" and are marked `skipped`.
7. [~] With a real staging mailbox and `WORKER_DRY_RUN` off, one staff alert email and one digest to a test user's inbox (check: no
   List-Unsubscribe header, no pixel, links open the CRM via `APP_BASE_URL`).

## INT-1 result (2026-11-17)

`[x]` done and passed, `[~]` done with a note below, `[ ] OPEN` not met.

- **058 + 059:** applied twice to staging, no change on the second run; `npm run db:security-check` green.
- **Owed test files:** all pass. Fixes were test bugs only (raw inserts against real triggers / constraints, doubled `/api/v1`
  prefix, owners not workspace members under LL-1 rule 1, old 2-day outcome window) — commits `655c55a`, `f3e20f7`.
- **Sweep dry run:** 0 leads in 0 workspaces, both default and `--since 2026-01-01`.
- **LL-1 6 / LL-2 5 `[~]`:** every expected index is used; sequential scans only on empty tables. `SWEEP_CANDIDATES_SQL`
  (~970 ms) and `SWEEP_COUNTS_SQL` (~870 ms) miss the 500 ms target on 20,000 seeded leads: a nested-loop anti-join against
  future meetings (planner estimates 10 rows, 500 actual). No migration 060; reported for a decision.
- **LL-1 5 / LL-2 4 OPEN:** the final pair was not fully green. Run 1: 505 passed, 2 failed (`replyClassification`, two 60 s
  timeouts; run took 3,039 s vs 1,951 s). Run 2: 506 passed, 1 failed (`agentAssets`, a step waiting on staging Storage).
  Both files pass alone (20/20). Every LL-1 / LL-2 file passed in every full run. Treated as staging slowness, not code.
- **Worker tick:** `WORKER_DRY_RUN=true`, `AGENT_RUNNER_ENABLED=false`; all 25 heartbeats written, no step error, LL steps 0 items.
- **LL-2 7 `[~]`:** one urgent alert (`email_status = sent`) and one digest sent to one staff login through the MOTM mailbox.
  Inbox, headers and links still to be checked by a person. `APP_BASE_URL` is not set in the staging `.env`, so links use
  `http://localhost:8080`.
