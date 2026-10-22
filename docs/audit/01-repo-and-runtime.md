# 01 — Repository layout and runtime

Audit snapshot: branch `main` @ `57d4a2a` (2026-10-21). Read-only audit; nothing in the codebase was changed.
`git status` reports `Backend/src/routes/publicLeads.routes.ts` as modified, but `git diff` (with and without whitespace) is empty, so the only change is line endings or file mode (`core.autocrlf=true` on this machine).

---

## 1. Directory tree (excluding `node_modules`, `dist`, `.git`)

### Root

| Path | Purpose |
|---|---|
| `CONTEXT.md` | Project context document (the starting map for this audit; "Last refreshed 2026-10-16"). |
| `PRIVACY_POLICY.md` | Privacy policy text ("MOTM KAM Portal (MOTM Flow)", effective 2026-10-03). The frontend `/privacy` page renders its own copy (`Frontend/src/features/legal/privacy-page.tsx`). |
| `compose.yaml` | Docker Compose: `backend`, `worker`, `frontend` services (see §3). |
| `.env.example` | Root env example for Compose only. |
| `.gitignore` | Ignores `/Supabase/disposable/` and `.env`. |
| `.claude/settings.json`, `.claude/settings.local.json` | Claude Code tool settings (not app code). |
| `.claude/worktrees/agent-a30b5f2b59dd30d8b/` | A **stale git worktree** (branch `worktree-agent-a30b5f2b59dd30d8b` @ `7bf64ca`). It is an older full copy of the repo: migrations only go up to `014`, it has no workspaces code, and it has a lowercase `context.md`. It is not part of the app. Delete it or ignore it. |

### `Backend/` (Node 22, TypeScript ESM, Express)

