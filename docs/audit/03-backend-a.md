# 03 (part A) — Backend: middleware, errors, routes

Part B (`03-backend-b.md`) covers services, domain routing tables and the workflow engine.

---

## 1. Request pipeline

`Backend/src/app.ts:5-24`. Middleware order:
1. `helmet()` (defaults).
2. `cors({ origin: corsOrigins, credentials: true })`.
3. `express.json({ limit: "2mb" })`.
4. `GET /health` returns `{status:"ok"}` (unauthenticated, no DB check).
5. `/api/v1` → `apiRouter`.
6. `notFoundMiddleware`.
7. `errorMiddleware`.

`apiRouter` mount order (`routes/index.ts:21-69`):

| Order | Mount | Gate |
|---|---|---|
| 1 | `/me` → `meRouter` | `requireAuth` (any role) |
| 2 | `/connections/google-calendar` → `googleCalendarOAuthRouter` | **none** (defines only `GET /oauth/callback`; other paths fall through) |
| 3 | `/public` → `createPublicLeadsRouter(...)` | only if `INGEST_API_KEY && INGEST_WORKSPACE_ID`; own key check |
| 4 | `/admin` → `adminRouter` | `requireAuth, requireAdmin` |
| 5 | `/workspaces` → `workspacesRouter` | `requireAuth, requireSalesperson` |
| 6 | (no path) `profilesAccessRouter` | `requireAuth, requireSalesperson` applied to **every remaining request**, then `/profiles` |
| 7 | (no path) `crmRouter` | `requireAuth, requireSalesperson, requireWorkspace`, then leads, tasks, meetings, proposals, workflows, templates, runs, scheduled-actions, dashboard, notifications, connections |

Because steps 6 and 7 have no path prefix, any unknown `/api/v1/*` path from an unauthenticated caller returns **401** rather than 404. An authenticated salesperson without `X-Workspace-Id` gets **404 "Workspace not found."** for unknown paths.

---

## 2. Authentication and authorization (`Backend/src/authMiddleware.ts`)

### `requireAuth` (lines 36-77)
1. If `req.actor` is already set it calls `next()`, so re-applying it in sub-routers is a no-op.
2. It reads `Authorization`. It must start with `"Bearer "`. Otherwise: **401** `authentication_failed` "Missing bearer token."
3. `supabaseAdmin.auth.getUser(token)` (a network call to Supabase on every request; no caching). An error or missing user gives **401** "Invalid or expired session."
4. `select id, full_name, email, is_active, role from public.profiles where id = $1`. No row gives **401** "No CRM profile for this account." `is_active = false` gives **403** `forbidden` "This account has been deactivated."
5. Sets `req.actor = { id, fullName, email, isActive, role }`.

### `requireAdmin` (79-85)
`role !== "admin"` gives **403** "Administrator access is required."

### `requireSalesperson` (87-93)
`role !== "salesperson"` gives **403** "Administrator accounts cannot access CRM business routes." Admins and salespeople are therefore disjoint: an admin cannot use the CRM, and a salesperson cannot use `/admin`.

### `requireWorkspace` (104-118)
- Missing `X-Workspace-Id` header gives **404** `not_found` "Workspace not found."
- Otherwise it runs `select id from workspaces where id = $1 and is_active = true`. No row gives 404. On success it sets `req.workspaceId`.
- The header is **not** validated as a UUID. A malformed value makes Postgres raise `22P02 invalid input syntax for type uuid`, which surfaces as **500** `internal_error`.
- There is **no membership check**: any active salesperson may address any active workspace. This is by design, per the code comments.

---

## 3. Errors

`Backend/src/errors.ts`:

| Class | HTTP | `code` |
|---|---|---|
| `AppError(status, code, message, details?)` | any | any (used directly for `rate_limited` 429, `payload_too_large` 413, `workspace_unavailable` 503, `unusable_submission` 422) |
| `ValidationError` | 400 | `invalid_input` |
| `AuthenticationError` | 401 | `authentication_failed` |
| `ForbiddenError` | 403 | `forbidden` |
| `NotFoundError(resource)` | 404 | `not_found` ("<Resource> not found.") |
| `ConflictError` | 409 | `conflict` |
| `DoNotContactError` | 409 | `do_not_contact` |
| `InvalidTransitionError` | 422 | `invalid_transition` |

