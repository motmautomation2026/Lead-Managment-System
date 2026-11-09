# 07 — Findings

Severity: **High** means business behaviour is broken or the integrity of tenant data is at risk. **Medium** means incorrect behaviour in a reachable path or an operational risk. **Low** means correctness, cosmetic, or a code-health issue. Every item was checked against the code. "Reachable from UI" says whether a normal user can hit it.

---

## A. Discrepancies between CONTEXT.md and the code

| # | CONTEXT.md says | Code does | Evidence |
|---|---|---|---|
| A1 | `Supabase/disposable/` files are named `stage1_welcome_workflow_seed.sql`, `not_connected_reconnect_seed.sql`, … | Files are numbered `001_…` to `015_…`. | `Supabase/disposable/` |
| A2 | Every disposable template contains `[PROOF NEEDED: ...]` markers. | There are **no** `PROOF NEEDED` markers. There are 40 `CALENDAR_LINK_PLACEHOLDER` tokens. | grep over `Supabase/disposable/*.sql` |
| A3 | Disposable seeds are run once after the migrations they depend on. | None of the seeds sets `workspace_id`, which migration 015 made `NOT NULL` on `workflows` and `message_templates`. **Every seed fails on the current schema.** | `001_stage1_welcome_workflow_seed.sql:35`; `015_workspaces.sql` |
| A4 | Backend *required* values include `CORS_ORIGINS` and `NODE_ENV`. | Both have defaults (`http://localhost:8080,http://127.0.0.1:8080` and `development`). | `Backend/src/env.ts:10,25` |
| A5 | The OAuth callback "redirects to the frontend's `/admin?calendar=...`". | It redirects to `corsOrigins[0] + "/admin?calendar=…"`, i.e. the **first CORS origin**. A wrong ordering of `CORS_ORIGINS` breaks the redirect. | `googleCalendarOAuth.routes.ts:21,34-41` |
| A6 | Worker "rechecks … **response state** …". | `computeEligibility` never looks at `response_state`. | `automation.service.ts:69-105` |
| A7 | `WORKER_DRY_RUN=true` sends nothing and "advances runs as if the send succeeded, without contacting providers". | It applies only to workflow `scheduled_actions`. Queued **proposal and meeting WhatsApp** sends are still sent for real by the same worker, and API-side emails (proposal, meeting, test) ignore the flag. | `worker.ts:42-49,140-162` |
| A8 | "Email can be disabled per workspace…; sends then defer." | True for workflow steps. Proposal and meeting emails, sent inline by the API, are marked **`failed`** permanently instead of deferring. | `proposalSending.service.ts:102-105`; `meetingScheduledNotification.service.ts` (`sendMeetingEmailNow` catch) |
| A9 | Call routing for Wrong Fit: "records `objection_type`… without changing stage or enrolling". Callback: "creates a manual callback task… and does not change stage". | Both are correct, but both also set **automation_mode = manual**, which **cancels all of the lead's active runs**. CONTEXT does not mention this. | `callRouting.ts:136-140,170-181`; `runs.service.ts:428-430` |
| A10 | Proposal `sent` "enrolls `proposal_pending` (the Day 2/4-5/7/10/14 follow-up cadence)". | The code creates one `proposal_follow_up` task due +3 days and auto-enrolls `proposal_pending`. The cadence exists only if the (git-ignored) seed `013_proposal_conversion_seed.sql` has been applied and edited. | `proposalRouting.ts:31-36` |
| A11 | `draft`, `uploaded`, `ready_to_send`, `revised`, `withdrawn` "record status only". | Correct for routing, but `withdrawn` is also **terminal**: no further status change is allowed. | `proposals.service.ts:209,233-237` |
| A12 | Website intake creates system events "Lead Created", "Lead Assigned", "Website form submission". | "Lead Assigned" is written **only when a default owner resolves**. The "First call" task's "Task Created" event is attributed to "Automation". | `leadIngest.service.ts:228-251`; `tasks.service.ts` `createTask` |
| A13 | Website intake responses: 201/200/401/413/422/429/503. | Also **400** for a non-object JSON body, and **500** for unexpected DB errors. The 413 check reads only `Content-Length`, after `express.json` has already parsed up to 2 MB. | `publicLeads.routes.ts:62-69,77`; `app.ts:18` |
| A14 | Lead detail includes "manual email/WhatsApp communication buttons" (boundary text) and "contactability". | There are **no** manual-communication buttons in the UI (`logCommunication` is never called by a component). Contactability is **read-only** in the UI, and there is no client function for `POST /contactability`. | `lead-detail-page.tsx` (no caller); `backend-client.ts:522` |
| A15 | "Lead merge preserves relationships…" (listed as a product capability). | The API exists, but there is **no frontend client function or UI** for merge. | `backend-client.ts` (no `merge`) |
| A16 | `Frontend/src/store/store-provider.tsx` "is intentionally a compatibility pass-through". | It wraps everything in `WorkspaceProvider`, which owns workspace selection. | `store-provider.tsx` |
| A17 | `Frontend/src/store/query.ts` "owns query keys and composite invalidation". | The settings page (`["connections",…,ws]`), admin page (`["admin","users"]`) and AuthGate (`["auth","role",uid]`) define their own keys. | `workspace-settings-page.tsx:62,151,329,506`; `admin-page.tsx:37`; `__root.tsx:135` |
| A18 | "Meetings page for scheduling/updating meetings, participants…". | Participants can only be set at creation. Edits send `participants`, but the PATCH schema strips them, and `MeetingDTO` never returns participants. | `meetings.routes.ts:138-145`; `meetings-page.tsx:238` |
| A19 | "Proposals page for… status transitions". | Choosing **Rejected** or **Expired** always fails (no loss reason is sent; see B4). | `proposals-page.tsx:31-38` |
| A20 | "Missing **or invalid** frontend config renders a visible configuration error". | Only *missing* values are detected; a malformed URL is not validated. | `supabase-client.ts:7-15` |
| A21 | Verification status: frontend coverage of "retained admin email secrets". | The test covers settings-page connection updates (now salesperson, workspace-scoped), not an admin page. | `backend-client.test.ts:146` |
| A22 | Integration list: Google Calendar OAuth callback "protected by generated state". | True, but the state is not bound to the browser or user that started the flow (no cookie or PKCE). Anyone who obtains a consent URL within 10 minutes can complete it with their own Google account. | `connections.service.ts:406-440` |
| A23 | Root and backend `.env.example` comments mention "Admin → Connections" for email/SMTP. | Connections moved to `/settings` (salesperson). Admin is user management only. The worker's user-facing messages also say "(Admin → Templates)". | `.env.example`; `Backend/.env.example`; `meetingScheduledNotification.service.ts` skip/fail messages |

