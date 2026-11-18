# CRM v2 — B1 inventory (read-only)

Date: 2026-10-24. Branch `dev` at `4900f6a` (after 4A). Input for the CRM v2 design doc (Contacts, Companies, Deals, server-side lists, new frontend).

Sources: the code, plus the live **staging** catalog (`arejsxqjhzotmngrobhm`), queried with SELECT only in a read-only transaction. The audit (`docs/audit`, 2026-10-21) was used as a map; where it differs from the code, the code wins (see §9). Migrations end at `031`.

---

## 1. Data model today

### 1.1 `leads` columns (staging catalog)

P = person (contact) field, C = company field, D = really deal/opportunity state, S = system/state.

| Column | Type | Null | Default | Meaning | Kind |
|---|---|---|---|---|---|
| id | uuid | NN | gen_random_uuid() | PK | S |
| workspace_id | uuid | NN | — | FK workspaces (015) | S |
| first_name | text | NN | — | not blank | P |
| last_name | text | NN | `''` | | P |
| company | text | NN | — | not blank; website form writes `"Not provided"` when blank | **C** |
| job_title | text | null | | | P |
| industry | text | null | | | **C** |
| email | text | null | | stored lowercase; email or phone required | P (domain → C) |
| phone | text | null | | as entered | P |
| phone_e164 | text | null | | E.164 check; WhatsApp matching key | P |
| source | `lead_source` | NN | — | linkedin, email, website, cold_call, referral, event, inbound_form, other | P (how the contact arrived) |
| service_interest | text | null | | what they want to buy | **D** |
| revenue_range | text | null | | free text as entered (021) | **C** |
| revenue_min_cr, revenue_max_cr | numeric | null | | parsed crore; check min ≤ max | **C** |
| owner_id | uuid | null | | FK profiles SET NULL | P (contact owner; becomes deal owner too) |
| pipeline_stage | `pipeline_stage` | NN | `new` | see §1.2 | mixed P/D |
| lifecycle_state | `lead_lifecycle_state` | NN | `active` | see §1.2 | mixed P/D |
| automation_mode | `automation_mode` | NN | `manual` | active/paused/manual/stopped | S (contact) |
| response_state | `response_state` | NN | `no_response` | only `responded` is written automatically | P |
| dnc_reason, dnc_by, dnc_by_name, dnc_at | text/uuid/text/ts | null | | DNC record | P |
| objection_type | `objection_type` | null | | required when stage = objection_nurture | D |
| interested_later_reason / _restart_at (date) / _next_action / _decision_owner | text/date | null | | call capture | D |
| loss_reason (`lead_loss_reason`), loss_notes | | null | | required when lifecycle = lost | **D** |
| merged_into_lead_id | uuid | null | | FK leads SET NULL | S |
| agent_status | text | NN | `none` | none/active/paused/handed_off/stopped (024) | S (contact) |
| agent_status_reason, agent_status_changed_at | text/ts | null | | | S |
| agent_touch_count | int | NN | 0 | | S |
| agent_last_touch_at | ts | null | | | S |
| last_activity_at | ts | NN | now() | bumped by most writes | S |
| created_by, created_by_name | uuid/text | null | | | S |
| created_at, updated_at | ts | NN | now() | | S |

Not present: **website, city, country, address, LinkedIn URL, employee count, email domain**. "How many have a website" is 0 by construction.

Checks: `leads_first_name_not_blank`, `leads_company_not_blank`, `leads_has_contact_channel`, `leads_phone_e164_valid`, `leads_dnc_has_reason`, `leads_lost_has_reason`, `leads_objection_stage_has_type`, `leads_merge_target_not_self`, `leads_merged_has_target`, `leads_revenue_min_le_max`, `leads_agent_status_check`.

Indexes: `workspace_id`; `(workspace_id, agent_status)`; single-column `owner_id`, `pipeline_stage`, `lifecycle_state`, `automation_mode`, `created_at desc`; partial `lower(email)`, `phone`, `phone_e164`, `merged_into_lead_id`, `objection_type`, `loss_reason`, `interested_later_restart_at`. **No unique index on email/phone; no composite `(workspace_id, …)` sort indexes; no trigram index for search.**

### 1.2 Stage and lifecycle values

`pipeline_stage` (Postgres order; R = retired, still in the enum):

| Value | Written by | Level |
|---|---|---|
| new | default | contact |
| ready_for_first_call, contact_attempted | never written | contact |
| not_connected_nurture | call not connected | contact |
| maybe_nurture **R**, negative_nurture **R** | never | — |
| connected_qualifying | call info requested / wrong person | contact |
| interested_later, future_possibility | call outcomes | contact |
| objection_nurture | call objections; meeting `needs_internal_discussion` | contact **and** deal (two sources) |
| meeting_scheduling | call positive / meeting_agreed; meeting `second_meeting` | boundary: intent to meet, no meeting yet |
| meeting_scheduled | scheduleMeeting | **deal** |
| meeting_follow_up | meeting outcomes | **deal** |
| proposal_preparation | meeting outcomes; createProposal; proposal revision | **deal** |
| proposal_sent | manual override only | **deal** |
| proposal_decision_pending | proposal sent | **deal** |
| negotiation | manual override only | **deal** |

