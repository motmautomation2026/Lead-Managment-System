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
  `OPENAI_GROUNDING_MODEL` (defaults when a workspace sets none; `name` or `name@effort`) and `OPENAI_PRICES_JSON`
  (optional `cachedInputPer1M` per model).
- `CRM_COMPANY_SWEEP_ENABLED` (worker; default on, off only when exactly `false`): the company sweeper.
- `CRM_DEAL_SWEEP_ENABLED` (worker; default on, off only when exactly `false`): the deal backfill sweeper.
- Email has no env vars (E1b): no `RESEND_API_KEY` / `SMTP_FROM_*`; the SMTP + IMAP mailbox is saved per workspace by an
  admin in Settings → Email. Tests never contact a real SMTP/IMAP server or DNS (fake transport, IMAP client, resolver).
- `EMAIL_IMAP_POLL_SECONDS` (worker; default 120, 30–3600): how often each workspace's mailbox is read over IMAP (D3).
- `PUBLIC_API_BASE_URL` (API + worker, E3b-2b; https in production; malformed = startup error; missing = open tracking off): the API's
  public address for the email open pixel `<base>/t/o/<token>.gif`.

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
- Stop any local `npm run dev` / `npm run worker:dev` that points at staging first: a live worker
  claims queued proposal/meeting rows that the tests create. `TEST_DATABASE_URL` is the transaction
  pooler (6543), `TEST_DATABASE_SESSION_URL` the session pooler (5432, the WhatsApp lock tests).
- P7: test cleanup retries network errors (`tests/helpers/networkRetry.ts`, 3 attempts); a cleanup that still fails on the
  network is logged and the global teardown (`tests/global-setup.ts`) deletes every `[test]` workspace created during the
  run (a failed sweep fails the run). Tests that depend on the time of day inject a clock (e.g. `BaileysManager`'s 4th
  argument); Storage calls in tests retry / poll. Leftover `public` functions no migration creates (e.g. `agent3b2_fail_*`)
  and `[test]` workspaces with WhatsApp numbers: `npm run staging:cleanup-test-workspaces` (dry run; `-- --confirm`).

## DB connections

- DB-3: two connection strings. `DATABASE_URL` = Supabase **transaction** pooler (port 6543): API requests
  (incl. `/t/o/…`), every worker query/tick/transaction, scripts, integration tests. `DATABASE_SESSION_URL` =
  **session** pooler (port 5432), used ONLY by code that needs a real session: the WhatsApp session-lock
  clients and `sessionPool` (`src/db.ts`, lazy, unused today). Unset → falls back to `DATABASE_URL` with one
  startup warning (WhatsApp then refuses to start if that is port 6543).
- Transaction-pooler safety: on `pool` never use session `SET` (use `SET LOCAL` / `set_config(…, true)` inside a
  transaction), named prepared statements (`name:`), temp tables, `LISTEN/NOTIFY`, cursors across transactions or
  session advisory locks (use `pg_advisory_xact_lock`); anything that truly needs a session goes on the session URL.
- The staging session pooler allows **15 client connections in total** (session pools, WhatsApp lock clients,
  the Supabase dashboard). Every session connection counts while open, even idle.
- Env (backend + worker): `DB_POOL_MAX` (API) and `WORKER_DB_POOL_MAX` (worker), default 10 each (transaction pool);
  `DB_SESSION_POOL_MAX` (default 2, session pool); `DB_IDLE_TIMEOUT_MS` (10000); `DB_CONNECTION_TIMEOUT_MS`
  (15000, how long a query waits for a connection). Every pool and lock client has TCP keepalive (10 s).
  Local staging `.env`: `DB_POOL_MAX=5`, `WORKER_DB_POOL_MAX=4`, `DB_SESSION_POOL_MAX=2`.
- Clean shutdown (`src/shutdown.ts`): API, worker and scripts close their pools (worker: also WhatsApp
  sockets + lock clients and SMTP transports) on SIGINT / SIGTERM / SIGBREAK, 10 s hard timeout. The API
  and worker log which pooler each pool uses (host:port) at startup.
