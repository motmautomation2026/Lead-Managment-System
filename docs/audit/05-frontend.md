# 05 — Frontend

React 19 SPA, TanStack Router (file-based), TanStack Query v5, Tailwind 4, shadcn/Radix. All paths below are relative to `Frontend/src/`.

---

## 1. Boot and gating

- `main.tsx` renders `<RouterProvider router={getRouter()}>` in StrictMode.
- `router.tsx` creates a `QueryClient` with these defaults:
  - `staleTime 15s`
  - `retry`: never for a `BackendError` with a 4xx status, otherwise once
  - `refetchOnWindowFocus false`
  - mutations never retry
- `routes/__root.tsx` sets head meta and links (Google Fonts Geist, favicons). Its `RootComponent` renders `QueryClientProvider` → `HeadContent` → **`AuthGate`** → `<Outlet/>`, plus `Toaster`.
- `AuthGate` (`__root.tsx:131-218`):
  1. Paths in `PUBLIC_PATHS = ["/privacy"]` render directly, with no login and no shell.
  2. If `configurationError` is set (a missing `VITE_*`), it shows the "MOTM Flow is not configured" card. There is no demo fallback.
  3. While the Supabase session is loading it shows "Loading…".
  4. With no session it shows `<LoginPage adminMode={path starts with /admin}>`. That page calls `supabase.auth.signInWithPassword`; there is no sign-up or reset UI.
  5. `useQuery(["auth","role",userId], backend.me)` shows "Checking access…" while loading. A 401 shows the login page; any other error is thrown to the router error boundary.
  6. **Admin role**: any path other than `/admin` redirects to `/admin`. On `/admin` it renders the page **without** `StoreProvider` or `AppShell`.
  7. **Salesperson** on `/admin…`:
     - If the query string contains `calendar=` (the Google OAuth return), it runs `window.location.replace('/settings' + search)`.
     - Otherwise it redirects to `/`.
  8. Salesperson anywhere else: `<StoreProvider><AppShell>{page}</AppShell></StoreProvider>`.
  - On sign-out (no session after loading) it calls `queryClient.clear()`.
- The router's error component reports through `lib/telemetry.reportError` (console sink by default) and offers "Try again" and "Go home". `NotFoundComponent` shows a 404 page.

---

## 2. Routes and pages

| URL | Route file | Page component | Main contents |
|---|---|---|---|
| `/` | `routes/index.tsx` | `features/dashboard/dashboard-page.tsx` `DashboardPage` | Summary cards (active leads, due today, meetings today, overdue actions, leads without next action, proposal follow-ups, automation failures), pipeline funnel bars, today's queue (lead names come from `useLeads`). |
| `/leads` | `routes/leads.index.tsx` | `features/leads/leads-page.tsx` `LeadsPage` | Client-side filtering of `useLeads()` (≤500 leads) by search text, owner, stage and automation mode. A "missing next action" warning. Next-action column falls back to the lead's next pending scheduled automation step. Buttons for Import CSV (`ImportLeadsDialog`) and Add lead (shell dialog). |
| `/leads/$leadId` | `routes/leads.$leadId.tsx` | `features/leads/lead-detail-page.tsx` `LeadDetailPage` | See §6. |
| `/tasks` | `routes/tasks.tsx` | `features/tasks/tasks-page.tsx` | Tabs: today / overdue / upcoming / done (client-side filters over all tasks). Complete task. Log-call shortcut (`LogCallDialog` is opened **without** `onEnrollPrompt` or `onScheduleMeetingPrompt`, so calls logged here never prompt for enrollment or a meeting; `tasks-page.tsx:183-190`). Schedule-meeting shortcut. |
| `/meetings` | `routes/meetings.tsx` | `features/meetings/meetings-page.tsx` | List with a status select (`completed` is disabled; it must go through "Record outcome"), an edit/reschedule dialog, a record-outcome dialog (blocked once a meeting is completed), Meet link, calendar sync and notify status. |
| `/proposals` | `routes/proposals.index.tsx` | `features/proposals/proposals-page.tsx` | Stats (open, sent, pipeline value), a table with a per-row status `<Select>`, and the `SendProposalDialog`. |
| `/automations` | `routes/automations.index.tsx` | `features/automations/workflows-page.tsx` | Workflow list with active/paused toggle, duplicate, delete (and force-delete), and a new-workflow dialog (name, description, trigger). |
| `/automations/workflows/$workflowId` | `routes/automations.workflows.$workflowId.tsx` | `features/automations/workflow-builder-page.tsx` | Version selector, step editor, debounced autosave, publish, discard draft, trigger change, rename and description, delete. |
| `/automations/templates` | `routes/automations.templates.tsx` | `features/automations/templates-page.tsx` (+ `template-body-editor.tsx`) | Email and WhatsApp templates: Tiptap visual editor or raw HTML mode, variable insert, email preview iframe, WhatsApp preview, attachments, "default meeting-scheduled" toggle. |
| `/automations/runs` | `routes/automations.runs.tsx` | `features/automations/runs-page.tsx` | Runs with retry/pause/resume/cancel buttons, a scheduled-actions table, and client-side pagination. |
| `/settings` | `routes/settings.tsx` | `features/settings/workspace-settings-page.tsx` | Four panels for the current workspace: Website leads (default owner), Email, WhatsApp, Google Calendar. |
| `/privacy` | `routes/privacy.tsx` | `features/legal/privacy-page.tsx` | Public static privacy policy. |
| `/admin` | `routes/admin.tsx` | `features/admin/admin-page.tsx` | Salesperson list, create form (name, email, password ≥12), and a per-user editor (name, email, optional new password, activate/deactivate). Uses query key `["admin","users"]`. |