`lead_lifecycle_state`: active, long_term_nurture, do_not_contact, merged, discarded are **contact-level**; **won** and **lost** (with `loss_reason`) are **deal outcomes** stored on the person. `proposals.loss_reason` already exists for rejected/expired, so loss reasons live in two places today.

Other enums touched by CRM v2: `meeting_status` (tentative never written), `meeting_outcome` (9 values), `proposal_status` (10 values; accepted/rejected/withdrawn/expired terminal in code), `task_origin` (manual, automation, **agent**).

### 1.3 Tables referencing `leads` (live FKs)

| Table.column | ON DELETE | Meaning |
|---|---|---|
| leads.merged_into_lead_id | SET NULL | merge target |
| lead_notes.lead_id | CASCADE | notes (no workspace_id) |
| lead_contact_channels.lead_id | CASCADE | per-channel contactability, unique (lead, channel) |
| calls.lead_id | CASCADE | call log |
| tasks.lead_id | CASCADE | tasks / next action |
| meetings.lead_id | CASCADE | meetings (→ meeting_participants, whatsapp_outbound_messages cascade) |
| proposals.lead_id | CASCADE | proposals (→ whatsapp_outbound_messages cascade) |
| workflow_runs.lead_id | CASCADE | workflow enrolments |
| scheduled_actions.lead_id | CASCADE | workflow steps due |
| timeline_events.lead_id | CASCADE | activity feed; `related_task/meeting/proposal/call/workflow_run_id` SET NULL |
| dnc_events.lead_id | CASCADE | DNC audit, written only by trigger |
| notifications.lead_id | CASCADE | in-app notifications |
| agent_wakeups.lead_id | CASCADE | AI wake queue (one pending per lead, partial unique) |
| agent_decisions.lead_id | CASCADE | AI drafts/decisions (→ agent_decision_reports cascade) |

Lead-linked **without** an FK: `deleted_leads_audit.lead_id` (survives deletes, snapshot = `leadToDto`); views `lead_next_actions`, `active_leads_missing_next_action`, `overdue_tasks`, `tasks_due_today` (no `workspace_id`; only `lead_next_actions` is used).
WhatsApp: `whatsapp_inbound_events` has **no lead column**; matching is by `phone_e164` at receive time (`whatsapp-inbound.service.ts:59-63`, active, non-merged leads only) and the result is recorded only as `match_count`/`disposition` plus timeline rows. `whatsapp_outbound_messages` links via scheduled_action / proposal / meeting, not lead.

### 1.4 Triggers, functions, merge, DNC

Triggers on `leads` (all BEFORE, fired alphabetically):
1. `leads_agent_lifecycle_stop` (026) — BEFORE UPDATE OF lifecycle_state, when agent_status ∈ active/paused/handed_off: terminal state, or LTN without `agent_settings.nurture_long_term` → `agent_status='stopped'` (`lifecycle_changed`), cancels pending wakeups, inserts timeline "AI Agent Stopped".
2. `leads_cascade_lifecycle_change` (001/002/020) — entering won/lost/discarded/DNC/merged cancels running/waiting/paused runs and pending/due/paused scheduled actions (not `executing`); entering DNC writes `dnc_events suppressed`; **leaving DNC is allowed only to `active` with a reason** (020, errcode 23514), writes `reactivated`, clears `dnc_reason`.
3. `leads_enforce_terminal_automation` — terminal lifecycle forces `automation_mode='stopped'` (not for LTN).
4. `leads_set_updated_at`.

Merge (`leads.service.ts:901-931`): source → `merged` + `merged_into_lead_id`; nothing is reparented; source open tasks cancelled; timeline on both. Refuses DNC sources and merged targets. No frontend UI.
DNC: `markDnc` (`:756`) cancels open tasks; `reactivateFromDnc` (`:789`) is the only exit (sets automation `manual`); `assertNotDnc` (`:816`) guards won/lost/discard/LTN/merge. `logCall`, `scheduleMeeting`, proposals and logManualCommunication refuse DNC leads (409).

---

## 2. Where leads come from

All three paths share `validateLeadFields` (`leads.service.ts:177`) and the single INSERT `insertLead` (`:268`). No other code inserts into `leads`.

