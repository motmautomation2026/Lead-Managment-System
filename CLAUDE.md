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

## Tests

- `npm run check` (in both `Backend/` and `Frontend/`) must pass and stays database-free.
- Integration tests (`Backend/tests/integration`) need `TEST_DATABASE_URL` (staging), run
  serially, and refuse the prod ref.
- Run them with `npm run test:integration:staging` in `Backend/`. It loads
  `TEST_DATABASE_URL` from `Backend/.env`, refuses the prod ref, and runs
  `tests/integration`. Run it after every backend change.
- Stop any local `npm run dev` / `npm run worker:dev` that points at staging first. They
  share the 15-slot session pooler (tests then fail with `EMAXCONNSESSION`). A live worker
  also claims queued proposal/meeting rows that the tests create.

## Migrations

- Additive only, numbered after the highest existing file in `Supabase/migrations/`
  (currently `020`).
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
- Do not skip migrations or apply only `001_initial_migration.sql`; the latest project needs migrations `001` through `018`.

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