The shell (`app/app-shell.tsx`):
- Sidebar nav: Dashboard, Leads, Tasks, Meetings, Proposals, Automations, Settings.
- **Workspace switcher** popover: the list, the current workspace, and "Create workspace" (`POST /workspaces`; then invalidates `["workspaces"]` and selects the new id).
- Header **search**: client-side over the loaded leads (≤500). Every token must match first/last name, company, email, phone, job title, industry, service interest or the stage label. Top 6 results, with keyboard navigation.
- **Notifications** bell: unread count; clicking navigates to the lead or a known href. The list is fetched only on mount and when invalidated; there is no polling.
- ⌘K **command palette**.
- **Add lead** dialog (`AddLeadDialog`, opened through `AddLeadContext`).

---

## 3. `lib/backend-client.ts`, the only CRM HTTP client

- `BackendError(status, code, message, details)`.
- Module-level `currentWorkspaceId`, set through `setCurrentWorkspaceId()` (called only by `WorkspaceProvider`). `workspaceHeaders()` returns `{ "X-Workspace-Id": id }` when an id is set.
- `request<T>(path, init)`:
  1. A configuration error throws `BackendError(0,"configuration_error")`.
  2. `supabase.auth.getSession()`. No access token throws `BackendError(401,"authentication_failed")`.
  3. `fetch(base + "/api/v1" + path)` with headers `Content-Type: application/json`, `Authorization: Bearer <token>`, `X-Workspace-Id` (if set), then `init.headers`. The `X-Workspace-Id` header is attached to **every** call, including `/me`, `/profiles` and `/workspaces`, which ignore it.
  4. A network failure becomes `BackendError(0,"network_error")`.
  5. It parses the JSON body (tolerant of an empty 204 body).
  6. On a non-OK response: for **401** it fires `supabase.auth.signOut({scope:"local"})`; it throws `BackendError(status, body.error.code ?? "unknown", body.error.message ?? statusText, details)`.