`errorMiddleware.ts`:
- `notFoundMiddleware` returns **404** `{error:{code:"not_found", message:"No route: METHOD /path"}}`.
- An `AppError` returns `{error:{code, message, details}}` with its status.
- Anything else (including Postgres errors such as check or FK violations and `22P02`) is logged with `console.error` (unless `NODE_ENV=test`) and returns **500** `{error:{code:"internal_error", message}}`. The message is `"Internal server error."` in production, otherwise the raw `err.message`.
- There is no mapping of Postgres SQLSTATEs to 4xx. Every DB constraint violation becomes a 500.

Validation helpers (`validation/parse.ts`): `parseBody`, `parseQuery`, `parseParams`. Each calls `schema.safeParse`. On failure they throw `ValidationError("Request body|Query parameters|Route parameters failed validation.", zodError.flatten())`. Zod `object` schemas **strip unknown keys** silently.

Transactions: `withTransaction(fn)` (`db.ts:22-35`) takes a pooled client and runs `BEGIN`, then `fn`, then `COMMIT`. On error it runs `ROLLBACK` (its own error swallowed) and rethrows. It always releases the client. Routes wrap mutating service calls in it. Read routes use `pool` directly.

Common gaps across all routers (details in 07):
- Path `:id` parameters are **not UUID-validated** except in `admin`, `workspaces`, and `workflows/:id/versions/:version` (version only). A malformed id gives a 500.
- `z.coerce.boolean()` is used for query flags, so the string `"false"` coerces to `true`.

---

## 4. Route catalogue

Abbreviations:
- **S** = `requireSalesperson`, **W** = `requireWorkspace`, **A** = `requireAdmin`.
- "tx" = wrapped in `withTransaction`.
- `?` marks optional fields.
- Every response body is JSON unless 204.

### 4.1 Identity (`me.routes.ts`, `admin.routes.ts`, `workspaces.routes.ts`)

| Method & path | Gate | Input | Service | Response |
|---|---|---|---|---|
| GET `/me` | auth (any role) | — | none (from `req.actor`) | `{id, name, email, role}` |
| GET `/profiles` | auth + S | — | `profiles.listProfiles(pool)` | `{data:[{id,name,email,initials,active}]}`: **all salespeople, including inactive**, ordered by name |
| GET `/admin/users` | auth + A | — | `admin-users.listSalespeople()` | `{data:[{id,name,email,initials,active,createdAt}]}` |
| POST `/admin/users` | auth + A | `{name: string.trim.min1, email: email, password: min12}` | `createSalesperson(actor, input)` | **201** user object |
| PATCH `/admin/users` | auth + A | `{id: uuid, name?: trim.min1, email?: email, password?: min12, active?: bool}` | `updateSalesperson` | user object |
| PATCH `/admin/users/:id` | auth + A | params `{id: uuid}`; body is the same as above without `id` | `updateSalesperson` | user object |
| GET `/workspaces` | auth + S | — | `listWorkspaces()` | `{data:[{id,name,slug,isActive,createdAt,updatedAt}]}` (active only, by `created_at`) |
| POST `/workspaces` | auth + S | `{name: string.min1}` | `createWorkspace(actor,input)` | **201** workspace |
| PATCH `/workspaces/:id` | auth + S | params `{id: uuid}`, `{name: min1}` | `renameWorkspace` | workspace (no UI calls this) |

### 4.2 Connections (`connections.routes.ts`): auth + S + W, scoped to `req.workspaceId`