---

## B. Bugs and incorrect behaviour (ranked)

### High

**B1. Meeting-scheduled WhatsApp notifications can never be sent.**
- *Where*: `providers/baileys.manager.ts:404-432` (eligibility) and `:456` (not-registered branch).
- *What*: `performSend` has two eligibility branches: `scheduled_action`, and "everything else", which queries `public.proposals where p.id = $1 and whatsapp_send_status='sending'`. A `meeting` source falls into the proposal branch, finds no row, and throws `PermanentProviderError("The lead is no longer eligible…")`. The worker then marks `meetings.notify_whatsapp_status='failed'`. The not-registered branch also reads `public.proposals` for meeting sources.
- *Reachable from UI*: yes, on every meeting booking for a lead with a phone (once a default WhatsApp template exists).

**B2. The "Meeting: Not a Fit" (`meeting_not_a_fit`) sequence never sends anything.**
- *Where*: `meetingRouting.ts:73-85` → `meetings.service.ts:305,317-319` → `runs.service.ts:183-194` → `automation.service.ts:79-81,307-309`.
- *What*:
  1. Outcome `not_interested` moves the lead to lifecycle `long_term_nurture`, then auto-enrolls `meeting_not_a_fit`.
  2. Enrollment flips automation to `active`, because LTN is not terminal.
  3. The worker's eligibility requires `lifecycle_state === 'active'`, so every step is **skipped**.
  4. Each skip advances the run, so the run completes with no message sent and only "Automation Step Skipped" timeline rows.