- `get(path, signal)` passes the TanStack abort signal. `send(method, path, body)` JSON-encodes the body. `del(path)` sends a DELETE.
- `uploadFile(path, FormData)`: the same flow, POST only, **without** a Content-Type header (the browser sets the multipart boundary).
- The `backend` object maps every backend route:
  - `me`, `profiles`
  - `admin.users.{list, create, update(id)}` (uses `PATCH /admin/users/:id`)
  - `workspaces.{list, create, rename}`
  - `connections.email.{get, update, test}`, `connections.websiteLeads.{get, update}`, `connections.whatsapp.{get, update, command}`, `connections.googleCalendar.{get, updateCredentials, oauthStart, disconnect}`
  - `leads.{list, get, create, importCsv, update, delete, addNote, notes, contactability, setAutomation, markDnc, reactivateFromDnc, markWon, markLost, discard, reactivate, longTermNurture, logCall, calls, timeline, meetings, proposals, runs, logCommunication}`
  - `tasks.{list, create, update, complete, cancel}`
  - `meetings.{list, create, update, recordOutcome}`
  - `proposals.{list, create (multipart), update, setStatus}`
  - `workflows.{list, get, create, update, createDraft, updateSteps, publish (enrollmentMode keep_existing), duplicate, delete(force → "?force=true"), deleteVersion}`
  - `templates.{list, create, update, delete, uploadAttachment, deleteAttachment}`
  - `runs.{list, create, pause, resume, cancel, retry}`
  - `scheduledActions.list`, `dashboard.summary`, `notifications.{list, markRead, markAllRead}`
- **No client functions exist** for `POST /leads/:id/merge` or `POST /leads/:id/contactability`.
- **Client functions with no UI caller**: `workspaces.rename`, `leads.calls`, `leads.logCommunication` (wired into the hook but no button uses it), `notifications.markRead`.

`lib/supabase-client.ts` exports `configurationError`, `backendBaseUrl` (strips a trailing `/`, `/api` or `/api/v1`), and a `supabase` client (`persistSession`, `autoRefreshToken`).

---

## 4. Workspace selection (`store/workspace-context.tsx`)

1. `StoreProvider` (`store/store-provider.tsx`) renders `WorkspaceProvider`. CONTEXT calls it "a compatibility pass-through", but it provides the workspace context.
2. `WorkspaceProvider` fetches `GET /workspaces` (key `["workspaces"]`, staleTime 60 s).
3. The stored id is read from `localStorage["motmflow.workspaceId"]` (try/catch).
4. `currentWorkspaceId` = the stored id if it is in the list, else the **first** workspace (oldest by `created_at`), else `null`.
5. A `useEffect` copies `currentWorkspaceId` into the backend client's module variable (`setCurrentWorkspaceId`). The header is attached in `backend-client.ts:78` (JSON requests) and `:132` (multipart).
6. `setCurrentWorkspaceId(id)` (from the switcher) updates state and `localStorage`.
7. Every workspace-scoped hook keys its queries on `currentWorkspaceId` and sets `enabled: Boolean(currentWorkspaceId)`, so switching workspaces triggers fresh fetches.

Timing caveat: the module variable is updated in a parent `useEffect`, which runs *after* the children's effects. Requests still carry the right header only because `request()` awaits `supabase.auth.getSession()` before it reads the header. This is a fragile ordering (see 07).

---

## 5. TanStack Query hooks (`store/server-hooks.ts`) and keys (`store/query.ts`)

Keys (`query.ts:11-31`):
- Global: `session`, `profiles`, `workspaces`.
- Workspace-scoped, each prefixed with the workspace id: `["leads",ws]`, `["lead",ws,id]`, `["notes",ws,id]`, `["contactability",ws,id]`, `["calls",ws,id]` (never queried), `["timeline",ws,id]`, `["tasks",ws]`, `["meetings",ws]`, `["proposals",ws]`, `["workflows",ws]`, `["templates",ws]`, `["runs",ws]`, `["scheduledActions",ws]`, `["dashboard",ws]`, `["notifications",ws]`.
- Defined outside `query.ts`:
  - `["auth","role",userId]` (AuthGate)
  - `["admin","users"]` (admin page)
  - `["connections","website-leads"|"email"|"whatsapp"|"google-calendar", ws]` (settings page)

`refreshLead(client, ws, leadId)` invalidates **leads, lead, notes, contactability, calls, timeline, tasks, meetings, proposals, runs, scheduledActions, notifications, dashboard**.

