# Northbeam CRM — project rules

## Project

Northbeam CRM. Start from `CONTEXT.md`, then `docs/audit/01`–`07` (a 2026-10-21 code
audit; findings A1–A23 and B1–B40, summarised in `docs/audit/07-findings.md`).

## Git

- Work on branch `dev` only. Commit once per item.
- Never push to `main`. Push to `dev` only when asked.

## Environments

- `Backend/.env` and `Frontend/.env` point to a **STAGING** Supabase project.
- The **PRODUCTION** project ref is `jorxltfwboabyjiydyhu`. Never connect to, migrate or
  query anything containing it.
- Never print passwords, keys or full connection strings.
- `OPENAI_API_KEY` / `OPENAI_EMBEDDING_MODEL` (default `text-embedding-3-small`, must be 1536
  dims) are optional, backend + worker only, never the frontend. Tests never call OpenAI:
  inject an `Embedder` (`tests/helpers/fakeEmbedder.ts`) or a `DecisionModel`
  (`tests/helpers/fakeDecisionModel.ts`). The agent also reads `OPENAI_DECISION_MODEL`,
  `OPENAI_GROUNDING_MODEL` (defaults when a workspace sets none) and `OPENAI_PRICES_JSON`.
- `CRM_COMPANY_SWEEP_ENABLED` (worker; default on, off only when exactly `false`): the company sweeper.
- `CRM_DEAL_SWEEP_ENABLED` (worker; default on, off only when exactly `false`): the deal backfill sweeper.

## Tests

- `npm run check` (in both `Backend/` and `Frontend/`) must pass and stays database-free.
- Integration tests (`Backend/tests/integration`) need `TEST_DATABASE_URL` (staging), run
  serially, and refuse the prod ref.
- Integration tests never write into real workspaces (e.g. MOTM, which may auto-enroll new leads
  in the AI and spend credits): only `[test] …` workspaces from `createTestWorkspace`.
  `tests/setup-env.ts` fails a file that leaves leads by test users (`@example.com`) in any other
  workspace.
- Never pipe test or check commands through `tail`, `head` or anything else that hides the exit code.
  Check every exit code.
- Push ONLY after `npm run check` passes in both packages AND `npm run test:integration:staging` has
  passed twice in a row. If a run fails, investigate, fix or report it, and do not push.
- Run them with `npm run test:integration:staging` in `Backend/`. It loads
  `TEST_DATABASE_URL` (plus the staging `SUPABASE_URL` / service key, for Storage) from
  `Backend/.env`, refuses the prod ref, and runs `tests/integration`. Run it after every backend change.
- Stop any local `npm run dev` / `npm run worker:dev` that points at staging first. They
  share the 15-slot session pooler (tests then fail with `EMAXCONNSESSION`). A live worker
  also claims queued proposal/meeting rows that the tests create.

## DB connections

- The staging session pooler allows **15 client connections in total** (API, worker, WhatsApp lock
  clients, tests, scripts, the Supabase dashboard). Every pooled connection counts while open, even idle.
- Env (backend + worker): `DB_POOL_MAX` (API) and `WORKER_DB_POOL_MAX` (worker), default 10 each;
  `DB_IDLE_TIMEOUT_MS` (10000); `DB_CONNECTION_TIMEOUT_MS` (15000, how long a query waits for a
  connection). Local staging `.env`: `DB_POOL_MAX=5`, `WORKER_DB_POOL_MAX=4`.
- The worker also holds one dedicated connection per running WhatsApp manager (lock client). It starts
  managers (every tick, one at a time) only for active workspaces whose `whatsapp_connection` has
  `desired_state` connected/restart, or a live status while disconnecting; unneeded managers are
  stopped (lock client closed). No row = no manager.
- Integration tests create workspaces with `createTestWorkspace` (`tests/helpers/testWorkspaces.ts`,
  name `[test] <label> <uuid>`) and delete them in `afterAll` with `deleteCreatedTestWorkspaces`
  (FK-safe, throws on failure). Never insert/delete workspaces directly in tests.
- Leftovers on staging: `npm run staging:cleanup-test-workspaces` (dry run; `-- --confirm` deletes;
  staging ref only; never MOTM / Quick ICP / workspaces with a `whatsapp_connection` row).