| Method & path | Input (Zod) | Service / provider | Response |
|---|---|---|---|
| GET `/connections/email` | — | `getEmailConnection(ws)` | `{provider, enabled, senderName, senderAddress, smtpHost, smtpPort (default 587), smtpSecurity (default starttls), resendApiKeyConfigured, smtpUsernameConfigured, smtpPasswordConfigured, environmentFallbackConfigured, source: database\|environment\|unconfigured, updatedAt}` (secrets are never returned) |
| PUT `/connections/email` | `{provider: resend\|smtp, enabled: bool, senderName: trim.min1, senderAddress: email, resendApiKey?, smtpHost?: trim, smtpPort?: int 1-65535, smtpSecurity?: tls\|starttls, smtpUsername?, smtpPassword?}` | `updateEmailConnection(actor, ws, input)`; empty or absent secrets keep the saved values | same shape as GET |
| POST `/connections/email/test` | `{to: email}` | `sendEmail(ws, {to, subject:"CRM email connection test", html}, {allowDisabled:true})`, then audit `connection.email.test_succeeded`/`_failed` | `{ok:true, providerMessageId}`; on failure the provider error is rethrown (often a plain `Error`, so **500**) |
| GET `/connections/website-leads` | — | `getWebsiteLeadSettings(ws)` | `{defaultOwnerId, defaultOwnerName, ownerAvailable}` |
| PUT `/connections/website-leads` | `{defaultOwnerId: uuid \| null}` | `updateWebsiteLeadSettings` (owner must be an active salesperson) | same as GET |
| GET `/connections/whatsapp/settings` | — | `getWhatsAppConnection(ws)` | see 04 §WhatsApp. Includes the decrypted QR while it is unexpired, today/pending counts, invalid-phone count, restriction flag, and the last 20 unmatched/ambiguous inbound events (metadata only) |
| PUT `/connections/whatsapp/settings` | `{enabled: bool, dailyCap: int 1-10000}` | `updateWhatsAppSettings` | same as GET |
| POST `/connections/whatsapp/connect` \| `restart` \| `logout` | — | `commandWhatsApp(actor, ws, cmd)`: sets `desired_state` (connected / restart / disconnected), increments `command_version`, clears the QR, writes an audit row | same as GET |
| GET `/connections/google-calendar` | — | `getGoogleCalendarConnection` | `{configured, platformConfigured, usesOwnCredentials, enabled, status, clientId, redirectUri, clientSecretConfigured, connectedEmail, connectedCalendarId, lastError, lastSyncedAt, updatedAt}` |
| PUT `/connections/google-calendar/credentials` | `{clientId: trim.min1, clientSecret?: string, redirectUri: trim.url}` | `updateGoogleCalendarCredentials` | same as GET |
| POST `/connections/google-calendar/oauth/start` | — | `startGoogleCalendarOAuth` | `{url}` (Google consent URL) |
| POST `/connections/google-calendar/disconnect` | — | `disconnectGoogleCalendar` | same as GET |
| GET `/connections/google-calendar/oauth/callback` | **unauthenticated**; query `{code?, state?, error?}` | `completeGoogleCalendarOAuth(code, state)` | **302** to `${corsOrigins[0]}/admin?calendar=connected` or `…/admin?calendar=error&message=…`. The frontend forwards these to `/settings` (see 05). |

### 4.3 Public website-lead intake (`publicLeads.routes.ts`)

POST `/public/leads`. Mounted only when both ingest env vars are set. Middleware order:
1. `requireIngestKey`: `ingestKeysMatch(header X-Ingest-Key, apiKey)` (SHA-256 both sides, then `timingSafeEqual`). Failure gives 401.
2. `rateLimit`: one in-process fixed window, **60 requests per 60 s total, shared by all callers**. Over the limit gives 429 `rate_limited` with a `Retry-After` header.
3. `limitSize`: if the declared `Content-Length` exceeds 32 KB it returns 413. This runs *after* `express.json` (2 MB) has already parsed the body, and ignores chunked bodies.
4. Body `z.object({name, email, phone, company, message} all z.unknown())`. A non-object body gives 400. Each field goes through `toText`: a string is cut to 20,000 chars, a finite number is stringified, anything else becomes null.
5. `select 1 from workspaces where id = $1 and is_active`. Missing gives **503** `workspace_unavailable`.
6. `withTransaction(ingestWebsiteLead(client, workspaceId, input))`.
7. Logs a JSON line `{event:"website_lead_ingest", status, leadId}`.
8. Outcomes:
   - `rejected` → **422** `unusable_submission` (reason message).
   - `created` → **201** `{data:{status:"created", leadId}}`.
   - `duplicate` → **200** `{data:{status:"duplicate", leadId}}`.

### 4.4 Leads (`leads.routes.ts`): auth + S + W

`withNextAction(row)` = `leadToDto(row, await getLeadNextAction(pool, row.id))`. It runs after the transaction commits, on the pool.