| Path | Entry | Fields set | Owner | Side effects | Duplicate detection |
|---|---|---|---|---|---|
| Manual add | `POST /leads` → `createLead` (`:215`) | first/last name, company, job title, industry, email, phone(+e164), source, service interest, revenue range (+parsed), owner | explicit `ownerId`, else revenue rules (`assignOwnerForNewLead`), else workspace default, else none | timeline Created/Assigned, notify owner, task "First call" due now, `autoEnroll lead_created`, `onAgentEvent lead_created` | **none** — a second identical lead is created |
| CSV import | `POST /leads/import` (≤2000 rows) → `importLeads` (`:344`) | same as manual, no owner column | revenue rules per row | same per row; one summary notification per owner | email (lowercase) or `phone_e164` vs existing leads in the workspace (incl. merged/DNC) **and** earlier rows in the file → skipped as duplicate |
| Website form | `POST /public/leads` (ingest key) → `ingestWebsiteLead` (`leadIngest.service.ts:122`) | name split, company (blank → `"Not provided"`), email, phone, industry, revenue range; source `website`; created_by_name "Website form" | revenue rules / default owner (`resolveOwner`) | timeline incl. submission metadata, task "First call", notifications, `onAgentEvent`; **no workflow enrolment** | email first, then `phone_e164`, non-merged, same workspace, under `pg_advisory_xact_lock` (`:59-76`); duplicate → timeline "submitted again", notify, no new lead |

No other source exists (no API key import, no email/WhatsApp-created leads; unmatched inbound WhatsApp only appears in Settings for review).

---

## 3. Business routing that moves stage or lifecycle

All stage writes except the workflow step go through `updateLead` (`leads.service.ts:556`), which requires lifecycle `active` (`assertPipelineStageEditable`) and writes a "Stage changed" timeline row.

| Trigger | Code | Old → new |
|---|---|---|
| Rep stage override | `PATCH /leads/:id` → `updateLead` `:623` | any → any non-retired stage (active only) |
| Call not connected | `callRouting.ts:50` via `calls.service.ts:144` | → not_connected_nurture (+automation active) |
| Call positive / meeting_agreed | `callRouting.ts:93,105` | → meeting_scheduling |
| Call interested_later / future_possibility | `callRouting.ts:116,130` | → interested_later / future_possibility (+capture fields) |
| Call information_requested / wrong_person | `callRouting.ts:147,187` | → connected_qualifying |
| Call objections (5) | `callRouting.ts:164,206` | → objection_nurture + objection_type |
| Call do_not_contact | `calls.service.ts:124` → `markDnc` | lifecycle → do_not_contact |
| Call automation side effects | `calls.service.ts:158` | automation → manual/active per outcome |
| Meeting booked | `meetings.service.ts:126-127` | stage → meeting_scheduled only if earlier in the stage order; cancels all runs (`:133`) |
| Meeting outcome | `meetingRouting.ts:25-82` via `meetings.service.ts:310-318` | won → lifecycle won; highly_interested/proposal_required → proposal_preparation; needs_internal_discussion → objection_nurture; needs_more_information/follow_up_required → meeting_follow_up; second_meeting → meeting_scheduling; not_interested → lifecycle long_term_nurture |
| Proposal created | `proposals.service.ts:133` | → proposal_preparation **unconditionally** (regresses later stages — B10 still open) |
| Proposal status | `proposalRouting.ts:33-60` via `proposals.service.ts:259-267` | sent → proposal_decision_pending; revision_requested → proposal_preparation; accepted → lifecycle won; rejected/expired → lifecycle long_term_nurture |
| Lifecycle buttons | `leads.service.ts:847-891` | → won / lost (+loss_reason) / discarded / long_term_nurture; reactivate → active (+automation manual) |
| DNC / reactivate | `:756`, `:789` | → do_not_contact; do_not_contact → active |
| Merge | `:911` | → merged |
| Workflow step `change_lead_stage` | `automation.service.ts:396-401` (worker) | → configured stage (active only; raw UPDATE, not `updateLead`) |
| Enrolment | `runs.service.ts:191` | automation → active |
| Inbound WhatsApp (matched) | `whatsapp-inbound.service.ts:86-90` | response_state → responded, automation → manual, runs cancelled |
| AI agent | `agentRunner.service.ts:365` | **never writes stage/lifecycle**; `update_stage` is stored as `agent_decisions.new_stage` (shadow), allow-list in `agent/rules.ts:72` |
| AI status | `agentEvents.service.ts:77`, `agentStatus.service.ts:74`, trigger 026 | `agent_status` only |

---

## 4. Staging data profile (aggregates only)

**Staging is not representative**: 1 real workspace, 4 leads, 0 test workspaces left. The numbers below cannot size dedupe or backfill; the Appendix has the query to run read-only on production by someone authorised (not run here, by rule).

| Table | Rows |
|---|---|
| leads | 4 (3 active, 1 won; stages: 3 new, 1 interested_later; source: 4 website) |
| meetings | 0 |
| proposals | 0 |
| tasks | 5 |
| calls | 1 |
| lead_notes | 0 |
| timeline_events | 24 |
| workflow_runs | 0 (scheduled_actions 0) |
| agent_decisions | 3 (agent_wakeups 6) |