| Path | Purpose |
|---|---|
| `package.json`, `package-lock.json` | Scripts and dependencies (see §2). |
| `tsconfig.json` | `strict`, `noUncheckedIndexedAccess`, NodeNext, `rootDir: "."`, includes `src` and `tests`. Output goes to `dist/src/**` (and `dist/tests/**`). |
| `eslint.config.js` | typescript-eslint config; ignores `dist/**` and `node_modules/**`. |
| `vitest.config.ts` | Node environment, `tests/**/*.test.ts`, setup file `tests/setup-env.ts`. |
| `Dockerfile` | Two-stage build (`npm ci`, then `tsc`, then runtime with `npm ci --omit=dev`). Runs as `node`, healthcheck is `GET /health`. |
| `.dockerignore`, `.gitignore` | Standard ignores (`.env` ignored). |
| `.env.example` | Documented backend env (see §4). |
| `.env` | **Exists locally (git-ignored)**. Not read for this audit. |
| `README.md` | Backend readme. |
| `src/index.ts` | API entry: `createApp()`, listens on `env.PORT`, closes the pool on SIGTERM/SIGINT. |
| `src/app.ts` | Express app: helmet, CORS (`corsOrigins`, credentials), `express.json({limit:"2mb"})`, `GET /health`, mounts `/api/v1`, then the 404 and error middleware. |
| `src/env.ts` | Zod-validated API env, plus the all-or-none Google OAuth and ingest checks. Exports `env` and `corsOrigins`. |
| `src/workerEnv.ts` | Zod-validated `WORKER_*` env. |
| `src/db.ts` | Single `pg.Pool` (max 10, idle 30s) and `withTransaction()`. |
| `src/dto.ts` | `Queryable` type, `addDaysIso()`, `isoOrNull()` (the latter is unused). |
| `src/supabaseAdmin.ts` | Service-role Supabase client (auth verification, Auth admin API, Storage). |
| `src/authMiddleware.ts` | `requireAuth`, `requireAdmin`, `requireSalesperson`, `requireWorkspace`, `Actor` type. |
| `src/asyncHandler.ts` | Forwards a rejected promise to `next`. |
| `src/errors.ts` | `AppError` hierarchy (`ValidationError` 400 … `InvalidTransitionError` 422). |
| `src/errorMiddleware.ts` | 404 JSON and the error-envelope middleware. |
| `src/validation/parse.ts` | `parseBody` / `parseQuery` / `parseParams` (Zod, throw `ValidationError` with `flatten()` details). |
| `src/domain/enums.ts` | TS mirrors of the Postgres enums (retired values omitted). |
| `src/domain/pipeline.ts` | Lifecycle/stage guards and stage ordering. |
| `src/domain/callRouting.ts` | Call-outcome routing table. |
| `src/domain/meetingRouting.ts` | Meeting-outcome routing table. |
| `src/domain/proposalRouting.ts` | Proposal-status routing table. |
| `src/domain/templateRenderer.ts` | `{{var}}` renderer, `KNOWN_TEMPLATE_VARIABLES`, publish-time unknown-token check. |
| `src/domain/htmlToWhatsAppText.ts` | Editor HTML to WhatsApp markup. |
| `src/domain/websiteForm.ts` | Pure normalisation of public website-form submissions. |
| `src/domain/email.ts` | `normalizeEmail` (trim, lowercase, Zod email). |
| `src/domain/phone.ts` | E.164 normalisation (IN default), JID mapping. |
| `src/domain/baileys-policy.ts` | Terminal disconnect codes, reconnect backoff, send spacing, restriction check. |
| `src/security/encryption.ts` | AES-256-GCM helpers with AAD (`INTEGRATION_ENCRYPTION_KEY`). |
| `src/security/ingestGuard.ts` | Constant-time ingest-key compare, fixed-window limiter. |
| `src/routes/index.ts` | Mounts all routers and their auth gates (see 03-backend-a). |
| `src/routes/me.routes.ts` | `GET /me`, `GET /profiles`. |
| `src/routes/admin.routes.ts` | Admin user management. |
| `src/routes/workspaces.routes.ts` | Workspace list, create, rename. |
| `src/routes/connections.routes.ts` | Workspace-scoped Email, WhatsApp, Google Calendar, and website-lead settings. |
| `src/routes/googleCalendarOAuth.routes.ts` | Unauthenticated OAuth callback. |
| `src/routes/publicLeads.routes.ts` | Public website-lead intake (only when configured). |
| `src/routes/leads.routes.ts` | Leads and sub-resources. |
| `src/routes/tasks.routes.ts`, `meetings.routes.ts`, `proposals.routes.ts`, `workflows.routes.ts` (+ templates), `runs.routes.ts` (+ scheduled-actions), `dashboard.routes.ts`, `notifications.routes.ts` | CRM routers. |
| `src/services/*.service.ts` | 23 service modules (SQL, transactions, orchestration). See 03-backend-b. |
| `src/providers/email.provider.ts` | Resend (fetch) and SMTP (nodemailer) sending with legacy env fallback. |
| `src/providers/whatsapp.provider.ts` | `sendWhatsApp()` → per-workspace `BaileysManager.sendAction`. |
| `src/providers/baileys-registry.ts` | One `BaileysManager` per active workspace. |
| `src/providers/baileys.manager.ts` | Baileys socket lifecycle, control-plane sync, guarded outbound send. |
| `src/providers/baileys-auth.store.ts` | Encrypted Baileys creds and Signal keys in Postgres. |
| `src/providers/google-calendar.provider.ts` | OAuth URL and token exchange, plus event insert/patch/delete. |
| `src/providers/provider-errors.ts` | `ProviderDeferredError` (retry later, default 60s) and `PermanentProviderError`. |
| `src/worker.ts` | Automation worker poll loop. |
| `tests/setup-env.ts` | Sets dummy `DATABASE_URL`, `SUPABASE_*`, `INTEGRATION_ENCRYPTION_KEY` when unset, and `NODE_ENV=test`. |
| `tests/unit/*.test.ts` (12 files) | Pure/unit tests (see 06). |
| `tests/integration/*.test.ts` (2 files) | DB tests gated on `TEST_DATABASE_URL`. |

### `Frontend/` (React 19, Vite 8, TanStack Router/Query, Tailwind 4)

