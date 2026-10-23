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

## Tests

- `npm run check` (in both `Backend/` and `Frontend/`) must pass and stays database-free.
- Integration tests (`Backend/tests/integration`) need `TEST_DATABASE_URL` (staging), run
  serially, and refuse the prod ref.
- Run them with `npm run test:integration:staging` in `Backend/`. It loads
  `TEST_DATABASE_URL` (plus the staging `SUPABASE_URL` / service key, for Storage) from
  `Backend/.env`, refuses the prod ref, and runs `tests/integration`. Run it after every backend change.
- Stop any local `npm run dev` / `npm run worker:dev` that points at staging first. They
  share the 15-slot session pooler (tests then fail with `EMAXCONNSESSION`). A live worker
  also claims queued proposal/meeting rows that the tests create.

## Migrations

- Additive only, numbered after the highest existing file in `Supabase/migrations/`
  (currently `027`).
- Apply them to staging only.

## Architecture boundaries

(Copied from "Non-Negotiable Project Boundaries" in `CONTEXT.md`.)

- Do not reintroduce frontend fixture/demo data for production CRM flows.
- Do not bypass Supabase Auth or trust client-supplied user IDs.
- Do not put service-role keys, provider secrets, encryption keys, or SMTP credentials in the frontend.
- Do not duplicate business routing tables in React.
- Do not send provider messages from manual Email/WhatsApp activity buttons.
- Do not execute workflow sends in request/response handlers; use the worker.
- Do not store inbound WhatsApp message bodies.
- Do not treat pipeline stage and lifecycle state as interchangeable.
- Do not edit published workflow versions; create a draft and publish a new version.
- Do not rotate `INTEGRATION_ENCRYPTION_KEY` casually.
- Do not skip migrations or apply only `001_initial_migration.sql`; the latest project needs every migration from `001` through the latest (currently `027`).

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

## AI agent (Feature 3)

- One action per wake-up: `send_email`, `send_whatsapp`, `wait`, `handoff`, `update_stage`,
  `stop`. Code enforces the safety rules (`src/agent/rules.ts`), not the model.
- Workspace modes: `off` (default) → `shadow` (drafts only, sends nothing) → `live`
  (Feature 6). Nothing in Feature 3 sends messages to leads.
- The agent never marks Won/Lost/DNC, never deletes, never changes the owner; never contacts
  DNC/won/lost/discarded/merged leads or leads whose `agent_status` ≠ `active`.
