# 06 — Tests and quality

---

## 1. Check results (run 2026-10-21 on this machine, read-only, no database)

Backend commands ran with `DATABASE_URL` unset. `tests/setup-env.ts` therefore supplied a dummy localhost URL, and unit tests never connect to it. `TEST_DATABASE_URL` was not set, and the integration suites were not run (`test:unit` only).

| Package | Command | Result |
|---|---|---|
| Backend | `npm run typecheck` (`tsc --noEmit`) | **PASS** (exit 0, no output) |
| Backend | `npm run lint` (`eslint .`) | **PASS** (exit 0, no output) |
| Backend | `npm run test:unit` (`vitest run tests/unit`) | **PASS**: `Test Files 12 passed (12)`, `Tests 123 passed (123)`, duration 1.59 s |
| Frontend | `npm run typecheck` (`tsc --noEmit`) | **PASS** (exit 0, no output) |
| Frontend | `npm run lint` (`eslint .`) | **FAIL**: `✖ 4834 problems (4833 errors, 1 warning)`, `4833 errors and 0 warnings potentially fixable with the --fix option.` |
| Frontend | `npm run test:run` (`vitest run`) | **PASS**: `Test Files 11 passed (11)`, `Tests 64 passed (64)`, duration 19.47 s. Noise: `Not implemented: Window's scrollTo() method` ×8 (jsdom). |

### Breakdown of the frontend lint failure

`eslint-plugin-prettier` runs Prettier as an ESLint rule.

- **4,831 errors** are `prettier/prettier  Delete ␍`. They come from 14 files whose **working-tree copy has CRLF line endings**: `git config core.autocrlf` is `true` on this machine, the index stores LF, and Prettier's default `endOfLine: "lf"` rejects CR. The files are:
  - `features/automations/workflow-builder-page.tsx`
  - `features/leads/lead-detail-page.tsx`
  - `features/leads/log-call-dialog.tsx`
  - `features/meetings/meetings-page.tsx`
  - `features/meetings/schedule-meeting-dialog.tsx`
  - `features/settings/workspace-settings-page.tsx`
  - `features/tasks/tasks-page.tsx`
  - `lib/backend-client.test.ts`
  - `lib/backend-client.ts`
  - `lib/template-variables.ts`
  - `routes/settings.tsx`
  - `store/index.ts`
  - `types/meeting.ts`
  - `types/task.ts`

  This is a checkout artefact; there is no `.gitattributes`. Repo-wide, `git ls-files --eol` shows 77 files with a CRLF working copy, 170 with LF, and 3 non-text files.
- **2 genuine formatting errors** that would also fail on an LF checkout:
  - `src/lib/labels.ts:47`: `prettier/prettier  Insert ⏎···`. This is the over-long `objection_internal_approval` label line.
  - `src/lib/supabase-client.ts:20`: `prettier/prettier  Delete ⏎·`.
- **1 warning**: `src/store/workspace-context.tsx:46`: `react-refresh/only-export-components  Fast refresh only works when a file only exports components. Use a new file to share constants or functions between components.` (the `useWorkspace` hook is exported next to the provider).

Not run, because they were outside the requested set: Frontend `format:check` and `build`, Backend `build`, and the integration tests.

---

## 2. Backend tests

Config: `vitest.config.ts` (node environment, `tests/**/*.test.ts`, setup `tests/setup-env.ts`).

| File | `it` blocks (it.each expands; vitest counted 123 unit tests) | Covers |
|---|---|---|
| `tests/unit/callRouting.test.ts` | 13 | `routeNotConnected` (stage, automation, retry task, trigger; `invalid_number` and `wrong_number` contactability). `routeConnectedOutcome` for positive, meeting_agreed, interested_later (30-day fallback and restart − 7 days), future_possibility, information_requested, wrong_fit, callback_requested, wrong_person. The 5 objection outcomes are covered by an `it.each`. |
| `tests/unit/meetingRouting.test.ts` | 9 | Every meeting outcome except `no_proposal_required`. |
| `tests/unit/proposalRouting.test.ts` | 4 | sent, accepted, rejected; draft and other statuses have no effect. **Not covered:** revision_requested and expired. |
| `tests/unit/pipeline.test.ts` | 7 | `isTerminalLifecycle`, `assertValidPipelineStage`, `assertPipelineStageEditable`, `pipelineStageIndex`. |
| `tests/unit/templateRenderer.test.ts` | 14 | Token substitution, fullName fallback, missing fields, unknown tokens kept and reported, meeting tokens, HTML escaping in the body but not the subject, null meeting link, the throw when meeting tokens are used without a meeting, `findUnknownTemplateTokens`. |
| `tests/unit/htmlToWhatsAppText.test.ts` | 13 | Bold/italic/underline, br, paragraphs, bullet and numbered lists, entities, links (safe, duplicate, unsafe), stripping unknown tags, nested lists with `start=`. |
| `tests/unit/integration-security.test.ts` | 9 | AES-GCM round trip with AAD, tag tampering rejected, phone normalisation (IN default, international, ambiguity), JID mapping, Baileys terminal codes, backoff cap, spacing bounds, restriction detection. |
| `tests/unit/leadImport.test.ts` | 11 | `validateLeadFields` rules and field tags. |
| `tests/unit/websiteForm.test.ts` | 22 | `splitName`, `parseMessage`, `normalizeWebsiteForm`, `formatSubmissionDetail`. |
| `tests/unit/ingestGuard.test.ts` | 4 | Key matching and the fixed-window limiter. |
| `tests/unit/publicLeads.routes.test.ts` | 5 | Router guards that run before the DB: no key, wrong key, oversized body, non-object JSON, GET → 404. Uses raw `fetch` against `app.listen(0)`. |
| `tests/unit/workflows.service.test.ts` | 2 | `updateWorkflow` with a fake `Queryable`: trimmed name and cleared description; whitespace name rejected. |
| `tests/integration/businessFlows.test.ts` | 15 (skipped without `TEST_DATABASE_URL`) | Create lead; not-connected call routing; DNC cascade; manual communication; task reschedule and cancel; meeting and proposal routing plus dashboard; Won meeting outcome; no stage regression on a second meeting; prep task cancelled with the meeting; published-version immutability; concurrent `updateDraftSteps`; `deleteWorkflowVersion` (3 cases); `enrollLeadInWorkflow` ignores the trigger; partial CSV import. |
| `tests/integration/leadIngest.test.ts` | 12 (skipped without `TEST_DATABASE_URL`) | Website ingest: unassigned lead and no automation; default owner; deactivated owner falls back to unassigned; settings service; placeholder company and single-word name; junk phone with a valid email; rejection writes nothing; dedupe by email or phone; 10-minute identical resubmission; DNC lead untouched; concurrent duplicate submits produce one lead; workspace isolation. |