| Hook | Queries (endpoint → key) | Mutation → endpoint | Invalidates on success |
|---|---|---|---|
| `useSession()` | `GET /me` → session (60 s); `GET /profiles` → profiles (60 s) | — | — |
| `useLeads()` | `GET /leads?limit=500` → leads | `addLead` → POST /leads | `refreshLead(new id)` |
| | | `importLeadsCsv` → POST /leads/import | leads, dashboard, notifications |
| | | `updateLead` → PATCH /leads/:id | refreshLead |
| | | `deleteLead` → DELETE /leads/:id | refreshLead(deleted id) |
| | | `addNote` → POST /leads/:id/notes | refreshLead |
| | | `setAutomation` → POST /leads/:id/automation | refreshLead |
| | | `markDnc`, `reactivateFromDnc` → POST …/dnc, …/dnc/reactivate | refreshLead |
| | | `logCall` → POST /leads/:id/calls | refreshLead |
| | | `logCommunication` → POST /leads/:id/communications | refreshLead |
| | | `setLifecycle(action)` → won / lost (lossReason, notes=reason) / discard / long-term-nurture / reactivate | refreshLead |
| `useLead(id)` | `GET /leads/:id` → lead; `GET …/notes` → notes; `GET …/contactability` → contactability | — | — |
| `useTasks()` | `GET /tasks` (no filters) → tasks | `addTask` POST /tasks; `updateTask` PATCH; `completeTask` POST …/complete; `cancelTask` POST …/cancel | refreshLead(task.leadId) |
| `useMeetings()` | `GET /meetings` → meetings | `addMeeting` POST; `updateMeeting` PATCH; `recordOutcome` POST …/outcome | refreshLead(meeting.leadId) |
| `useProposals()` | `GET /proposals` → proposals; **refetches every 8 s** while any proposal's WhatsApp status is queued or sending | `addProposal` POST (multipart); `updateProposal` PATCH; `setProposalStatus` POST …/status | refreshLead(proposal.leadId) |
| `useTimeline(id)` | `GET /leads/:id/timeline` → timeline | — | — |
| `useAutomations()` | `GET /workflows`, `GET /templates`, `GET /runs`, `GET /scheduled-actions` | workflow create/update/createDraft/updateSteps/publish/duplicate/delete/deleteVersion; run pause/resume/cancel/retry; `enrollLead` POST /runs `{leadId, workflowId, reason}`; template create/update/delete/uploadAttachment/deleteAttachment | **workflows, templates, runs, scheduledActions, dashboard** only. Lead, timeline and leads are **not** refreshed, so the lead's `automationMode`, which enrollment can change, stays stale until refetch. |
| `useNotifications()` | `GET /notifications` → notifications | `markNotificationsRead` POST /notifications/read-all | notifications |
| `useDashboard()` | `GET /dashboard/summary` → dashboard | — | — |
| Settings page (local `useQuery`/`useMutation`) | website-leads, email, whatsapp (**poll 5 s**), google-calendar (**poll 5 s**) | PUT/POST to the matching `/connections/*` endpoints | its own `["connections",…,ws]` key |

---

## 6. Forms and dialogs that drive business actions

### Lead detail page (`features/leads/lead-detail-page.tsx`)

- **Data**: `useLead`, `useLeads`, `useTasks`, `useMeetings`, `useProposals`, `useAutomations`, `useTimeline`. Meetings, proposals, tasks, runs and scheduled actions for the lead are filtered client-side from the workspace-wide lists.
- **Header buttons**: Edit (`EditLeadDialog`), Do not contact (`ReasonDialog` → `markDnc(reason)`; disabled when the lead is already DNC), Delete forever (`ConfirmDialog` → DELETE, then navigate to /leads).
- **`LeadJourneyCard`**: maps the stage to a phase (new / call / nurture / meeting / proposal) using local stage groupings and shows one primary action. It also renders `ScheduledFollowupTimeline`.
- **Next action card**: complete the task (if it is a call task the call dialog opens with `taskId`), schedule a meeting, and `NextActionDialog`, which updates the existing next-action task or creates a new one (owner required).
- **Overview tab**:
  - Contact details with contactability rows (read-only; there is no UI to change contactability).
  - Pipeline: "Stage (manual override)" select over all 15 stages (disabled unless lifecycle is active), Response state select, and Owner select over all salespeople, **including inactive ones**.