- The same applies to any run on an LTN lead, for example a manual enrollment after a proposal is rejected or expired. LTN behaves like a terminal state for automation, although the enum, the trigger and the docs treat it as a nurture state.

**B3. The default meeting-scheduled template is a global flag across all workspaces.**
- *Where*: `006_google_calendar_meeting_sync.sql` (global partial unique indexes); `workflows.service.ts:634-649`; `meetingScheduledNotification.service.ts:49-55`.
- *What*:
  - (a) Setting a template as default in workspace B clears the flag on workspace A's template. The UPDATE has no `workspace_id` filter. This is a cross-tenant write.
  - (b) `getDefaultTemplate` picks *any* active default template in the database, so leads in every workspace receive the same workspace's meeting email and WhatsApp copy, including its branding and sender text.
- The code comment at `workflows.service.ts:635-642` acknowledges this ("acceptable for now since only one workspace… uses it").

**B4. Proposals can never be marked Rejected or Expired from the UI.**
- *Where*: `Frontend/src/features/proposals/proposals-page.tsx:31-38,155-170`; `store/server-hooks.ts:364-366`.
- *What*: The status `<Select>` calls `setProposalStatus(id, status)` without `lossReason`. The backend requires one for rejected/expired and returns 400. The hook comment claims "the UI prompts for it first (see proposals-page.tsx)", but no such prompt exists.

**B5. Leaving Do Not Contact through any lifecycle action other than reactivation.**
- *Where*: `leads.service.ts:766-790` (`setTerminalLifecycle`), `:807-813` (`moveToLongTermNurture`); trigger in `002_fix_bugs_and_constraints.sql`.
- *What*: Nothing checks for the DNC state before moving to won, lost, discarded or LTN. The DB trigger allows the move because `dnc_reason` is still set, writes a `dnc_events 'reactivated'` row with the **original suppression reason**, and clears `dnc_reason`. The DNC suppression is silently lifted with no reactivation reason recorded.
- *Reachable from UI*:
  - Lead page: no (lifecycle buttons are hidden unless active).
  - API: `POST /leads/:id/won|lost|discard|long-term-nurture`.
  - Indirectly: `POST /meetings/:id/outcome` with `won` or `not_interested`, and `POST /proposals/:id/status accepted` (neither checks DNC). The meetings and proposals pages expose those controls for any lead.

**B6. Deleting a template used by a *previous* (superseded) workflow version fails with 500.**
- *Where*: `workflows.service.ts:741-756`; trigger `enforce_workflow_steps_draft_only` (001).
- *What*: The guard only checks `published` steps. FK `workflow_steps.template_id ON DELETE SET NULL` issues an UPDATE on the `previous` version's steps, which the draft-only trigger rejects (23514). The result is a raw 500. Any template that was ever used in a version that has since been republished cannot be deleted.

**B7. A worker internal action that throws is retried forever, every 15 minutes.**
- *Where*: `worker.ts:91-93,131-137`; `automation.service.ts:252-266,396-401`.
- *What*: `executeInternalAction` runs in a transaction. If it throws, the transaction rolls back, so the action stays `executing`. The error is only logged. After 15 minutes the claim query reclaims it, and it fails the same way again. The `attempt_count` is never incremented, the run is never failed, and nobody is notified.
- Concrete triggers:
  - a `change_lead_stage` step with an empty config (400)
  - target stage `objection_nurture` on a lead without `objection_type` (DB check violation)
  - a lead that is no longer editable after the eligibility check (422)
- The builder offers `objection_nurture` as a target stage (`workflow-builder-page.tsx:799-816`).

### Medium