Company data quality (4 leads): with a real company name 4; placeholder (`Not provided`/n/a) 0; distinct names raw 4, lower+trim 4, normalised (punctuation and pvt ltd/private limited/ltd/llp/inc/llc/corp/co stripped) 4; with email 2 (corporate domain 2, free mail 0, 2 distinct corporate domains); website 0 (no column); industry 4; revenue range 4; phone_e164 4. Duplicate email groups 0, duplicate phone groups 0.

Deal backfill: leads with meetings 0, with proposals 0, with either 0 → **0 deals** on staging.

---

## 5. Backend API today

### 5.1 Routes touching leads and related records

Guards: every route below is `requireAuth + requireCrmUser + requireWorkspace` (admins and salespeople, `X-Workspace-Id` UUID-checked) unless marked **A** (`requireAdmin`). Path ids are UUID-checked (`router.param(... uuidParam)`).

| Method & path | Returns |
|---|---|
| GET `/leads` (`?stage, lifecycle, ownerId, source, automationMode, search, limit≤500, offset`) | `{data: Lead[]}` |
| POST `/leads` | 201 Lead |
| POST `/leads/import` | 201 `{data:{created, duplicates, failed, totalRows}}` |
| GET / PATCH / DELETE `/leads/:id` | Lead / Lead / 204 |
| GET / POST `/leads/:id/notes` | `{data:[{id,author,body,at}]}` / 201 note |
| POST `/leads/:id/automation` | Lead |
| POST `/leads/:id/dnc`, `/dnc/reactivate`, `/won`, `/lost`, `/discard`, `/long-term-nurture`, `/reactivate`, `/merge` | Lead |
| GET / POST `/leads/:id/contactability` | `{data:[{channel,status,reason,updatedAt}]}` |
| GET / POST `/leads/:id/calls` | `{data: Call[]}` / 201 `{call, lead, workflowTrigger?, promptScheduleMeeting?}` |
| POST `/leads/:id/communications` | 201 `{channel,title}` (timeline only) |
| GET `/leads/:id/timeline`, `/meetings`, `/proposals`, `/runs` | `{data: [...]}` |
| GET `/tasks` (`?ownerId, leadId, status, type, overdueOnly, dueTodayOnly`); POST; PATCH `/:id`; POST `/:id/complete`, `/:id/cancel` | `{data: Task[]}` / Task |
| GET `/meetings` (`?leadId, status, ownerId`); POST; PATCH `/:id`; POST `/:id/outcome` | `{data: Meeting[]}` / Meeting |
| GET `/proposals` (`?leadId, status, ownerId`); POST (multipart); PATCH `/:id`; POST `/:id/status` | `{data: Proposal[]}` / Proposal |
| GET `/runs`, POST `/runs`, POST `/runs/:id/{pause,resume,cancel,retry}`; GET `/scheduled-actions` | runs / actions |
| GET `/dashboard/summary` | counts, funnel, today's queue |
| GET `/notifications`, POST `/:id/read`, `/read-all` | newest 100 |
| GET `/agent/decisions` (keyset), `/decisions/:id`, PUT `…/rating`, POST `…/reports`, GET `/agent/stats`, GET `/agent/leads/:id` | AI review (CRM users) |
| POST `/agent/reports/:id/resolve`; GET/PUT `/agent/settings`; `/agent/playbooks…`; POST `/agent/leads/enroll`, `/agent/leads/:id/{pause,resume,stop,wake}` | **A** |
| GET/PUT `/assignment-rules` | **A** |
| POST `/public/leads` | ingest key, not user auth |

### 5.2 How lists work

- Leads: offset/limit (default 200, max 500), fixed `order by created_at desc`, no total count, equality filters only, `search` = `ilike '%q%'` over first/last name, company, email, phone with **`%`/`_` unescaped (B30 still open, `leads.service.ts:471-476`)**; next actions batch-loaded from `lead_next_actions`. Response `{data: Lead[]}`.
- Tasks (`order by due_at`), meetings (`scheduled_at asc`), proposals (`updated_at desc`), runs, scheduled actions, workflows: **no limit, no paging**; equality filters.
- Notifications: newest 100.
- AI decisions: the only server-paginated list — keyset cursor `base64url(JSON[created_at::text, id])`, `limit` 1–50 (default 25), `.strict()` query, `{data, nextCursor}` (`agentReview.service.ts:41-99`).

### 5.3 DTO shapes (fields)

