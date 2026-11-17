# Northbeam CRM — history

Completed phases, moved unchanged from CLAUDE.md ("Completed so far").


- **0A:** line endings, the stale worktree, email timeouts, Compose email env.
- **0B:** B1 per-source WhatsApp eligibility, B17 manager retry with backoff, B18 dedicated
  lock connection.
- **0C:** B3 per-workspace meeting templates (migration 019), B5 DNC exit only via
  reactivation (migration 020), re-runnable integration suite.
- **0D:** staging integration runner, B7 internal-action failures, B19 stuck-send reclaim,
  deferrals don't burn attempts, send-time socket loss deferred, readable WhatsApp logs,
  meeting-variable publish/edit validation.
- **0E:** Postgres errors mapped to clear 4xx (`domain/dbErrorMessages.ts`), request ids on
  500s, UUID-validated ids (B24), strict query booleans (B14), template delete 409 (B6),
  provider errors on the email test, shared frontend error display.
- **1A:** admins get the full CRM (`requireCrmUser`) plus admin-only options; `requireAdmin`
  is the admin-only guard (also for future routes inside the CRM router); `/profiles` lists
  active users of both roles with `role` (B29); frontend `useIsAdmin()` and an admin-only
  Admin nav item. RLS `is_active_salesperson()` still excludes admins (backend bypasses RLS).
- **1B:** lead revenue (`revenue_range` + parsed crore, migration 021) and automatic owner
  assignment for NEW leads by admin-managed per-workspace rules (`/assignment-rules`,
  `domain/revenue.ts`, `services/leadAssignment.service.ts`) on manual add (no explicit
  owner), CSV import and website form; fallback owner = `workspaces.default_lead_owner_id`.
- **2A:** knowledge-base foundation, nothing sent to leads: migration 022 (pgvector in
  `extensions`, `kb_documents`, `kb_chunks` with HNSW cosine index, `agent_assets`, private
  buckets `kb-documents` / `agent-assets`), `knowledge/extractText.ts` (PDF/DOCX/PPTX/MD/TXT),
  `knowledge/chunkText.ts` (cl100k_base, ≤800 tokens, ~80 overlap), `providers/openai.provider.ts`
  (injectable `Embedder`), `services/knowledge.service.ts` `searchKnowledge`.
- **2B:** knowledge ingestion in the worker tick (`services/knowledgeIngestion.service.ts`,
  migration 023: `next_attempt_at`, `storage_bucket`), `/knowledge` API (reads + search for
  every CRM user, writes admin-only; `services/knowledgeLibrary.service.ts`), and the
  Knowledge page (documents, assets, test retrieval). Still nothing sent to leads.
- **3A:** AI agent foundation, nothing sent to leads and no AI calls: migration 024
  (`agent_settings` per workspace, seeded + AFTER INSERT trigger on `workspaces`;
  `agent_playbooks`, `agent_wakeups`, `agent_decisions`; `leads.agent_status` /
  `agent_touch_count` / `agent_last_touch_at`; `task_origin` + `agent`) and pure code in
  `src/agent/`: `decisionSchema.ts` (Zod + strict JSON Schema, `parseModelOutput`),
  `rules.ts` (`validateDecision`, `nextAllowedSendTime`, IST = fixed UTC+05:30),
  `composeMessage.ts` (code appends signature + opt-out), `constants.ts`
  (`AGENT_ACTOR_NAME`; timeline events use `actor_source='automation'`).
  3A-fix: a bad phone status (`invalid`/`wrong_number`/`do_not_contact`) also blocks agent
  WhatsApp; knowledge delete was fine (caching: downloads are served from cache briefly), so
  `knowledgeApi` checks Storage existence with `list()` and polls (500 ms, up to 10 s).
- **3B-1:** agent admin backend, nothing sent and no AI calls: migration 025 (one pending
  `agent_wakeups` row per lead via partial unique index; `agent_settings.rep_quiet_hours`,
  `auto_enroll_new_leads`); `agent/settingsSchema.ts` (`live` → 422 until Feature 6),
  `agent/status.ts` (`canTransition`; permanent stop reasons `asked_to_stop`/`not_interested`);
  `services/agentWakeups.service.ts` (`enqueueWakeup(s)` no-op when mode off or lead not
  active, merges into the pending row; `cancelPendingWakeups`), `agentSettings.service.ts`
  (off → shadow wakes active leads over 60 min; linear playbook versions, restore = new
  version), `agentStatus.service.ts` (enroll ≤500, one tx per lead; pause/resume/stop/wake).
  Admin-only `/agent/*` routes; lead DTO has read-only `agentStatus*`/`agentTouchCount`/
  `agentLastTouchAt`. Agent status timeline events: kind `automation`, titles `AI Agent …`.
  Never touches workflows, runs or `automation_mode`.
- **3B-2:** agent reacts to CRM events, still nothing sent and no AI calls: migration 026
  (`leads_agent_lifecycle_stop` BEFORE UPDATE OF `lifecycle_state`: terminal, or LTN without
  `nurture_long_term` → `stopped`/`lifecycle_changed`, wakeups cancelled, timeline; never
  restarts). `agent/wakePolicy.ts` (`wakeFor`); `rules.ts` adds `lastRepActivityAt` +
  `rep_quiet_hours` to the send time (adjustment `rep_quiet`).
  `services/agentEvents.service.ts` `onAgentEvent` (SAVEPOINT, never fails the caller; no-op
  in mode off): meeting booked → paused; outcome/cancel (no other upcoming meeting) resumes
  only `meeting_booked` pauses; inbound WhatsApp → `handed_off`; auto-enroll on lead creation
  (`auto_enroll`); then `enqueueWakeup(wakeFor(...))`. Called once at the end of createLead,
  importLeads (per lead), ingestWebsiteLead, logCall, addNote, scheduleMeeting, updateMeeting,
  recordMeetingOutcome, updateProposalStatus, processInboundUpsert (per matched lead).
- **3B-3:** `onAgentEvent` status effects (meeting pause/resume, reply → `handed_off`) apply in
  EVERY mode; only wakeups and auto-enroll are mode-gated. Frontend: `backend.agent.settings`
  / `.playbooks`, keys `agentSettings` / `agentPlaybooks`, hooks `useAgentSettings`,
  `useUpdateAgentSettings`, `useAgentPlaybooks`, `useSavePlaybook`, `useRestorePlaybook`;
  `Lead` has the agent fields. Settings → admin-only `AgentPanel`
  (`features/settings/agent-panel.tsx`): mode (Off → Shadow confirms), limits form, playbook
  editor with history/restore. `ConfirmDialog` takes `confirmVariant`. Sidebar Add Lead spacing.
- **3C-1:** one decision's inputs, no loop, nothing saved or sent:
  `services/agentContext.service.ts` `buildAgentContext` (lead, rules inputs, timeline,
  past agent messages, decision summaries, playbook, KB top 8 via pure `agent/kbQuery.ts`,
  active assets; ≤12,000 tokens by trimming oldest timeline then summaries, `ctx.meta`);
  `agent/prompt.ts` (`buildDecisionMessages`, `buildGroundingMessages`, data in delimited
  blocks with tags neutralised, `GROUNDING_JSON_SCHEMA`); `providers/openai.provider.ts`
  `DecisionModel` / `createOpenAIDecisionModel` (strict JSON schema, 30 s, 2 retries;
  `ModelOutputError` = failed attempt) and `resolveAgentModels` (no hard-coded models);
  `agent/pricing.ts` `costUsd` (unknown model → null). Fake: `tests/helpers/fakeDecisionModel.ts`.
  Dev: `npm run agent:preview -- --lead <uuid> [--call]` (refuses the prod ref).
  New env (backend + worker only): `OPENAI_DECISION_MODEL`, `OPENAI_GROUNDING_MODEL`,
  `OPENAI_PRICES_JSON` (`{"<model>":{"inputPer1M":n,"outputPer1M":n}}`).
- **3C-2:** the SHADOW decision loop (drafts only; never sends, creates tasks, changes stage/
  status from a decision or touches workflows). `services/agentRunner.service.ts`
  `runAgentTick` in the worker tick behind `AGENT_RUNNER_ENABLED=true` (worker env, default
  off): cancel pending wakeups of non-active leads; claim ≤5 due wakeups in shadow workspaces
  (SKIP LOCKED, reclaim `executing` > 15 min, `claimed_at` ms-precision = claim token);
  `precheck` (rules.ts) → models + prices + playbook (else defer, no attempt burned) → IST-month
  budget (else defer 1 h, admins notified once via `budget_alerted_month`, migration 027) →
  context → `draftDecision` (decide, rules, grounding for allowed sends, regenerate once,
  then handoff "AI couldn't write a safe message") → one `agent_decisions` draft row, timer
  wakeup for send/wait, timeline "AI drafted…/suggested…" ("Shadow mode — not sent"). No DB
  client held during model calls. Deferrals restore the attempt; other errors burn it (3 →
  `failed` row); permanent provider errors fail at once. Shadow drafts the rules allowed count
  as touches (`agentContext.service.ts`). Prompt: first name, latest call/note, stated timing,
  internal-KB guard; grounding checks factual claims only. `agent:preview --call` uses the
  same pipeline and saves nothing.
- **3C-3:** migration 028 `agent_settings.company_display_name` (null = workspace name; API
  `companyDisplayName`, Settings "Company name used in AI messages"); `ctx.companyName` is the
  display name (persona, signature, grounding), `ctx.workspaceName` the raw name. Grounding
  (`buildGroundingMessages(decision, ctx)`) has three approved sources (knowledge, playbook,
  lead_data incl. call/note text) and checks only specific, checkable claims; never the
  sender's/lead's own company names or vague intent. The runner claims at most one wakeup per
  lead (earliest; none while one is executing). `loadWorkerEnv(source)` is exported.