**B8. `logCall` fails for any lead that is not `active`.** (`calls.service.ts:142-158`)
- The routing table changes the stage for almost every outcome. `updateLead` asserts that the lifecycle is active and throws a 422 ("Pipeline stage cannot be changed…"), which rolls back the whole call record.
- `setAutomationMode` throws a 409 for terminal leads.
- So a rep cannot log a call on a Long-Term-Nurture, Won, Lost or Discarded lead (only the outcomes `callback_requested` and `wrong_fit` avoid the stage change). DNC gets a friendly 409; the other states get a confusing 422.

**B9. `scheduleMeeting` fails for non-active leads whose stage is before `meeting_scheduled`.** (`meetings.service.ts:125-127`) Same assertion as B8, giving a 422.

**B10. `createProposal` overwrites the stage unconditionally.** (`proposals.service.ts:132`)
- It always sets stage `proposal_preparation`, regressing leads at `proposal_decision_pending` or `negotiation`. `scheduleMeeting` explicitly avoids this kind of regression.
- For a non-active lead it fails with 422 **after** the document has already been uploaded to Storage (orphan file).

**B11. The call dialog renders nothing for leads outside the first 500.**
- *Where*: `log-call-dialog.tsx:59-60`; `server-hooks.ts:72`.
- *What*: `useLeads()` loads at most 500 leads (`created_at desc`). The dialog looks the lead up in that list and returns `null` if it is missing. Older leads in a large workspace cannot have calls logged. Header search, `SendProposalDialog` and `ScheduleMeetingDialog`'s lead picker have the same 500 limit.

**B12. Calls logged from the Tasks page never prompt for enrollment or a meeting.** (`tasks-page.tsx:183-190`) `LogCallDialog` is mounted without `onEnrollPrompt` or `onScheduleMeetingPrompt`. Because call outcomes do not auto-enroll, nurture outcomes logged from the Tasks queue (the main daily workflow) silently skip enrollment, and Positive/Meeting Agreed outcomes do not open scheduling.

**B13. A callback "today" is rejected.** The callback date input allows today (`min=dateInputValue()`), but the value is sent as 10:00 IST on that date (`dates.ts:7-9`). After 10:00 IST the backend rejects it ("callbackDueAt must be in the future", `calls.service.ts:75-77`). There is no time picker.

**B14. Query-string booleans: the string `"false"` means true.** `z.coerce.boolean()` on `overdueOnly`, `dueTodayOnly` (`tasks.routes.ts:18-19`) and `force` (`workflows.routes.ts:125`). `?force=false` therefore **force-deletes** a workflow and its enrollment history. The current frontend never sends `false`, but any other client would.

**B15. `POST /runs` does not validate the lead against the workspace or its lifecycle.** (`runs.service.ts:205-245`; `runs.routes.ts:335-356`) A run is inserted with the caller's `workspace_id` for any `leadId`: a lead from another workspace, a DNC/won lead (the worker later skips every step), or a nonexistent id (FK error, 500). The data-integrity invariant "run.workspace_id = lead.workspace_id" is not enforced anywhere.

**B16. `POST /meetings` can return 500 after the meeting is committed.** (`meetings.routes.ts:126-135`; `meetingScheduledNotification.service.ts:94-108`) `notifyMeetingScheduled` is described as best-effort, but its lead lookup and status UPDATEs are outside the try block. Any DB error makes the request fail while the meeting, tasks and enrollment are already saved. A retry by the user would book it again.

**B17. A WhatsApp manager that fails to start is never retried.** (`baileys-registry.ts:17-33,52`) A rejected start promise stays in `starting`. `ensureManagersForAllActiveWorkspaces` skips workspaces that have a `starting` entry, and `getOrCreateManager` returns the same rejected promise. For example, a transient advisory-lock clash at worker boot disables WhatsApp for that workspace until the worker restarts. All its WhatsApp actions then fail as non-deferred errors (3 attempts, then the run fails).