| Path | Purpose |
|---|---|
| `package.json`, `package-lock.json` | Scripts and dependencies (see §2). |
| `vite.config.ts` | Tailwind, TanStack router plugin, React. `lightningcss`, tsconfig paths, dev server `::` port 8080. |
| `vitest.config.ts` | jsdom, `src/test/setup.ts`, `@` alias, `restoreMocks`, `clearMocks`. |
| `tsconfig.json`, `eslint.config.js`, `.prettierrc` (`printWidth 100`, double quotes, trailing commas), `.prettierignore`, `components.json` (shadcn) | Tooling. |
| `Dockerfile` | Build with `VITE_*` build args, served by `nginxinc/nginx-unprivileged:1.27-alpine` on 8080. |
| `nginx.conf` | SPA fallback, security headers, gzip, immutable caching of assets, `no-store` for `index.html`. |
| `index.html` | Vite HTML shell. |
| `.env.example` | Three required `VITE_*` values. `.env` **exists locally (git-ignored)** and was not read. |
| `README.md` | Frontend readme. |
| `public/` | Favicons, `robots.txt`, `brand/` (MOTM logo SVG/PNG and readme). |
| `scripts/generate-brand-icons.ps1` | One-off icon generation script. |
| `src/main.tsx` | `createRoot`, `RouterProvider` (StrictMode). |
| `src/router.tsx` | `QueryClient` defaults (staleTime 15s, no retry on 4xx, at most 1 retry otherwise, no refetch on focus) and `createRouter`. |
| `src/routeTree.gen.ts` | Generated route tree. |
| `src/routes/*.tsx` | File routes (see 05). `routes/README.md` describes the conventions. |
| `src/app/app-shell.tsx` | Sidebar nav, workspace switcher and creator, header lead search, notifications bell, ⌘K palette, Add-lead dialog. |
| `src/app/add-lead-context.ts` | Context to open the Add-lead dialog. |
| `src/components/ui/*` | shadcn/Radix primitives. |
| `src/components/common/*` | `BrandLogo`, `ConfirmDialog`, `LoadingBlock`/`ErrorBlock`, `StatusBadge`. |
| `src/features/**` | Pages and dialogs per area (leads, tasks, meetings, proposals, automations, settings, admin, auth, legal, dashboard). |
| `src/lib/backend-client.ts` | The only CRM HTTP client. |
| `src/lib/supabase-client.ts` | Supabase browser client, config validation, `backendBaseUrl`. |
| `src/lib/use-supabase-session.ts` | Session hook for the AuthGate. |
| `src/lib/dates.ts`, `format.ts` | IST form and display helpers. |
| `src/lib/labels.ts` | Enum value to display label. |
| `src/lib/pipeline.ts` | Nurture stage to workflow-trigger hint (pre-filters the enroll dialog). |
| `src/lib/lead-validation.ts` | Client-side (non-authoritative) lead validation. |
| `src/lib/template-*.ts`, `html-to-whatsapp-text.ts` | Template editor schema, variables list, HTML helpers, WhatsApp preview port. |
| `src/lib/workflow-timeline.ts` | Cumulative "Day N" math and current-step lookup. |
| `src/lib/telemetry.ts` | `reportError` with a swappable sink (console by default). |
| `src/lib/utils.ts` | `cn()`. |
| `src/store/*` | TanStack Query hooks, query keys and invalidation, `WorkspaceProvider`. |
| `src/types/*` | Frontend mirrors of backend contracts and enum arrays. |
| `src/test/setup.ts`, `src/test/routes.smoke.test.tsx` | Test setup and route smoke tests. |
| `src/styles.css` | Tailwind 4 theme tokens (oklch). |

### `Supabase/`

| Path | Purpose |
|---|---|
| `migrations/001…018_*.sql` | Ordered schema migrations (tracked in git). See 02-database. |
| `disposable/001…015_*_seed.sql` | **Present on this machine, git-ignored** (`.gitignore:4 /Supabase/disposable/`). See §6. |

---

## 2. Scripts and key dependency versions