- The worker also holds one dedicated session connection per running WhatsApp manager (lock client) — E4a: one manager
  per **number**. It starts managers (every tick, one at a time) only for numbers (`whatsapp_numbers`, active
  workspaces) with `desired_state` connected/restart and not removed, or a live status while disconnecting / being
  removed; unneeded managers are stopped (lock client closed). No number = no manager. It logs "WhatsApp numbers with a
  session: <ws>: n → N session-pooler slot(s)" whenever that set changes. Session slots needed = 2 × DB_SESSION_POOL_MAX
  + connected numbers (all workspaces); Settings → WhatsApp warns above SESSION_POOLER_MAX_CLIENTS (15) − 2 × DB_SESSION_POOL_MAX − 3.
- Integration tests create workspaces with `createTestWorkspace` (`tests/helpers/testWorkspaces.ts`,
  name `[test] <label> <uuid>`) and delete them in `afterAll` with `deleteCreatedTestWorkspaces`
  (FK-safe, throws on failure). Never insert/delete workspaces directly in tests.
- Leftovers on staging: `npm run staging:cleanup-test-workspaces` (dry run; `-- --confirm` deletes;
  staging ref only; never MOTM / Quick ICP / workspaces with a `whatsapp_connection` row).
- On EMAXCONNSESSION run `npm run db:connections -- --probe` (Backend). Behind the pooler every
  connection shows as `Supavisor` in `pg_stat_activity`; `--probe` counts free client slots of both poolers.
- Stop the local API/worker before integration tests.
- Production: set `DATABASE_URL` (6543) and `DATABASE_SESSION_URL` (5432) on the API and the worker; the
  session pools (2 each) + WhatsApp lock clients must stay below the production session pooler size, and
  the transaction pools below its transaction client limit (Supabase → Database → Connection pooling); check
  both before deploying.

## Migrations

- Additive only, numbered after the highest existing file in `Supabase/migrations/`
  (currently `057`).
- Apply them to staging only.

## Architecture boundaries

(Copied from "Non-Negotiable Project Boundaries" in `CONTEXT.md`.)

- Do not reintroduce frontend fixture/demo data for production CRM flows.
- Do not bypass Supabase Auth or trust client-supplied user IDs.
- SEC-1 (056): Never add RLS policies or grants for anon/authenticated; the browser talks only to the backend (Supabase only for
  login). Every new `public` table keeps RLS on with no policies. `npm run db:security-check` (Backend, staging) and the
  integration test `dbSecurity` fail otherwise.
- Do not put service-role keys, provider secrets, encryption keys, or SMTP credentials in the frontend.
- Do not duplicate business routing tables in React.
- Sends come only from workflows, the AI agent, rep proposal/meeting messages and (E3b-2a) a rep's deliberate Send of an AI
  reply draft, which is a third allowed send kind (after workflows and the AI): always queued and sent by the worker, never
  inside the request. Manual Email/WhatsApp activity buttons still never send.
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
- Do not skip migrations or apply only `001_initial_migration.sql`; the latest project needs every migration from `001` through the latest (currently `057`).

## Way of working

- One coherent unit per task. Don't touch unrelated code.
- If the code contradicts the audit, stop and report.
- Finish with a diff summary and test results.

## Completed so far

Every completed phase (0A … E3b-1b and later, incl. UX-1) is in `docs/HISTORY.md`; read it for details of a past phase.

## Scale, fair ticks and system health (P7)

- Fair worker ticks: every worker claim that can serve several workspaces has a per-tick limit AND picks round-robin across
  workspaces (`services/fairPick.ts` `fairPickSql`: each workspace's first due row before anyone's second, then the claim
  re-checks under `for update skip locked`). Never add a claim ordered only globally. Email outbound: one row per workspace,
  longest-waiting first; IMAP: one workspace per tick by `next_poll_at`; reply escalation: 20 per workspace, 100 per tick.