| Method & path | Input | Service | Response |
|---|---|---|---|
| GET `/leads` | query `{stage?: PIPELINE_STAGES, lifecycle?, ownerId?: uuid, source?: LEAD_SOURCES, automationMode?, search?: string, limit?: int 1-500, offset?: int ≥0}` | `listLeads(pool, ws, filters)`: default limit 200, max 500, `order by created_at desc`, batch-loads next actions | `{data: LeadDTO[]}` |
| POST `/leads` | `{firstName?, lastName?, company?, jobTitle?, industry?, email?, phone?, source?, serviceInterest?, ownerId?: uuid}` (all strings; blank or unknown values are rejected by the service) | tx `createLead` | **201** LeadDTO + nextAction |
| POST `/leads/import` | `{rows: [{rowNumber: int>0, firstName: string, lastName?, company: string, jobTitle?, industry?, email?, phone?, source: string, serviceInterest?}] (1..2000)}` | tx `importLeads` | **201** `{data:{created: LeadDTO[] (no nextAction), duplicates:[{rowNumber,reason}], failed:[{rowNumber,reason}], totalRows}}` |
| GET `/leads/:id` | — | `getLeadRowOr404` | LeadDTO + nextAction |
| PATCH `/leads/:id` | `{firstName?, lastName?, company?, jobTitle?, industry?, email?, phone?, source?, serviceInterest?, ownerId?: uuid, pipelineStage?: enum, responseState?: enum}` | tx `updateLead(actor)` | LeadDTO |
| DELETE `/leads/:id` | — | tx `deleteLead` | **204** |
| GET `/leads/:id/notes` | — | `listNotes` | `{data:[{id, author, body, at}]}` newest first |
| POST `/leads/:id/notes` | `{body: string.min1}` | tx `addNote` | **201** `{id, author, at, body}` |
| POST `/leads/:id/automation` | `{mode: AUTOMATION_MODES, reason?}` | tx `setAutomationMode` | LeadDTO |
| POST `/leads/:id/dnc` | `{reason: min1}` | tx `markDnc` | LeadDTO |
| POST `/leads/:id/dnc/reactivate` | `{reason: min1}` | tx `reactivateFromDnc` | LeadDTO |
| POST `/leads/:id/won` | `{reason?}` | tx `markWon` | LeadDTO |
| POST `/leads/:id/lost` | `{lossReason: LEAD_LOSS_REASONS, notes?}` | tx `markLost` | LeadDTO |
| POST `/leads/:id/discard` | `{reason?}` | tx `markDiscarded` | LeadDTO |
| POST `/leads/:id/long-term-nurture` | `{reason?}` | tx `moveToLongTermNurture` | LeadDTO |
| POST `/leads/:id/reactivate` | `{reason?}` | tx `reactivateLead` | LeadDTO |
| POST `/leads/:id/merge` | `{targetLeadId: uuid, reason?}` | tx `mergeLead` | LeadDTO of the **source** (no frontend caller) |
| GET `/leads/:id/contactability` | — | `listContactability` | `{data:[{channel,status,reason?,updatedAt}]}` |
| POST `/leads/:id/contactability` | `{channel: CONTACT_CHANNELS, status: string.min1, reason?}` | tx `setContactability` | `{data: [...]}` (no frontend caller) |
| GET `/leads/:id/calls` | — | `listCallsForLead` | `{data: CallDTO[]}` (no frontend caller) |
| POST `/leads/:id/calls` | `{connected: bool, notConnectedReason?: enum, connectedOutcome?: enum, notes?, callbackDueAt?: ISO datetime with offset, taskId?: uuid, interestedLater?: {reason?, restartAt?: string, nextAction?, decisionOwner?}}` | tx `logCall` | **201** `{call: CallDTO, lead: LeadDTO, workflowTrigger?, promptScheduleMeeting?}` |
| POST `/leads/:id/communications` | `{channel: "email"\|"whatsapp", detail?}` | tx `logManualCommunication` (timeline only, no provider send) | **201** `{channel, title}` (no frontend caller) |
| GET `/leads/:id/timeline` | — | `listTimelineForLead` (oldest first) | `{data: TimelineDTO[]}` |
| GET `/leads/:id/meetings` | — | `listMeetings(ws,{leadId})` | `{data: MeetingDTO[]}` |
| GET `/leads/:id/proposals` | — | `listProposals(ws,{leadId})` | `{data: ProposalDTO[]}` |
| GET `/leads/:id/runs` | — | `listRuns(ws,{leadId})` | `{data: RunDTO[]}` |

