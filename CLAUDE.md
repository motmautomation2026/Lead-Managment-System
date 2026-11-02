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
- Email has no env vars (E1b): no `RESEND_API_KEY` / `SMTP_FROM_*`; the SMTP + IMAP mailbox is saved per workspace by an
  admin in Settings → Email. Tests never contact a real SMTP/IMAP server or DNS (fake transport, IMAP client, resolver).
- `EMAIL_IMAP_POLL_SECONDS` (worker; default 120, 30–3600): how often each workspace's mailbox is read over IMAP (D3).

## Tests

- `npm run check` (in both `Backend/` and `Frontend/`) must pass and stays database-free.
- Integration tests (`Backend/tests/integration`) need `TEST_DATABASE_URL` (staging), run
  serially, and refuse the prod ref.
- Integration tests never write into real workspaces (e.g. MOTM, which may auto-enroll new leads
  in the AI and spend credits): only `[test] …` workspaces from `createTestWorkspace`.
  `tests/setup-env.ts` fails a file that leaves leads by test users (`@example.com`) in any other
  workspace.
- Run the staging integration suite one at a time; never overlap runs; read the result from the run's exit code/log.
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
  (currently `047`).
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
- Inbound email reply text (D3) follows the same rules: subject + text (quoted history stripped, never HTML or attachments)
  stored only encrypted (AAD `email:inbound:<event id>`), only for replies matched to exactly one contact, never logged.
- Inbound text is readable only through `GET /contacts/:id/replies/:messageId` (WhatsApp) and
  `GET /contacts/:id/email-replies/:replyId` (email) (owner + admins, every read audited in `inbound_message_views` with its
  `channel`, `Cache-Control: no-store`); never in lists, timelines, search, notifications, tasks, AI or logs.
  Sole exception (D4a, D3): the worker's reply classifier decrypts it once to label it (WhatsApp or email; no DB client held
  during the call, strict label + confidence schema); only the label is stored, and the decision agent never gets the text.
- Do not treat pipeline stage and lifecycle state as interchangeable.
- Do not edit published workflow versions; create a draft and publish a new version.
- Do not rotate `INTEGRATION_ENCRYPTION_KEY` casually.
- Do not skip migrations or apply only `001_initial_migration.sql`; the latest project needs every migration from `001` through the latest (currently `047`).

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

## WhatsApp safety (E1)

- Every WhatsApp send — workflow steps, rep proposal/meeting messages and (E2) the AI agent — goes through
  `domain/whatsappSafety.ts` `decideSend` inside `performSend` (`providers/baileys.manager.ts`). **E2 must route agent sends
  through it** (source `agent` = automated). No other code path may call `sendMessage`.
- Rules (per workspace, admin-adjustable): 1 spacing random 45–120 s between any two sends; 2 "typing…" ~2–8 s by length
  before each send; 3 warm-up cap min(cap, 20/40/80) for IST days 1–3/4–7/8–14 after pairing (`paired_at` null = warmed);
  4 ≤ 20 first messages per IST day to phones never messaged / never heard from, else defer to the next day's window;
  5 automated sends only in the send window (Mon–Sat 09:30–19:00 IST), else the next opening + 0–20 min; rep proposal/
  meeting sends ignore the window but not spacing, caps or pause; 6 a first automated message must not contain a link
  (permanent failure "First WhatsApp message can't contain a link") and gets "Reply STOP to opt out." unless it says STOP;
  7 auto-pause (`enabled` = false + `paused_reason`, admins notified once, only an admin resumes; signals count only after
  `resumed_at`): restriction, 401/403/440 close, ≥ 5 send failures (not "not on WhatsApp") or ≥ 5 dropped connections /
  failed reconnects in 30 min, ≥ 3 STOP replies or ≥ 5 % of ≥ 40 sends in 24 h. Paused sends defer, never fail;
  8 clearing a WhatsApp opt-out is admin-only with a reason; 9 `WORKER_DRY_RUN` unchanged.
- Deferrals never burn attempts. Never hold a DB transaction across a wait or the network send.

## Email safety (E1b)

- Every email — workflow steps, rep proposal/meeting emails, the Settings test and (E2) the AI agent — is a row in
  `email_outbound_messages` (`enqueueEmail`, one per source) and is sent only by the worker (`runEmailOutbound` →
  `processEmail`), through `domain/emailSafety.ts` `decideEmailSend`. **E2's AI emails must be queued the same way**
  (source `agent` = automated). No request handler sends email; nothing else may call `sendMail`.