- **Automation tab**: mode buttons active / paused / manual / stopped (`setAutomation(mode, "Changed from lead record")`; disabled when DNC), the workflow runs list, and "Enroll in workflow".
- **Lifecycle card**:
  - When active: Won, Lost (`LostReasonDialog` requires a loss reason, notes optional), Discard, Move to Long-Term Nurture.
  - When not active and not DNC or merged: Reactivate.
  - A separate "Remove Do Not Contact" button (`ReasonDialog` → `reactivateFromDnc`).
- **Other tabs**: Notes (add note), Activity (timeline newest first), Meetings, Proposals.
- **Not exposed**: merge, contactability editing, and manual email/WhatsApp logging.

### `LogCallDialog` (`features/leads/log-call-dialog.tsx`)
- It reads the lead from `useLeads().getLead(id)`, i.e. the first 500 leads. If the lead is not in that list **the dialog renders nothing** (see 07).
- "Connected?": Connected / Not connected.
  - Not connected: reason select (all 10 reasons).
  - Connected: outcome chips (all 14 connected outcomes).
- `callback_requested`: a date input (min today) sent as `callbackDueAt = toIsoFromIst(date)`, i.e. **10:00 IST** on that date.
- `interested_later`: reason, restart date (`YYYY-MM-DD`), next action, decision owner.
- Notes.
- Sends `{connected, connectedOutcome | notConnectedReason, notes?, callbackDueAt?, interestedLater?, taskId?}`.
- After success:
  - If `promptScheduleMeeting`, it calls `onScheduleMeetingPrompt(workflowTrigger)` (Positive, Meeting Agreed).
  - Else if `workflowTrigger`, it calls `onEnrollPrompt(trigger)`, which opens `EnrollWorkflowDialog` filtered to that trigger.
- **The frontend does not duplicate the routing table**; it only reacts to the two fields the backend returns.

### `EnrollWorkflowDialog` (`features/leads/scheduled-followups.tsx:40-150`)
- Candidates: workflows with `status === "active"` and a published version.
- If `triggerFilter` is set: it narrows to workflows with that trigger and **pre-selects one if exactly one matches**. If none match, it shows all active workflows with an explanatory note.
- Optional reason.
- Submit calls `enrollLead(leadId, workflowId, reason?)` → `POST /runs {leadId, workflowId, reason}`. The rep must click Enroll; nothing is applied automatically.

### Meeting Agreed chaining (lead detail page lines 838-890)
After a call with `promptScheduleMeeting`:
1. `ScheduleMeetingDialog` opens and the trigger is held in `pendingWorkflowTrigger`.
2. Once `addMeeting` succeeds, it opens `EnrollWorkflowDialog(trigger)`.
3. For `positive` there is no trigger, so only scheduling happens.

### `ScheduleMeetingDialog` (`features/meetings/schedule-meeting-dialog.tsx`)
- Fields:
  - Lead picker (only when no `leadId` prop; the first lead is the default)
  - Title (default "Discovery call")
  - Date (default tomorrow) and time (default 11:00), sent as `at = toIsoFromIst(date, "HH:MM:00")`
  - Duration (default 30)
  - URL
  - Participants (name, email) on create only
- Sends `{leadId, title, at, durationMin, url?, participants?}`. **No ownerId**; the backend uses the lead owner.
- Editing from the meetings page sends `{...value, status: "rescheduled"}` through PATCH. The backend schema silently drops `leadId` and `participants`.

### Meetings page outcome dialog
- An outcome select (all 9 values; default `proposal_required`) and notes → `recordOutcome`.
- The button is disabled once the meeting is completed, so outcome corrections are impossible from the UI.

### `SendProposalDialog` (`features/proposals/components/send-proposal-dialog.tsx`)
- Fields:
  - Lead (all loaded leads, including DNC ones)
  - Title, optional amount, notes
  - Email template (active email templates) and WhatsApp template (active WhatsApp templates)
  - Document (client-side 10 MB check)
- Calls `addProposal` → multipart `POST /proposals`.