LeadDTO (`leads.service.ts:67-103`) fields:
- Identity and contact: `id, firstName, lastName, company, jobTitle, industry, email, phone` (null becomes `""`), `source, serviceInterest`.
- Ownership: `ownerId?, ownerName?`.
- State: `pipelineStage, lifecycleState, automationMode, responseState, doNotContact` (= lifecycle `do_not_contact`), `dncReason?, dncBy?` (the name), `dncAt?`.
- Capture fields: `objectionType?, interestedLaterReason?, interestedLaterRestartAt?` (YYYY-MM-DD), `interestedLaterNextAction?, interestedLaterDecisionOwner?, lossReason?, lossNotes?, mergedIntoLeadId?`.
- Metadata: `lastActivityAt, createdBy?` (the name), `createdAt, updatedAt`.
- `nextAction: {taskId, type, title, dueAt, ownerId?, ownerName?, origin} | null`.
- `phone_e164` is **not** exposed.

### 4.5 Tasks (`tasks.routes.ts`): auth + S + W

| Method & path | Input | Service | Response |
|---|---|---|---|
| GET `/tasks` | query `{ownerId?: uuid, leadId?: uuid, status?, type?, overdueOnly?: coerce.bool, dueTodayOnly?: coerce.bool}` | `listTasks` (`order by due_at`) | `{data: TaskDTO[]}` |
| POST `/tasks` | `{leadId: uuid, ownerId?: uuid, type: TASK_TYPES, title: min1, dueAt: ISO datetime+offset}` | tx `createTask(..., origin "manual")` | **201** TaskDTO |
| PATCH `/tasks/:id` | `{ownerId?: uuid, type?, title?: min1, dueAt?: ISO}` | tx `updateTask` (open tasks only) | TaskDTO |
| POST `/tasks/:id/complete` | — | tx `completeTask` (idempotent) | TaskDTO |
| POST `/tasks/:id/cancel` | `{reason?}` | tx `cancelTask` (idempotent) | TaskDTO |

TaskDTO: `{id, leadId, ownerId?, ownerName?, type, title, dueAt, status, done, origin, sourceWorkflowRunId?, completedAt?, cancelledAt?, cancelReason?, createdAt, updatedAt}`.

### 4.6 Meetings (`meetings.routes.ts`): auth + S + W

| Method & path | Input | Service flow | Response |
|---|---|---|---|
| GET `/meetings` | query `{leadId?: uuid, status?, ownerId?: uuid}` | `listMeetings` (`order by scheduled_at asc`) | `{data: MeetingDTO[]}` |
| POST `/meetings` | `{leadId: uuid, ownerId?: uuid, title: min1, at: ISO+offset, durationMin?: int>0, url?: url, participants?: [{name?: trim.min1, email: trim.email}]}` | (1) tx `scheduleMeeting`; (2) **after commit** `await syncMeetingCreated(id)`; (3) `await notifyMeetingScheduled(id)`; (4) `getMeetingOr404` | **201** MeetingDTO |
| PATCH `/meetings/:id` | `{title?: min1, at?: ISO, durationMin?: int>0, url?: url, status?: MEETING_STATUSES, notes?}` | tx `updateMeeting`. Then, after commit: if `status === "cancelled"` it calls `syncMeetingCancelled`; otherwise, if `at`, `title` or `durationMin` changed, it calls `syncMeetingRescheduled` | MeetingDTO |
| POST `/meetings/:id/outcome` | `{outcome: MEETING_OUTCOMES, notes?}` | tx `recordMeetingOutcome` | MeetingDTO |

MeetingDTO: `{id, leadId, ownerId?, ownerName?, title, at, durationMin, url?, status, outcome?, notes?, meetLink?, calendarSyncStatus, calendarSyncError?, notifyEmailStatus, notifyEmailError?, notifyWhatsappStatus, notifyWhatsappError?, createdAt, updatedAt}`. Participants are **not** returned.