- **Lead** (`leads.service.ts:80-124`): id, firstName, lastName, company, jobTitle, industry, email, phone, source, serviceInterest, revenueRange, revenueMinCr, revenueMaxCr, ownerId, ownerName, pipelineStage, lifecycleState, automationMode, responseState, doNotContact, dncReason, dncBy, dncAt, objectionType, interestedLater{Reason,RestartAt,NextAction,DecisionOwner}, lossReason, lossNotes, mergedIntoLeadId, agentStatus, agentStatusReason, agentStatusChangedAt, agentTouchCount, agentLastTouchAt, lastActivityAt, createdBy, createdAt, updatedAt, nextAction `{taskId,type,title,dueAt,ownerId,ownerName,origin}|null`. (`phone_e164`, `workspace_id` not exposed.)
- **Task** (`tasks.service.ts:29-48`): id, leadId, ownerId, ownerName, type, title, dueAt, status, done, origin, sourceWorkflowRunId, completedAt, cancelledAt, cancelReason, createdAt, updatedAt.
- **Meeting** (`meetings.service.ts:46-69`): id, leadId, ownerId, ownerName, title, at, durationMin, url, status, outcome, notes, meetLink, calendarSyncStatus/Error, notifyEmailStatus/Error, notifyWhatsappStatus/Error, createdAt, updatedAt (no participants).
- **Proposal** (`proposals.service.ts:50-80`): id, leadId, ownerId, ownerName (never written), title, fileName, documentMimeType, documentSizeBytes, amount, currency, status, sentDate, followUpDate, nextAction, notes, email/whatsappTemplateId, emailSendStatus/SentAt/SendError, whatsappSendStatus/SentAt/SendError, lossReason, lossNotes, updatedAt, createdAt.

### 5.4 Patterns to reuse

- Zod: `parseBody` / `parseQuery` / `parseParams`, `uuidParam`, `queryBoolean` (strict "true"/"false", B14 fixed), `isUuid` (`validation/parse.ts`).
- Errors: `AppError` subclasses (`errors.ts`); Postgres → 4xx via `mapDatabaseError` / `CONSTRAINT_MESSAGES` (`domain/dbErrorMessages.ts`) — new constraints need a message entry; 500s carry a request id.
- Request ids: `requestIdMiddleware` (`errorMiddleware.ts:8-12`, `X-Request-Id`).
- Workspace scoping: `requireWorkspace` sets `req.workspaceId`; services load the root row with `id and workspace_id` (`getLeadRowOr404`), then key by id. Child tables (notes, timeline, contact channels, dnc_events) have no `workspace_id`.
- Transactions: `withTransaction` per mutating route; `onAgentEvent` uses a SAVEPOINT and never fails the caller.
- Keyset cursor: `agentReview.service.ts` (encode/decode, text timestamp to keep microseconds).
- Single INSERT + shared validation for leads (`insertLead`, `validateLeadFields`); owner assignment in `leadAssignment.service.ts`.

---

## 6. Frontend today

### 6.1 Stack (`Frontend/package.json`)

React 19.2, Vite 8.1.5, TanStack Router 1.170.18 (file routes, `routeTree.gen.ts`), TanStack Query 5.101, Tailwind 4.2 (`@tailwindcss/vite`, `tw-animate-css`), shadcn "new-york" config (`components.json`) over Radix (checkbox, dialog, label, popover, scroll-area, select, slot, switch, tabs), `class-variance-authority`, `clsx`, `tailwind-merge`, `cmdk` (command palette), `sonner` (toasts), lucide-react 0.575, Tiptap 3.30 (template editor), PapaParse 5.4, libphonenumber-js, qrcode.react, Supabase JS 2.45 (auth only). Tests: Vitest 4, Testing Library, jsdom.
**No** table library (hand-written `<table>` in 9 pages), **no** form library (useState + `lib/lead-validation.ts`), **no** chart library (dashboard funnel is CSS bars), no virtualisation.

### 6.2 Routes and pages

| Route | Page | Shows |
|---|---|---|
| `/` | `features/dashboard/dashboard-page.tsx` | KPI cards, funnel, today's queue |
| `/leads` | `features/leads/leads-page.tsx` | table of ≤500 leads filtered client-side (search, owner, stage, automation, AI status); admins: row checkboxes → Enroll in AI; Import CSV; Add lead |
| `/leads/$leadId` | `features/leads/lead-detail-page.tsx` | §6.6 |
| `/tasks` | `features/tasks/tasks-page.tsx` | today/overdue/upcoming/done tabs over all tasks |
| `/meetings` | `features/meetings/meetings-page.tsx` | all meetings, edit, outcome |
| `/proposals` | `features/proposals/proposals-page.tsx` | all proposals, status select (rejected/expired still fail — B4 open) |
| `/automations`, `/automations/workflows/$id`, `/automations/templates`, `/automations/runs` | `features/automations/*` | workflows, builder, templates, runs |
| `/knowledge` | `features/knowledge/knowledge-page.tsx` | KB documents, assets, retrieval test |
| `/ai-activity` | `features/agent/ai-activity-page.tsx` | AI decision log (infinite, cursor), stats, drawer |
| `/settings` | `features/settings/workspace-settings-page.tsx` | website leads, email, WhatsApp, calendar; admin: assignment rules, AI agent panel |
| `/admin` | `features/admin/admin-page.tsx` | user management (admins) |
| `/privacy` | `features/legal/privacy-page.tsx` | public |