- Heartbeats: `src/worker.ts` runs every tick step through `step(loop, …)`; a failing step is logged (codes only) and the tick
  goes on; one upsert per tick into `worker_heartbeats` (one row per loop, error codes only). A new worker step gets a
  `WORKER_LOOPS` entry (`services/systemHealth.service.ts`, critical or background).
- `GET /health/worker` (public, mounted before `/api/v1` like `/t/o`, `no-store`): 200 `{status:"ok",stale:[]}`, or 503
  `{status:"stale",stale:[<critical loops>]}` when a critical loop hasn't finished within `expected_seconds` × 3 (expected =
  max(60 s, 2 × poll interval)). Never add workspace data to it. For an external uptime monitor in production.
- Settings → System health (super-admins, `GET /super-admin/system-health`): loop ages and per workspace stuck (due > 15 min)
  vs waiting (window / spacing / warm-up / pause / backoff) email + WhatsApp queues, overdue AI wake-ups, paused numbers /
  email, failed sends 24 h, AI budget %, decisions today vs cap. The worker's `runHealthAlerts` (every 15 min) sends a
  workspace's admins one notification per IST day per red problem (`stuck_queue`, `paused_channel`, `ai_budget` ≥ 90 %),
  deduplicated in `system_health_alerts`. Nothing here sends a message.
- Performance targets (server time; measure on staging only: `npm run staging:load-seed -- --confirm` →
  `npm run staging:perf-measure -- --label <x>` → `npm run staging:load-seed -- --remove --confirm`; results in
  `docs/perf/`): API reads p95 < 300 ms, funnel 180 days < 1 s, each worker claim/batch < 500 ms, no sequential scan on a
  table > 10,000 rows in a hot path. Joins to `leads` / `companies` from a workspace-scoped table carry the workspace
  equality (`l.workspace_id = t.workspace_id`) so the workspace indexes are used.
- Per-number cost (fake managers, `npm run staging:worker-capacity`): one session-pooler connection (the lock client) per
  running number; the session-slot formula (E4a/E4b) is unchanged.

## Workspace access (E4b)

- Users belong to workspaces (`workspace_members`, role `admin` | `salesperson` **per workspace**). `requireWorkspace`
  (`authMiddleware.ts`) is the ONE access check: `X-Workspace-Id` must be a workspace the user is a member of, or the user is a
  super-admin (`profiles.is_super_admin`, admin everywhere); else 403 "You don't have access to this workspace". It replaces
  `req.actor.role` with the role in that workspace, so `requireAdmin` and every `actor.role` check are per workspace. Never add a
  route-level copy of these rules; pure rules live in `domain/workspaceAccess.ts`.
- The global `profiles.role` only gates `/admin` user accounts (global admin or super-admin) and was the 055 backfill default.
- New owners / assignees must be active members (`assertAssignableUser`, `profiles.service.ts`); admin notifications go to
  `WORKSPACE_ADMIN_IDS_SQL` (admins of that workspace; super-admins only if members). Pickers use `/profiles` (workspace-scoped).
- Super-admin: only `npm run admin:set-super-admin -- --email <email> [--remove] [--confirm]` (staging; dry run by default; refuses
  production — production uses SQL in the Supabase editor). No UI makes a super-admin.
- Team: Settings → Team (`/team/members`, admins); every workspace × user: Settings → All workspaces (`/super-admin/memberships`).
  Removing is blocked while the user owns active contacts / open deals / open tasks there; never remove or demote the last admin;
  every change is in `workspace_member_events`. A new workspace's creator becomes its admin.
- Tests: `startTestApi().call()` makes the caller a member of the `[test]` workspace with its role unless `newUser(..., { member:
  false })`; otherwise `addTestMember` (`tests/helpers/testWorkspaces.ts`, refuses non-`[test]` workspaces).
- `SESSION_POOLER_MAX_CLIENTS` (API + worker, default 15): the session pooler's client limit for the WhatsApp slot warning.

## WhatsApp numbers (E4a)