### Proposal status (`features/proposals/proposals-page.tsx:31-38, 150-170`)
- A per-row `<Select>` over all 10 statuses calls `setProposalStatus(id, status)` with **no lossReason**.
- Selecting `rejected` or `expired` therefore always fails with 400 ("lossReason is required"). The hook's comment (`server-hooks.ts:364-366`) claims the page prompts for a reason, but it does not.

### Lifecycle actions
Covered above: `setLifecycle`. Lost requires `lossReason` (dialog); the other actions pass no reason.

### Add, edit and import leads
- `AddLeadDialog`:
  - Fields: first name, last name, company, job title, industry, email, phone, source (default `website`), service interest, owner (default the current user), notes.
  - Client validation runs through `lib/lead-validation.ts`.
  - `addLead`, then, if there are notes, a separate `addNote` call. This is two requests, not atomic.
- `EditLeadDialog`: the same fields without notes → `updateLead`.
- `ImportLeadsDialog`:
  - Steps: CSV upload, PapaParse (`header:false`), header mapping by name (`csv-import-utils.buildHeaderMap`, normalised headers, duplicate-header detection), preview with client validation, then `importLeadsCsv(rows)`.
  - The result shows created, duplicate and failed rows.
  - Source values are normalised by `normalizeSourceValue`.

### Workflow builder (`features/automations/workflow-builder-page.tsx`)
- **Editable** only when the selected version is a draft. "Edit" (create draft) calls `createDraft` and selects the returned draft number.
- Step editing:
  - Add, insert, delete, move steps; delay days; enable toggle.
  - Action select.
  - Template select, **filtered to the matching channel**.
  - `change_lead_stage` offers a stage select over all 15 stages, including `objection_nurture`.
  - Create-task steps take a "Task title" text field; `stop_workflow` takes a "Note" text field.
- **Autosave**:
  - A 500 ms debounce on buffer changes, through a serialized promise-chain queue (`enqueueSave`). An older snapshot is skipped if superseded.
  - A dirty buffer is flushed on unmount.
  - Each save sends `PUT …/versions/:v/steps`, with `steps` reindexed `order = index`.
- **Publish**: `enqueueSave(current)`, then `publishVersion`.
- **Discard draft**: `deleteWorkflowVersion`.
- **Delete**: `deleteWorkflow`. On a 409 with `reason has_enrollment_history` it asks a second time and then calls `deleteWorkflow(force=true)`.
- Trigger select (all 19) → `updateWorkflow({trigger})`. Name and description edit.

### Templates page
- Create and update: name, channel, subject (email only), body, active.
- "Default meeting-scheduled template" checkbox: after save, a second `updateTemplate({isDefaultMeetingScheduled:true})` call.
- HTML is sanitised at save time (`lib/template-html.ts`): scripts, frames, event handlers, `javascript:` URLs and meta-refresh are removed.
- Attachment upload and delete.
- The variable picker uses `lib/template-variables.ts`, a hand-synced copy of `KNOWN_TEMPLATE_VARIABLES`.

### Runs page
- Retry, Pause, Resume, Cancel buttons → `runAction`.
- Lists runs and scheduled actions, with client-side pagination.

### Settings page
- **Website leads**: owner select → `PUT /connections/website-leads`.
- **Email**:
  - provider (resend / smtp), enabled, sender name and address
  - Resend key, SMTP host, port, security, username, password. Secrets are write-only; blank keeps the saved value. A test checks that update requests omit retained secrets.
  - "Send test" → `POST /connections/email/test`.
- **WhatsApp**:
  - Status, QR (rendered with `qrcode.react`), Connect / Restart / Logout.
  - Enabled switch and daily cap → PUT settings.
  - Metrics, and the inbound review list.
- **Google Calendar**:
  - One-click "Connect" (`oauthStart` → `window.location.href = url`), Disconnect.
  - Advanced own-credentials form (client id, secret, redirect URI).
  - Handles `?calendar=connected|error&message=` on return (toast, then strips the query).

---

## 7. Presentation helpers