### 4.7 Proposals (`proposals.routes.ts`): auth + S + W

| Method & path | Input | Service | Response |
|---|---|---|---|
| GET `/proposals` | query `{leadId?, status?, ownerId?}` | `listProposals` (`order by updated_at desc`) | `{data: ProposalDTO[]}` |
| POST `/proposals` | **multipart**: file field `document` (required; multer memory storage, max 10 MB, MIME allow-list PDF/DOC/DOCX/XLS/XLSX/PNG/JPEG/GIF/WEBP; a multer error becomes 400) plus text fields `{leadId: uuid, title: min1, amount?: coerce.number ≥0, notes?, emailTemplateId: uuid, whatsappTemplateId: uuid}` | `createAndSendProposal(actor, ws, input, file)`. **Not wrapped in a route-level tx**; it manages its own (see part B). | **201** ProposalDTO |
| PATCH `/proposals/:id` | `{title?: min1, fileName?: string, amount?: number ≥0, notes?}` | tx `updateProposal` (`fileName` writes `document_reference`) | ProposalDTO |
| POST `/proposals/:id/status` | `{status: PROPOSAL_STATUSES, lossReason?: LEAD_LOSS_REASONS, lossNotes?}` | tx `updateProposalStatus` (`lossReason` is required by the service for rejected/expired) | ProposalDTO |

ProposalDTO: `{id, leadId, ownerId?, ownerName? (always undefined), title, fileName?, documentMimeType?, documentSizeBytes?, amount?, currency, status, sentDate?, followUpDate?, nextAction?, notes?, emailTemplateId?, whatsappTemplateId?, emailSendStatus, emailSentAt?, emailSendError?, whatsappSendStatus, whatsappSentAt?, whatsappSendError?, lossReason?, lossNotes?, updatedAt, createdAt}`.

### 4.8 Workflows and templates (`workflows.routes.ts`): auth + S + W

| Method & path | Input | Service | Response |
|---|---|---|---|
| GET `/workflows` | — | `listWorkflows` (`updated_at desc`; N+1 queries per workflow and version) | `{data: WorkflowDTO[]}` |
| POST `/workflows` | `{name: min1, description?, trigger: WORKFLOW_TRIGGERS, ownerId?: uuid}` | tx `createWorkflow` (status paused, v1 draft) | **201** WorkflowDTO |
| GET `/workflows/:id` | — | `getWorkflow` | WorkflowDTO |
| PATCH `/workflows/:id` | `{name?: min1, description?, status?: active\|paused, ownerId?: uuid, trigger?}` | tx `updateWorkflow` | WorkflowDTO |
| POST `/workflows/:id/draft` | — | tx `createDraft` (idempotent) | **201** WorkflowDTO |
| PUT `/workflows/:id/versions/:version/steps` | params `{version: coerce int>0}`; body `{steps: [{order: int≥0, delayDays: int≥0, action: STEP_ACTIONS, templateId?: uuid\|null, config?: string\|null, enabled: bool}]}` | tx `updateDraftSteps` | WorkflowDTO |
| DELETE `/workflows/:id/versions/:version` | params version | tx `deleteWorkflowVersion` (draft only, not the only version) | WorkflowDTO |
| POST `/workflows/:id/versions/:version/publish` | `{enrollmentMode?: "keep_existing"}` | tx `publishVersion` | WorkflowDTO |
| POST `/workflows/:id/duplicate` | — | tx `duplicateWorkflow` | **201** WorkflowDTO |
| DELETE `/workflows/:id` | query `{force?: coerce.bool}` | tx `deleteWorkflow` (409 `has_enrollment_history` unless forced) | **204** |
| GET `/templates` | — | `listTemplatesWithAttachments` (signs a 300 s URL per attachment on every call) | `{data: [{id,name,type,subject,body,active,isDefaultMeetingScheduled,attachments:[{id,fileName,mimeType,sizeBytes,downloadUrl}]}]}` |
| POST `/templates` | `{name: min1, channel: email\|whatsapp, subject?, body: min1}` | tx `createTemplate` | **201** TemplateDTO (no `attachments`) |
| PATCH `/templates/:id` | `{name?: min1, subject?, body?: min1, active?: bool, isDefaultMeetingScheduled?: bool}` | tx `updateTemplate` | TemplateDTO |
| DELETE `/templates/:id` | — | tx `deleteTemplate` (409 if used by a *published* step) | **204** |
| POST `/templates/:id/attachments` | multipart `file` (max 15 MB, same MIME list) | tx `createTemplateAttachment` | **201** `{id,fileName,mimeType,sizeBytes,downloadUrl}` |
| DELETE `/templates/:id/attachments/:attachmentId` | — | tx `deleteTemplateAttachment` | **204** |

