# 04 — Environment variables (API, worker, frontend)

No secret values are written here. **Keep every secret that production already has exactly as it is**, above all
`INTEGRATION_ENCRYPTION_KEY`: a new value makes every saved WhatsApp session, SMTP/IMAP password and Google token
unreadable (WhatsApp would need re-pairing, email re-entering).

**Where they go.** The repo deploys as three Docker images (`Backend/Dockerfile` for the API, the same image started with
`node dist/src/worker.js` for the worker, `Frontend/Dockerfile` for the frontend; see `compose.yaml`). The repo does not say
which host production runs on. Set the values wherever that host keeps them. **If production uses `compose.yaml`:** put them
in the root `.env` next to it. This release adds the missing ones to `compose.yaml`, so deploy the new `compose.yaml` too:
the old one silently dropped `AGENT_RUNNER_ENABLED`, the model and price variables, `PUBLIC_API_BASE_URL`, `APP_BASE_URL`
and the pool sizes.

A = API, W = worker, F = frontend (build time). "Blank" = leave empty (the default in the code applies).

## Required (unchanged from today)

| Variable | A | W | F | Value |
|---|:-:|:-:|:-:|---|
| `DATABASE_URL` | ✔ | ✔ | | **Transaction pooler**, port **6543**: `postgres://postgres.<prod-ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres` |
| `DATABASE_SESSION_URL` | ✔ | ✔ | | **Session pooler**, port **5432** (same string, port 5432). Required on the worker for WhatsApp, which refuses to start without it. |
| `SUPABASE_URL` | ✔ | ✔ | | `https://<prod-ref>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | ✔ | ✔ | | keep today's value (never in the frontend) |
| `INTEGRATION_ENCRYPTION_KEY` | ✔ | ✔ | | **keep today's production value: the same on API and worker. Never generate a new one.** |
| `CORS_ORIGINS` | ✔ | ✔ | | the CRM's public URL, e.g. `https://crm.example.com` (the worker uses the first one for links when `APP_BASE_URL` is blank) |
| `NODE_ENV` | ✔ | ✔ | | `production` |
| `VITE_SUPABASE_URL` | | | ✔ | `https://<prod-ref>.supabase.co` (build argument) |
| `VITE_SUPABASE_ANON_KEY` | | | ✔ | the production anon key (build argument) |
| `VITE_API_BASE_URL` | | | ✔ | the API's public URL, e.g. `https://api.example.com` (build argument) |

## New since the last production deploy

| Variable | A | W | Value for go-live day |
|---|:-:|:-:|---|
| `AGENT_RUNNER_ENABLED` | | ✔ | **`false` at first deploy.** `true` only at step 11 (shadow check). This is the worker-level AI kill switch. |
| `OPENAI_API_KEY` | ✔ | ✔ | the OpenAI key (backend + worker only, **never** the frontend) |
| `OPENAI_EMBEDDING_MODEL` | ✔ | ✔ | `text-embedding-3-small` (must be 1536 dimensions) |
| `OPENAI_DECISION_MODEL` | ✔ | ✔ | `gpt-5.4-mini@low` (the writer; used when a workspace's AI settings leave the model blank. Staging MOTM sets the same pair in Settings → AI agent.) |
| `OPENAI_GROUNDING_MODEL` | ✔ | ✔ | `gpt-4.1` (the checker) |
| `OPENAI_PRICES_JSON` | ✔ | ✔ | one line of JSON with a price for **both** models, USD per million tokens, e.g. `{"gpt-5.4-mini":{"inputPer1M":<in>,"cachedInputPer1M":<cached>,"outputPer1M":<out>},"gpt-4.1":{"inputPer1M":<in>,"cachedInputPer1M":<cached>,"outputPer1M":<out>}}`. Take the numbers from OpenAI's pricing page, or from the JSON you used for `agent:model-test` / the demo journey (staging's `.env` has none). **A model without a price never runs** (the AI waits with "No AI model configured"). Malformed JSON stops the API from starting. |
| `PUBLIC_API_BASE_URL` | ✔ | ✔ | the API's public **https** URL, e.g. `https://api.example.com` (the email open pixel; open tracking itself stays OFF per workspace) |
| `APP_BASE_URL` | | ✔ | the CRM's public URL, e.g. `https://crm.example.com` (links in staff alert / digest emails) |
| `SESSION_POOLER_MAX_CLIENTS` | ✔ | ✔ | the production **session** pooler size (Supabase → Database → Connection pooling → Pool size) |
| `EMAIL_IMAP_POLL_SECONDS` | | ✔ | `120` |
| `CRM_COMPANY_SWEEP_ENABLED` / `CRM_DEAL_SWEEP_ENABLED` | | ✔ | blank (= on). They link existing contacts to companies and deals in batches after deploy. |
| `WORKER_DRY_RUN` | | ✔ | `false` (with `true` nothing is really sent, so leave it off on production) |
| `WORKER_POLL_INTERVAL_MS` / `WORKER_BATCH_SIZE` | | ✔ | `10000` / `20` |
| `GOOGLE_OAUTH_*`, `INGEST_API_KEY`, `INGEST_WORKSPACE_ID` | ✔ | | keep today's values (all three Google values together, or none) |

Not used any more: `RESEND_API_KEY`, `SMTP_FROM_*`. Email is set up per workspace in Settings → Email (SMTP + IMAP).

## Database connections (check before step 6)

Supabase → Database → Connection pooling shows two limits. Write both down.

| Pool | Variable | Go-live value |
|---|---|---|
| API transaction pool | `DB_POOL_MAX` (A) | `10` |
| Worker transaction pool | `WORKER_DB_POOL_MAX` (W) | `10` |
| Session pool (each of API and worker) | `DB_SESSION_POOL_MAX` (A, W) | `2` |
| Idle / wait timeouts | `DB_IDLE_TIMEOUT_MS`, `DB_CONNECTION_TIMEOUT_MS` | blank (10000 / 15000) |

- **Transaction pooler:** `DB_POOL_MAX + WORKER_DB_POOL_MAX` = 20 must be below its client limit. **STOP** if the limit is below 25.
- **Session pooler:** `2 × DB_SESSION_POOL_MAX` (4) + **1 per connected WhatsApp number** (the worker's lock connection) + 3 (the
  dashboard and scripts) must be ≤ the session pool size. With 2 numbers that is 9. Settings → WhatsApp shows a warning
  when it gets close. **STOP** before connecting another number once the sum reaches the limit.
- **Exactly one worker** may point at production. A second worker means two WhatsApp sockets on one number, which risks a
  ban. Local `.env` files always point at staging (`arejsxqjhzotmngrobhm`).