### Backend `package.json`

| Script | Command |
|---|---|
| `dev` | `tsx watch src/index.ts` |
| `build` | `tsc -p tsconfig.json` |
| `start` | `node dist/src/index.js` |
| `worker` | `node dist/src/worker.js` |
| `worker:dev` | `tsx watch src/worker.ts` |
| `typecheck` | `tsc --noEmit` |
| `test` / `test:run` | `vitest` / `vitest run` |
| `test:unit` | `vitest run tests/unit` |
| `test:integration` | `vitest run tests/integration` |
| `lint` | `eslint .` |
| `check` | `npm run typecheck && npm run lint && npm run test:run` |

Engines: `node >=22`. Runtime dependencies: `@supabase/supabase-js ^2.45.4`, `baileys 7.0.0-rc14` (pinned pre-release), `cors ^2.8.5`, `dotenv ^16.4.5`, `express ^4.21.1`, `googleapis ^176.0.0`, `helmet ^7.1.0`, `libphonenumber-js 1.12.16`, `multer ^2.3.0`, `nodemailer 7.0.6`, `pg ^8.13.1`, `pino ^9.5.0`, `pino-http ^10.3.0` (**declared but never imported**), `zod ^3.23.8`. Dev dependencies: `typescript ^5.8.3`, `vitest ^4.1.11`, `eslint ^9.32.0`, `typescript-eslint ^8.15.0`, `tsx ^4.19.2`, `supertest ^7.0.0` (**not imported by any test**; `publicLeads.routes.test.ts` uses raw `fetch` against a listening server), plus `@types/*`.

### Frontend `package.json`

| Script | Command |
|---|---|
| `dev` | `vite dev` |
| `build` / `build:dev` | `vite build` / `vite build --mode development` |
| `preview` | `vite preview` |
| `test` / `test:run` | `vitest` / `vitest run` |
| `typecheck` | `tsc --noEmit` |
| `lint` / `lint:fix` | `eslint .` / `eslint . --fix` |
| `format` / `format:check` | `prettier --write .` / `prettier --check .` |
| `check` | `format:check && lint && typecheck && test:run && build` |

`overrides: { rolldown: "1.2.1" }`. Key dependencies: `react ^19.2.0`, `react-dom ^19.2.0`, `vite 8.1.5`, `@tanstack/react-router 1.170.18`, `@tanstack/router-plugin 1.168.23`, `@tanstack/react-query ^5.101.1`, `tailwindcss ^4.2.1`, `@tailwindcss/vite ^4.2.1`, `@supabase/supabase-js ^2.45.4`, `@tiptap/* ^3.30.5` (`extension-link` pinned at 3.30.5), `papaparse ^5.4.1`, `qrcode.react 4.2.0`, `libphonenumber-js ^1.12.16`, `lucide-react ^0.575.0`, `sonner ^2.0.7`, `cmdk ^1.1.1`, Radix packages. Dev dependencies: `vitest ^4.1.11`, `jsdom ^30.0.1`, `@testing-library/react ^16.3.2`, `@testing-library/jest-dom ^7.0.1`, `eslint ^9.32.0`, `typescript-eslint ^8.56.1`, `prettier ^3.7.3`, `eslint-plugin-prettier ^5.2.6` (prettier runs as an ESLint rule, see 06), `lightningcss ^1.30.0`.

---

## 3. Containers and serving

### `compose.yaml`