- Rules (per workspace, admin-adjustable): 1 SMTP only; provider `resend`/none = not set up → defer 15 min with "Email is not
  set up. An admin must add the SMTP mailbox in Settings → Email." (never fail); 2 settings admin-only, secrets write-only;
  3 login tests read-only, 15 s; 4 claim SKIP LOCKED, reclaim `sending` after 15 min, no transaction across the SMTP call;
  5 4xx/timeouts/connection errors temporary (backoff 5/10/20/40 min, 5 attempts → failed), 5xx recipient → failed + the
  contact's email `invalid` (5.1.x) or `permanent_bounce`, 535/EAUTH or 421 or 4.7.x or 5.7.x → auto-pause (email
  re-queued, no attempt); 6 spacing random 30–90 s (> 20 s defers via `next_send_at`), ≤ 20 per IST clock hour, daily cap
  100, warm-up min(cap, 20/40/70) for IST days 1–3/4–7/8–14 after `configured_at` unless `already_warmed`; 7 automated email
  only in the send window (Mon–Sat 09:30–19:00 IST) + 0–20 min jitter; proposal/meeting/test ignore the window, not the
  rest; 8 auto-pause (`enabled` false + reason, admins notified once, admin resume; signals after `resumed_at`): rule 5
  responses, ≥ 5 temporary failures in 30 min, ≥ 5 % recipient rejections of ≥ 40 attempts in 24 h; paused emails defer;
  9 recipient checks (syntax, DNC, email contactability `invalid|permanent_bounce|unsubscribed`) fail with the reason;
  10 From "<owner> | <company display name>" for contacts else the default name, Reply-To, `Message-ID <uuid@from-domain>`
  stored, Date, text + HTML, `List-Unsubscribe: <mailto:…?subject=unsubscribe>` to contacts, no tracking/`Precedence`,
  attachments ≤ 10 MB; 11 DNS check reads only; 12 monitoring for every CRM user; 13 `WORKER_DRY_RUN` marks sent
  (`dry_run`, not counted) without SMTP.