### `lib/labels.ts`
- `label(value)`:
  - `null`/`undefined`/empty → "-".
  - Otherwise the `SPECIAL` map, or a fallback that replaces underscores with spaces and title-cases each word.
- `SPECIAL` entries:

| Group | Mappings |
|---|---|
| General | do_not_contact → "Do Not Contact"; ready_for_first_call → "Ready for First Call"; no_show → "No-show"; whatsapp → "WhatsApp" |
| Basic triggers | call_not_connected → "Call Not Connected"; proposal_pending → "Proposal Pending"; manual_enrollment → "Manual Enrollment"; lead_created → "New Lead Created"; meeting_scheduled → "Meeting Scheduled"; meeting_agreed → "Meeting Agreed" |
| Stages | connected_qualifying → "Connected - Qualifying"; interested_later → "Interested - Later"; future_possibility; objection_nurture; negotiation |
| Call outcomes | commission_only, internal_hiring, existing_team, budget_price → "Budget / Price", internal_approval, wrong_fit, wrong_person, information_requested → "Send Information" |
| Meeting outcomes | highly_interested, needs_internal_discussion, needs_more_information, no_proposal_required |
| Loss reasons | price_budget → "Price / Budget", project_postponed, competitor_selected, management_rejected, no_urgency, no_response |
| Newer triggers | call_outcome_* → "Call Outcome = …"; objection_* → "Objection: …" (objection_internal_approval → "Objection: Internal Approval (also used for Meeting: Needs Internal Discussion)"); meeting_needs_more_information, meeting_not_ready → "Meeting: Not Ready (Timed Nurture)", meeting_highly_interested, meeting_proposal_requested, meeting_not_a_fit → "Meeting: Not a Fit (Archive / Alternate Service)" |

- `workflowTriggerLabel(v)`: like `label`, but `meeting_agreed` becomes "Call Outcome = Meeting Agreed".
- Shared keys mean, for example, `interested_later` reads "Interested - Later" whether it is a stage, an outcome or a reason.

### `lib/dates.ts`
- `APP_TIME_ZONE = "Asia/Kolkata"`.
- `toIsoFromIst(date, time="10:00:00")` builds `new Date("${date}T${time}+05:30").toISOString()`.
- `dateInputValue(daysFromToday)` returns the IST `YYYY-MM-DD` for now + N×24h.
- `addDays(days, time)` and `nowIso()`.

### `lib/format.ts`
- Formatters are `Intl` `en-IN` in IST.
- `fmtDate` ("d MMM yyyy"), `fmtTime` (h:mm am/pm), `fmtDateTime`.
- `dayOf(iso)` returns the IST date. `relDay(iso)` returns "Today, t" / "Tomorrow, t" / "Yesterday, t" / "date (Nd ago)" / date. `dayDiff`.
- `isOverdue`, `isToday` (IST).
- `money(n)`: ₹ with Cr above 1e7, L above 1e5, otherwise en-IN grouping.
- `initials(name)`.

### Other helpers
- `lib/pipeline.ts`:
  - `nurtureTriggerForStage(stage, objectionType)`: not_connected_nurture → call_not_connected; interested_later → call_outcome_interested_later; future_possibility → call_outcome_future_possibility; objection_nurture plus the type → objection_<type> (wrong_fit → none).
  - Used to pre-filter enrollment from the journey card. It is a partial client-side copy of backend trigger knowledge (see 07).
- `lib/workflow-timeline.ts`: `stepsWithCumulativeDay` (cumulative delayDays, matching backend scheduling relative to the previous step) and `findCurrentStep(workflow, run)`.
- `lib/lead-validation.ts`: a client mirror of phone (libphonenumber, IN) and email validation, plus field rules.
- `lib/html-to-whatsapp-text.ts`: a preview-only port of the backend converter.
- `components/common/status-badge.tsx`: maps enum values to badge tones (includes `proposal_sent`).
- `types/*`: enum arrays identical to `Backend/src/domain/enums.ts`. This was verified programmatically: all 21 shared arrays match. `RUN_STATUSES` has the same members in a different order. Task statuses, origins, workflow and version statuses, template channels and notification kinds exist only as TS union types on the frontend.