| Service | Build | Ports | Env passed | Notes |
|---|---|---|---|---|
| `backend` | `./Backend/Dockerfile` | `127.0.0.1:${BACKEND_PORT:-8787}:8787` | `PORT=8787`, `NODE_ENV=production`, `CORS_ORIGINS` (default `http://localhost:8080,http://127.0.0.1:8080`), **required** `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `INTEGRATION_ENCRYPTION_KEY`; optional `GOOGLE_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI`, `INGEST_API_KEY`, `INGEST_WORKSPACE_ID` (all default empty) | `init: true`, `restart: unless-stopped`. |
| `worker` | same image | none | `NODE_ENV=production`, the same four required values, `RESEND_API_KEY` (default empty), `SMTP_FROM_NAME` (default `MOTM Technologies`), `SMTP_FROM_ADDRESS`, `WORKER_POLL_INTERVAL_MS` (10000), `WORKER_BATCH_SIZE` (20), `WORKER_DRY_RUN` (false) | `command: node dist/src/worker.js`, `healthcheck: disable: true`, `depends_on: backend`. |
| `frontend` | `./Frontend/Dockerfile` with build args `VITE_SUPABASE_URL` (required), `VITE_SUPABASE_ANON_KEY` (required), `VITE_API_BASE_URL` (default `http://localhost:8787`) | `127.0.0.1:${FRONTEND_PORT:-8080}:8080` | none at runtime | `depends_on: backend`. |

Things to notice about this setup:
- The **backend** service does *not* receive `RESEND_API_KEY` / `SMTP_FROM_*`. The API process also sends email: the "test email" endpoint, the proposal email, and the meeting-scheduled email are all sent inline by the API (see 04). So under Compose the env-var Resend fallback works only in the worker. The API reports `source: "unconfigured"` and defers proposal and meeting emails until a workspace saves database email settings.
- The **worker** does not receive `CORS_ORIGINS`/`PORT`. It does not need them: `env.ts` defaults both.
- The worker imports `env.ts` transitively (through `db.ts`), so it **also validates and requires** the four required API values, and applies the Google/ingest all-or-none checks to whatever it is given.

### `Backend/Dockerfile`
- Build stage: `node:22-bookworm-slim`, `npm ci` (with dev dependencies), `npm run build`.
- Runtime stage: `NODE_ENV=production`, `npm ci --omit=dev`, copies `dist`, `EXPOSE 8787`, runs as `USER node`, `CMD node dist/src/index.js`.
- Healthcheck: `fetch('http://127.0.0.1:'+(PORT||8787)+'/health')` every 30s. The worker reuses this image and disables the healthcheck in Compose.

### `Frontend/Dockerfile` and `nginx.conf`
- Build stage: `npm ci`, the three `ARG`s become `ENV`, then `npm run build`.
- Runtime: `nginx-unprivileged:1.27-alpine`, copies `nginx.conf` to `conf.d/default.conf`, healthcheck is `wget` on `/`.
- nginx config:
  - `listen 8080`.
  - Headers: `X-Content-Type-Options nosniff`, `X-Frame-Options SAMEORIGIN`, `Referrer-Policy strict-origin-when-cross-origin`.
  - gzip for text/css/json/js/xml/svg.
  - Static asset regex is cached `1y` with `public, immutable` and `try_files $uri =404`.
  - `location /` uses `try_files $uri $uri/ /index.html` (SPA fallback); `location = /index.html` sends `Cache-Control: no-store`.
  - No CSP header and no HSTS header.

---

## 4. Environment variables actually read in code

### Backend API (`Backend/src/env.ts:8-40`, validated at import time; a failure throws and the process exits)

| Var | Read at | Required? | Default / rule |
|---|---|---|---|
| `PORT` | `env.ts:9` | optional | `8787` (coerced positive int) |
| `CORS_ORIGINS` | `env.ts:10`, split at `env.ts:74-76` | **optional** (CONTEXT lists it as required) | `"http://localhost:8080,http://127.0.0.1:8080"`. The **first** origin is also used as the frontend base URL for the OAuth redirect (`googleCalendarOAuth.routes.ts:21`). |
| `DATABASE_URL` | `env.ts:11` | required | non-empty string |
| `SUPABASE_URL` | `env.ts:12` | required | must be a URL |
| `SUPABASE_SERVICE_ROLE_KEY` | `env.ts:13` | required | non-empty |
| `INTEGRATION_ENCRYPTION_KEY` | `env.ts:14-23`, used at `security/encryption.ts:12` | required | base64 that decodes to exactly 32 bytes |
| `NODE_ENV` | `env.ts:25` | **optional** (CONTEXT lists it as required) | enum `development \| production \| test`, default `development`. Controls whether the 500 message is exposed (`errorMiddleware.ts:24`) and suppresses error logging in test. |
| `GOOGLE_OAUTH_CLIENT_ID` | `env.ts:30` | optional | blank becomes unset |
| `GOOGLE_OAUTH_CLIENT_SECRET` | `env.ts:31` | optional | blank becomes unset |
| `GOOGLE_OAUTH_REDIRECT_URI` | `env.ts:32` | optional | must be a URL if set. All three Google vars must be set together or none (`env.ts:56-65`), otherwise startup throws. |
| `INGEST_API_KEY` | `env.ts:38` | optional | at least 32 chars if set |
| `INGEST_WORKSPACE_ID` | `env.ts:39` | optional | UUID. Both ingest vars must be set together (`env.ts:66-68`). When both are set, `/api/v1/public/*` is mounted (`routes/index.ts:36-38`). |