- Deferrals never burn attempts.
- D3: SMTP 451 auto-pauses only with a `4.7.x` code or rate-limit wording ("rate", "limit", "too many", "throttl"); other
  451s are temporary retries. A queued meeting email whose meeting has started / was cancelled is cancelled ("Meeting time
  has passed" / "Meeting was cancelled").
- D3 IMAP (read-only): the worker polls each workspace with a saved IMAP login (also while sending is paused) every
  `EMAIL_IMAP_POLL_SECONDS`, one workspace at a time, connect → EXAMINE → SEARCH/FETCH (`BODY.PEEK`, ≤ 1 MB per message) →
  logout, 30 s timeouts. Never set flags, move, copy, delete or expunge; only the configured folder. First poll (and after a
  UIDVALIDITY change): only mail after the IMAP login was saved (after the last good poll); then by UID, ≤ 50 per poll; every
  message once. IMAP errors → `last_error` (plain text), retried next poll; a rejected IMAP login never pauses sending (admins
  notified once per IST day).
- D3 effects: a 5.x.x DSN → our email `bounced_at`, the contact's email `invalid` (5.1.x) / `permanent_bounce`, a
  `recipient_rejected` event (counts toward the 5 % pause); 4.x.x / delayed → recorded only; out-of-office → timeline only;
  "unsubscribe" to our List-Unsubscribe address → email `unsubscribed` + AI stopped (`asked_to_stop`), never DNC; a matched
  reply behaves like a WhatsApp reply (automation stopped, reply task + handoff for AI contacts, D4a labels; `asked_to_stop` →
  email `unsubscribed`). Clearing an email `invalid|permanent_bounce|unsubscribed` is admin-only with a reason.

## Baileys rules (https://baileys.wiki)

- B1 presence: `composing` per chat expires after ~10 s → resend every ≤ 8 s, then `paused`, then send. Keep
  `markOnlineOnConnect: false`; never leave the client `available` (it mutes the paired phone's notifications).
- B2 send to the JID `onWhatsApp` returns (`exists`), built from digits only; v7 sessions are LID — inbound keeps using
  `remoteJidAlt`; never "restore" PN JIDs from LIDs.
- B3 never re-enable delivery ACKs, never `readMessages` automatically, never `chatModify`.
- B4 401 → no reconnect, clear auth, new QR; 403/440 → no reconnect, pause; 411/500 → stop, clear auth, re-pair;
  515 → reconnect at once; others → backoff 5 s → 10 min + jitter; ≥ 5 in 30 min → pause.
- B5 `getMessage` returns the stored outbound payload; `msgRetryCounterCache` lives outside the socket; `maxMsgRetryCount` 5.
- B6 persist creds on every `creds.update` and keys immediately; the store accepts `lid-mapping`, `device-list`, `tctoken`.
- B7 never fetch the WA Web version per connect (pinned by the installed Baileys); standard `Browsers` preset for new
  pairings only; no history sync; no link previews (`link-preview-js` not installed); stay on 7.0.0-rc14 (v8 is pre-release).

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
- Name wins over domain (E2f, B2-design §2.1 step 4): free-mail and reserved/test domains are never corporate; a contact whose
  company name differs from the same-domain company's (trigram similarity < 0.6) gets its own company by name (no domain) +
  a `same_domain_different_name` pair, and its `leads.company` is not overwritten; ≥ 0.6 links as before. Only new links
  change; existing links stay.
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
- Workspace modes: `off` (default) → `shadow` (drafts only, sends nothing) → `live` (E2). In `live` the **live scope** picks
  the live AI contacts: `test_contacts` (marked "AI live test" by an admin; no gate), `new_leads` (created ≥ `live_since`),
  `all`; the last two need the go-live gate (`goLiveReadiness`, checked in the backend; E2f: only decisions created since
  `agent_settings.readiness_since` count, reset by an admin). Every other AI contact runs as
  shadow. `agent/liveMode.ts` `effectiveMode` is the only place that decides; runner, send path and UI use it (bulk SQL
  mirror: `liveContactSql`). Only admins change mode, scope or the mark.
- Live sends only from the worker, through the channel queues and their safety rules (WhatsApp `performSend` →
  `decideSend` source `agent`; email `email_outbound_messages` source `agent`), one per decision, re-checked right before the
  provider call (`sendRecheck`: AI status, lifecycle/DNC, channel status, any reply after the decision, IMAP health for
  email, an active workflow run, mode/scope/mark, limits on real sends, ≤ 24 h old; time problems defer, the rest cancel).
  AI email only while the workspace's IMAP polled OK in the last 30 min. Kill switch: shadow/off, narrower scope, mark
  removed, paused/stopped contact → queued sends are cancelled at the re-check; WhatsApp pause defers.
- Live counting: touches, gaps and limits use real sends only (`outcome = 'sent'`); `leads.agent_touch_*` only on a real
  send; shadow drafts never count for a live contact and are labelled "draft — never sent to the contact" in prompts.
- One question per message (both modes): > 1 → regenerate (up to twice, E2f) → handoff.
- E2f (both modes, in code): signals from the website enquiry/industry (consumer business → stop `not_a_fit`) and the latest
  call/note (price, visit/in-person, ready for a call/next step → handoff) turn any send into that action without a
  regeneration (`agent/signals.ts`, `rules.signal`); never offer or promise a visit. A banned phrase negated within 3 words
  ("we cannot guarantee orders") is allowed.
- E2c/E2d (both modes, in code, never the model): an inbound first message with no conversation yet must thank the lead; when a conversation exists
  (`situationOf(ctx).conversationExists`) no introduction or first-call ask; never ≥ 4 consecutive words of the internal
  company description or open deal name (`internal_info_leak`, serious).
- Message quality (E2b, both modes, every send decision): code checks first (`checkMessage`: admin-editable banned phrases,
  word limits from settings, one question about one thing, no "!"), then the grounding call also returns playbook style
  problems; every problem from either goes into the regeneration as feedback (one; E2f: a second only while the latest
  attempt failed only fixable code checks, never after a grounding problem or `internal_info_leak`), then handoff. The prompt's limits and
  banned phrases always come from `agent_settings`, never hard-coded. Live handoff = one open owner task "AI handed
  off — please follow up"; stop → `stopped` with the reason; update_stage only within `AGENT_STAGE_ALLOW_LIST` via
  `updateLead`.
- A contact is never AI-live and in a workflow: becoming live cancels its runs ("Managed by AI agent"), `autoEnroll`
  skips it, manual enrolment → 409.
- Attachments (E2g, both modes, in code): only assets from the library on their allowed channels (rule 1 = violation);
  never before a conversation or a real message from us, WhatsApp only after the contact replied on WhatsApp, never the
  same asset twice, ≤ 2 email / ≤ 1 WhatsApp, ≤ 10 MB in total — these DROP the attachment and keep the message (no
  regeneration, recorded in `quality_checks`). The AI sees only an asset's title and "use when"; asset chunks are never a
  fact source (decide or grounding) and grounding flags numbers/results attributed to an attachment. Live sends attach the
  file (email attachment / one WhatsApp document with the text as caption); a file gone, turned off or over 10 MB at send
  time → sent without it, recorded, unless the text mentions an attachment (E2h): then cancelled `attachment_missing`, no
  touch, a new wake-up. A message never mentions an attachment it won't carry (`attachment_mention`, fixable, then handoff).
- Approved fact sources (prompt + grounding): knowledge, playbook, lead data (incl. call/note text and the company
  facts: name, domain, website, industry, location, employees, revenue). Internal context (company description +
  the open deal and won/lost counts) is decide-only: never stated, never a grounding source, never amounts/loss notes.
- The agent never marks Won/Lost/DNC, never deletes, never changes the owner; never contacts
  DNC/won/lost/discarded/merged leads or leads whose `agent_status` ≠ `active`. Every safety ceiling, the daily decision
  cap and the monthly budget apply in live as in shadow.
- Reply labels (D4a): a matched WhatsApp reply is labelled by keyword first (every contact, every mode: `stop`,
  `unsubscribe`, `remove me`, `don't message me`, `do not message`, `not interested`, … — exact short phrases only, list in
  `domain/replyKeywords.ts`), else by the worker's AI step (AI contacts, non-off mode, budget left). `asked_to_stop` → WhatsApp
  opted out + AI stopped (permanent); `not_interested`/`annoyed` → AI stopped (permanent); never Do Not Contact (a rep
  decision). A rep's correction never undoes these.