These integration tests **write real rows** to the target database.

## 3. Frontend tests

Config: `vitest.config.ts` (jsdom, `src/test/setup.ts`, restore and clear mocks).

| File | Covers |
|---|---|
| `lib/backend-client.test.ts` | A parameterised method/URL table for key calls (lead create, log call, task edit, meeting, …). Multipart proposal upload fields. Retained email secrets omitted from the update. `X-Workspace-Id` absent before selection and present after. Error normalisation and the local sign-out on 401. |
| `lib/supabase-client.test.ts` | `backendBaseUrl` strips a trailing `/`, `/api` and `/api/v1` (parameterised). |
| `lib/presentation.test.ts` | IST form value converted to UTC; labels kept distinct from enum values; `meeting_agreed` trigger label. |
| `lib/html-to-whatsapp-text.test.ts` | The preview port: links, unsafe hrefs, nested lists. |
| `lib/template-html.test.ts` | Design detection, legacy body handling, preview isolation, base64 images, sanitiser. |
| `store/query.test.ts` | `refreshLead` invalidates every lead-dependent key; workspace-scoped keys include the workspace id. |
| `app/app-shell.search.test.tsx` | Header search: case-insensitive, multi-field, token order, whitespace, no results, Escape, outside click, keyboard navigation. |
| `features/automations/template-body-editor.test.tsx` | Link insertion, no spurious updates, list Enter/Tab. |
| `features/automations/templates-page.test.tsx` | Variable insertion (parameterised), HTML preservation through preview/save/reopen, a failed save keeps the edits, convert-to-visual confirmation, WhatsApp switch. |
| `features/automations/workflow-builder-page.test.tsx` | The details editor only: save trimmed values, block an empty name, cancel. |
| `test/routes.smoke.test.tsx` | Empty-state text for Dashboard, Leads, Tasks, Meetings and Proposals with empty backend data. |

## 4. What is not covered

Backend:
- **Services with no unit tests or mocks:** `leads` (beyond validation), `calls`, `tasks`, `meetings`, `proposals`, `proposalSending`, `runs`, `automation`, `connections`, `workspaces`, `admin-users`, `notifications`, `dashboard`, `timeline`, `whatsapp-inbound`, `meeting-calendar-sync`, `meetingScheduledNotification`, `websiteLeadSettings`. Only the gated integration tests touch some of these.
- **Routes:** no supertest/HTTP tests except the public-leads guards. Nothing tests `authMiddleware` (`requireAuth`, `requireSalesperson`, `requireWorkspace`), the error envelope, Zod schemas, multer limits, or role separation.
- **Worker:** `worker.ts` tick, claim, eligibility, retry and backoff, dry run, reclaim of stuck actions; `executeInternalAction`, `recordActionResult`, `skipAction`.
- **Providers:** email provider (Resend/SMTP selection, env fallback, error classification); `BaileysManager` (`performSend` and its eligibility branches, which is where the meeting-source bug lives); registry; Google Calendar provider and OAuth completion.
- **Logic paths:** template deletion vs previous versions; the default-meeting template across workspaces; lifecycle transitions out of DNC through won, lost or nurture; `moveToLongTermNurture` together with workflow eligibility; `logCall` on non-active leads; `change_lead_stage` to `objection_nurture`.
- **Database:** no migration tests (no check that 001→018 applies cleanly or that the seeds work).

Frontend:
- No tests for: the lead detail page, `LogCallDialog` (including the enroll and schedule chaining), `EnrollWorkflowDialog`, `ScheduleMeetingDialog`, `SendProposalDialog`, the proposals status flow (the missing loss reason would have been caught), the workflow builder step editing, autosave and publish, the runs page, the settings page, the admin page, the login page, AuthGate redirects (including the `?calendar=` forward), workspace switching, and the CSV import dialog and its utils.
- No end-to-end or browser tests anywhere.

## 5. Tooling notes

- Backend `tsconfig` includes `tests`, so `npm run build` compiles the tests into `dist/tests` (they ship in the image, unused).
- Backend has `supertest` and `pino-http` as dependencies but never imports them.
- There is no `.gitattributes`. CRLF/LF depends on each developer's git config, which is why Frontend lint fails on this Windows checkout.
- There is no CI configuration in the repo (no `.github/`).