### 6.3 App shell (`app/app-shell.tsx`, gate `app/auth-gate.tsx`)

Sticky left sidebar (`w-60`, hidden below `lg`) with `NAV` (`:56-66`): Dashboard, Leads, Tasks, Meetings, Proposals, Automations, Knowledge, AI Activity, Settings; admins also Admin (`:67`, `useIsAdmin`). Workspace switcher popover at the sidebar foot (list, create; id in `localStorage["motmflow.workspaceId"]`, `store/workspace-context.tsx`). Sticky header (`:282`): lead search over the ≤500 cached leads, notifications bell, ⌘K palette (`cmdk`), Add lead (`add-lead-context.ts`). Navigation is TanStack Router `<Link>`/`navigate`. Below `lg` the sidebar is hidden and the header shows only a logo link (`:283`): there is no mobile navigation.

### 6.4 Shared components

- `components/ui/*`: shadcn primitives (button, card, checkbox, command, dialog, input, label, popover, scroll-area, select, sonner, switch, tabs, textarea) — fully reusable.
- `components/common/`: `ConfirmDialog` (takes `confirmVariant`), `StatusBadge` (enum → tone; `display` prop), `LoadingBlock` / `ErrorBlock` (`server-state.tsx`), `BrandLogo`. Reusable.
- Feature-local, reusable with effort: `LogCallDialog`, `ScheduleMeetingDialog`, `SendProposalDialog`, `EnrollWorkflowDialog` (`scheduled-followups.tsx`), `Add/EditLeadDialog`, `ImportLeadsDialog`, `DecisionDrawer` (only drawer; Radix dialog based), `EnrollInAiDialog`. Several read the lead from the ≤500 list (`log-call-dialog.tsx:58-59`, B11 open).
- Missing: data-table, empty-state, page header, drawer/sheet primitive, filter bar, pagination.

### 6.5 Data fetching (`store/server-hooks.ts`, `store/query.ts`)

- Keys: workspace-scoped tuples `[name, workspaceId, …]` in `keys` (`query.ts`); prefix keys for `agentDecisions` / `agentLeadPanel`. Settings/admin/auth define local keys.
- Fetch-everything lists: leads (`limit: 500`, `server-hooks.ts:81`), tasks, meetings, proposals (polls 8 s while WhatsApp queued), workflows, templates, runs, scheduled actions, notifications. The lead page filters workspace-wide lists client-side.
- Server-paginated: only AI decisions (`useInfiniteQuery`, `:735`). Knowledge polls while ingesting.
- Invalidation: `refreshLead(client, ws, leadId)` invalidates 13 keys (leads, lead, notes, contactability, calls, timeline, tasks, meetings, proposals, runs, scheduledActions, notifications, dashboard); automation mutations only invalidate automation keys (B31).
- QueryClient: staleTime 15 s, no refetch on focus, no retry on 4xx.

### 6.6 Lead detail page

Header (edit, DNC, delete), `LeadJourneyCard` (stage → phase, one primary action), next-action card, then tabs (`lead-detail-page.tsx:290-296`): **Overview** (Contact card with contactability, Pipeline card: stage override / response state / owner, Open tasks), **Activity** (timeline), **Meetings**, **Proposals**, **Automation** (mode buttons, workflow runs, scheduled actions, enroll), **AI** (`LeadAIPanel`), **Notes**. Side cards: Status, Interested-Later capture, Lifecycle (won/lost/discard/LTN/reactivate, remove DNC).

### 6.7 Styling

`src/styles.css`: Tailwind 4 `@theme inline` mapping CSS variables (shadcn token set: background, foreground, card, popover, primary `#bc422c`, secondary, muted, accent `#fff0e8`, destructive, success, warning, info, surface, border, input, ring, chart-1..5, sidebar-*), OKLCH values, `--radius: 0.5rem` with sm–2xl derived. A `.dark` block exists but **nothing applies the class**: the app is light-only. Fonts Geist / Geist Mono from Google Fonts (`routes/__root.tsx:90-94`). Spacing is Tailwind's default scale. `src/mocks/seed/` and `src/store/slices/` are empty, unreferenced folders.

---

## 7. Constraints and risks for CRM v2