**B18. The worker's DB pool is exhausted as workspaces grow.** (`baileys.manager.ts:107`; `db.ts:11`) Each active workspace's manager permanently holds one pooled connection for its session advisory lock, and the pool max is 10. With about 9 or more active workspaces the worker cannot claim or execute actions. Session-level advisory locks also do not work behind a transaction-mode pooler (pgbouncer / Supabase pooler on port 6543).

**B19. Proposal and meeting WhatsApp rows can be stuck in `sending` forever.** (`proposalSending.service.ts:183-199`; `meetingScheduledNotification.service.ts:111-127`) Unlike `scheduled_actions` (15-minute reclaim), a worker crash mid-send leaves them unclaimable. The proposals page then polls every 8 seconds indefinitely (`server-hooks.ts:328-331`).

**B20. Published workflow behaviour can change without a new version, bypassing validation.** (`workflows.service.ts:607-656` vs `356-376`) Templates are mutable and shared. Editing a template that a published step uses changes what the live version sends. The unknown-variable check runs only at publish, so a template edited afterwards can ship literal `{{typo}}` text to customers (the worker only logs a warning). This works against the boundary "Do not edit published workflow versions".

**B21. Template channel is not checked against the step action.** (`workflows.service.ts:280-303`; `automation.service.ts:86-102`) An email template on a `send_whatsapp` step, or the reverse, is accepted by the API and executed. The UI filters by channel, so the risk is limited to other API clients.

**B22. Inline sends in the API have no timeouts.** (`email.provider.ts:27-48,77-99`) The Resend `fetch` has no timeout, and nodemailer uses its defaults (minutes). `POST /proposals` and `POST /meetings` await these sends, plus Google Calendar sync, inside the request. The comment at `worker.ts:126-130` claims `email.provider.ts` has "a bounded but non-trivial socket timeout"; it does not.

**B23. Under Compose, the API has no env-var email fallback.** (`compose.yaml` backend `environment`) `RESEND_API_KEY` and `SMTP_FROM_*` are given only to `worker`. Until a workspace saves database email settings, proposal and meeting emails fail ("Email connection is not configured" → marked failed), and Settings shows the source as "unconfigured".

**B24. Malformed ids cause 500 instead of 4xx.** `X-Workspace-Id` (`authMiddleware.ts:105-112`) and almost every `:id` route parameter are not UUID-validated, so `22P02` becomes a 500. More generally, every Postgres constraint violation becomes a 500 (`errorMiddleware.ts:9-26`). Reachable cases:
- Lead page stage override to `objection_nurture` (`lead-detail-page.tsx:322-336`): check violation, 500.
- Template update with whitespace-only body, or name `" "`.
- Assigning an unknown `ownerId`.

**B25. Tasks' denormalised `owner_name` is almost never filled.** (`tasks.service.ts:72-123,139-159`) Only automation tasks and website-ingest tasks pass `ownerName`. `createLead`, `importLeads`, `logCall`, meeting and proposal routing, `POST /tasks` and `updateTask` do not. `lead_next_actions.owner_name` and `TaskDTO.ownerName` are therefore usually empty or stale. The frontend works around it with `userName(ownerId)`.

**B26. `proposals.owner_name` is never written**, so `ProposalDTO.ownerName` is always undefined. (`proposals.service.ts:102-128`)

### Low

**B27. Website intake hardening is weak.** (`publicLeads.routes.ts:42,62-69`) The rate limit is one global in-memory window shared by every request (60/min), not per client, and it resets on restart. The size guard trusts `Content-Length` and runs after JSON parsing. This is acceptable for a single trusted caller, but it is not a real protection.

**B28. Unknown authenticated paths return 401/404 "Workspace not found" instead of a clean 404.** (`routes/index.ts:51-57`) This is a side effect of mounting `profilesAccessRouter` and `crmRouter` without a path.

**B29. Owner pickers list deactivated salespeople.** (`profiles.service.ts:3-9` returns inactive users; `lead-detail-page.tsx` owner select, Add/Edit lead dialogs) Leads and tasks can be assigned to deactivated users.

**B30. Lead search treats `%` and `_` as wildcards.** (`leads.service.ts:437-442`) They are not escaped in `ilike`.