Read directly from `process.env`, outside the schema:

| Var | Read at | Required? | Default / use |
|---|---|---|---|
| `RESEND_API_KEY` | `providers/email.provider.ts:60`, `services/connections.service.ts:59` | optional | Legacy Resend fallback, used only while the workspace's `integration_connections.provider` is NULL. |
| `SMTP_FROM_ADDRESS` | `email.provider.ts:61`, `connections.service.ts:59` | optional | Sender address for the fallback. The fallback works only if this **and** `RESEND_API_KEY` are set. |
| `SMTP_FROM_NAME` | `email.provider.ts:62` | optional | default `"MOTM Technologies"` |
| `NODE_ENV` | `providers/baileys.manager.ts:101` | optional | pino level `warn` in production, otherwise `info` |

`dotenv/config` is imported by both `env.ts:1` and `workerEnv.ts:1`, so a local `.env` in the process's working directory is loaded.

### Worker (`Backend/src/workerEnv.ts:4-8`), plus everything in `env.ts`

| Var | Read at | Required? | Default / rule |
|---|---|---|---|
| `WORKER_POLL_INTERVAL_MS` | `workerEnv.ts:5` | optional | `10000`, int ≥ 1000 |
| `WORKER_BATCH_SIZE` | `workerEnv.ts:6` | optional | `20`, int 1–100 |
| `WORKER_DRY_RUN` | `workerEnv.ts:7` | optional | `"false"`. Exactly the string `"true"` enables it. |

### Frontend (`Frontend/src/lib/supabase-client.ts:3-5`, baked in at build time)

| Var | Required? | Notes |
|---|---|---|
| `VITE_SUPABASE_URL` | required | If missing, `configurationError` is set and AuthGate shows the "not configured" screen. |
| `VITE_SUPABASE_ANON_KEY` | required | same |
| `VITE_API_BASE_URL` | required | A trailing `/`, `/api` or `/api/v1` is stripped (`supabase-client.ts:20-21`), then the client appends `/api/v1`. |

### Tests only