- **RLS**: enabled everywhere. Backend bypasses it. Old CRM tables have policies keyed on `is_active_salesperson()` (not workspace-aware, excludes admins); tables from 021 on have RLS **with no policies** (deny-all to non-bypass clients). New `companies`/`deals` tables should follow the 021+ pattern.
- **Connections**: staging session pooler = 15 client slots in total (API 5, worker 4 locally + WhatsApp lock clients + tests + scripts). Backfills and dedupe jobs must run in the worker tick or a script using one connection, in batches, never a new pool.
- **Encryption**: inbound WhatsApp bodies (AAD `whatsapp:inbound:<message_id>`), outbound payloads, secrets — none keyed by lead, so a contacts rename does not touch them; never copy ciphertext between rows.
- **Agent depends on `leads`**: `agentContext.service.ts:158-166` reads lead columns incl. `company`, `industry`, `revenue_range`; prompt and grounding allow-list use `ctx.lead.company` (`agent/prompt.ts:129-132,170,200`); `kbQuery` uses industry; rules use `lifecycle_state`, `agent_status`, `pipeline_stage`; wakeups/decisions FK `lead_id`; trigger 026 on lifecycle. Moving company data out of `leads.company` changes AI input unless the context reads the company table.
- **Workflows depend on `leads`**: runs/scheduled actions by `lead_id`, worker eligibility on `lead.lifecycle_state = 'active'` (`automation.service.ts:79`, B2 still open), template variables `lead.company`/`lead.industry` (`domain/templateRenderer.ts:71-72`), `change_lead_stage` writes `leads.pipeline_stage`.
- **Triggers**: any UPDATE of `leads.lifecycle_state` fires 3 BEFORE triggers with side effects (run cancellation, DNC events, AI stop). Driving lead lifecycle from deals (e.g. deal won → lead won) inherits all of them.
- **`leads.company` is NOT NULL + not blank**: cannot be dropped or nulled; website form writes `"Not provided"`. Keep it as a denormalised display/backward-compat field.
- **Hard delete** cascades every lead child. A `deals.lead_id` CASCADE would delete deals with their contact; `companies` must not cascade to leads (SET NULL).
- **Dashboard** funnel and counts read `leads` stage/lifecycle (`dashboard.service.ts`); `deleted_leads_audit.snapshot` is `leadToDto` output (DTO changes change the snapshot shape).
- **Dedup keys** today: email (lower) / `phone_e164`, not unique in DB, three different behaviours (none / skip / absorb). WhatsApp inbound matches only active, non-merged leads by phone.
- **Stage order matters**: `pipelineStageIndex` (TS order in `domain/enums.ts`) prevents regressions on meeting booking; adding or splitting stages changes that ordering.
- Open audit bugs that touch CRM v2 flows: B2 (LTN runs never send), B4 (proposal reject/expire UI), B8/B9 (call/meeting on non-active leads 422), B10 (createProposal regresses stage), B11 (500-lead client cap), B30 (search wildcards), B31 (stale lead after enrol).

---

## 8. Recommendations

**a. Keep `leads` as the contact table (rename in UI/API only).**
Pros: 14 FK tables, 3 triggers, the agent, workflows, WhatsApp matching, ingest and DTO snapshots all key on `leads.id`; zero data migration; add `company_id` (nullable FK, SET NULL) and later move deal state out. Cons: the name stays `lead` in SQL/code (mitigate with a `contacts` API alias/view later); deal-ish columns remain on the row until a later phase.
A new `contacts` table would mean re-pointing every FK, trigger and service — high risk for no user-visible gain.

**b. Deals.** New `deals` (workspace_id, company_id, primary `lead_id` RESTRICT or SET NULL, owner, name, `deal_stage` enum = the deal-level stages in §1.2, amount/currency, status open/won/lost + loss_reason, closed_at). Add nullable `meetings.deal_id` and `proposals.deal_id`. Create/attach in the **same transaction** as `scheduleMeeting` / `createAndSendProposal` (reuse the open deal for that lead, else create). Let the existing routing functions return both the contact stage and the deal stage so the rule stays in one place (domain), not triggers.
Pros: proposals/meetings already carry amount, status and loss reason; deal won/lost becomes per-opportunity, supporting repeat business. Cons: a transition period where `leads.pipeline_stage` and `deals.stage` both exist; lead `won`/`lost` must be derived from deals carefully (lifecycle triggers fire). Keep lead lifecycle as contact state; map deal won → lead won only while the lead has no other open deal.

**c. Company dedupe/backfill.** Staging has 4 leads, so decide thresholds only after a read-only production profile (Appendix). Approach: workspace-scoped; key 1 = normalised name (lower, trim, punctuation and legal suffixes stripped); key 2 = corporate email domain (free-mail list excluded); `"Not provided"`/placeholders → no company. Auto-link only exact key matches; everything else (similar names, conflicting domains) goes to the duplicate-review screen with merge = re-point `company_id`, never delete leads. Run as batched, idempotent worker/script with one connection.
Pros: deterministic, explainable, no false merges. Cons: misses fuzzy variants until reviewed; pg_trgm would help but adds an extension.

**d. Frontend: build a new shell next to the current app and switch per page.** Keep `lib/backend-client.ts`, `store/query.ts` keys, `components/ui`, auth/workspace providers; add new routes under the same router behind a per-page switch, migrate Contacts list first (server-paginated), then detail, Companies, Deals. Pros: no big-bang; old pages keep working for workflows/settings; reuse of auth, workspace and the error display. Cons: two layouts for a while; shared dialogs that read the ≤500 cache (B11) must be ported to fetch by id. Evolving pages in place is cheaper per page but locks in the client-side-filter pattern.