**B31. Enrolling from the UI leaves the lead page stale.** (`server-hooks.ts:476-480`) `enrollLead` and run actions invalidate only the automation keys, so `automationMode`, the timeline and the next action shown on the lead page are stale until refetch (15 s stale time, no focus refetch).

**B32. Workspace header timing is fragile.** (`workspace-context.tsx:81-83`) The backend client's module-level workspace id is updated in a parent `useEffect`, which runs after the children's effects. The correct header currently depends on `request()` awaiting `getSession()` before it reads the id. If someone removed or cached that await, requests would carry the previous workspace's id while cached under the new key.

**B33. Meeting outcome corrections are possible in the API but blocked in the UI.** (`meetings-page.tsx:172-185`) When the API is used, a correction re-runs the routing, creating duplicate tasks and enrollments. The idempotency only covers an exact repeat (`meetings.service.ts:279-281`).

**B34. The Google Calendar connection is not updated when the client changes.** (`connections.service.ts:370-402`) `updateGoogleCalendarCredentials` keeps the existing refresh token, which is bound to the previous OAuth client. Sync then fails until the user reconnects. Status remains `connected`.

**B35. Storage objects are orphaned.**
- Proposal documents and template attachments are uploaded *before* the DB transaction (`proposalSending.service.ts:146-167`; `workflows.service.ts:703-714`).
- Deleting a template or a lead never removes Storage objects (`workflows.service.ts:741-756`; `leads.service.ts:626-636`).

**B36. `moveToLongTermNurture` leaves automation running.** (`leads.service.ts:807-813`) It does not cancel tasks or touch automation or runs. Existing runs keep advancing but every step is skipped (see B2).

**B37. Inbound WhatsApp handling can conflict with in-flight sends.** (`whatsapp-inbound.service.ts:69-74`) An inbound reply cancels `executing` actions. If an email send for the same lead is in flight, the email still goes out, and the later `recordActionResult` throws a Conflict that is only logged. WhatsApp sends are protected by `performSend`'s re-check.

**B38. Data shown on the dashboard is inconsistent.** (`dashboard.service.ts`) `meetingsToday` counts no-show and failed meetings. The funnel's "Meetings" and "Proposals" stages count leads with *any* meeting or proposal, including cancelled ones.

**B39. `scheduleMeeting` cancels every open `call` task**, including an explicit callback the customer requested for another date. (`meetings.service.ts:133-138`)

**B40. Unmaintained timezone view.** The `tasks_due_today` view uses the UTC day. It is unused, but misleading. (`001_initial_migration.sql`, the views at the end of the file)

---

## C. Dead code, unused dependencies, stale comments