- A workspace has 1…`max_numbers` (default 5, admin) WhatsApp numbers: rows in `whatsapp_numbers` (own QR pairing, Baileys
  auth in `whatsapp_number_auth_*`, socket, session-lock client keyed by the number id, `paired_at` / warm-up, daily cap,
  spacing, new-chat limit, `enabled` + pause, optional `owner_user_id`, soft delete `removed_at`). `whatsapp_connection` is
  the workspace row: send window, `outbound_enabled` (master switch for every number), `max_numbers`; its old per-number
  columns are legacy (copied to number #1 by migration 054) and never read.
- Sticky number (`leads.whatsapp_number_id`): set on the first send (any source) or the first matched inbound, whichever is
  first; never changed automatically. Only an admin moves a contact (`POST /contacts/:id/whatsapp-number`, reason, audit,
  timeline; prepared rows follow) or removes a number (rule 10: move its contacts or leave them without one).
- Choosing (`domain/whatsappNumbers.ts`, the only place): the owner's connected, not-paused number with room today, else the
  one with the most room after warm-up → fewest new chats today → oldest pairing; none → the send waits (deferral, no attempt).
  Paused / disconnected / removed sticky number → that contact's sends wait; never a silent switch. Every sender goes through
  `sendWhatsApp` → `resolveSendNumber` → that number's manager → `performSend`.
- Safety (E1 below) is counted **per number** (`loadSendStats` on `whatsapp_number_id`), except the send window and the master
  switch (per workspace) and the opt-out line / first-message link rule (per lead: the workspace never messaged the phone);
  the new-chat limit counts a phone new to that number (`isNewChat`). STOP-rate auto-pause per number; a STOP on any number
  opts the contact out of WhatsApp. Auto-pause notifications name the number.
- Locks: session lock per number (`hashtextextended(numberId, 1)`); sends and inbound share `pg_advisory_xact_lock` on
  (number, phone) (`numberPhoneLockKey`). Inbound carries its number; a reply on another number than the sticky one is
  handled as usual and flagged `other_number`.

## WhatsApp safety (E1)

- Every WhatsApp send — workflow steps, rep proposal/meeting messages, (E2) the AI agent and (E3b-2a) a rep's Send of an AI
  reply draft (source `reply_draft`, follows the automated send window) — goes through
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

- Every email — workflow steps, rep proposal/meeting emails, the Settings test, (E2) the AI agent and (E3b-2a) a rep's Send of
  an AI reply draft (source `reply_draft`, follows the automated send window, threaded to the lead's Message-ID) — is a row in
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
  stored, Date, text + HTML, `List-Unsubscribe: <mailto:…?subject=unsubscribe>` to contacts, no `Precedence`, no tracking except the
  E3b-2b open pixel below,
  attachments ≤ 10 MB; 11 DNS check reads only; 12 monitoring for every CRM user; 13 `WORKER_DRY_RUN` marks sent
  (`dry_run`, not counted) without SMTP.
- Deferrals never burn attempts.
- E3b-2b open tracking (soft signal only): a random 128-bit token per queued email; the worker adds a 1×1 pixel at the end of the HTML
  part of AI agent and workflow emails only (never reply drafts, proposals, meetings, tests), only with `PUBLIC_API_BASE_URL` AND the
  workspace's "Track email opens" on (admin, default OFF; the privacy policy must mention it before production use). Public
  `GET /t/o/<token>.gif` (before auth): always the same no-store GIF, token format checked before the DB, one UPDATE, 60/min per IP in
  memory, no IP / user agent stored. An open within 60 s of sending is not counted. The worker turns the first counted open into one
  timeline event, the message fact and a score mark. Opens never send, never wake the agent, never count as a reply, never reach a prompt.
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

## Tracking, score and funnel (E3b-2b)

- `message_facts`: one row per message that really went out (never queued / dry run; email in `markSent`, WhatsApp in `performSend`);
  outcomes only through `attributeOutcome` / `attributeReplyLabel` (last touch within 14 days, set once). No backfill.
- Hot-lead score: pure `domain/leadScore.ts` (enquiry ≤ 25, fit ≤ 25, engagement ≤ 50; bands hot ≥ 60 / warm 30–59 / cold); services
  only set `leads.hot_score_dirty` (`markHotScore`); the worker sweeper recomputes (200 per tick, plus scores older than 24 h). Never
  recompute in a request, never give the score to the AI. A score-only update keeps `leads.updated_at` (trigger).
- Funnel: `GET /analytics/funnel` (≤ 180 days); lead numbers by cohort, channel / number / angle by message facts.

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
- UX-1 (frontend patterns, `docs/crm-v2/C1-ui.md` §11–12, audit + phase plan `docs/crm-v2/UX-audit.md`): **every list that can
  grow is paginated** — a B4 keyset endpoint with Load more (never fetch everything; add the endpoint first); fixed-size lists
  say why in the audit. Sub-nav pages use `SectionLayout` (one route per section, hidden-not-disabled by permission, phones:
  list → section); channel/record sections open with a `StatusCard`, details go in `SectionTabs` (`?tab=`); item details open
  in a `DetailDrawer` (`?<item>=<id>`); every form has one `SaveBar` (sticky, guards leaving) instead of Save buttons;
  dangerous actions behind `ConfirmDialog` saying exactly what happens; reversible ones use `toastUndo`; loading =
  `SectionSkeleton`/skeletons; empty states carry one next action. Settings: `/settings/<section>`, registry
  `features/settings/settings-search.ts` (sections, access, search entries — a new setting gets a field id + an entry).
- UX-2 (lists + queues, `docs/crm-v2/C1-ui.md` §13): every list page uses `DataTable` with rows per page + columns remembered
  (`lib/list-prefs.ts`), phone cards, `j`/`k`/`x`/`Enter` (`keysAreTaken`; new keys go in `LOCAL_SHORTCUTS` for `?`); record
  lists open a peek drawer (`?peek=`, lazy `features/crm/record-peek.tsx`); inline/row edits use `features/crm/row-controls`
  with Undo where reversible; a dialog opened from a menu item uses `afterMenuClose`. Call queue `/tasks/calls` sends a call
  only after its Undo window (`POST /leads/:id/calls` + `taskId`, call or follow-up task); Replies `/tasks/replies` =
  `replyTasks=only` (B4 §7w).
- Deal routing lives in `domain/dealRouting.ts`; event-driven deal moves never touch the contact; only a
  manual deal won (no other open deal) syncs the contact (via `markWon`). Deal code never changes DNC, the
  contact owner, `agent_status` or automation.

## AI agent (Feature 3)

- E3b-2b: AI reply labels count only toward the monthly budget, never the daily decision cap (reply drafts count toward both).
  Auto-fixes `call_days` (time phrase after both suggested days removed) and `generic_client_claim` (a general client-experience
  sentence removed when ≥ 2 other sentences stay, else the fixable check); an auto-fixed draft is a first-try pass. The writer gets the
  exact "Closing question: Would <Day1> or <Day2> suit you for a short call?". After the daily draft limit a newer reply never
  supersedes the open draft (`newer_reply_at`). Seeded drafts (`staging-seed`) can never be sent (409).
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
- One question per message (both modes): > 1 → regenerate (up to twice, E2f) → handoff. A choice between two options ("Would
  Thursday or Friday suit you?") is one question (E3b-1).
- Stage plan (E3b-1, both modes, in code: `agent/stagePlan.ts`, the only place): `new_no_contact` journey welcome → insight →
  client_experience → check_in, then insight/client_experience alternately, `final_check` always the last allowed touch;
  `after_call` (call/note newer than our last message → `call_followup`, then the journey without welcome); `meeting_scheduled` no
  sends (wait until after it); `meeting_held_no_proposal` recap (only from the outcome notes) then check-in, max 2; `meeting_no_show`
  one `reschedule` ≥ 24 h after, then the journey; `proposal_sent` questions ≥ 2 d, timing ≥ 7 d, client_experience ≥ 14 d, max 3,
  then wait; `rep_owned` no sends, one handoff the first time, then wait 7 days; `long_term` insight/check_in ≤ 1 per 30 days. The
  model may still pick wait/handoff/stop.
- Channels (E3b-1): both usable → the first touch on `agent_settings.first_channel`, then the other channel than the last touch
  (real sends; shadow: allowed drafts); the wrong one is switched + regenerated (`channel_switch`, fixable). One usable → that one.
  Limits count both channels together.
- Speed to lead (E3b-1): a website/inbound-form contact < 2 h old with no touch may get its FIRST AI message 08:00–21:00 IST any day
  (rules, send re-check and both channel checks); every other safety rule unchanged; follow-ups keep the normal window.
- Call days (E3b-2a-2, code check `call_days`, fixable, both channels, decisions and reply drafts): a question asking for a call offers
  the two suggested days; a day question never also says "in the coming days".
- Booking link + suggested days (E3b-1): call angles get "Suggested days" (next two working days, Mon–Sat, ≥ 1 day ahead, IST) and,
  when the owner has `profiles.booking_url`, a code-added booking line before the signature (never a first WhatsApp). Never exact clock
  times; the model never writes URLs.
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
  never before a conversation or a real message from us, WhatsApp only after the contact replied on WhatsApp (E3b-1: or a logged call / held meeting), never the
  same asset twice, ≤ 2 email / ≤ 1 WhatsApp, ≤ 10 MB in total — these DROP the attachment and keep the message (no
  regeneration, recorded in `quality_checks`). The AI sees only an asset's title and "use when"; asset chunks are never a
  fact source (decide or grounding) and grounding flags numbers/results attributed to an attachment. Live sends attach the
  file (email attachment / one WhatsApp document with the text as caption); a file gone, turned off or over 10 MB at send
  time → sent without it, recorded, unless the text mentions an attachment (E2h): then cancelled `attachment_missing`, no
  touch, a new wake-up. A message never mentions an attachment it won't carry (`attachment_mention`, fixable, then handoff).
- Models (E3a): writer and checker are settings (`name` or `name@effort`, e.g. `gpt-5.4-mini@low`), never code; a price must exist or the
  wake-up defers. Keep the system message free of anything about the contact, owner or moment: it is what OpenAI caches.
- Auto-fixes (E3a, both modes, in code): `polishDecision` runs before every check, on subject + body; a fixed problem never causes a
  regeneration; every fix is in `quality_checks[].autoFixes`. It never changes meaning: if a fix would break a sentence the text stays
  and the normal check fails. The model never writes links, emails or phones (`contact_details`, fixable).
- Message shape (E3a, E3b-1b): limits 120 / 60 words by default (the model's body only, never the signature, opt-out or booking
  line; the writer aims for about two thirds on WhatsApp, 40), admin style examples in the prompt (never a fact source), subject 2–7 plain
  words (`subject_style`, fixable).
- Threading (E3a): a follow-up AI email to a contact with a real AI email (sent, not bounced, not dry run) in the last 45 days uses
  `In-Reply-To` + `References` = that email's Message-ID and "Re: <first subject>"; the model's subject is ignored (it writes "-").
  Decided again at send time. A new Message-ID every time. Rep proposal/meeting emails are never threaded.
- Measuring (E3a): `GET /agent/stats.quality` (since `readiness_since` and last 7 days); `npm run agent:model-test -- --combos
  "writer/checker,..."` (`>` also works, but not through `npm.cmd`: cmd.exe redirects it) prints the plan and the estimated cost; E3b-1b: `--only "Full Name,..."`, `--channel email|whatsapp`, `--max-cost <usd>` (default
  $0.10, at most $3; stops before the next contact once reached); `--confirm` spends, saves nothing, writes
  `scripts/output/model-test-<timestamp>.md` (per message: channel, first WhatsApp, word count).
- Approved fact sources (prompt + grounding): knowledge, playbook, lead data (incl. call/note text, the meeting outcome notes for a
  recap, and the company facts: name, domain, website, industry, location, employees, revenue). Checker (E3b-1): describing our
  approach for any B2B sector is fine, and so is naming ONE listed client experience as described (any sector, E3b-2a-2); flagged: claims of results/experience in an unlisted sector, what a past call/meeting/proposal
  contained unless the notes say so, one client experience turned plural ("similar companies"), and "you mentioned…" not in the
  lead's own data. Internal context (company description +
  the open deal and won/lost counts) is decide-only: never stated, never a grounding source, never amounts/loss notes.
- The agent never marks Won/Lost/DNC, never deletes, never changes the owner; never contacts
  DNC/won/lost/discarded/merged leads or leads whose `agent_status` ≠ `active`. Every safety ceiling, the daily decision
  cap and the monthly budget apply in live as in shadow.
- Reply labels (D4a): a matched WhatsApp reply is labelled by keyword first (every contact, every mode: `stop`,
  `unsubscribe`, `remove me`, `don't message me`, `do not message`, `not interested`, … — exact short phrases only, list in
  `domain/replyKeywords.ts`), else by the worker's AI step (AI contacts, non-off mode, budget left). `asked_to_stop` → WhatsApp
  opted out + AI stopped (permanent); `not_interested`/`annoyed` → AI stopped (permanent); never Do Not Contact (a rep
  decision). A rep's correction never undoes these.
- Reply drafts (E3b-2a, `services/replyDrafts.service.ts`, `domain/replyDrafts.ts`): a matched reply (WhatsApp or email) on a contact
  the AI managed before it (the D4a condition; a contact already handed off by an earlier reply gets none), mode not off, gets ONE
  suggested reply for the owner, written by the worker (behind `AGENT_RUNNER_ENABLED`) once its label is known: only for
  `positive|question|other|unclassified`, never DNC / opted-out channel / no budget / daily cap reached. Same writer + checker, code
  checks, word limit (60 / 120, body only), the reply only inside the delimited `reply` block (never logged or stored), one
  regeneration, else a `failed` row (no draft; the task stays). Each draft counts in `MONTH_SPEND_SQL` and `DAY_DECISIONS_SQL`
  (the daily cap; E3b-2a-2: AI reply labels count there too). A newer matched reply supersedes the open draft.
  E3b-2a-2 bursts: a reply on a contact `handed_off` with an open reply task or any draft (`isReplyFollowUp`) is labelled, gets a
  reply task and a draft too; the draft waits for 3 quiet minutes and answers every matched reply since our last message (AI send,
  any email sent, the rep's Send/Discard; both channels, ≤ 10) in the one reply block; a stop label on any reply in the burst → no
  draft; ≤ 3 drafts per contact per IST day. Staging test data: `npm run staging:seed-reply-draft -- --contact "<full name>"` (no AI
  call; `--remove`). The AI never sends a draft (it stays `handed_off`); the owner or
  an admin sends it (edited or not; the word limit still applies, 400) or discards it. The Send is exempt from the AI touch limits
  (48 h gap, 2 per week, 8 total) but not from the channel rules (send window, spacing, caps, warm-up, pause, opt-out, DNC, channel
  status, re-check before sending); it marks the reply task done; one send per draft.
- Escalation (E3b-2a, `services/workReminders.service.ts`, every tick, no flag): a reply task still open 2 working hours after it
  was created (working hours = the workspace's `agent_settings` send window, IST) → one notification to the admins, once
  (`tasks.escalated_at`), at most 20 per workspace per tick. A meeting 2–30 days past with no outcome → one owner task "Log the
  meeting outcome" (`meetings.outcome_task_created_at`). Both only for tasks / meetings created at or after
  `agent_settings.reminders_since` (migration 052's apply time: no old-task flood on deploy).
- Meeting recap (E3b-2a): when the meeting notes say the lead is deciding or consulting someone (`leadIsDeciding`), the angle is
  `meeting_recap_deciding` (not a call angle: no suggested days, no booking line); "as agreed" / "as discussed" need an agreement
  in the notes (`unsupported_agreement`, fixable).