- **3D-1:** AI review backend, nothing sent: migration 029 (`agent_decisions.rating_reason`, required iff
  rating `bad`; `agent_decision_reports`). Pure `agent/readiness.ts` `goLiveReadiness` (≥50 rated excl.
  failed, ≥90% good, zero `made_up_fact`/`internal_info_leak`). `services/agentReview.service.ts`:
  decision log (keyset cursor on `created_at` text + id), detail with `composed` (via `composeOutgoing`)
  and KB chunk previews ("deleted" when gone), ratings (admin or the lead's owner; failed → 422),
  problem reports (warning notification to every active admin; resolve admin-only), stats with spend
  and readiness, lead AI panel. Routes in `agent.routes.ts` registered BEFORE `agentRouter.use(requireAdmin)`
  (CRM users): `GET /agent/decisions[/:decisionId]`, `PUT …/:decisionId/rating`, `POST …/:decisionId/reports`,
  `POST /agent/reports/:reportId/resolve` (inline `requireAdmin`), `GET /agent/stats`, `GET /agent/leads/:id`.
  `IST_MONTH` is exported from `agentRunner.service.ts`.
- **3D-2:** AI review screens, nothing sent. `GET /agent/stats` also returns `mode` (settings are
  admin-only; every user needs the Shadow banner). Frontend: `backend.agent.decisions/stats/leads/
  resolveReport`; keys `agentDecisions` (prefix without filters), `agentDecision`, `agentStats`,
  `agentLeadPanel` (prefix without lead id); hooks `useAgentDecisions` (infinite, cursor),
  `useAgentDecision`, `useRateDecision`, `useReportDecision`, `useResolveReport`, `useAgentStats`,
  `useLeadAgentPanel`, `useEnrollLeads` (chunks of 100), `usePauseLead`, `useResumeLead`,
  `useStopLead`, `useWakeLead`. `features/agent/`: `ai-activity-page.tsx` (nav "AI Activity", route
  `/ai-activity`, all CRM users), `decision-drawer.tsx` (also `RatingControls`, `ReportsSection`),
  `lead-ai-panel.tsx` (lead page "AI" tab), `enroll-in-ai-dialog.tsx`, `agent-labels.ts` (display
  labels only). Leads list: AI column + filter; admins get row checkboxes → "Enroll in AI".
  `StatusBadge` takes `display` to show text as given (no `label()` title-casing).
- **3D-3 (cost safety):** migration 030 `agent_settings.max_decisions_per_day` (default 50, 1–10000;
  API `maxDecisionsPerDay`, "Max AI decisions per day") + `daily_cap_alerted_on`: at the cap (today's
  IST `agent_decisions`) the runner defers to the next IST midnight + 5 min, no attempt burned, admins
  notified once per day. `GET/PUT /agent/settings` return read-only `activeLeadCount`, shown in the
  Off → Shadow confirm.
- **4A:** WhatsApp reply logging + AI handoff + B37, backend only (no UI, no AI classification, no email
  replies). Migration 031: `whatsapp_inbound_events.body_ciphertext/iv/tag/key_version` (all-or-none) +
  `body_truncated`. Pure `domain/whatsappInboundText.ts` `extractInboundText` (text, extended text,
  image/video/document captions, button/list replies; wrappers unwrapped; ≤4,000 code points). In
  `processInboundUpsert`, `matched` events only: text encrypted with `encryptText` (AAD
  `whatsapp:inbound:<message_id>`); a lead whose `agent_status` was active/paused before the reply gets ONE
  open task (`origin='agent'`, `follow_up`, "Lead replied on WhatsApp — respond today", due 23:59 IST today,
  owner only) in every mode; `onAgentEvent`'s handoff cancels the wakeups. `createTask` accepts
  `origin: 'agent'` (created_by/timeline actor "AI Agent"). B37: `recordActionResult` on a `cancelled`
  action no longer throws; success → timeline "A message was already being sent when the reply arrived"
  (provider id in detail/metadata; no column for it), failure/deferred → no-op; the run is never touched.
- **B3a (CRM v2 foundation + Companies, backend only, no routes/UI):** migration 032 (`pg_trgm` in `extensions`;
  `companies`, `deal_stage` + `deals` (no logic until B3b), `company_duplicate_candidates`, `saved_views`;
  `leads.company_id` / `company_link_checked_at` / `company_link_attempts`; `meetings/proposals.deal_id`,
  `timeline_events.related_deal_id`, `workspaces.crm_deals_backfilled_at`). Pure `domain/companyNormalize.ts`
  (`normalizeCompanyName`: lower, & → and, punctuation out, trailing legal suffixes out; no SQL copy;
  `isPlaceholderCompany`, `corporateDomain`, `FREE_MAIL_DOMAINS`) and `domain/companyMatch.ts` (design §2.1 steps
  1–5). `services/companies.service.ts`: `linkCompanyForLead` (INSERT … ON CONFLICT DO NOTHING + re-lookup for
  concurrent creates; `similar_name` pairs at trigram similarity ≥ 0.6, up to 3), `linkCompanySafely` (SAVEPOINT;
  failure → attempts + 1, checked_at null), hooked into createLead, importLeads (per row), ingestWebsiteLead (new
  lead) and updateLead (company or email changed); `mergeCompanies` (no route yet); `runCompanySweep` (worker
  tick, 200/tick, one connection, SKIP LOCKED; `npm run crm:sweep -- --once`, staging only). Duplicate candidates
  are a company PAIR (a < b) or ONE company + the contact that disagrees (`company_b_id` null, `lead_id`,
  `observed_name/domain`; e.g. "TML" linked to "Tata Motors" by domain). Lead DTO: read-only `companyId`.
- **B3b (CRM v2 deals, backend only, no list routes/UI, no migration):** pure `domain/dealRouting.ts`
  (`dealStageForMeetingOutcome` / `dealStageForProposalStatus`, null = no change; `canMoveDealStage`: events
  forward only except second_meeting → meeting_scheduled and revision_requested → proposal_preparation,
  closed deals reopen only manually; `dealStageFromLeadStage`; `pickDealToAttach`; `defaultDealName`;
  `backfillDealStage`; `DEAL_CLOSED_LOSS_REASON = 'other'`). `services/deals.service.ts`: `createDeal`,
  `moveDealStage`, hooks in a SAVEPOINT `deal_hook` (a deal error never blocks the meeting/proposal/contact;
  a bad requested `dealId` is rethrown → 400): `scheduleMeeting` / `createProposal` attach to the requested
  or newest open deal (moved forward only; proposal amount fills an empty deal amount) else create at
  meeting_scheduled / proposal_preparation; meeting outcome / proposal status move `meetings/proposals.deal_id`
  BEFORE today's contact routing; contact lost/discarded/DNC (incl. call outcome)/merged → open deals lost
  (`other`, "Contact <state>"); `markWon(..., fromWonButton=true)` (only the `/won` route) wins exactly one
  open deal. Optional `dealId` on POST /meetings and POST /proposals. `runDealSweep` (worker, 100 contacts/
  tick, one connection, SKIP LOCKED, failures skipped for the process lifetime; sets
  `workspaces.crm_deals_backfilled_at` when a workspace has nothing left); `npm run crm:deal-sweep -- --once`
  (staging only). Timeline deal rows: kind `system`, `related_deal_id`.
- **B4 (CRM v2 list API, backend only, no UI):** migration 033 (list indexes: leads `(workspace_id, created_at|
  last_activity_at|updated_at|last_name,first_name|company, id)`, trigram GIN on leads first/last name, company, email,
  phone; deals `(workspace_id, updated_at|name, id)`). `lists/listQuery.ts` (the list standard, below). Routers (CRM
  users): `/contacts` (list, `/count`, `/:id` = Lead DTO + company + deals with the text in `companyText`, `/bulk`
  assignOwner via `updateLead` / enrollAi admin via `enrollLeads`), `/companies` (list, count, detail, POST/PATCH via
  `services/companyRecords.service.ts`, rename syncs `leads.company`, `/:id/contacts`, `/:id/deals`, `/:id/merge` admin),
  `/company-duplicates` (admin; list, merge, dismiss, relink; `companyDuplicates.service.ts`), `/deals` (list, count,
  `/board`, detail, POST → `createDeal`, PATCH (INR only, no stage), `/:id/stage` → `moveDealStage` manual;
  `dealRecords.service.ts`), `/search`, `/saved-views` (filters/sort validated by the list schemas; max 30 per user per
  object). `mergeCompanies` re-points the source's other open suggestions (dismissed when the row exists in any status);
  similar names use the trigram `%` operator. Old `/leads?search=` is escaped (B30). Contract: `docs/crm-v2/B4-api.md`.
  Perf check: `RUN_PERF_TESTS=true` (`tests/integration/listPerformance.test.ts`).
- **C1 (CRM v2 design system + app shell, frontend only):** pinned `@tanstack/react-table` 8, `@tanstack/react-virtual`,
  `react-hook-form` + `@hookform/resolvers`, `zod` 3, `@dnd-kit/core`/`sortable`, Radix dropdown-menu/tooltip; shadcn
  `sheet`, `dropdown-menu`, `tooltip`, `skeleton`. `styles.css`: real `.dark`, `*-soft` tokens, `surface-raised`,
  `focus-ring`, density vars (`data-density="compact"`), `type-*` scale; `styles-contrast.test.ts` (≥ 4.5:1 both themes).
  `ThemeProvider` (light/dark/system + density, localStorage, pre-paint script in `index.html`). New shell
  (`app/app-shell.tsx`, `sidebar.tsx`, `top-bar.tsx`, `nav.ts`, `command-palette.tsx`): grouped collapsible sidebar,
  mobile Sheet, breadcrumbs, + Create, user menu, ⌘K palette over `GET /search` (`useGlobalSearch`); the old header
  search over cached leads is gone. `/companies`, `/deals` placeholders; `/dev/ui` kit (DEV only).
  `components/crm/*` + `useListUrlState`. Docs: `docs/crm-v2/C1-ui.md`.
- **C2 (Contacts list + record):** contacts UI lives at `/contacts` (`features/contacts/`); `/leads` and `/leads/$id`
  redirect there (old `leads-page.tsx` / `lead-detail-page.tsx` stay unrouted until C6). Migration 034: trigram GIN on
  `(first_name || ' ' || last_name)`; `/contacts?q=`, `/search`, `/leads?search=` share `leadSearchSql` (full name
  "first last" too; not reverse order). `ContactListItem` + saved-view columns gain `source`; meeting/proposal DTOs
  `dealId`; timeline DTO `relatedDealId`. Frontend: `useContacts`/`useContactsCount`/`useContact`/`useBulkContacts`
  (100 per request)/`useSavedViews`+CRUD/`useCreateDeal`/`useCompanySearch`/`useCompanyOptions`/`useCreateContact`;
  `useLeads` = `useLeadList` (≤500, pickers only) + `useLeadMutations`. One invalidation helper `refreshContact(client,
  ws, id?)` (no id = every contact) replaces `refreshLead`, also after workflow enroll/run actions (**B31 fixed**).
  Record page fetches by id; LogCall/ScheduleMeeting/SendProposal dialogs no longer read the leads list (**B11 fixed**).
  `CreateContactDialog` (react-hook-form + `leadFormSchema`, which delegates to `validateLeadForm`) is the app-wide
  "Create contact". Task origin `agent` → `TaskOriginBadge` "AI Agent". `/deals/$dealId` is a placeholder until C4.
- **C3 (Companies list + record + duplicate review, paginated timelines, code splitting):** migration 035
  (`timeline_events (lead_id, occurred_at, id)`). Backend: `GET /contacts/:id/timeline` and `GET /companies/:id/timeline`
  (list standard, newest first on `occurred_at, id`, no sort, `kind[]` = Activity groups; company feed = non-merged
  contacts' events + its deals' events, each with `contact {id,name}`; `timeline.service.ts`), `GET /companies/industries`,
  `GET /company-duplicates/count` + `companyId` filter, duplicate companies gain `industry`/`openDealCount`, company
  detail `lastActivityAt`. Old `/leads/:id/timeline` unchanged. Frontend (`features/companies/`): `/companies` index
  (views, Owner/Industry/Domain/Created filters, saved views `companies`), `CreateCompanyDialog` (409 → link to the
  existing one; + Create → Company, palette), `/companies/$companyId` record (About inline edit, rename confirm, Overview/
  Activity/Contacts/Deals tabs, merge dialog for admins, merged → "Merged into X"), `/companies/duplicates` (admins;
  pair merge/dismiss, contact keep/move/create, optimistic removal), sidebar duplicate badge for admins. `CompanyPicker`
  replaces the Contacts Company filter and the contact's Change company. Shared `features/crm/activity-feed.tsx`
  (contact + company Activity tabs; `contact-activity.tsx` removed). `refreshCompany(client, ws)`; `refreshContact` also
  refreshes company views. `AddLeadContext.open({ company? })`, `CreateCompanyContext`. Route code splitting
  (`autoCodeSplitting`, `RoutePending`): entry 553 → 101 kB gzip, initial load 340 kB.
- **C4 (Deals list + board + record + create/close dialogs, no migration):** backend `GET /deals/:id/timeline` (list
  standard; rows with `related_deal_id` + the events of meetings/proposals linked by `deal_id`; "Meeting Scheduled" /
  "Proposal Created" rows now carry their ids), `/deals/board` as ONE window query (same contract), `POST /deals/:id/stage`
  `contactAction` (`keep` | `long_term_nurture` | `lost`, lost only, else 400; via `moveToLongTermNurture` / `markLost` in the
  same transaction), activity kind `proposals` (own group; contact, company, deal feeds). Frontend (`features/deals/`):
  `/deals` table (views All open / My / Closing this month (IST) / Won / Lost + saved `deals`, filters, `layout=board` and
  `showClosed` in the URL), pipeline board (`@dnd-kit` pointer + keyboard ←/→, optimistic move + rollback, Won/Lost →
  Close dialog, below md one stage + "Move to…"), `CreateDealDialog` app-wide (`useCreateDealDialog().open({ contact?,
  companyId?, stay? })`, + Create → Deal, palette), `CloseDealDialog` (won: PATCH changed amount/close date then won;
  lost: reason + contactAction; reopen), `/deals/$dealId` record (stage bar, About inline edit, Overview / Activity /
  Meetings & proposals, contact/company/other deals). `ContactPicker` (`features/contacts/contact-picker.tsx`) replaces
  every contact `<Select>`; ScheduleMeeting / SendProposal dialogs take `dealId`. Data: `useDeals`, `useDealsCount`,
  `useDealBoard`, `useDeal`, `useDealTimeline`, `useUpdateDeal`, `useMoveDealStage`, `useContactSearch`; every deal key
  under `keys.deals(ws)`; `refreshDeal(client, ws)` after every deal write. `ComingSoonPage` removed. Board timing (HTTP,
  1,500 deals) 103–162 → 39–43 ms; initial load 345 kB gzip.
- **C5 (search, saved views UX, shortcuts, speed; no migration):** `POST /deals` takes `ownerId` (active user or null;
  omitted = contact's owner; else 400); Create deal sends it (no follow-up PATCH). Prefetch on intent: `usePrefetchRecord`
  (`features/crm/prefetch.ts`: route chunk + record query, never on touch), `RecordLink`, DataTable `onRowIntent`.
  Palette: Recent (last 8 opened, `lib/recent-records.ts`, localStorage per workspace) + quick actions; "See all results"
  → lazy `/search?q=&tab=` (tabs over the list endpoints + `/count`). Saved views: one shared implementation
  (`features/crm/saved-views.ts`, `use-list-views.ts`, `saved-view-tabs.tsx`, `save-view-dialog.tsx`,
  `manage-views-dialog.tsx`; each `*-search.ts` exports a `ListViewSpec`): Edited marker, Save / Save as new / Reset,
  Manage views (rename, dnd-kit reorder → `position`, share, delete). Shortcut registry `app/shortcuts.ts` (`?`, `/`, `n`,
  `g`+c/o/d/t, ⌘K) + help dialog; user menu is non-modal. Palette + create dialogs are `React.lazy`: first load 345 →
  286 kB; `npm run check` ends with `npm run size` (fails above 350 kB). `COMPANY_COLUMNS` lives in
  `features/companies/company-columns.tsx`.
- **C6a (Tasks, Meetings, Proposals in the new shell):** migration 036 (`(workspace_id, field, id)` indexes on tasks
  `due_at|created_at|updated_at`, meetings `scheduled_at|created_at`, proposals `updated_at|sent_at|amount`; saved views
  objects `tasks|meetings|proposals`). Backend `services/workLists.service.ts`: `GET /tasks/list|count`,
  `/meetings/list|count`, `/proposals/list|count|summary` (list standard; IST `due`/`when` buckets in SQL; owner names
  joined from `profiles`; task rows `isOverdue` and the contact's open deal; proposal `group` + `allowedNextStatuses`).
  `domain/proposalRouting.ts` `allowedNextProposalStatuses` / `LOSS_REASON_PROPOSAL_STATUSES` / `PROPOSAL_STATUS_GROUPS` —
  `updateProposalStatus` enforces the same table. Old `GET /tasks|/meetings|/proposals` unchanged (unrouted lead page, C6b).
  Frontend: `/tasks`, `/meetings`, `/proposals` pages (default view written to the URL on a bare landing,
  `ListViewSpec.defaultView`), row Sheets, bulk tasks, sidebar overdue badge, + Create → Task / Meeting, palette
  actions, `g m` / `g p`; shared `features/work/` (`CreateTaskDialog`, `ScheduleMeetingFlow`, `LogCallFlow`,
  `ProposalStatusDialog`, `RecordWorkCards`), `store/work-hooks.ts`, `refreshWork`. Record pages use the work lists with
  View all links. **B4, B12, B13 fixed; B25/B26 fixed for display** (lists read names from `profiles`; the `owner_name`
  columns are still not written). B19 display: proposal polling stops after 2 min per row. Docs: `C1-ui.md` §9,
  `B4-api.md` §7a.
- **C6b (Workflows, AI Activity, Knowledge, Settings, Home; old pages removed):** migration 037 (`workflow_runs
  (workspace_id, started_at, id)`, `scheduled_actions (workspace_id, scheduled_for, id)`). Backend
  `services/automationLists.service.ts`: `GET /runs/list|count`, `/scheduled-actions/list|count` (list standard; rows with
  `contact`, `workflow`, `currentStepAction` / `stepOrder`); `listWorkflows` in 4 queries (same body; 681 → 33 ms on staging);
  `services/home.service.ts` `GET /home/summary` (the caller's day from the list services, IST in SQL, B38 statuses, the
  board query for the pipeline, AI drafts when the agent is not off); B38 fixed in the deprecated `/dashboard/summary`;
  proposal rows `lossReasonStatuses` (`lossReasonStatusesFrom`); `GET /proposals/:id/document` (5-min signed URL, workspace
  check, 404 without a file). Old `GET /leads|/tasks|/meetings|/proposals|/runs|/scheduled-actions|/dashboard/summary` kept,
  deprecated (`B4-api.md` §9). Frontend: `store/automation-hooks.ts` (`useRunList`, `useRunCount`, `useScheduledActionList`,
  `useScheduledActionCount`, `useRunAction`, `useWorkflowList`, `useHomeSummary`); Settings/Admin/auth keys in `query.ts`
  (A17). `/automations` DataTable, `/automations/runs` (Runs · Scheduled steps, filters in the URL, run Sheet with the old
  actions + step history), builder/templates in the new layout, `/ai-activity` (URL filters, decision Sheet), `/knowledge`
  tables, `/settings?tab=` (Workspace, Lead assignment, AI agent, Users, Appearance; `/admin` → Users, `/admin?calendar=` →
  Workspace with the query), Home at `/`. `useAutomations` = workflows + templates only; the contact Automation section reads
  the lists by `contactId`. C6a fixes: ProposalStatusDialog uses the row's flags, no Deal column on tasks ("Tasks of this
  deal's contact" chip), View document. Removed: old dashboard, lead pages/dialogs, `useLeads`/`useTasks`/`useMeetings`/
  `useProposals`/`useTimeline`/`useDashboard` and the unpaginated client calls (`src/test/removed-code.test.ts` guards it);
  sidebar Admin item gone; shortcuts `g w|a|k|s`. Docs: `C1-ui.md` §10, `B4-api.md` §7b–7d, §9.

**Phase C complete** (C1–C6b): every page is in the new shell and no page fetches a whole table (only small reference lists,
`C1-ui.md` §10).

- **D1 (agent understands the contact's company + open deal; shadow only, nothing sent):** `buildAgentContext` reads, in
  the same lead query, the linked company (merge followed once; a merged target → no company) and the contact's deals
  (never amount, loss reason/notes or owner). Pure `agent/companyFacts.ts` (`resolveCompany`, `companyFacts`: company
  first, contact fallback for industry/revenue; `companyDescription` ≤500 chars) and `agent/dealContext.ts`
  (`buildDealContext`: open deal = most recently updated (updated_at desc, id desc), stage label, days in stage from the
  last `moveDealStage` timeline row (`metadata.to`) else `created_at`, close month, latest linked meeting/proposal status;
  won/lost counts). `DEAL_STAGE_LABELS` moved to `domain/dealRouting.ts`. `ctx.company` (lead data) + `ctx.internal`
  (decide only), never trimmed. Prompt: "Company record" lines inside `lead_data`; `<internal_context>` block (tag
  neutralised) + one system rule, only when there is a description or a deal, so a contact without either gets
  byte-identical prompts (snapshot `tests/unit/__snapshots__/agentPrompt.test.ts.snap`). Grounding: company facts in
  lead_data, internal block never; the company record's name is an ignored claim. Migration 038:
  `agent_decisions.context_company_id` / `context_deal_id` / `context_deal_stage` (nullable; failed rows too); decision
  detail + lead panel rows return `context` (`B4-api.md` §7e). Frontend: `ContextUsed` ("Context used: company · deal +
  stage pill", or "No company · no open deal") in the decision Sheet and the lead AI panel rows. `agent:preview` prints the
  Company and Internal context blocks and the prompt token count. No change to rules, wake policy, ceilings or actions.
- **D2 (read a contact's WhatsApp reply; owner + admins, audited):** migration 039 `inbound_message_views` (workspace,
  lead, message, viewer, outcome `shown|denied|no_text|decrypt_failed`, viewed_at; RLS on, no policies; no UI yet).
  `services/inboundReplies.service.ts` (the only decrypt of `whatsapp_inbound_events.body_*`; `canReadReplies`):
  `GET /contacts/:id/replies/:messageId` → `{ messageId, receivedAt, text, truncated }` or `text: null` + `reason`
  `not_stored`/`unreadable`; 403 for others (audited `denied`), 404 unless a matched reply of this contact (linked by its
  timeline row's `metadata.messageId`; no lead column on the event), `Cache-Control: no-store`. Contact timeline rows of
  matched replies get `reply: { messageId, hasText, canRead }` (`B4-api.md` §7f). No HTTP logger exists, so there is no
  redaction list to extend; the route logs only the message id on a decrypt failure. Frontend: Activity "Show message" /
  "Hide" (`useInboundReply`: staleTime 0, gcTime 60 s, no retry/focus refetch, removed on hide/unmount/workspace change),
  "Read reply" (`ReadReplyLink`) in the reply task's Sheet and the AI panel when `statusReason = lead_replied`; contact
  route search `tab` / `activity` / `reply=latest` (`validateContactRecordSearch`); `RecordLayout` takes optional
  `tab`/`onTabChange`. Matching, encryption, the reply task, handoff and notifications unchanged; the agent never gets the text.
- **D4a (understand WhatsApp replies; nothing sent):** migration 040 on `whatsapp_inbound_events`: `lead_id`, `reply_label`
  (`asked_to_stop|not_interested|annoyed|positive|question|other|unclassified`), `reply_label_source` (`keyword|ai|rep`),
  `reply_label_confidence`, `classification_status` (`pending|done|failed|skipped`), `classification_attempts` (claim token),
  `classification_next_at`, `classified_at`, `label_corrected_by/_at`, `classification_model/_input_tokens/_output_tokens/
  _cost_usd`; partial index on pending. Pure `domain/replyKeywords.ts` (`matchReplyKeyword`: the WHOLE reply, lower-cased,
  punctuation/emoji dropped, must be an exact short phrase) and `agent/replyClassification.ts` (strict JSON schema
  `label` + `confidence`, `finalLabel`: < 0.6 → `other` except stop/not-interested, `replyEffects`, `replyTaskTitle`,
  `REPLY_TASK_TITLES`, delimited `<reply>` block). `processInboundUpsert` (matched only, same transaction): keyword → label at
  once in every mode; else `pending` when the contact was active/paused in the AI before the reply and the mode is not off;
  else `unclassified` (`skipped`). `services/replyLabels.service.ts` `applyReplyLabel`: `asked_to_stop` → WhatsApp
  `opted_out` (+ timeline, owner notification "<Name> asked us to stop messaging on WhatsApp"), AI → `stopped`
  `asked_to_stop`; `not_interested`/`annoyed` → AI `stopped` `not_interested`; re-titles the one open reply task (not for
  other/unclassified); never DNC. The reply upsert no longer overwrites `opted_out` with `reachable`; the reply-task lookup
  matches every reply title; proposal/meeting WhatsApp eligibility (`loadSourceEligibility`) refuses an opted-out contact
  (workflows and agent rules already did). `services/replyClassifier.service.ts` `runReplyClassification` (worker, behind
  `AGENT_RUNNER_ENABLED`): ≤ 10 pending (15-min claim), mode/budget re-check (else `unclassified`), grounding model +
  price (else defer), `decryptInboundBody` (`inboundReplies.service.ts`), `DecisionModel`'s sibling `ReplyClassifierModel`
  `classifyReply` with no client held; 3 attempts then `unclassified` (`failed`). `MONTH_SPEND_SQL` (agentRunner) = decisions +
  classification cost: the monthly budget and `/agent/stats` spend; never the daily decision cap. API: timeline `reply` +
  `label`, `labelSource`, `labelBy`, `classifying`, `canCorrect`; `PUT /contacts/:id/replies/:messageId/label` (owner/admin,
  `correctReplyLabel`: source rep, re-titles, never undoes an opt-out or a permanent stop); `/agent/stats` `replies {byLabel,
  costUsd}` (`B4-api.md` §7g). Frontend: Activity reply pill + "by AI / keyword / <rep>" + Change menu
  (`useCorrectReplyLabel`), "Classifying…", WhatsApp status "Opted Out — Asked to stop on WhatsApp", AI Activity "WhatsApp
  replies this month"; `REPLY_LABEL_TEXT` / `REPLY_TASK_TITLES` in `features/agent/agent-labels.ts`. Clearing an opt-out today:
  `POST /leads/:id/contactability {channel:"whatsapp", status:"valid"}` (any CRM user, no UI; admin-only since E1). D1 prompt
  fix: the DATA sentence names `internal_context`.
- **E1 (WhatsApp safety, Feature 5; nothing new sent):** migration 041: `whatsapp_connection.paired_at` (null = paired before
  E1, fully warmed; set on `isNewLogin`, cleared on logout/auth clear), `max_new_chats_per_day` (20), `send_window_days/_start/
  _end` (Mon–Sat 09:30–19:00 IST), `next_send_at` (spacing), `paused_reason/_at/_by`, `resumed_at`; spacing defaults 45/120
  (rows still on 5/15 moved); `whatsapp_outbound_messages.new_chat`; `whatsapp_safety_events` (`send_failed|reconnect_failed|
  disconnected|restricted|paused|resumed`); indexes for "never messaged" and the 24 h / IST-day counts. Pure
  `domain/whatsappSafety.ts` (`decideSend`, `warmupCap`, `warmupDayFor`, `hasLink`, `ensureOptOutLine`, `typingMsFor`,
  `nextWindowTime` (reuses `agent/rules.ts` `nextAllowedSendTime`), `shouldAutoPause`). `services/whatsappSafety.service.ts`
  (`loadSendStats` one query, `autoPause` flips `enabled` once + notifies admins, `notifyAdmins`, `resumeSending`,
  `loadSafetyMonitoring`, `updateSafetySettings`). `performSend`: the claim tx returns its outcome and throws after commit
  (so the auto-pause and the not-registered mark persist — the latter used to roll back); spacing > 20 s defers to
  `next_send_at` instead of sleeping (keeps the worker tick and the 15-min reclaim safe); no tx across `sendMessage`;
  `BaileysManager(workspaceId, wait)` (tests inject a no-op wait). Baileys hygiene (B1–B7 below): composing refresh,
  `onWhatsApp` JID, `disconnectAction` per reason (`domain/baileys-policy.ts`, backoff 5 s → 10 min), reconnect-storm pause,
  per-workspace `retryCounterCache` outside the socket, `makeCacheableSignalKeyStore`, `getMessage` by message id only,
  `Browsers.macOS("Chrome")` for new pairings (numbers paired before E1 keep `["Northbeam CRM","Chrome","1.0.0"]`). API
  (`B4-api.md` §7h): GET adds the monitoring numbers; PUT settings + `POST /connections/whatsapp/resume` admin-only;
  clearing a WhatsApp opt-out admin-only with a reason (timeline "WhatsApp opt-out cleared by <admin>: <reason>").
  Frontend: `features/settings/whatsapp-safety.tsx` (Safety section: admin form RHF + Zod, read-only for others, red paused
  banner + Resume confirm, stats, last 20 events, 14-day table), `features/contacts/clear-opt-out-dialog.tsx` ("Clear
  opt-out" on the contact's WhatsApp status line, admins), `useLeadMutations().clearWhatsAppOptOut`. Non-admins can no
  longer flip the outbound switch or the daily cap.
- **E1b (email through SMTP only; Resend removed; nothing new sent to leads):** migration 042: `integration_connections` (the
  'email' row) gains `configured_at` (warm-up start, set on the first E1b SMTP save; null = no warm-up), `already_warmed`,
  `daily_cap` 100, `hourly_cap` 20, `min/max_delay_seconds` 30/90, `send_window_days/_start/_end` (Mon–Sat 09:30–19:00 IST),
  `next_send_at`, `paused_reason/_at/_by`, `resumed_at`; IMAP non-secret fields in `settings`, IMAP login in the same
  encrypted blob; `email_outbound_messages` (unique `(source, source_id)`, source `scheduled_action|proposal|meeting|test|
  agent`, rendered subject/html/text, attachments as Storage refs, status `queued|sending|sent|failed|cancelled`, attempts,
  `next_attempt_at` = due time or reclaim time, `message_id`, `smtp_response`, `dry_run`); `email_safety_events`. Pure
  `domain/emailSafety.ts` (`decideEmailSend`, `classifySmtpError`, `shouldAutoPauseEmail`, `buildFromName`, `htmlToText`,
  `messageIdFor`, `connectionTestMessage`) and `domain/emailDeliverability.ts` (grade MX/SPF/DKIM/DMARC).
  `providers/email.provider.ts`: SMTP only, `TransportCache` (one pooled nodemailer transport per workspace, rebuilt when
  host/port/security/secret change; connect/greeting 15 s, socket 60 s, TLS ≥ 1.2 checked), `verifySmtp`, `verifyImap`
  (`imapflow` 1.7.8, EXAMINE only). `services/emailConnection.service.ts` (settings, `mailboxOf`, stats, `autoPauseEmail`,
  resume, login tests), `services/emailOutbound.service.ts` (`enqueueEmail` idempotent, `queueEmailForAction`,
  `claimDueEmails` one row per workspace SKIP LOCKED, `processEmail`, `runEmailOutbound` in the worker tick, test email),
  `services/emailDeliverability.service.ts` (DNS, 5 s, cached 10 min). `POST /proposals` and `POST /meetings` only queue
  (`email_send_status` / `notify_email_status` `pending` = Queued, the reason in `*_error` while waiting) — **B22, B23
  fixed**. A workflow `send_email` step queues its email and defers (no attempt) until the email is sent (success) or failed
  (permanent failure); a step no longer pending/due/executing cancels its email, re-running re-queues it. `tryAdvanceToSent`
  moved to `proposals.service.ts`. Removed: Resend, the `RESEND_API_KEY` / `SMTP_FROM_*` env fallback (compose, .env
  examples, agent `fallbackSenderAddress`; agent sender = saved SMTP from address), old `GET|PUT /connections/email` and
  `POST /connections/email/test`. API `B4-api.md` §7i. Frontend: `features/settings/email-settings.tsx` (`EmailPanel`: SMTP
  + IMAP + Safety form RHF + Zod for admins, read-only for others, "Email is not set up" notice, login tests, "Send test email
  to me" with polled status, paused banner + Resume confirm, stats, events, 14-day table, Deliverability card);
  `EmailStatusPill` ("Email: Queued/Sent/Failed", reason as tooltip or with `showReason`) on proposal/meeting lists, sheets
  and contact/deal record pages; proposal lists poll while an email is queued.
- **D3 (email replies, bounces and unsubscribes over IMAP; nothing new sent):** migration 043: `email_inbound_events` (one row
  per message read; unique (workspace, Message-ID header), else (workspace, uidvalidity, uid); `kind`
  `reply|bounce|bounce_temporary|auto_reply|unsubscribe|ignored`, `match_status` `matched|unmatched|ambiguous`, `match_method`
  `in_reply_to|references|sender|original_message|recipient`, `lead_id`, `outbound_id`, `bounce_status/_detail`, encrypted
  `body_*` (JSON `{subject, text}`) + `text_truncated`, the D4a label/classification/cost columns), `email_imap_state` (per
  workspace `uidvalidity`, `last_uid`, `imap_saved_at`, `last_poll_at`, `last_success_at`, `last_error`, `next_poll_at`,
  `login_alerted_on`), `email_outbound_messages.bounced_at/bounce_status` + `(workspace_id, message_id)` index,
  `inbound_message_views.channel` (default whatsapp) + `email_event_id` (`message_id` now nullable, check: exactly one).
  `mailparser` 3.9.3 (pinned; linkify / html-to-text never run on inbound mail). Pure `domain/emailInbound.ts`
  (`parseInboundEmail`, `classifyInboundEmail` (rule order bounce → auto-reply → unsubscribe → own/no-reply ignored →
  reply), `parseDsn`, `candidateMessageIds`, `extractReplyText` (quote stripping, HTML → text, 4,000 code points),
  `isOwnOrNoReply`); fixtures `tests/fixtures/email/rawEmails.ts`. `providers/email.provider.ts` `ImapReader` /
  `createImapReader` (30 s timeouts). `services/emailInbound.service.ts` `runEmailInbound` (worker tick, no flag, one due
  workspace per tick; no DB client during the IMAP session; one transaction per message; matching rule 4; effects below).
  Shared with WhatsApp (no behaviour change): `stopAutomationForReply`, `ensureReplyTask` (whatsapp-inbound.service.ts),
  `applyReplyEffects` / channel-aware `applyReplyLabel`, `retitleReplyTask`, `correctReplyLabel` (replyLabels.service.ts),
  `decryptInboundBody(row, aad)` + `whatsappReplyAad` / `emailReplyAad`, `readEmailReply`; the classifier claims from both
  tables; `replyTaskTitle(label, channel)` (email: "Lead replied by email — respond today", "Asked to stop by email — review
  today"); `onAgentEvent` `email_inbound` hands off like `whatsapp_inbound`; `MONTH_SPEND_SQL` and `/agent/stats` replies
  include email. `emailConnection.service.ts`: `loadImapStatus`, `requestImapCheck`, `resetImapState` (a changed IMAP host /
  port / folder / login reads only new mail). API (`B4-api.md` §7j): `GET|PUT /contacts/:id/email-replies/:replyId[/label]`,
  timeline `reply.channel`, email status clear admin-only with a reason, settings `imapStatus`, `POST
  /connections/email/check-now` (admin). E1b fixes: 451 rule, stale meeting emails cancelled, `npm run
  staging:cleanup-test-users` (deactivates active `@example.com` users; dry run by default) + test helpers deactivate their
  users. Frontend: Activity "Replied by email" rows (Show message with subject / Hide, label pill + Change, Classifying…),
  `ClearOptOutDialog` `channel` ("Clear" on Bounced / Invalid / Unsubscribed email status, admins), Settings → Email →
  Replies & bounces (+ Check now), AI Activity "Replies this month (WhatsApp + email)".
- **UI fix (dialog overflow, frontend only):** `DialogContent` had an implicit `auto` grid column, which grows to the
  widest nowrap content (a long proposal file name), so every field ran past the right edge. It is now `grid-cols-1`
  (`minmax(0,1fr)`), which fixes every dialog. Send proposal file row: name `min-w-0 flex-1 truncate` (+ `title`), size and
  Remove `shrink-0` (`send-proposal-dialog.test.tsx`).

- **E2 (AI Live mode, Feature 6):** migration 044: `agent_settings.live_scope` (`test_contacts|new_leads|all`, default
  `test_contacts`) + `live_since`; `leads.agent_live_test` (+ `_by`, `_at`); `agent_decisions.send_status`
  (`queued|sending|sent|failed|cancelled|dry_run`, null = draft) + `send_attempts`, `send_next_at`, `send_claimed_at`, `sent_at`,
  `send_error`, `cancel_reason`, `provider_message_id`; `whatsapp_outbound_messages.agent_decision_id` (unique; the 4th WhatsApp
  source); indexes for the send claim and real sends. Pure `agent/liveMode.ts` (`effectiveMode` — the ONE rule for live vs
  shadow per contact, `canSetScope`, `liveChannels` / `imapHealthy`, `sendRecheck`, `STALE_DECISION_MS` 24 h) and
  `agent/messageChecks.ts` `countQuestions`. Context (`agentContext.service.ts`): `rules.mode` = the contact's effective mode;
  a live contact counts/shows only real sends (`outcome = 'sent'`), drafts are labelled "draft — never sent to the contact" in
  the prompt; `rules.emailBlockedReason` (rules `emailUsable`) when a live contact's workspace IMAP hasn't polled OK in 30 min.
  `draftDecision`: > 1 question → regenerate once (`one_question:` problem) → handoff "AI couldn't write a one-question
  message". Runner: claims shadow AND live workspaces; a live contact's decision is `mode 'live'`, `outcome 'executed'`: a send
  is queued (`send_status queued`, `send_next_at` = rules send time; email = an `email_outbound_messages` row source `agent`,
  source id = decision id, `notBefore`), handoff / stop / update_stage executed in the decision's transaction
  (`agentSends.service.ts`: `executeHandoff` one open task "AI handed off — please follow up" + `handed_off` `ai_handoff`;
  `executeStop`; `executeStageChange` via `updateLead` + a timer wakeup after `wake_min_days`). Sends (`runAgentSends` in the
  worker, behind `AGENT_RUNNER_ENABLED`, before `runAgentTick`): SKIP LOCKED claim of `send_whatsapp` decisions (15-min
  reclaim, `send_claimed_at` token), compose (signature + opt-out on the first AI WhatsApp) → `sendWhatsApp` →
  `performSend` source `agent`, whose claim transaction runs `agentSendRecheck` (`agentSendState.service.ts`, decision + lead
  locked) instead of `loadSourceEligibility` (cancel → `SendCancelledError`). Emails: `processEmail` runs the same re-check
  first and again right before `sendMail` (`agentGate`); `onSourceSent` / `onSourceProblem` write back via
  `recordAgentSendOutcome` (sent → `outcome sent`, `sent_at`, Message-ID, `leads.agent_touch_*`, timeline "AI sent WhatsApp" /
  "AI sent email: <subject>"; failed → owner notified; dry run → `dry_run`, no touch). Rule 9: `isAiLiveContact`,
  `cancelWorkflowsIfLive`, `cancelWorkflowsOfLiveContacts` ("Managed by AI agent", via `cancelRunsForLead`) on scope on/widened,
  live-test mark, admin enroll, auto-enroll; `autoEnroll` skips live AI contacts; `POST /runs` → 409. API (`B4-api.md` §7k):
  `PUT /agent/settings` `mode: live` + `liveScope` (gate → 422 with `details.readiness`), `GET /agent/settings/live-preview`,
  `PUT /agent/leads/:id/live-test`, decision DTO send fields, `/agent/stats.live`, panel `liveTest` / `effectiveMode`.
  Frontend: Settings → AI agent Off/Shadow/Live, scope buttons (gated), `GatePanel`, `LiveConfirmDialog` (preview counts),
  `LiveBanner` (`features/agent/live-mode.tsx`), contact AI panel Live/Shadow + "Live test" pills + admin "AI live test
  contact" switch (`useSetLiveTest`), `SendStatusPill`, rule notes in IST (`withIstTimes`), enrol dialog shows the 409.
  `npm run test:integration:staging -- <files>` runs only those files. Not in E2: backfilling older leads (handoff note 10).
- **E2b (AI message quality; nothing new sent):** migration 045: `agent_settings.banned_phrases text[]` (13 defaults, ≤ 100),
  the EXISTING `email_max_words` / `whatsapp_max_words` (migration 024; there are no `max_words_*` columns) get defaults 160/75
  (rows still on 250/80 moved) and a 1–500 check; `agent_decisions.quality_checks jsonb` (`[{problems}]` per attempt, null =
  before E2b; `playbook_version` already existed); `kb_documents.chunker_version` (null = before E2b). Pure
  `agent/messageChecks.ts` (`findBannedPhrases` whole words, Unicode-aware, URLs ignored; `wordCount`; `compoundQuestion`: a
  question sentence joining two asks with and/or + an interrogative/auxiliary, not at the sentence start; `checkMessage` →
  `banned_phrase|length|one_question|compound_question|exclamation`). The word-limit check moved out of `rules.ts` (rule 6) into
  `checkMessage`; `draftDecision` runs it after `validateDecision` and folds its violations into `rules_result` (so `allowed`
  keeps meaning "passed every code check" for touch counting and AI Activity), before grounding. Pure `agent/situation.ts`
  `situationOf` (inbound = source website/inbound_form, firstMessage, hasCallOrNote, proposalStage, conversationStarted).
  Grounding (same call): strict schema adds `styleViolations [{rule, quote}]` (`STYLE_RULES`: `asks_lead_to_describe_business`,
  `not_thanking_inbound`, `introduction_mid_conversation`, `unsupported_sector_claim`), each explained with one example plus the
  CRM facts (inbound / first message / conversation exists, never the deal stage); sector claims are also factual claims. Any
  message-check or style problem → the ONE regeneration (problems with quotes as feedback) → handoff "AI couldn't write a
  message that meets the playbook" (only playbook problems; one_question-only keeps its E2 title; anything else "safe
  message"). Prompt: lead data "How they came to us: …" replaces "Source:"; drafts from another playbook version (or none) are
  one line "draft from an earlier playbook — not sent"; the user message ends with "Before you answer, check:" (one question,
  banned phrases, word limits from settings, inbound thanks, no introduction mid-conversation). Knowledge: `chunkText` merges a
  chunk < 60 tokens into the next chunk of the document (next's metadata; only if both fit 800); `CHUNKER_VERSION` 2: the worker
  ingestion also claims `ready` documents with an older `chunker_version` and re-chunks + re-embeds them (the unchanged-text
  shortcut needs the current version), so production re-chunks by itself after deploy (staging MOTM: 31 → 23 chunks). KB query
  adds designation, source and `Topics:` by situation (`situationTopics`). API (`B4-api.md` §7l): settings `bannedPhrases`,
  word limits 1–500, `GET /agent/stats.messageRules` (every CRM user), decision detail `qualityChecks`, grounding
  `styleViolations`. Frontend: Settings → AI agent is visible to everyone; non-admins see only the read-only "Message rules"
  card (`features/settings/message-rules-card.tsx`, RHF + Zod; admins edit, word limits moved out of the limits card); the
  decision drawer's Checks show style problems and "First attempt failed (regenerated)". `npm run agent:preview -- --lead <id>
  --evaluate` (implies `--call`) ignores mode off, AI status and touch limits (prints what it ignored), saves/sends nothing,
  and prints "Quality checks" (each rule PASS/FAIL per attempt).
- **E2c (AI message quality fixes; nothing new sent, no migration):** three checks moved into code (`agent/messageChecks.ts`
  `checkMessage(decision, settings, messageFactsOf(ctx))`, before grounding, same ONE regeneration then handoff):
  `not_thanking_inbound` (first message to a website/form lead must say "thank you"/"thanks" followed within 6 words by
  contacting, reaching out, getting in touch, your enquiry/inquiry, your interest, writing to us, filling, submitting or sharing;
  removed from the grounding style schema/prompt), `introduction_mid_conversation` (when `conversationExists`: no "thank you for
  reaching out/contacting", "this is / I am / I'm <owner first name> from", "introductory
  call/discussion", "introduce <company>", "introduce ourselves"), `internal_info_leak` (any ≥ 4-word run of the internal company
  description or the open deal name in body or subject, not stop-words only; feedback "Do not mention: …"; a safety problem →
  handoff "AI couldn't write a safe message"). `agent/situation.ts`: `conversationExists` (was `conversationStarted`: call/note,
  meeting/proposal, a real AI send with a matched WhatsApp/email reply after it (`ctx.aiSendReplied`), open deal past
  `qualified`); `firstMessage` also false after a current-playbook shadow draft. Prompt: lead_data line "Conversation so far: you
  are already in discussion with this contact (do not introduce <company> again or ask for a first call)." / "Conversation so far:
  none yet."; grounding gets `conversationExists: true|false` (the inbound/first-message lines are gone). AI Activity: check names
  in plain words (`CHECK_LABEL`, `checkProblem`), "Internal information leak" in red also among a regenerated attempt's failures.
  `agent:preview --evaluate` prints the three new checks.
- **E2d (fix):** inbound thanks (`not_thanking_inbound` + its checklist line) only when NO conversation exists
  (`situationInboundFirst`: inbound && firstMessage && !conversationExists; Raj: inbound, no sends, deal in Negotiation got both
  contradictory rules). With a conversation the checklist shows only "don't introduce us again…", and "thank you for reaching
  out/contacting" always count as introduction phrases (the E2c inbound exception is gone).
- **E2e (staging tool, no migration):** `scripts/seed-ai-test-contacts.ts` — `npm run staging:seed-ai-test-contacts [-- --confirm]`
  creates 20 realistic AI test contacts in MOTM (6 website enquiries, 2 thin, 2 non-engineering B2B, a bakery, 3 after a call,
  2 objection notes, price, Pune visit, meeting follow-up, proposal sent 5 days ago) through the real services, owner Naitik
  (fallback demo admin), marker `leads.created_by_name = 'AI test seed'` (set right after create), emails `<first>.<last>@example.com`
  (the name + phone thin lead has none), phones `+91 90000 000NN`, never "AI live test"; history steps are backdated on the timeline
  (+ `proposals.sent_at`); enrols them with `enrollLeads`; wake-ups spread over 2 h only when the mode isn't off (off → the Shadow
  switch wakes them over 60 min). `npm run staging:remove-ai-test-contacts [-- --confirm]` deletes them via `deleteLead` (marker
  AND a seeded email/phone; linked companies stay). Dry run by default, staging ref only; table in `scripts/output/ai-test-contacts.md`
  (git-ignored).
- **E2f (AI quality round 2 + company-linking fix; nothing new sent):** migration 046 `agent_settings.readiness_since`
  (null = all time). Companies: `corporateDomain` also returns null for reserved/test domains (`isReservedDomain`:
  `example.com/.org/.net`, `*.test`, `*.example`, `*.invalid`, `*.localhost`) and more free mail (rediffmail, yahoo.co.in,
  hotmail.co.in, outlook.in, live.in, me.com, proton.me, zoho.com, gmx, yandex, mail.com …; one list, no SQL copy); step 4
  "name wins": `findCompanies` returns the domain company's `similarity()` and `companyMatch` creates a company by name
  (no domain) + a `same_domain_different_name` PAIR when it is < `SIMILAR_NAME_THRESHOLD` (0.6, exported from
  `domain/companyMatch.ts`), else links as before. Every seeded @example.com contact had been linked to "Sharda Hydraulics"
  and its text overwritten: `npm run staging:repair-ai-test-contacts [-- --confirm]` (= seed script `--repair`) restores each
  seeded contact's company text, dismisses its stale contact-level rows, relinks it (+ its deals) and lists non-seeded contacts
  linked to a differently named company by domain (list only). Grounding (`buildGroundingMessages`): faithful paraphrases and
  general statements of our approach are supported; unsupported = specific claims in no source (numbers, named clients,
  results beyond the case study, "many/most clients", unlisted sectors, promises) with an invented-generalisation example;
  the website enquiry + calls/notes were already in its lead_data (the "unsupported enquiry" flags came from the wrong company
  record). Style: `asks_lead_to_describe_business` = written asks only (inviting a call about priorities is allowed);
  `introduction_mid_conversation` allows describing our approach in a follow-up. `findBannedPhrases`: an occurrence within 3
  words after not/cannot/can't/don't/never/no/won't/unable doesn't count. Pure `agent/signals.ts` (`detectSignals`,
  `signalsOf`: website enquiry + industry → consumer; plus the latest call/note → price, visit, ready): one lead_data line +
  one checklist line per signal; `rules.signal` (most decisive: consumer > price > visit > ready, set by `buildAgentContext`
  only when present) makes `validateDecision` turn a send into handoff ("Lead asked about price", "Lead asked for a visit or
  in-person meeting", "Lead is ready for a call or next step") or stop (`not_a_fit`, "Not a B2B business") as adjustment
  `signal`, no regeneration. `draftDecision`: a second regeneration only while the latest attempt failed only fixable code
  checks (`FIXABLE_RULES`: one_question, compound_question, banned_phrase, length, exclamation, not_thanking_inbound,
  introduction_mid_conversation; never after grounding or `internal_info_leak`), then handoff; `quality_checks` up to 3
  entries; AI Activity lists every failed attempt. Readiness: `loadRatings` counts decisions created since
  `readiness_since`; `POST /agent/settings/reset-readiness` (admin); settings + stats `readinessSince`; Settings → AI agent gate
  panel "Counting since <IST>" + "Reset go-live count" (confirm). Staging MOTM reset at 2026-10-29 15:59:32 IST.
- **E2g (AI attachments made safe and delivered; nothing new sent to real leads):** migration 047: `agent_assets.channels`
  default `{email}` (POST `/knowledge/assets` without `channels` → email only; existing rows unchanged),
  `agent_decisions.sent_asset_ids` (assets really sent; null = none/draft/dry run) + `attachment_issues` (send-time drops
  `[{assetId, title, reason}]`). Pure `agent/assetRules.ts`: `assetViolations` (rule 1: unknown / inactive / channel not
  allowed → violation, regenerate) and `applyAssetRules` (DROP the attachment, keep the message, no regeneration):
  `first_message` (no conversation (`conversationExists`) and no real message from us: real AI send or email/WhatsApp on
  the timeline; drafts never count), `whatsapp_no_reply` (no matched inbound WhatsApp from the contact), `already_sent`
  (`sent_asset_ids`), `count_limit` (≤ 2 email, ≤ 1 WhatsApp; Zod still allows 3/1), `size_limit` (≤ 10 MB total, largest
  dropped); `attachmentFileName` (title + the file's extension). `validateDecision` rule 7 applies both;
  `rulesResult.attachmentsRemoved`; `quality_checks` entries get `attachmentsRemoved` (with titles). `buildAgentContext`
  sets `rules.assetFacts` and searches knowledge with `excludeDocTypes: ['asset']` (asset files are still chunked for the
  Knowledge page's Test retrieval, but never reach the decision or grounding). Prompt (only when the workspace has assets,
  so other prompts are unchanged): rule "Attach an asset only if its 'use when' fits; mention it in one short sentence …;
  never quote numbers or results from it", an "Attachments now: …" line after the assets block (none before a conversation;
  WhatsApp only after a reply) and "already sent to this contact" marks; grounding (always) flags any number/result
  attributed to an attachment. Delivery: `executeLive` queues the email with Storage refs (`AttachmentRef.assetId/title`,
  bucket `agent-assets`, asset MIME); `processEmail` (`attachmentFiles`) leaves out an AI email's asset that was deleted /
  turned off or whose object is missing (`MissingStorageObjectError`, `providers/storageErrors.ts`) and records it; other
  download errors stay temporary. WhatsApp: `runAgentSends` claims `asset_ids`, `loadAsset` → `performSend` attachment =
  ONE message, the document with the text as caption (as proposals); an AI asset whose file is missing → text only
  (`attachmentMissing`). `recordAgentSendOutcome` sent → `sent_asset_ids`, `attachment_issues`, timeline detail
  "With attachment: <title>" / "Attachment not sent: <title> (<reason>)". Dry run: `dry_run`, nothing downloaded or sent.
  API (`B4-api.md` §7n): decision detail + lead panel rows `attachments {assets, removed, issues}`. Frontend: Knowledge →
  Assets Add dialog defaults to Email only, admin Edit dialog (`features/knowledge/edit-asset-dialog.tsx`, RHF + Zod: title,
  use when, channels; `ChannelChoices` shared), `AttachmentsUsed` (decision Sheet under Message, contact AI panel rows).
  `agent:preview --evaluate` prints the attachments and each `attachment_removed: <reason>`. Integration
  `tests/integration/agentAssets.test.ts` (real Storage objects in `[test]` workspaces).
- **E2h (attachment follow-ups; nothing new sent to real leads, no migration):** `messageChecks.ts` `mentionsAttachment`
  + `checkMessage` rule `attachment_mention` when the rules' FINAL `assetIds` is empty and the text refers to a file (fixable,
  playbook handoff). Send time: `ATTACHMENT_MISSING` = `attachment_missing` (`agent/assetRules.ts`), a cancel reason.
  `processEmail` (after the last `agentGate`, `cancelAgentEmail`) and `processAgentWhatsApp` (asset gone) / `performSend`
  (`textMentionsAttachment`, file missing or > 10 MB → `SendCancelledError(ATTACHMENT_MISSING, detail)`) cancel a text that
  mentions it; `recordAgentSendOutcome` stores `attachment_issues` on the cancel and enqueues a `timer` wake-up due now. An AI
  email no longer fails for size: `attachmentFiles` leaves its largest files out until it fits. `performSend` returns
  `attachmentProblem` (was `attachmentMissing`). Sizes: `knowledgeLibrary.service.ts` `assetFileSize` (Storage metadata), used by
  `buildAgentContext` when `size_bytes` is null (read each decision, not saved; no backfill needed; unknown = allowed).
  `buildAgentContext` hides assets with an `attachment_issues` entry on this contact's decisions (stops a cancel → wake →
  same asset loop). Frontend: `CHECK_LABEL.attachment_mention`, `cancelReasonText` (`SendStatusPill`). `B4-api.md` §7n.
- **E3a (AI writing quality; nothing new sent to real leads):** migration 048: `agent_settings.style_examples` (≤ 6,000 chars), 24 banned
  phrases added to every workspace (only missing ones, ≤ 100), `email_max_words` / `whatsapp_max_words` defaults 120/50 (rows on
  160/75 moved), index `email_outbound_agent_thread_idx`. Pure `agent/modelSetting.ts` (`parseModelSetting`, `modelParams`,
  `modelSettingProblem`): a model setting is `name` or `name@effort` (none|minimal|low|medium|high|xhigh), GPT-5.x / o-series get
  `reasoning_effort` (default `none` on GPT-5.1+) and `max_completion_tokens` 6000; GPT-4.x requests are unchanged, an effort on them
  is refused. `pricing.ts` `priceOf`, `costUsd(..., cachedInputTokens)`. Prompt order (OpenAI caches identical prefixes): the system
  message is the same for every contact of a workspace (rules, "How you write", email structure, playbook, style examples, message
  rules; grounding: rules + playbook), the contact's data is in the user message (grounding: `<message>` last). `quality_checks[]`
  gains `inputTokens`, `cachedInputTokens`, `autoFixes`. Pure `agent/polish.ts` `polishDecision` (before `validateDecision`): dashes,
  "!", "…", sign-offs, links/emails/phones, spacing; a range ("9–5") and hyphenated words are left alone; a fix that would break the
  sentence isn't made. `messageChecks.ts`: fixable `subject_style` (`subjectProblem`: > 60 chars, > 8 words, an all-caps word of 4+
  letters that isn't a company's, Re:/Fwd:) and `contact_details` (what polish couldn't remove); straight/curly apostrophes match.
  Threading: `latestAiEmail` (`agentSendState.service.ts`), `ctx.emailThread`, `threadSubject`/`unthreadedSubject`
  (`domain/emailSafety.ts`), `agentThread` in `processEmail` decides again at send time. `GET /agent/stats.quality`
  (`loadQuality`), `messageRules.styleExamples`. `services/agentModelTest.service.ts` + `npm run agent:model-test`. Frontend:
  `StyleExamplesCard`, "Fixed automatically" in the decision Checks, `QualityStats` on AI Activity. `B4-api.md` §7o.
- **E3b-1 (conversion core; nothing new sent to real leads):** migration 049: `agent_decisions.stage_key` / `angle`,
  `agent_settings.first_channel` (`whatsapp|email`, default whatsapp), `profiles.booking_url` (https, ≤ 300). Pure `agent/stagePlan.ts`
  (`stagePlan` → `{stageKey, angle, allowedActions, preferredChannel, reason, fallback}`, `journeyAngle`, `preferredChannel`,
  `suggestedDays`, `CALL_ANGLES`, labels); `buildAgentContext` builds it from the latest meeting/proposal, calls/notes, touches per
  channel (real sends; shadow also allowed drafts), `conversationExists`, channel usability and an earlier `rep_owned` decision
  (`ctx.stagePlan`, `ctx.stagePlanInput`, `ctx.latestMeeting` {outcome, notes}, `rules.stagePlan`). Status mapping (Item 0): upcoming
  meeting, or a past one with no outcome → `meeting_scheduled`; completed with an outcome (incl. second_meeting) and no sent proposal →
  `meeting_held_no_proposal`; `no_show` → `meeting_no_show`; cancelled/failed → back to the journey; proposal `sent` →
  `proposal_sent`; `revision_requested|revised|withdrawn` or a deal/lead in negotiation → `rep_owned`; draft/uploaded/ready_to_send =
  no proposal yet; won/accepted, LTN without nurture, DNC… stay stopped by the existing rules. `validateDecision` 5b: an action the
  stage doesn't allow → its fallback (adjustment `stage_plan`); the channel that isn't due while the other is usable → switched +
  fixable violation `channel_switch` (adjustment `channel_balance`). Prompt: one system list of angles + the easy-yes rule (cached),
  lead_data "This message: <angle> (<reason>)", "Channel for this message", "Suggested days: Thursday or Friday" (call angles), meeting
  outcome + notes for a recap. Speed to lead: `isFreshInbound` (website/inbound_form, < 2 h, no touch) → `FIRST_INBOUND_WINDOW`
  08:00–21:00 IST any day in `rules.ts` (`sendWindowSettings`), `sendRecheck` (`freshInbound`, returned by `agentSendRecheck`), and
  `decideSend` / `decideEmailSend` (`firstInboundWindow`, source agent only, `automatedWindow`); caps, spacing, warm-up, new-chat
  limit, pause unchanged; `onAgentEvent` lead_created wakes a fresh inbound contact at once; "First call" due in 1 hour and the
  notification "New website lead — call within 1 hour" (website form; manual inbound_form/website create). Booking link:
  `GET|PATCH /me` (`bookingUrlSchema`, `profiles.service.ts`), admin `PATCH /admin/users` `bookingUrl`; `composeOutgoing` `bookingLine`
  (email "If it's easier, you can pick a time here: <url>", WhatsApp "You can also pick a time here: <url>", call angles only, never a
  first WhatsApp; `bookingLinkAdded`). `assetRules`: a WhatsApp attachment also after a logged call or a held meeting
  (`AssetFacts.callOrMeetingHeld`). Checker: approach statements for any B2B sector are supported; invented call/meeting/proposal
  history, one client experience made plural and "you mentioned…" not in the lead's data are flagged. WhatsApp signature
  "<first name>, <company>" (no dash). `agent:preview` / `agent:model-test` print stage + angle (model test: plan without touches,
  "Booking link added"). Frontend: Settings → Profile (`profile-panel.tsx`, `booking-url.ts`), Users booking link field, AI agent
  "First message channel", `StageUsed` + `BookingLinkNote` in the decision Sheet / contact AI panel, Message rules card text.
  `B4-api.md` §7p.
- **E3b-1b (fixes from the 2026-11-03 model test; nothing new sent, no OpenAI calls):** migration 050 `agent_settings.whatsapp_max_words`
  default 50 → 60 (rows on 50 moved); prompt "aim for about 40" (`whatsappTargetWords`, ⅔ of the limit); the `length` feedback gives the
  count, words to cut and "drop the thank-you opener first". `applyGroundingAllowList(result, ctx, now)` drops an unsupported claim or
  `asks_lead_to_describe_business` whose quote is only the suggested-day question (`isDayOptionQuestion`); checker prompt allows it and
  flags a promised follow-up time; `meeting_recap` offers help with questions, not a call slot, when the lead will decide later or
  consult someone. `agent:model-test` `--only`, `--channel`, `--max-cost` (above).

- **E3b-2a (reply drafts for reps, 2-hour escalation, small fixes; nothing sent by the AI):** CLAUDE.md slimmed ("Completed so
  far" moved here). Migration 051: `reply_drafts` (one per matched reply: WhatsApp message id or email event id, channel, our subject
  + body, `in_reply_to` = the lead's Message-ID header, status `open|sent|discarded|superseded|failed`, failed check NAMES, model /
  tokens / cost, the rep's `sent_body` / `edited` / `sent_by`, delivery `send_status|send_next_at|sent_at|send_error`; never the
  lead's text; RLS on, no policies), `draft_status|draft_attempts|draft_next_at` on both inbound event tables,
  `whatsapp_outbound_messages.reply_draft_id` (5th source), email source `reply_draft`, `tasks.escalated_at`,
  `meetings.outcome_task_created_at`. Pure `domain/replyDrafts.ts` (`draftSkipReason`, `contactSendProblem`, `replySendProblem` —
  no touch history, so the AI's 48 h / 2 per week / 8 total limits never apply — `replySendAt`, `addWorkingTime`, `escalationDue`).
  `services/replyDrafts.service.ts`: `markReplyForDraft` (both ingestions: supersede open drafts + pending steps of the contact;
  pending only under the D4a condition), `runReplyDrafts` (worker, behind `AGENT_RUNNER_ENABLED`, after the label step; budget,
  daily cap (`DAY_DECISIONS_SQL` = decisions + drafts) and channel checks before any call; `buildAgentContext` +
  `buildReplyDraftMessages` / `buildReplyDraftGroundingMessages` in `agent/prompt.ts`; polish, `checkMessage` (conversation exists,
  subject from code), grounding; one regeneration; `writeReplyDraft`), `sendReplyDraft` / `discardReplyDraft` (owner/admin, open
  only, idempotent, 400 word limit, 409 DNC/opt-out/status, queued until the channel window opens, reply task completed),
  `runReplyDraftSends` (WhatsApp via `performSend`, `loadSourceEligibility` case `reply_draft`), `recordReplyDraftOutcome` (also
  from `emailOutbound.service.ts`; timeline "Reply sent on WhatsApp/email", failure → the rep notified). `isAutomated` /
  `isAutomatedEmail` include `reply_draft` (send window). `MONTH_SPEND_SQL` adds draft cost. `services/workReminders.service.ts`:
  `runReplyEscalation` (2 working hours, once, admins, 20 per workspace, oldest first) and `runMeetingOutcomeTasks` (meetings 2–30
  days past, no outcome, once). Rohit fix: `leadIsDeciding` (meeting notes) → angle `meeting_recap_deciding` (not in
  `CALL_ANGLES`); fixable code check `unsupported_agreement` (`agreementClaim`: "as agreed/discussed" unless the notes or a
  call/note say "agreed") + checker example. Admin booking-link change on someone else → `admin_audit_events`
  `user.booking_url_changed`. API (`B4-api.md` §7q): timeline `reply.drafting` / `reply.draft`, `GET /contacts/:id/reply-drafts/
  latest`, `POST …/reply-drafts/:draftId/send|discard`. Frontend: `features/crm/suggested-reply-card.tsx` (`SuggestedReplyCard`,
  `LatestSuggestedReply`) on the Activity reply row and the reply task's Sheet; `useLatestReplyDraft`, `useReplyDraftActions`; angle
  label and `CHECK_LABEL.unsupported_agreement`. Integration: `replyDrafts.test.ts`, `freshInboundSunday.test.ts` (E3b-1 7c).

- **E3b-2a-2 (reply draft fixes before the manual test; nothing sent by the AI, no OpenAI call):** Rule 1 bursts: a matched reply on a
  contact `handed_off` with an open reply task or any reply draft (`isReplyFollowUp`, both ingestions) is labelled, gets a reply task
  and a draft step like an AI-managed one (keywords still first). `markReplyForDraft` sets `draft_next_at = now() + 3 min`
  (`DRAFT_DEBOUNCE_MS`); a newer reply skips the older pending step. The draft step (`loadBurst`) reads every matched reply of the
  contact (both channels, newest 10, oldest first, joined by `---` in the one `reply` block) since our last message (an AI send, any
  sent email to the contact, the rep's Send `queued_at` / Discard `discarded_at`); a reply in the burst still being labelled → retry
  in 1 min; `draftSkipReason` takes the burst's `labels` (any `asked_to_stop|not_interested|annoyed` → no draft) and
  `contactDraftsToday` (≤ 3 per contact per IST day, `MAX_DRAFTS_PER_CONTACT_PER_DAY`). `DAY_DECISIONS_SQL` now also counts AI reply
  labels (`classification_cost_usd` set). Rule 2: migration 052 `agent_settings.reminders_since` (default `now()`: existing workspaces
  get the apply time, new ones their creation time); `runReplyEscalation` / `runMeetingOutcomeTasks` only for tasks / meetings
  created at or after it. Rule 3: already sent `In-Reply-To` + `References` = the lead's Message-ID (`agentThread`); now tested via a
  fake SMTP transport. Rule 4: `npm run staging:seed-reply-draft -- --contact "<full name>"` (`scripts/seed-reply-draft.ts`; staging
  ref only, seeded "AI test seed" contacts only, latest matched reply, refuses an open draft; model `staging-seed`, cost 0;
  `--remove`). Rule 5 (2026-11-04 email model test): (a) Naitik has no `booking_url` → `agent:model-test` prints "Booking link added:
  no (owner has no booking link)" (`bookingLinkNote`); (b) Anil's steel-trader story was in KB_MOTM_Client_Experiences and the writer
  and checker get the same knowledge block → checker prompt: naming one listed client experience as described is supported in any
  sector, never `unsupported_sector_claim` (`LISTED_EXPERIENCE_EXAMPLE`); (c) fixable code check `call_days` (`callDaysProblem`): a
  question asking for a call offers two weekdays and a day question never says "in the coming days" (both channels, decisions and
  reply drafts); frontend `CHECK_LABEL.call_days`. API shape unchanged (`B4-api.md` §7q as is). Tests: `replyDrafts.test.ts`
  (bursts, limit, stop label, new burst after Send, old tasks/meetings, SMTP headers), `seedReplyDraft.test.ts`,
  `replyDraftFixes.test.ts`.

- **E3b-2b (small fixes, email open tracking, per-message tracking, hot-lead score, funnel; migration 053; no OpenAI call):**
  Rule 1: `DAY_DECISIONS_SQL` counts AI decisions + reply drafts only (AI reply labels: monthly budget only). Rule 2:
  `markReplyForDraft` never supersedes the open draft once the contact has 3 drafts today; it sets `reply_drafts.newer_reply_at` and the
  Suggested reply card shows "<Name> wrote again after this draft…". Rule 3: `SEEDED_DRAFT_MODEL = 'staging-seed'` (the existing
  marker) → Send **409** "Seeded test draft — sending is disabled"; `--remove` also deletes queued WhatsApp/email sends of seeded drafts
  (prints both counts). Rule 4: prompt "Closing question: Would <Day1> or <Day2> suit you for a short call?" (decisions and reply drafts,
  `callQuestion`), no time phrase; auto-fix `call_days` removes "in the coming days / in the next few days / in the coming week /
  sometime soon" when both suggested days are offered (`polishDecision` gets `suggestedDays`). Rule 5: writer rule (one listed client
  experience or none); auto-fix `generic_client_claim` drops such a sentence when ≥ 2 other sentences stay, else fixable code check
  `generic_client_claim`. Auto-fixes never add an attempt, so an auto-fixed draft counts as passed first try. Rule 6: `agentAssets`
  polls Storage up to 60 s after a delete. Rules 7–13: `domain/emailTracking.ts` (token, pixel, `PUBLIC_API_BASE_URL` validation, rate
  limiter), token on every queued email, pixel added by `processEmail` (agent + workflow only, env + `integration_connections.track_opens`),
  `routes/tracking.routes.ts` (public GIF), `services/emailOpens.service.ts` (`recordEmailOpen` UPDATE; worker `runOpenEvents`: one
  timeline event "Email opened: <subject>", the email's fact, score mark; `open_event_at`), "Opened" pill, Settings → Email toggle.
  Rule 14: `message_facts` written by `recordEmailFact` (markSent, not dry run) and `recordWhatsAppFact` (performSend); sources agent /
  workflow / reply_draft / proposal / meeting; `attributeOutcome` (last touch ≤ 14 days, set once) on matched replies, labels
  (`attributeReplyLabel`), meetings, deals created / won; `whatsapp_connection.id`. Rules 15–18: `domain/leadScore.ts`,
  `services/leadScore.service.ts` `runLeadScoreSweep` (worker, 200 per tick: marked, then older than 24 h; backfill via
  `hot_score_dirty` default true), marks via `markHotScore`, `updateLead`, company link, website re-submission; trigger
  `leads_zz_keep_updated_at_for_score` keeps `updated_at` on score-only updates; `agent_settings.target_industry_keywords` (MOTM default);
  Contacts "Hot" column + sort, Tasks "Hottest first", contact record, Settings → AI agent "Target industries". Rules 19–20:
  `services/funnel.service.ts`, `GET /analytics/funnel`, Home "Conversion (last 30 days)", AI Activity "Results"
  (`features/analytics/funnel.tsx`). Frontend `testTimeout` 15 s. Migration 053 (re-runnable) applied to staging. Tests:
  `emailTracking`, `leadScore` (unit), `emailOpens`, `messageFacts`, `leadScore`, `funnel` (integration) + updates in `replyDrafts`,
  `seedReplyDraft`, `emailOutbound`, `whatsappSafety`, `emailSettingsApi`, `agentAssets`, `agentDraft`, `agentPolish`.

- **DB-3 (transaction pooler, session pooler only where needed, keepalive + clean shutdown; no migration; no OpenAI call):**
  `DATABASE_URL` = Supabase transaction pooler (6543) for the API (incl. `/t/o/…`), every worker query/tick, scripts and
  integration tests; new `DATABASE_SESSION_URL` = session pooler (5432) for the WhatsApp session-lock clients
  (`sessionConnectionOptions`) and `sessionPool` (`DB_SESSION_POOL_MAX` default 2, lazy, unused today); unset → `DATABASE_URL`
  with one startup warning (`resolveDatabaseUrls`, `logPoolTargets` prints host:port of each pool). Inventory: the only
  session-dependent use was the WhatsApp manager's `pg_try_advisory_lock`/`pg_advisory_unlock` (moved to the session URL); every
  other lock is `pg_advisory_xact_lock` (performSend, WhatsApp inbound per phone, lead ingest, saved views), `hnsw.iterative_scan`
  is `set_config(…, true)` inside a transaction, no session `SET`, named statements, temp tables, `LISTEN` or cursors. TCP
  keepalive (10 s) on every pool and lock client. `src/shutdown.ts` `installShutdown` (SIGINT, SIGTERM, SIGBREAK; once; 10 s hard
  timeout): API (server close + both pools), worker (loop, WhatsApp managers + lock clients, pooled SMTP transports, both pools),
  scripts (installed by `db.ts` for role `script`). `db:connections --probe` probes both poolers. Staging `.env`: `DATABASE_URL` and
  `TEST_DATABASE_URL` on 6543, `DATABASE_SESSION_URL` / `TEST_DATABASE_SESSION_URL` on 5432, `DB_SESSION_POOL_MAX=2`; the staging
  runner passes `TEST_DATABASE_SESSION_URL`. Production deploy: set both URLs on API and worker, check the transaction pooler is
  enabled and both pool sizes (CLAUDE.md "DB connections"). Tests: `db`, `shutdown` (unit), `dbPoolers` (integration: 30 parallel
  queries on the transaction pooler while the session pool is held, the WhatsApp lock still excludes a second manager, the hot-score
  sweeper on the transaction pool), `whatsappManagers` uses the session URL.

- **E4a (several WhatsApp numbers per workspace, sticky number per lead; migration 054; no OpenAI call, no real socket in tests):**
  New `whatsapp_numbers` (one row per number: label, optional owner, QR pairing, status / desired state, `paired_at` warm-up, daily
  cap, spacing, new-chat limit, `enabled` + pause, soft delete `removed_at`); auth state per number in `whatsapp_number_auth_*`
  (the old per-workspace `whatsapp_auth_*` tables are kept, unused); `whatsapp_connection` stays the workspace row (send window,
  new `outbound_enabled` master switch, `max_numbers` default 5; its per-number columns are legacy). `leads.whatsapp_number_id`
  (sticky), `whatsapp_number_id` on outbound / inbound / safety rows and `message_facts`, inbound `other_number`, per-number counter
  indexes. Backfill: each connection → number #1 with the same id (so `message_facts.whatsapp_connection_id` history matches), same
  `paired_at`, auth rows copied (AADs carry no workspace: no re-pairing), every lead with a sent WhatsApp or a matched reply and every
  existing outbound / inbound / safety row → #1; re-runnable (only workspaces whose #1 the run creates). Staging: 8 numbers, 1 lead.
  Domain `domain/whatsappNumbers.ts` (`chooseNumber`, `pickNumber`, `moveProblem`, `numberPhoneLockKey`); `decideSend` gets
  `isNewChat` (per-number new-chat limit; the opt-out line / link block stay per lead via `isFirstMessage`). Worker: one
  `BaileysManager(workspaceId, numberId)` per number (advisory lock on the number id, retry-counter cache, QR, auto-pause and
  notifications per number, "WhatsApp number <label> paused automatically"), registry keyed by number (`NEEDS_MANAGER_SQL` on
  `whatsapp_numbers`, removed numbers only while logging out), log line per change "WhatsApp numbers with a session: <ws>: n → N
  session-pooler slot(s)". Sending: `sendWhatsApp` → `resolveSendNumber` (sticky, or rule 4 under the lead row lock; none usable →
  `ProviderDeferredError`) → that number's manager; the claim locks (number, phone), re-checks the sticky number (assigns it when
  still empty, defers 1 s when an admin moved it) and counts per number (`loadSendStats`); the outbound row and the fact carry the
  number. Inbound: `processInboundUpsert(ws, event, numberId)`, lock per (number, phone), first matched inbound sets the sticky
  number, another number → `other_number`. API: workspace settings, `/connections/whatsapp/numbers` (add / edit / pause / resume /
  remove with the rule-10 options / connect / restart / logout), `POST /contacts/:id/whatsapp-number` (admin, reason, timeline,
  audit), `GET /contacts/:id` `whatsappNumber`, funnel "number" by label (B4 §7s). UI: Settings → WhatsApp number cards
  (`features/settings/whatsapp-numbers.tsx`: status, sent / cap with warm-up day, owner picker, safety, pause / resume, QR, remove
  dialog), workspace settings (`whatsapp-safety.tsx`: master switch, window, max numbers, monitoring with number labels), session-slot
  warning (headroom = 15 − 2 × DB_SESSION_POOL_MAX − 3); contact record "WhatsApp number" + admin "Move to another number"
  (`features/contacts/move-whatsapp-number-dialog.tsx`). Not built: a WhatsApp test send (none existed). Tests: `whatsappNumbers`
  (unit + integration: spread by room, owner first, cap on A → new leads to B while A's wait, pause one number, first inbound /
  other number, STOP on B, moved lead), `agentLive` (agent → proposal → reply_draft on one number), `whatsappSafetyApi` (routes),
  `dbPoolers` (one lock per number), `whatsappManagers` (two numbers → two managers, removed → none), registry / manager / auth
  store unit tests; frontend `whatsapp-numbers`, `whatsapp-safety`, `move-whatsapp-number-dialog`, `contact-about`. Production: stop
  the worker, apply 054 (MOTM and MOTM Tech: their number becomes #1, no re-pairing), deploy API + worker; env unchanged.
- **E4b (users assigned to workspaces: membership, per-workspace role, super-admin; migration 055; no OpenAI call, nothing sent):**
  New `workspace_members` (workspace, user, role `admin` | `salesperson` — the profile role values, per workspace; unique pair;
  indexes both ways; RLS on, no policies), `profiles.is_super_admin`, `workspace_member_events` (audit: added / role_changed /
  removed / workspace_created, actor). Backfill (rule 8, only while the table is empty): every active user × every non-`[test]`
  workspace with the global role — staging: 1 admin + 1 salesperson in MOTM. Access: `requireWorkspace` is the ONE check
  (non-member → 403 "You don't have access to this workspace"; super-admin opens everything as admin) and replaces
  `req.actor.role` with the role in that workspace, so every `requireAdmin` / `actor.role` check (agent, knowledge, connections,
  assignment rules, duplicates, contacts enrol AI, opt-out/bounce clearing, saved views, reply reads, ratings) is per workspace. The
  global role remains only for `/admin` user accounts (global admin or super-admin) and the backfill; `requireCrmUser` still
  validates it. `domain/workspaceAccess.ts` (effective role, last admin, removable). `/me` → `isSuperAdmin` + `workspaces` with
  roles; `/workspaces` lists only the user's (super-admin: all), the creator becomes admin, rename is super-admin only; `/profiles` is
  workspace-scoped (members + non-member owners `member: false`). Assignment (rule 5, `assertAssignableUser`): lead create/edit,
  bulk assign, companies, deals, manual tasks, meetings, revenue rules + fallback, website owner, number owner accept only active
  members; an unchanged non-member owner is kept. Notifications (rule 6, `WORKSPACE_ADMIN_IDS_SQL`): auto-pause (WhatsApp / email),
  IMAP alert, budget / daily cap, AI report, reply escalation → admins of that workspace; unassigned website lead → members of that
  workspace; owner notifications unchanged. Worker (rule 7): revenue rules / fallback skip non-members; escalation, budget, auto-pause,
  IMAP use membership; the meeting-outcome task still goes to the meeting/lead owner (owner rule). Team API `/team/members`
  (admin: add by email, role, remove — 409 with counts of active contacts / open deals / open tasks, last-admin guard), super-admin
  `/super-admin/memberships` (paged matrix, set/remove) (B4 §7t). Script `npm run admin:set-super-admin -- --email <e> [--remove]
  [--confirm]` (staging only, refuses production, dry run by default, admin audit row). UI: the switcher lists only allowed workspaces
  (stale selection → first allowed), `?workspace=<id>` opens that workspace or shows "You don't have access to this workspace", no
  workspace → "You haven't been added to a workspace yet. Ask your admin."; Settings → Team (`team-panel.tsx`, lazy), Settings → All
  workspaces (super-admins, `super-admin-panel.tsx`, lazy, also creates workspaces); pickers offer members only, non-member owners
  are shown "(not in this workspace)"; admin UI follows the role in the current workspace. Small fixes: env
  `SESSION_POOLER_MAX_CLIENTS` (default 15, validated, API + worker) replaces the hard-coded rule-12 pooler size; unused `yesNo`
  removed. Tests: unit `workspaceAccess`, `roleGuards`, `params` (403), `setSuperAdmin`, `db` (env); integration
  `workspaceAccess` (non-member 403 across contacts/deals/settings/AI/WhatsApp/funnel/knowledge/directory, admin in A + sales in B,
  super-admin, pixel public), `workspaceMembership` (auto-pause to that workspace's admins, revenue assignment never a non-member,
  pickers), `team`, escalation in `replyDrafts`; test helpers `addTestMember` + testApi auto-membership (`member: false` opts out);
  frontend `team-panel`, `super-admin-panel`, `session-hooks`, `auth-gate`, `settings-page`. First load 296.8 kB. Production:
  apply 055 (the backfill keeps today's access), set `SESSION_POOLER_MAX_CLIENTS` to the production session pooler size, make the
  super-admin by SQL in the Supabase SQL editor (the script refuses production):
  `update public.profiles set is_super_admin = true where lower(email) = lower('<email>');`, then apply management's member lists
  in Settings → All workspaces. ~~Open: the 001-era RLS policies (`is_active_salesperson()`) still let any signed-in active user read
  every workspace through PostgREST (the app doesn't use it); removing them needs a non-additive migration (decision pending).~~
  **Closed in SEC-1** (migration 056).
- **SEC-1 (no direct database access from the browser; migration 056; no OpenAI call, nothing sent, no change in what the AI
  writes):** Item 0 found: the backend/worker connect as `postgres` (BYPASSRLS) and use the service-role key for Storage + Auth; the
  frontend uses Supabase only for login (`signInWithPassword`, `getSession`, `onAuthStateChange`, `signOut`); no browser path reads a
  table, calls an RPC or touches Storage. Staging before: 57 policies on 21 `public` tables (all `authenticated`, `is_active_salesperson()`),
  0 RLS-off tables, anon + authenticated held every privilege on 55 tables + 4 views (826 grants; the views run as their owner, so
  they bypassed RLS), EXECUTE on all 12 `public` functions, the same through `postgres`'s default privileges; 0 Storage policies (4
  private buckets). A signed-in active salesperson with the anon key read real leads via `/rest/v1/leads`. Migration 056 (the one
  allowed non-additive change: policies and privileges only; re-runnable): drops every policy on `public` tables, enables RLS where
  off, revokes table/view/sequence/function privileges from anon, authenticated and PUBLIC in `public` and the matching default
  privileges of `postgres` (PUBLIC's EXECUTE default globally for `postgres`), drops Storage policies for the browser that name a
  private bucket or no bucket. Functions stay (5 are trigger functions incl. `handle_new_user` on `auth.users`; triggers don't check
  EXECUTE); none is needed by Supabase Auth. After (staging, run twice, second run no change): 0 policies, 0 RLS-off, 0 grants, 0
  EXECUTE; 12 functions and 43 triggers unchanged. Not changeable as `postgres`: `supabase_admin`'s default privileges (objects
  created by `supabase_admin` only — none of ours). Guard: `npm run db:security-check` (`scripts/db-security-check.ts`, read-only,
  refuses production) + integration test `dbSecurity` (also the proof: anon key alone and a signed-in active salesperson get 401/403
  on `/rest/v1/leads`, `/rest/v1/tasks`, an insert and `rpc/is_active_salesperson`, a private bucket lists nothing; password login
  still works); the staging runner passes the public anon key (`TEST_SUPABASE_ANON_KEY`, from `Frontend/.env`). CLAUDE.md rule:
  never add policies or grants for anon/authenticated. Leftover on staging: two `agent3b2_fail_*` functions from an old interrupted
  `agentEvents` run (now not executable by the browser). Production: apply 056 with the other migrations (no app change needed);
  before release run this read-only query in the production SQL editor; every row must be a `public` policy, `rls_off`, or a
  `storage` policy that 056 drops (names a private bucket or none) — anything else, review before applying:
  `select 'policy' as kind, schemaname, tablename, policyname, roles::text, cmd from pg_policies where schemaname in ('public',
  'storage') union all select 'rls_off', 'public', c.relname, null, null, null from pg_class c join pg_namespace n on n.oid =
  c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity order by 1, 2, 3, 4;`
  After 056: `npm run db:security-check` cannot target production (it refuses); re-run the query instead (expect only storage
  rows for other buckets, if any).
- **P7 (scalability review, test stability, system health; migration 057; no OpenAI call, nothing sent, no real WhatsApp
  socket, no change in what the AI writes):** Item 0: SEC-1's failed staging runs were run 1 (`automationHomeApi` timed N+1
  test over its 120 s timeout on a slow network), run 3 (`getaddrinfo ENOTFOUND` network outage in `replyDrafts`, one test
  hung 6,280 s; and `whatsappSafety` "outside the send window": the helper's window opens at 00:00, so with "today" excluded a
  run at 23:29 IST deferred only 31 min — the pure window function is correct), run 5 (`knowledgeApi` cleanup: Storage
  `fetch failed`, no retry), run 7 (`agentLive` stalled 812 s on the network); they left 20 `[test]` workspaces (all with
  WhatsApp numbers) and 2 `agent3b2_fail_*` functions. Item 1: cleanup retries network errors (`tests/helpers/networkRetry.ts`,
  3 attempts, backoff; a retry after a lost commit reply stops when the workspace is gone); a cleanup that still fails is logged
  and the new global teardown (`tests/global-setup.ts`) deletes every `[test]` workspace created during the run (a failed sweep
  fails the run); `BaileysManager` takes an injected clock (4th argument) and the window test uses Wednesday 12:00 IST with a
  09:30–19:00 window (asserts 21.5 h + ≤ 20 min); Storage uploads/lists/removes in tests retry, the asset signed URL is polled;
  `staging:cleanup-test-workspaces` also takes `[test]` workspaces with WhatsApp numbers (numbers marked removed first) and
  lists / drops (`--confirm`) `public` functions no migration creates (run: 20 workspaces + 2 functions removed). Item 2:
  `npm run staging:load-seed` (staging ref; dry run; `--confirm`; `--remove`; 10 `[test] load-seed` workspaces × 2,000
  contacts with companies, deals, tasks, 100,000 timeline events, meetings, proposals, 18,000 AI decisions, 8,000 sent
  messages + facts, opens, replies, drafts, 24,000 wake-ups, 30 users, 20 disconnected fake numbers, AI off; stops above
  70 % of the plan limit — Free plan 500 MB assumed, `max_connections` 60; staging 141.6 → 226.4 MB) and
  `npm run staging:perf-measure` (20 runs per path, every statement under EXPLAIN ANALYZE in a rolled-back transaction, seq
  scans on tables > 10k rows flagged; `--only`, `--explain`); results in `docs/perf/P7-baseline.md`. Item 3: fair worker ticks
  (`services/fairPick.ts`: every multi-workspace claim round-robin across workspaces within its per-tick limit; sweeps pick
  candidates up front; email outbound longest-waiting workspace first; reply escalation also ≤ 100 per tick); migration 057
  `email_outbound_lead_idx` (hot-score batch 161 → 44 ms); work lists join `leads` / `companies` with the workspace equality
  (tasks "Hottest first" 31 → 2 ms, no seq scan). At 20,000 contacts every API read ≤ 25 ms server, funnel 180 d ≤ 70 ms,
  every claim ≤ 1 ms, every batch ≤ 45 ms; the funnel's 180-day cohort still seq-scans `leads` while one workspace is 10 % of
  it (planner choice; the index exists). Per WhatsApp number (fake managers, `npm run staging:worker-capacity`): ~0.1 MB heap
  and one session-pooler client; recommended ≤ 8 numbers per worker on a 15-client session pooler (the E4a/E4b formula).
  Item 4: migration 057 `worker_heartbeats` + `system_health_alerts` (RLS on, no policies, no grants); the worker runs every
  tick step through `step()` (failures logged as codes, the tick goes on) and upserts one heartbeat row per loop per tick;
  `GET /health/worker` (public, no data: 200 `ok` / 503 `stale` + critical loop names when a loop hasn't finished within
  expected × 3, expected = max(60 s, 2 × poll)); `GET /super-admin/system-health` + Settings → System health (super-admins,
  lazy); `runHealthAlerts` every 15 min: one admin notification per workspace per IST day per red problem (stuck queue,
  paused channel, AI budget ≥ 90 %). Item 5: load seed removed (workspaces 1, contacts 26, seed users 0 — as before; the
  database stays at 229 MB until autovacuum reuses the space). Tests: backend 1258 → 1271, frontend 510 → 512, integration
  462 + 2 skipped → 468 + 2 skipped; `npm run db:security-check` OK after 057.
  **Production:** apply 057 (additive). On a large `email_outbound_messages` first run
  `create index concurrently if not exists email_outbound_lead_idx on public.email_outbound_messages (lead_id) where lead_id is not null;`
  by hand (not inside a transaction), or apply 057 in a quiet window; the two new tables are empty. Point an uptime monitor at
  `https://<api>/health/worker` (alert on non-200). Keep `DB_POOL_MAX` 10 (API) and `WORKER_DB_POOL_MAX` 10 (worker) within the
  production transaction pooler's client limit, `DB_SESSION_POOL_MAX` 2, and run ≤ (session pooler clients − 2 × 2 − 3)
  connected numbers per worker; measure a real Baileys socket's memory on the first production numbers before raising it.
- **UX-1 (UX audit, design foundations, Settings redesign; branch `ui-redesign`, local only; no OpenAI call, nothing sent,
  no migration):** Item 0: `docs/crm-v2/UX-audit.md` — every route (tasks + clicks, scroll, pagination status, problems,
  fixes), repetitive-work flows before → after, top 10 problems, phase plan UX-2 (lists + repetitive work), UX-3 (records +
  Home), UX-4 (AI / automation + polish; backend keyset lists for workflows, templates, knowledge, notifications). Item 1:
  foundations in `components/crm` — PageHeader `menuActions` + `filters`, `SectionLayout`/`SectionHeader`, `StatusCard`,
  `SectionTabs`, `DetailDrawer`, `SaveBar` + `UnsavedChangesGuard` (TanStack `useBlocker`), `SectionSkeleton`; ConfirmDialog
  ReactNode description + `cancelLabel`; `lib/toast-undo.ts`; contrast pair `danger-soft-foreground` on `surface-raised`;
  C1-ui §11. Item 2: Settings = one route per section (`/settings/<id>`, own chunk) in five groups (Workspace, Channels, AI,
  Personal, Admin) with a sub-nav (phones: section list → section), hidden by permission ("No access" by URL), a settings
  search that jumps to `?tab=` + the field, ⌘K "Settings → <section>" + frequent settings actions (word-based action
  matching), breadcrumbs, redirects from `/settings?tab=…`, `?calendar=` and `/admin`. Item 3: Email / WhatsApp / Google
  Calendar with status cards and tabs (WhatsApp numbers list → drawer `?number=`), every form on the save bar, pause /
  remove / log out / deactivate / disconnect behind confirms (WhatsApp Pause newly confirmed), AI sections split per module;
  backend keyset pages `GET /team/members`, `GET /admin/users` and new `GET /connections/{email,whatsapp}/safety-events`
  (B4 §7v; integration test `settingsLists`). Tests: frontend 512 → 549, backend unit 1271 (unchanged), integration
  468 + 2 skipped → 471 + 2 skipped. First load 298.5 → 284.1 kB gzip. Staging integration: runs 1 and 2 each had one
  unrelated flaky failure (E2h attachment send left queued; a Knowledge asset upload got a Storage 500), each passing when
  re-run alone. **Production:** no migration; the API change is additive in shape (`{data, nextCursor}` on the two lists).
- **UX-2 (lists and repetitive work; branch `ui-redesign`, local only; no OpenAI call, nothing sent, no migration):**
  Item 1: the list standard on Contacts, Companies, Deals, Tasks, Meetings, Proposals — `DataTable` rows per page 25/50/100
  and columns remembered per user + list in the browser (`lib/list-prefs.ts`), density in the Columns menu, `j`/`k`/`x`
  (+ `Enter`, `Esc`, `?` sheet with list and call-queue keys), phone cards with a Sort picker, `rowActions`; Contacts Import in
  the More menu; deal board "Load more (N more)"; duplicates one Actions menu on phones. Item 2: peek drawer `?peek=` on
  Contacts / Companies / Deals (lazy `record-peek.tsx`), inline owner (Contacts, Tasks) and due date (Tasks) with Undo, row
  menus, bulk confirm above 20 + owner Undo, Tasks bulk Reschedule + Undo, Meetings "Record outcome" on Needs outcome,
  `NoteDialog` module, `afterMenuClose`. Item 3: call queue `/tasks/calls` (hottest first, contact facts + `tel:`, outcomes
  1–5 / skip / pause, sent after a 6 s Undo window, resume per IST day); backend: `logCall` accepts an open follow-up task,
  task lists `replyTasks=only|exclude` (B4 §7w). Item 4: Replies queue `/tasks/replies` (audited Show message, Suggested reply
  Send / Discard, Mark done → next) and the sidebar "Replies" badge. Item 5: WhatsApp number drawer asks before discarding
  unsaved settings; UX-1/UX-2 blocks on `/dev/ui`; C1-ui §13, B4 §7w, UX-audit §5 (clicks: 10 calls ≈ 50 → 11, 5 replies
  ≈ 20 + scrolls → 11, one owner 3 → 2, meeting outcome 4 → 3). Tests: frontend 549 → 572, backend unit 1271 → 1275,
  integration +2 (`workListsApi` UX-2 cases) — **not run**: the staging pooler answered "tenant/user … not found" (staging
  project unreachable, probably paused) for the whole phase; the two staging passes UX-1 owed are still owed. First load
  284.1 → 285.6 kB gzip. **Production:** no migration; API changes are additive (a new optional filter; one relaxed rule).

- **DEMO-1 (offline demo journey; branch `ui-redesign`, local only; no migration, nothing sent, no database):**
  Item 1: context provider — `buildAgentContext` = `loadAgentContextSource` (the same SQL) + `assembleAgentContext`
  (`agent/contextAssembly.ts`, DB-free, knowledge search injected); `draftDecision` → `agent/draftDecision.ts`, `writeReplyDraft`
  + `composeReplyDraft` → `agent/replyDraftWriter.ts` (re-exported from their services); `NORTHBEAM_NO_DATABASE=1`
  (`src/noDatabase.ts`): loading `src/db.ts` throws (`dbGuard.ts`, its first import), `DATABASE_URL` may be empty, and
  `installNoDatabaseGuard()` makes any pg connect throw. Unit test: the DB-backed and in-memory contexts from the same data
  are deep-equal and give identical writer and checker prompts. Item 2: `npm run agent:demo-journey -- --input
  demo-local/demo-leads.json --knowledge demo-local/knowledge --out demo-local/output [--confirm] [--max-cost 0.40] [--only <key>]`
  (`src/demo/demoJourney.ts`): per lead, on a simulated clock with the real rules — arrival (hot score, First call task, AI
  enrolled), first WhatsApp (+ the email version for comparison, not sent), the rep's call (simulated note) → call follow-up
  after rep-quiet, a no-reply follow-up, a simulated reply (keyword / AI label, handoff, reply task, suggested reply) and the
  final check as message 8 on a no-reply branch; knowledge chunked + embedded with the real code, searched in memory (top 8);
  dry run by default (plan, prompt sizes, estimate, zero OpenAI calls); `--confirm` writes `demo-journey.md` + `.json`;
  `demo-local/` is git-ignored. Dry-run estimate for both leads ≈ $0.35. Tests: backend unit 1275 → 1284 (identical prompt,
  guard, dry run, max-cost, timing rules, output, first WhatsApp, import graph), frontend 572 (unchanged); staging integration
  **not run** (staging paused; the UX-1/UX-2 passes are still owed, UX-3). **Production:** no migration; no behaviour change.
- **AI-FIX-1 (the demo journey's writing problems; branch `ui-redesign`, local only; no migration, no OpenAI call in tests):**
  The 13 Nov 2026 demo run (Sagar Khanna, Reshma Tantry; 11 messages, first try 64 %) had five problems. Item 1: Reshma's
  "We have done similar account-based work for / We have worked with a premium industrial automation company…" were flagged
  by the checker LLM (not code) as unsupported + `introduction_mid_conversation` although the checker had the whole playbook:
  its introduction rule had no client-experience exception and the list was never named as a source. Now the CLIENT
  EXPERIENCES bullets go to the checker as an approved source, the introduction rule says it is about re-introducing us, and
  `applyGroundingAllowList` drops a flag whose quote is a faithful paraphrase of ONE listed experience; new fixable
  `repeated_client_experience` (Sagar's EPC company in steps 3 and 4) + an "already used" line for the writers. Item 2:
  `final_check` rewritten (goal still a priority, reconnect later; no old-call thanks, recap or call ask), new fixable
  `stale_call_thanks` (call > 7 days old), final-check call ask → "doesn't ask for a call"; `call_followup` quotes the lead's
  question from the call note and answers it from the knowledge (Reshma: how we qualify leads). Item 3: reply drafts never
  claim or deny unlisted experience (Reshma's GCC question had no draft: both attempts `unsupported_claim`) — the rep walks
  them through it on a short call, and the checker never flags that; WhatsApp drafts start with the first name. Tests: backend
  unit 1284 → 1303, frontend 572 (unchanged); staging integration **not run** (staging paused). **Production:** no migration;
  prompt + check changes only.
- **LL-1 (safety net: no active lead without a next action; branch `ui-redesign`, local only; migration 058 written, NOT applied;
  no OpenAI call, nothing sent):** LL-0 (`docs/crm-v2/LL-0-gap-report.md`, untracked) found many paths leaving an active lead with no
  open task and nobody told. Item 1: migration 058 (`agent_settings.next_action_sweep_since` default = apply time; `tasks (lead_id)
  where open` and `leads (workspace_id, last_activity_at)` partial indexes) + pure `domain/nextAction.ts` (`needsNextAction`,
  `sweepTask`, `resolveResponsible`, `batchBells`, `aiStopTask`). Item 2: `services/nextAction.service.ts` (every LL-1 query) + worker
  step `next_action_sweep` every 15 min (≤ 200 per workspace, ≤ 1000 per tick, round-robin, locked per-lead re-check): "Decide the next
  step" (follow_up, now) or "Plan re-engagement" (re_engage, +45 d), timeline "No next action — task created", one bell per person per
  tick; CLI `npm run ll:sweep -- --dry-run [--workspace] [--since]`. Interpretations: shadow AI never covers a lead (it sends nothing);
  the rollout guard also counts an AI status change or a task closed after `since` (a task completed after release on an old lead is
  the main leak, H9). Item 3: AI stop (decision or reply label) → task + bell (no_response → long-term nurture; skipped while a reply
  task is open); every matched reply gets the reply task (unowned → admins); unassigned handoff → unowned task + admins' bell; meeting
  cancelled / no-show / failed → "Reschedule the meeting" +1 d unless another future meeting; meeting-outcome reminder no longer skips
  unowned meetings; website leads `autoEnroll("lead_created")` (no published workflow → no-op: the lead has only the First call task
  and, if the AI takes it, the AI); owner-only bells (WhatsApp reply, email reply, opt-out / unsubscribe) → rule 1; reply escalation
  says "Nobody has answered … (no owner)" for an unowned task. Tests: backend unit 1303 → 1341, frontend 572 (unchanged); integration
  tests written, **not run** (staging down): `nextActionSweep`, `nextActionDirectFixes`, and updated expectations in `whatsappInbound`,
  `emailInbound`, `replyClassification` — all owed to INT-1 (`docs/crm-v2/INT-1-owed.md`). **Production:** apply 058 (indexes:
  `create index concurrently` by hand first on a big table), run `npm run ll:sweep -- --dry-run` and decide whether to move
  `next_action_sweep_since` before the worker is deployed.
- **LL-2 (reminders, escalation and staff email; branch `ui-redesign`, local only; migration 059 written, NOT applied; no OpenAI call;
  the only messages to leads are fixed-text meeting reminders / "Updated" confirmations):** Item 1: migration 059 + pure
  `domain/workingTime.ts` (Mon–Sat 09:30–19:00 IST = `DEFAULT_SEND_WINDOW`, the one definition; `addWorkingTime` moved there from
  `replyDrafts`; holidays not supported) and `domain/reminders.ts` (first-call due, due-bell time, escalation kind, reminder schedule,
  fixed texts). Item 2: worker `task_reminders` — due bells batched per person per tick, admins' escalation of tasks 1 working day
  overdue and of website first calls 1 working hour after due (once, `tasks.escalated_at` reused; reply tasks keep their 2-hour
  escalation), website first call due 1 working hour after creation, "AI message failed" bell via rule 1, meeting-outcome task 2 h after
  the end. Item 3: worker `meeting_reminders` / `meeting_reminder_whatsapp` — lead 24 h / 1 h (email + WhatsApp on the sticky number;
  `meeting_reminders_enabled`, default on), rep 1 h (bell + email), service messages (`meeting` safety rules, no AI limits, no wake-up,
  no message fact), reschedule resets reminders and re-sends the confirmation "Updated: …". Item 4: urgent bells also emailed
  (`notifications.email_status`), worker `staff_alert_emails` (one email per person per tick, workspace mailbox SMTP directly, not the
  lead queue) + `morning_digest` 09:00 IST; Settings → My profile "Email alerts" (two switches), Users drawer switches, AI limits
  "Meeting reminders to the lead"; `APP_BASE_URL` (new, optional). Interpretations: a WhatsApp reminder needs the lead's sticky number
  (no reminder from a number that never talked to them); the 24 h reminder's "last window slot" = 15 min before closing; alerts older than
  a day are not emailed; "one admin warning" = once per workspace ever; the AI handoff now always bells (was: unowned only); the
  meeting-reminder setting sits in the AI limits card. Tests: backend unit 1341 → 1398, frontend 572 → 575; integration tests written,
  **not run** (staging down): `taskReminders`, `meetingReminders`, `staffAlerts`, updated `leadIngest` — owed to INT-1. **Production:**
  apply 059 before deploying API, worker and frontend (the AI limits Save sends `meetingRemindersEnabled`); staff emails need the
  workspace's SMTP mailbox (Settings → Email); set `APP_BASE_URL` on the worker; Govinda approves the reminder texts.
- **INT-1 (staging integration run for UX-1 … LL-2; branch `ui-redesign`, local only; staging `arejsxqjhzotmngrobhm` only; no
  OpenAI call, nothing sent to a lead):** staging was at 057. Migrations 058 and 059 applied twice (second run no change),
  `db:security-check` green. Every owed LL-1 / LL-2 integration file runs and passes; all failures were test bugs (raw inserts
  against the lifecycle / workflow-draft / run-completed triggers and constraints, enum parameter casts, doubled `/api/v1` prefix,
  owners that were not workspace members under LL-1 rule 1, a fake reply-task title, the old 2-day outcome window, `error.message`
  shape) — commits `655c55a`, `f3e20f7`. Item 4 (`5373f46`): demo-journey first call now reads "within 1 working hour" with the
  working-time due; admin Users drawer email switches covered by a component test. Full suite: runs before the pair 502 / 5 failed
  and 506 / 1 failed (fixed / `agentAssets`); final pair 505 / 2 failed (`replyClassification`, two 60 s timeouts in a slow run) and
  506 / 1 failed (`agentAssets`, a staging Storage step) — both files pass alone, every LL-1 / LL-2 file passed in every run; **not
  green twice in a row**, treated as staging slowness. LL-1 sweep dry run: **0 leads in 0 workspaces** (default and
  `--since 2026-01-01`). `explain (analyze)` on 20,000 load-seeded leads: every new index used, no sequential scan on a big table;
  `SWEEP_CANDIDATES_SQL` ~970 ms and `SWEEP_COUNTS_SQL` ~870 ms over the 500 ms target (nested-loop anti-join on future meetings),
  `DIGEST_CANDIDATES_SQL` ~210 ms, the rest < 30 ms; no migration 060; load seed removed. One worker tick
  (`WORKER_DRY_RUN=true`, `AGENT_RUNNER_ENABLED=false`): 25 heartbeats, no step error, LL steps 0 items (the read-only IMAP poll
  processed 17 replies from the MOTM mailbox). One real urgent-alert email and one digest sent to one staff login (inbox check
  by a person still owed). Tests: backend unit 1398, frontend 575 → 576. Still open: sweep query time, the two flaky files,
  `leads.service.ts` manual inbound bell "call within 1 hour" (not working hours), `APP_BASE_URL` unset on staging.
- **UX-3 (records + Home + leftovers; branch `ui-redesign`, local only; staging only, nothing sent, no OpenAI):** Item 0: the two
  flaky files fixed without weakening them — `replyClassification` (an inbound reply is ~37 sequential pooler queries at ~40 ms;
  independent scenarios split into their own tests, independent workspaces built in parallel; no timeout raised) and `agentAssets`
  (checked Storage upload / remove errors with retry, a bounded re-tick while a 10 MB download fails temporarily, the remove re-sent
  while Storage still serves the file); each 3× alone green, full suite **green twice in a row** (510 / 510). Item 1–2: `RecordShell`
  for contact / company / deal (sticky header + primary actions, composer + one paged Activity feed with 7 chip groups, collapsible
  rail remembered per record type, phones: tabs; deal stage stepper; breadcrumbs back to the list's filters; peek → ⌘K Recent).
  Backend: notes on a deal (`dealId`), notes / calls grouped by kind first, meeting reminders sent to the lead as timeline rows (kind
  `meeting_reminder`, never in the AI context). Item 3: `GET /home/summary` "My day" (replies, calls, meetings, next-step tasks,
  overdue; admins: team row + red flags incl. no mailbox). Item 4: `POST /tasks/:id/reopen` + Undo on every Complete (LL-2 bells
  never repeat), bulk Assign owner on Companies and Deals (not Meetings / Proposals: no owner change in the API), Connected calls
  count in the call queue, manual inbound lead bell "New lead — call now" + first call due now (was + 1 h, contradicting LL-2),
  meeting-reminder switch → Settings → Google Calendar. Contact page 5–7 screens → ≈ 1 (estimated from the layout). Tests: backend
  unit 1398 → 1401 (+ integration `taskReopen`, `ux3Records`), frontend 576 → 590; first load 285.7 → 285.7 kB gzip.
- **LL-3 (calls & recovery; branch `ui-redesign`, local only; migration 060 applied twice on staging; no OpenAI call; the only new
  message to leads is the fixed-text "We tried calling" WhatsApp):** Item 0 found: outcomes in `domain/enums.ts` (+ PG enums), no
  plain Not interested; lead Lost (`leads.loss_reason`, drives recovery) vs deal Lost (own reason; a lost contact closes its deals with
  `other`); AI-only follow-up limits (counted from `agent_decisions`); workflows blocked by `lifecycle_state = 'active'` in
  `automation.service.ts`; call-outcome workflows only prompted; `interested_later_restart_at` read by nothing but the rep task; no
  proposal validity / decision date. Item 1: migration 060 (enum values, `calls.attempt_number`, `tasks.marker` / `call_attempt`, lead
  recovery / competitor / project date / discard reason, `proposals.valid_until` + markers, deal decision date / `stage_changed_at` /
  review markers, `tried_calling_whatsapp_enabled`, `tried_calling_messages` = the 7th WhatsApp source, worker indexes) + pure
  `domain/callAttempts.ts`, `domain/recovery.ts`, `domain/dealFollowUp.ts`. Item 2: Not interested → Lost (reason required),
  Interested later (restart date required; call-back task 09:30 IST; AI wake-ups / sends and workflow message steps wait), retry
  ladder ("Call attempt N", 5 attempts, then long-term nurture + "Decide the next step" unless covered; wrong number → "Fix the phone
  number"), "We tried calling" WhatsApp (worker `tried_calling_whatsapp`), call-outcome workflows auto-enroll (Meeting Agreed still
  schedule-first), "Attempt N of 5" in the queue. Item 3: Lost recovery (worker `lost_recovery`), discard reason, workflows in
  long-term nurture. Item 4: proposal valid-until, deal next decision date (required into negotiation), worker `deal_follow_ups`
  (expiring / expired proposal, decision date passed, 10-day manager review), Won → onboarding task. Interpretations: every
  not-connected reason except wrong / invalid number counts as No answer; the "tried calling" message may be the first WhatsApp to a
  lead (no safety rule forbids it: it gets the opt-out line and counts toward the 20 new chats a day) and picks a number when the lead
  has none (that number then sticks); it is dropped (not deferred) once the AI 7-day / total limit is reached and says "earlier"
  instead of "just now" when sent on a later day; "other" recovers after 60 days; recovery is lead-level (a deal lost with the contact
  kept active is covered by the LL-1 safety net); the "approval pending" deal stage does not exist, so the decision date is required
  for `negotiation` only; the manager-review task is unowned (admins' bell); proposal / deal markers only start with rows sent / moved
  after 060 (existing deals get `stage_changed_at` = apply time). Tests: backend unit 1401 → 1438, frontend 590 → 600 (+ integration
  `ll3Calls`, `ll3Recovery`, `ll3Deals`; updated `workListsApi`, `agentContext`, `deals`, `dncExit`). LL-1 sweep dry run: 0 leads.
  Staging integration: first full run 4 failures (old expectations: open tasks after Won, negotiation without a decision date) → fixed (`5ad4b92`); then run A 533 / 533 green (2121 s), run B 532 / 533 (`agentAssets` "WhatsApp after the contact replied": the AI send `deferred` instead of `sent`; the file passes 3× alone) — **not green twice in a row**, reported, not re-run. **Production:** apply 060 before deploying API, worker and frontend; Govinda approves the "We tried calling" text.
- **LL-3b (LL-3 review fixes; branch `ui-redesign`, local only; no migration; no OpenAI call, nothing sent):** Rule 1 (Govinda,
  18 Nov): the "We tried calling" WhatsApp still counts toward 2 per week (shared with the AI) and skips the 48 h gap, but no longer
  toward the AI's 8 in total (removed from `touch_count` / `agentTouchCount`; still in `recent_touches`); own cap 3 per lead, ever
  (`MAX_TRIED_CALLING_MESSAGES`). Rule 2: the LL-2 due bell + overdue escalation also for rule-9 deal tasks (`DEAL_FOLLOW_UP_MARKERS`,
  e.g. "Onboarding: …") on a Won lead. Rule 3: the safety net's "Plan re-engagement" uses the loss reason's recovery date
  (`domain/recovery.ts` `reengagementDueAt`, lost date shared as `LOST_AT_SQL`) while that loss is unrecovered and the date is ahead;
  once recovered (its "Re-engage" task exists) or past, + 45 days. Rule 4: lead Lost → its open deals close with the lead's loss reason
  (deals share the `lead_loss_reason` enum: no mapping needed) + "competitor: <name>" in the notes. Rule 5: "Valid until" editable
  after sending in the proposal sheet (`ProposalValidUntil`; PATCH guarded: admin / proposal or contact owner, timeline row). Rule 6:
  the manager review stays unowned; it did not show anywhere for admins but the bell (Home cards were owner = me only) → an admin's
  Home overdue + "Decide the next step" cards include unowned tasks (Manager review lands in overdue: due at creation), Tasks owner
  option `none` labelled "Admins (no owner)". Item 2 (`agentAssets` run B): not the clock — every window in that file is 24 h × 7
  days and its lead is not fresh-inbound; likeliest cause a transient Storage download in the WhatsApp attachment send (any
  non-provider error → "Temporary error, will retry" → `deferred`); no other integration test asserts a send without a 24 h window,
  a fixed `now` or a mocked sender; the file was left unchanged (reported, not a test bug). Tests: backend unit 1438 → 1442, frontend
  600 → 603 (+ integration cases in `taskReminders`, `deals`, `dealsC4Api`, `ll3Deals`).