| Item | Location |
|---|---|
| `getProfile()`: unused | `services/profiles.service.ts:13-21` |
| `listTemplateAttachments()`: unused | `services/workflows.service.ts:671-678` |
| `baileysSerialization`: unused export | `providers/baileys-auth.store.ts:119` |
| `isoOrNull()`: unused | `dto.ts:7-10` |
| Views `active_leads_missing_next_action`, `overdue_tasks`, `tasks_due_today`: unused, and they lack `workspace_id` | `001_initial_migration.sql` |
| Enum or status values never written: `pipeline_stage` ready_for_first_call, contact_attempted, proposal_sent (backend); `meeting_status` tentative; `scheduled_action_status` due; `calendar_sync_status` pending; `whatsapp_inbound_events.disposition` ignored; `notification_kind` success, danger | §02 |
| Columns never written: `proposals.owner_name`, `proposals.next_action`, `workflow_runs.created_by/_name` | services |
| `npm` dependencies not imported: `pino-http`, `supertest` (backend) | `Backend/package.json` |
| Frontend client functions with no UI caller: `workspaces.rename`, `leads.calls`, `leads.logCommunication`, `notifications.markRead`. Key `keys.calls` is invalidated but never queried. | `lib/backend-client.ts`, `store/query.ts:20` |
| API endpoints with no UI: merge, set contactability, list calls, manual communications, rename workspace, mark one notification read, `POST /runs` without workflowId, `PATCH /admin/users` (body-id variant) | 03-A |
| Stale comment: "Runs inside a single caller-supplied transaction (see routes/calls.routes.ts)". That file does not exist. | `calls.service.ts:56` |
| Stale comment: says positive outcome clears "Send Proposal/Schedule Meeting acquisition tasks". The code cancels `follow_up` and `nurture`. | `calls.service.ts:175-179` |
| Stale comment: `wrong_person` "No stage/automation change". The stage is changed. | `callRouting.ts:182-185` |
| Error messages reference nonexistent endpoints `POST /automation/actions/:id/result` and `/execute-internal` | `automation.service.ts:365,444` |
| Comment says OAuth config is "Deliberately NOT read from environment variables". It now is (platform env fallback). | `google-calendar.provider.ts:155-163` |
| Comments say "no executor in this phase" / "read/cancel only — no execution in this phase". The worker executes. | `runs.service.ts:336-339`; `runs.routes.ts:92` |
| Worker comment claims an email socket timeout exists | `worker.ts:126-130` |
| Comment on `useProposals.setProposalStatus` claims the UI prompts for a loss reason | `server-hooks.ts:364-366` |
| `templateRenderer.ts` docs say meeting variables only render in the meeting-notification path. Workflow sends also render them when the lead has any non-cancelled meeting (`automation.service.ts:194-195`). | `templateRenderer.ts:96-100` |
| `.claude/worktrees/agent-a30b5f2b59dd30d8b/`: a stale full repo copy (pre-workspaces) | repo root |

**TODO / FIXME / HACK / XXX:** a search over `Backend/src`, `Backend/tests`, `Frontend/src` and `Supabase` found **none**.

---

## D. Missing validation and risky areas

- ~~**No workspace membership.** Any active salesperson can read and modify every workspace, including its connections and secrets configuration (by design, per the code comments). `requireWorkspace` only checks that the workspace exists.~~ **Closed in E4b** (migration 055): `requireWorkspace` requires membership (or super-admin) and roles are per workspace. The RLS item below is still open.
- **RLS is not workspace-aware.** Policies only check `is_active_salesperson()`. A salesperson using the anon key directly against PostgREST could read every workspace's CRM tables. Integration and secret tables are denied, which is correct.
- **No DB-level tenant consistency.** Nothing enforces that child rows share their parent's `workspace_id` (tasks, runs, calls vs leads). Enforcement depends on every service pre-checking. B15 shows one place where it does not.
- **AES-GCM AAD is not workspace-namespaced** (deliberate, for backward compatibility). A ciphertext copied between workspace rows would decrypt.
- **No key rotation path** (`KEY_VERSION` constant 1). Losing or changing `INTEGRATION_ENCRYPTION_KEY` makes every stored secret, QR and Baileys session unusable.
- **WhatsApp** uses unofficial Baileys at a pinned pre-release `7.0.0-rc14`. There is account-ban risk. The spacing (5–15 s) and cap (200/day) are not configurable through the API.
- **The worker processes a batch concurrently**, with each action in its own transaction. Email sends are re-checked for eligibility only at claim time.
- **At-least-once WhatsApp delivery.** The DB transaction is held across `socket.sendMessage`. A crash after sending but before commit leaves the row `prepared`, so it can be re-sent later.
- **Many service functions lack lifecycle guards** (meeting outcome, proposal status, manual enrollment, run resume and retry). The worker is the final safety net, and it treats LTN like a terminal state (B2).
- **Frontend data volume.** All lists (leads ≤500, tasks, meetings, proposals, runs, scheduled actions, workflows with every version and step) are fetched in full per workspace, then filtered client-side. `listWorkflows` makes N+1 queries.
- **`profiles` are global.** Notifications from website ingest go to every active salesperson, not to the workspace's users (there is no membership).

---

## E. Non-Negotiable Project Boundaries: compliance