**e. Server-side list standard.** Keyset cursor (the AI Activity pattern) with a whitelisted `sort` (`field:asc|desc`, cursor = sort value + id), `limit` ≤100, `{data, nextCursor}` plus an optional separate `count` endpoint; filters as flat, Zod-validated query params (repeatable for multi-value: `stage=a&stage=b`, ranges `createdFrom/createdTo`), `.strict()` schemas, escaped `ilike` search (fix B30) or pg_trgm. Needs composite indexes `(workspace_id, <sort col>, id)`. Pros: stable under inserts, cheap deep pages. Cons: no "jump to page N"; every sortable column needs an index. Offset is simpler but slow and unstable past a few thousand rows.

**f. Must not break.**
- DNC: exit only via `reactivateFromDnc`; every contact path (calls, meetings, proposals, agent, workflows, ingest) keeps refusing DNC.
- The three `leads` lifecycle triggers and their side effects; trigger 026 (AI stop) and the agent's safety rules (never Won/Lost/DNC, never owner change, contact only `agent_status=active`).
- Routing tables stay in backend `domain/*`; React must not duplicate them (deal stage included).
- Website ingest dedupe and advisory lock; CSV dedupe; WhatsApp reply matching by `phone_e164` to exactly one active lead, encrypted body, owner task.
- `leads.company` still populated (templates, agent prompt and grounding allow-list read it).
- Workflow sends only in the worker; published versions immutable; `lead_created` / `meeting_scheduled` / `proposal_pending` auto-enrolment.
- Hard delete + `deleted_leads_audit`; timeline as the single activity feed.
- Workspace scoping on every query; additive migrations only; the 15-connection budget.

---

## 9. Where the code differs from the audit

Expected drift from 0A–4A (code is current); none blocks this inventory:
- Admins now use the CRM (`requireCrmUser`, 1A); the audit's "admin and salesperson are disjoint" is outdated. RLS `is_active_salesperson()` still excludes admins.
- `leads` gained `revenue_range`, `revenue_min_cr`, `revenue_max_cr` (021) and five `agent_*` columns (024); `task_origin` gained `agent`; trigger `leads_agent_lifecycle_stop` (026) added.
- B5 fixed: DNC can only be left to `active` (020 + `assertNotDnc`).
- B24/B14 fixed: UUID params and header validated; strict query booleans; DB errors mapped to 4xx (0E).
- Owner on manual add/CSV/website is chosen by assignment rules (1B), not "owner = actor"; website revenue range is stored on the lead, not only in the timeline.
- `whatsapp_inbound_events` now stores the encrypted body for matched replies (031); still no lead column.
- AuthGate moved to `app/auth-gate.tsx`; nav adds Knowledge, AI Activity, Admin.
- Still open as described: B2, B4, B8–B11, B30, B31; merge and contactability editing still have no UI.

---

## Appendix — company/deal profile query (read-only, aggregates only)

Used for §4 on staging. Run it in a `begin read only` transaction; it returns counts only, no names, emails or phones.

```sql
with n as (
  select company,
    nullif(btrim(regexp_replace(regexp_replace(
      regexp_replace(lower(btrim(company)), '[[:punct:]]', ' ', 'g'),
      '\m(private limited|pvt ltd|pvt|private|limited|ltd|llp|inc|llc|corp|corporation|co|company)\M', ' ', 'g'),
      '\s+', ' ', 'g')), '') as norm,
    lower(split_part(email, '@', 2)) as dom
  from public.leads),
f as (select unnest(array['gmail.com','yahoo.com','yahoo.co.in','outlook.com','hotmail.com','rediffmail.com',
                          'rediff.com','live.com','icloud.com','protonmail.com','aol.com','ymail.com','msn.com']) as d)
select count(*) as leads,
  count(*) filter (where lower(btrim(company)) in ('not provided','na','n/a','-','none','unknown')) as placeholder_company,
  count(distinct company) as distinct_raw,
  count(distinct lower(btrim(company))) as distinct_lower_trim,
  count(distinct norm) as distinct_normalised,
  count(*) filter (where dom <> '') as with_email,
  count(*) filter (where dom in (select d from f)) as free_mail,
  count(*) filter (where dom <> '' and dom not in (select d from f)) as corporate_domain,
  count(distinct dom) filter (where dom <> '' and dom not in (select d from f)) as distinct_corporate_domains
from n;

-- deals a backfill would create (one per lead with any meeting or proposal)
select (select count(distinct lead_id) from public.meetings)  as leads_with_meetings,
       (select count(distinct lead_id) from public.proposals) as leads_with_proposals,
       (select count(*) from (select lead_id from public.meetings union select lead_id from public.proposals) x) as leads_with_either;
```