- On EMAXCONNSESSION run `npm run db:connections -- --probe` (Backend). Behind the pooler every
  connection shows as `Supavisor` in `pg_stat_activity`; `--probe` counts free client slots.
- Stop the local API/worker before integration tests.
- Production: `DB_POOL_MAX` + `WORKER_DB_POOL_MAX` + WhatsApp lock clients must stay below the
  production pooler size (Supabase → Database → Connection pooling); check it before deploying.

## Migrations

- Additive only, numbered after the highest existing file in `Supabase/migrations/`
  (currently `037`).
- Apply them to staging only.

## Architecture boundaries

(Copied from "Non-Negotiable Project Boundaries" in `CONTEXT.md`.)

- Do not reintroduce frontend fixture/demo data for production CRM flows.
- Do not bypass Supabase Auth or trust client-supplied user IDs.
- Do not put service-role keys, provider secrets, encryption keys, or SMTP credentials in the frontend.
- Do not duplicate business routing tables in React.
- Do not send provider messages from manual Email/WhatsApp activity buttons.
- Do not execute workflow sends in request/response handlers; use the worker.
- Inbound WhatsApp text is stored only encrypted (AAD `whatsapp:inbound:<message_id>`), only for replies matched to exactly one lead, is never logged, and is not sent to the frontend except through explicit, access-checked endpoints.
- Do not treat pipeline stage and lifecycle state as interchangeable.
- Do not edit published workflow versions; create a draft and publish a new version.
- Do not rotate `INTEGRATION_ENCRYPTION_KEY` casually.
- Do not skip migrations or apply only `001_initial_migration.sql`; the latest project needs every migration from `001` through the latest (currently `037`).

## Way of working

- One coherent unit per task. Don't touch unrelated code.
- If the code contradicts the audit, stop and report.
- Finish with a diff summary and test results.

## Completed so far

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

## CRM v2

- Design: `docs/crm-v2/B2-design.md` (approved); inventory `docs/crm-v2/B1-inventory.md`.
- List API contract: `docs/crm-v2/B4-api.md`. Every new list uses `lists/listQuery.ts`: keyset `cursor`
  (base64url `[sortValue, id, sort]`, 400 when invalid), `sort` from a per-object whitelist (NULLs last), `limit` 1–100
  (default 50), flat `.strict()` filters, `q` ≥ 2 chars through `escapeLike`, `{data, nextCursor}` plus a `/count`
  endpoint with the same filters. Every sortable field needs a `(workspace_id, field, id)` index (exception: companies
  `contactCount`). Values only as bind parameters (`SqlBuilder.p`).
- Contacts = rows in `leads` (UI says Contact). `leads.company` stays populated and is kept equal to the linked
  company's name (placeholders such as "Not provided" → no company, text unchanged).
- Company linking never blocks creating or editing a contact; failures are retried by the sweeper.
- Frontend (C phases, `docs/crm-v2/C1-ui.md`): build pages from `components/crm` (PageHeader, ViewTabs, FilterBar,
  DataTable, RecordLayout, PropertyList, AssociationCard, EmptyState, StatusPill, Money…); theme tokens only, no
  hard-coded colours; lists always server-side via the B4 endpoints (never fetch everything); list state
  (filters/sort/view/q) in the URL via `useListUrlState`; icon-only buttons need `aria-label`; every page has
  loading/empty/error states and works at 375 px; new forms use react-hook-form + Zod.
- Deal routing lives in `domain/dealRouting.ts`; event-driven deal moves never touch the contact; only a
  manual deal won (no other open deal) syncs the contact (via `markWon`). Deal code never changes DNC, the
  contact owner, `agent_status` or automation.

## AI agent (Feature 3)

- One action per wake-up: `send_email`, `send_whatsapp`, `wait`, `handoff`, `update_stage`,
  `stop`. Code enforces the safety rules (`src/agent/rules.ts`), not the model.
- Workspace modes: `off` (default) → `shadow` (drafts only, sends nothing) → `live`
  (Feature 6). Nothing in Feature 3 sends messages to leads.
- The agent never marks Won/Lost/DNC, never deletes, never changes the owner; never contacts
  DNC/won/lost/discarded/merged leads or leads whose `agent_status` ≠ `active`.