| Boundary | Status | Notes |
|---|---|---|
| No frontend fixture/demo data for production flows | ✅ | No fixtures outside tests. A config error shows a blocking screen. |
| Don't bypass Supabase Auth / trust client user IDs | ✅ mostly | Identity always comes from `auth.getUser(token)` and the profile. Client-supplied `ownerId`s are assignment targets, not identities, but they are not validated as active salespeople (B29). The OAuth callback attributes its audit to `updated_by`. |
| No secrets in frontend | ✅ | Only the anon key and URLs. Secrets are write-only in Settings. |
| Don't duplicate business routing tables in React | ⚠️ partial | `lib/pipeline.ts` duplicates the stage → workflow-trigger mapping (not_connected, interested_later, future_possibility, objection_*) used to pre-filter enrollment. `lead-journey-card.tsx:10-34` keeps its own stage → phase grouping (presentational). The call routing itself is not duplicated. |
| Manual Email/WhatsApp buttons must not send provider messages | ✅ | The endpoint is timeline-only. There are actually no buttons in the UI (A14). |
| No workflow sends in request handlers | ✅ for workflows / ⚠️ adjacent | Workflow steps run only in the worker. However, **proposal emails and meeting-scheduled emails are sent synchronously inside API request handlers** (`POST /proposals`, `POST /meetings`), along with Google Calendar calls. |
| Don't store inbound WhatsApp bodies | ✅ | Only the message type and metadata are stored. |
| Pipeline stage ≠ lifecycle | ⚠️ | They are separate columns, but lifecycle actions can silently exit DNC (B5), and LTN is treated as non-terminal by enrollment but as terminal by the worker (B2). |
| Don't edit published workflow versions | ✅ for steps / ⚠️ | Steps are protected by a DB trigger. Templates referenced by published steps stay editable and change live behaviour (B20). |
| Don't rotate `INTEGRATION_ENCRYPTION_KEY` casually | ✅ | There is no rotation code. A mismatched key fails closed. |
| Apply migrations 001–018 | ✅ / ⚠️ | The code reads `default_lead_owner_id` (018) behind a savepoint fallback, which tolerates a missing 018. The disposable seeds are incompatible with 015+ (A3). |

---

## F. Open questions (not resolvable from the code)

1. **Is LTN meant to receive automated nurture?** The `meeting_not_a_fit` trigger, the "Not fit → alternate service sequence" comments and the manual reactivation seeds suggest yes, but the worker's `lifecycle_state === 'active'` rule says no. Which behaviour is intended (B2)?
2. **Should exiting DNC through Won, Lost, Discard or LTN be allowed at all?** Or should every path require `reactivateFromDnc` (B5)?
3. **Are multiple workspaces in production use yet?** If so, B3 (shared default meeting template) and B18 (worker pool) are already live problems. Which workspaces exist, and do they have database email configured?
4. **Which Postgres connection string do the API and worker use?** Session pooler, direct, or transaction pooler. The Baileys session advisory locks require a session-level connection.
5. **Have the disposable seeds been applied in production?** If so, they were run before 015 or were edited. Which workflows and templates actually exist per workspace, and do any use the retired triggers?
6. **Are calls meant to be loggable on LTN, Won or Lost leads** (B8)? Callbacks and reactivation flows suggest reps would want to.
7. **Is the 500-lead client-side cap acceptable** for current data volumes (B11)?
8. **Is `responded` supposed to block automation** (CONTEXT A6)? Only the WhatsApp inbound path sets `automation_mode=manual`. Manually setting `response_state` has no effect on automation.
9. **Intended semantics of a meeting-outcome correction** (B33): should it re-run the routing, or only update the outcome?
10. **Is a CSP or HSTS header expected** at a layer in front of nginx? The repo's `nginx.conf` sets neither.
11. **Is the modified-but-diff-free `publicLeads.routes.ts` intentional**, for example a line-ending change awaiting commit?
12. **Where is the WhatsApp sender spacing configured in practice?** No API or UI changes `min_delay_seconds` or `max_delay_seconds`.