WorkflowDTO: `{id, name, description, trigger, status, currentVersion (published, else highest, else 0), activeLeads (runs running/waiting/paused), failures (runs failed), ownerId?, updatedAt, versions:[{version, status, createdBy, createdAt, publishedAt?, steps:[{id, order, delayDays, action, templateId?, config?, enabled}]}]}`.

### 4.9 Runs and scheduled actions (`runs.routes.ts`): auth + S + W

| Method & path | Input | Service | Response |
|---|---|---|---|
| GET `/runs` | query `{workflowId?, leadId?, status?}` | `listRuns` (`started_at desc`) | `{data: RunDTO[]}` |
| POST `/runs` | `{leadId: uuid, workflowId?: uuid, reason?}` | With `workflowId`: tx `enrollLeadInWorkflow` (null means an active run already exists, giving **400** `invalid_input`). Without it: tx `autoEnroll(..., "manual_enrollment")` (no candidates gives **400**). Default reason "Manually enrolled". | **201** `{data: RunDTO[]}` |
| POST `/runs/:id/pause` | `{reason?}` | tx `pauseRun` | RunDTO |
| POST `/runs/:id/resume` | — | tx `resumeRun` | RunDTO |
| POST `/runs/:id/cancel` | `{reason?}` | tx `cancelRun` (default reason "Cancelled by salesperson") | RunDTO |
| POST `/runs/:id/retry` | — | tx `retryRun` | RunDTO |
| GET `/scheduled-actions` | query `{leadId?, workflowRunId?, status?}` | `listScheduledActions` (`scheduled_for asc`) | `{data:[{id, leadId, workflowRunId, workflowStepId, actionType, scheduledFor, status, payload, attemptCount, maxAttempts, lastError?, executedAt?, cancelledAt?, cancelReason?}]}` |

RunDTO: `{id, workflowId, version, leadId, currentStep? (step id), status, startedAt, nextRunAt?, completedAt?, cancelledAt?, cancelReason?, lastError?}`.

### 4.10 Dashboard and notifications

| Method & path | Gate | Service | Response |
|---|---|---|---|
| GET `/dashboard/summary` | auth + S + W | `getDashboardSummary` and `listTodaysQueue` in parallel | `{activeLeads, tasksDueToday, overdueActions, meetingsToday, proposalFollowUps, leadsWithNoNextAction, automationFailures, pipelineFunnel:[{label,value}×6], todaysQueue:[{id, leadId, title, type, dueAt, ownerId?}] (≤10)}` |
| GET `/notifications` | auth + S + W | `listNotificationsFor(actor.id, ws)`: recipient = actor, and workspace = ws **or NULL**; newest 100 | `{data:[{id,title,detail?,kind,leadId?,href?,read,at}]}` |
| POST `/notifications/:id/read` | auth + S + W | tx `markNotificationRead` | notification (no frontend caller) |
| POST `/notifications/read-all` | auth + S + W | tx `markAllNotificationsRead` | `{data: [...]}` |

---

## 5. Summary of CONTEXT.md vs routes

Every route that CONTEXT lists exists, with the methods it gives. Extra details from the code that CONTEXT omits:
- `PATCH /admin/users` (body-id variant) is listed. Both variants exist.
- Endpoints with no frontend caller: `/leads/:id/merge`, `POST /leads/:id/contactability`, `GET /leads/:id/calls`, `/leads/:id/communications`, `PATCH /workspaces/:id`, `POST /notifications/:id/read`.
- CONTEXT says the OAuth callback "redirects to the frontend's `/admin?calendar=...`". It actually redirects to the **first CORS origin** + `/admin`.
