# INT-1 — integration checks owed

Phases that ran without the staging database list here what INT-1 must run once staging is back. Run everything on
**staging only** (`arejsxqjhzotmngrobhm`), local API/worker stopped, one suite at a time (CLAUDE.md "Tests"). Tick an item
only when it passed; a failure is fixed or reported in INT-1, never skipped.

## LL-1 — safety net (commits `e02bbcb`, `73372de`, `93e09b1` + docs)

1. [ ] Apply `Supabase/migrations/058_next_action_sweep.sql` to staging; run it a second time (re-runnable); then
   `npm run db:security-check` (no new table, should stay green).
2. [ ] `npm run ll:sweep -- --dry-run` on staging: record the per-workspace counts in `docs/HISTORY.md` (LL-1 entry). Expect ~0
   right after 058 (the setting = apply time); also `--since 2026-01-01` to see the size of the old backlog.
3. [ ] New integration files: `tests/integration/nextActionSweep.test.ts` (completed task → task + one batched bell; live AI with
   touches → nothing; AI stopped / out of touches → task; shadow → task; workflow pending → nothing, completed → task, pending on a
   manual lead → task; future meeting → nothing; long-term nurture → re_engage; DNC / lost / before `since` → nothing; second tick →
   no duplicate; unowned → unowned task + admin bell; dry-run counts) and `tests/integration/nextActionDirectFixes.test.ts`
   (reply on a manual / unassigned / deactivated-owner lead, escalation "Nobody has answered", AI stop no_response → long-term
   nurture + task, AI stop on DNC → nothing, unassigned handoff, meeting no-show / cancel with another future meeting, meeting-outcome
   reminder unowned, website lead enrolled in `lead_created`).
4. [ ] Changed expectations in existing files: `whatsappInbound.test.ts` (ownerless and non-AI replies now get the reply task),
   `emailInbound.test.ts` (unsubscribe → "Lead opted out on email — review" task; non-AI reply → reply task),
   `replyClassification.test.ts` (STOP on a non-AI contact → re-titled reply task).
5. [ ] The full staging suite (`npm run test:integration:staging`) twice in a row: LL-1 changed shared paths (reply handling,
   handoff, stop, meeting PATCH, website ingest), so other files may assert the old behaviour — likely candidates: `workListsApi`
   (Replies queue counts), `agentLive` / `agentRunner` (stop / handoff), `agentEvents` (meeting cancel), `leadIngest` (website
   enrolment when a `lead_created` workflow is published), `businessFlows`.
6. [ ] SQL to verify with `explain (analyze)` on the load-seeded data (`npm run staging:load-seed -- --confirm`, P7 targets: < 500 ms
   per batch, no sequential scan on a table > 10,000 rows), all in `Backend/src/services/nextAction.service.ts`:
   `SWEEP_CANDIDATES_SQL`, `SWEEP_COUNTS_SQL`, `LEAD_FACTS_SQL`, `RESPONSIBLE_SQL`, `LIVE_LEAD_SQL`, the open-task check in
   `followUpAiStop`, the meeting/task check in `rescheduleAfterMeeting`, and the `unnest` notification insert in `notifyUsers`.
   The sweep should use `leads_next_action_sweep_idx` and `tasks_lead_open_idx`.
7. [ ] One worker tick on staging with the worker running (`next_action_sweep` heartbeat appears in Settings → System health).