| Var | Read at | Notes |
|---|---|---|
| `TEST_DATABASE_URL` | `tests/integration/businessFlows.test.ts:27`, `leadIngest.test.ts:13` | Integration suites are skipped when it is unset. |
| `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `INTEGRATION_ENCRYPTION_KEY`, `NODE_ENV` | `tests/setup-env.ts:1-5` | Defaulted with `??=` (`NODE_ENV` is forced to `test`). |

### Compose-only (root `.env`)
`BACKEND_PORT` (default 8787) and `FRONTEND_PORT` (default 8080). Both are bound to `127.0.0.1`.

---

## 5. Process model summary

```
Browser SPA (nginx :8080)
   ├── Supabase Auth (password sign-in, session in localStorage via supabase-js)
   └── fetch  {VITE_API_BASE_URL}/api/v1/*  (Bearer token + X-Workspace-Id)
            │
Backend API (Express :8787) ──── pg Pool(max 10) ──── Supabase Postgres (RLS-bypassing role)
   │   ├── supabaseAdmin: auth.getUser, auth.admin.*, Storage (template-attachments, proposal-documents)
   │   ├── inline sends: test email, proposal email, meeting-scheduled email, Google Calendar sync
   │
Worker (node dist/src/worker.js) ── same DB/Storage
   ├── polls scheduled_actions, queued proposal WhatsApp, queued meeting WhatsApp
   ├── email via Resend/SMTP
   └── one Baileys WhatsApp socket per active workspace (session advisory lock per workspace)
```

---

## 6. `Supabase/disposable/` on this machine

The folder **exists** with 15 files. Every one is git-ignored (`.gitignore:4`). CONTEXT names the files without their numeric prefixes. The files on disk are numbered:

| File | Workflow name inserted | Trigger | Steps (actions) | Templates inserted |
|---|---|---|---|---|
| `001_stage1_welcome_workflow_seed.sql` | Stage 1 - Immediate New Lead Welcome | `lead_created` | 2 (1 send_email, 1 send_whatsapp) | 2 |
| `002_not_connected_reconnect_seed.sql` | Not Connected - Reconnect Sequence | `call_not_connected` | 9 (send_email ×4, send_whatsapp ×2, create_call_task ×2, stop_workflow ×1) | 6 |
| `003_send_information_seed.sql` | Send Information - Progressive Relevance Sequence | `call_outcome_information_requested` | 4 (3 email, 1 WhatsApp) | 4 |
| `004_interested_later_seed.sql` | Interested - Later - Nurture Sequence | `call_outcome_interested_later` | 6 (5 email, 1 WhatsApp) | 6 |
| `005_future_possibility_seed.sql` | Future Possibility - Low-Intensity Nurture | `call_outcome_future_possibility` | 5 (email) | 5 |
| `006_objection_commission_only_seed.sql` | Objection - Commission Only | `objection_commission_only` | 4 (3 email, 1 WhatsApp) | 4 |
| `007_objection_internal_hiring_seed.sql` | Objection - Internal Hiring | `objection_internal_hiring` | 4 | 4 |
| `008_objection_existing_team_seed.sql` | Objection - Existing Team | `objection_existing_team` | 3 | 3 |
| `009_objection_budget_price_seed.sql` | Objection - Budget / Price | `objection_budget_price` | 4 | 4 |
| `010_objection_internal_approval_seed.sql` | Objection - Internal Approval | `objection_internal_approval` | 3 | 3 |
| `011_meeting_needs_more_info_seed.sql` | Meeting - Needs More Information | `meeting_needs_more_information` | 2 (email) | 2 |
| `012_meeting_not_ready_seed.sql` | Meeting - Not Ready (Timed Nurture) | `meeting_not_ready` | 2 (email) | 2 |
| `013_proposal_conversion_seed.sql` | Proposal Conversion - Follow-up Cadence | `proposal_pending` | 8 (4 email, 3 WhatsApp, 1 call task) | 7 |
| `014_reactivation_price_budget_seed.sql` | Reactivation - Price / Budget | `manual_enrollment` | 3 | 3 |
| `015_reactivation_internal_hiring_seed.sql` | Reactivation - Internal Hiring | `manual_enrollment` | 2 | 2 |

Each script inserts a workflow (`status 'active'`), version 1 (draft), the templates and the steps, then flips the version to `published`, then runs a verification select. Observations, all of them discrepancies with CONTEXT or the current schema:
- **None of the scripts set `workspace_id`.** Migration `015` made `workflows.workspace_id` and `message_templates.workspace_id` `NOT NULL` with no default. So **every seed fails on a database migrated to 015 or later** unless it is edited first.
- The bodies contain **40 occurrences of `CALENDAR_LINK_PLACEHOLDER`** that must be replaced by hand. They contain **no `[PROOF NEEDED: …]` markers**, although CONTEXT says "every template contains … `[PROOF NEEDED: ...]` markers".
- None of the seeds covers the `meeting_scheduled`, `meeting_agreed`, `meeting_highly_interested`, `meeting_proposal_requested` or `meeting_not_a_fit` triggers.
