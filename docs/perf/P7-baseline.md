# P7 — scalability baseline (staging, 2026-11-10)

**Data:** `npm run staging:load-seed -- --confirm`: 10 `[test] load-seed …` workspaces × 2,000 contacts = 20,000
contacts, 8,000 companies, 6,000 deals, 30,000 tasks, 100,000 timeline events, 2,000 meetings, 2,000 proposals, 18,000
AI decisions, 8,000 sent messages (4,000 email + 4,000 WhatsApp, i.e. 20 % of contacts on both channels) with message
facts, 1,000 counted opens, 1,230 replies, 321 reply drafts, 24,000 wake-ups, 30 users, 20 fake WhatsApp numbers
(disconnected), AI off. Database 141.6 MB →
226.4 MB (limit used: the Free plan's 500 MB, stop line 350 MB; `max_connections` 60, Nano/Free tier; the plan itself
can't be read without the Management API).

**Method:** `npm run staging:perf-measure -- --label baseline`: each path 20× (worker sweeps 5×, the AI tick 3×) from
this laptop against the staging transaction pooler (Mumbai). **Wall** includes one network round trip (~40–60 ms) per
statement plus row transfer, so it is not what production sees; **server** = EXPLAIN (ANALYZE, BUFFERS) execution +
planning of every statement of one call, re-run in a rolled-back transaction. Targets: API reads p95 < 300 ms, funnel
180 d < 1 s, each worker claim/batch < 500 ms (judged on server time + statements × in-region round trip, ~1 ms), no
sequential scan on a table > 10,000 rows in a hot path. Worker paths ran only on the load-seed workspaces; nothing was
sent; the AI tick used the tests' fake model (never OpenAI).

| Path | p50 wall ms | p95 wall ms | statements | server ms | worst statement ms | seq scan > 10k rows |
|---|---:|---:|---:|---:|---:|---|
| contacts: default (createdAt desc) | 495 | 939 | 2 | 10.8 | 3.2 | — |
| contacts: sort lastActivityAt:desc | 589 | 858 | 2 | 2.3 | 1.0 | — |
| contacts: sort updatedAt:desc | 414 | 942 | 2 | 2.7 | 1.5 | — |
| contacts: sort name:asc | 501 | 858 | 2 | 1.8 | 0.7 | — |
| contacts: sort company:asc | 404 | 1003 | 2 | 1.7 | 0.6 | — |
| contacts: sort hotScore:desc | 381 | 766 | 2 | 1.9 | 0.7 | — |
| contacts: filter stage + owner | 381 | 695 | 2 | 4.9 | 2.8 | — |
| contacts: filter open deal + AI active | 629 | 1001 | 2 | 4.5 | 2.1 | — |
| contacts: search q=Seed123 | 183 | 487 | 2 | 14.5 | 12.2 | — |
| contacts: count | 54 | 99 | 1 | 1.1 | 0.9 | — |
| contacts: count q=Seed12 | 59 | 131 | 1 | 6.9 | 5.4 | — |
| contact timeline page | 64 | 212 | 1 | 0.8 | 0.1 | — |
| companies: default | 185 | 424 | 1 | 1.2 | 0.6 | — |
| companies: sort contactCount | 218 | 398 | 1 | 7.1 | 6.4 | — |
| companies: search q=Company 12 | 78 | 216 | 1 | 3.5 | 2.4 | — |
| deals: default | 267 | 392 | 1 | 1.7 | 0.8 | — |
| deals: open, sort amount | 400 | 753 | 1 | 7.1 | 6.3 | — |
| deal board | 668 | 984 | 1 | 7.5 | 5.1 | — |
| tasks: default (open, due asc) | 330 | 528 | 1 | 2.1 | 1.1 | — |
| tasks: Hottest first | 366 | 712 | 1 | 31.3 | 30.3 | leads |
| tasks: overdue | 393 | 885 | 1 | 2.1 | 1.1 | — |
| tasks: count | 50 | 65 | 1 | 7.0 | 6.5 | — |
| global search q=Seed 15 | 79 | 359 | 3 | 25.8 | 15.9 | — |
| Home summary | 663 | 1436 | 9 | 10.9 | 2.8 | — |
| AI Activity list | 202 | 498 | 1 | 2.1 | 1.4 | — |
| AI Results stats | 152 | 376 | 11 | 15.3 | 7.5 | — |
| funnel 30 d by source | 166 | 403 | 3 | 29.6 | 15.3 | — |
| funnel 30 d by channel | 139 | 170 | 3 | 13.1 | 9.2 | — |
| funnel 30 d by number | 144 | 162 | 3 | 11.5 | 7.5 | — |
| funnel 30 d by angle | 140 | 640 | 3 | 11.2 | 7.3 | — |
| funnel 180 d by source | 193 | 451 | 3 | 70.6 | 39.5 | leads |
| funnel 180 d by channel | 176 | 429 | 3 | 42.5 | 38.8 | — |
| funnel 180 d by number | 183 | 418 | 3 | 45.0 | 40.0 | — |
| funnel 180 d by angle | 173 | 667 | 3 | 43.4 | 39.6 | — |
| Settings → WhatsApp numbers | 100 | 356 | 9 | 4.9 | 0.7 | — |
| worker: workflow action claim (20) | 139 | 180 | 1 | 0.3 | 0.1 | — |
| worker: email outbound claim (10) | 160 | 650 | 1 | 0.5 | 0.1 | — |
| worker: email outbound tick (seeded, dry run) | 144 | 155 | 1 | 0.5 | 0.1 | — |
| worker: decideSend counters (loadSendStats) | 47 | 96 | 1 | 1.1 | 0.3 | — |
| worker: inbound reply match (phone) | 134 | 175 | 1 | 0.3 | 0.1 | — |
| worker: hot-score sweep batch (200 marked) | 759 | 1563 | 3 | 161.5 | 158.1 | — |
| worker: company sweep (20 contacts) | 8415 | 8772 | 80 | 36.4 | 0.9 | — |
| worker: deal sweep (10 contacts) | 2988 | 3390 | 51 | 20.9 | 0.9 | — |
| worker: reply labels tick | 79 | 124 | 2 | 0.6 | 0.1 | — |
| worker: reply drafts tick | 77 | 148 | 2 | 0.7 | 0.1 | — |
| worker: reply draft sends tick | 36 | 42 | 1 | 0.3 | 0.1 | — |
| worker: reply escalation tick | 40 | 58 | 1 | 1.0 | 0.1 | — |
| worker: meeting outcome tasks tick | 170 | 257 | 1 | 1.8 | 0.9 | — |
| worker: AI sends tick | 51 | 364 | 1 | 0.4 | 0.1 | — |
| worker: open events tick | 36 | 48 | 1 | 0.2 | 0.0 | — |
| worker: open pixel UPDATE | 36 | 43 | 1 | 0.3 | 0.2 | — |
| worker: AI wake-up claim + tick (shadow, fake model) | 1349 | 1770 | 17 | 202.3 | 34.0 | — |

**Plan notes (baseline):**
- `tasks: Hottest first` — joined every workspace's leads (seq scan of `leads`, 20,026 rows) and all companies, then
  sorted 1,800 open tasks: 41 ms server. Grows with the total number of contacts, not the workspace's.
- `funnel 180 d by source` — seq scan of `leads` for the cohort: the planner's choice while one workspace is 10 % of
  the table (`leads_workspace_created_idx` exists and is used once workspaces are a smaller share); 71 ms, target met.
- `hot-score sweep batch` — 158 ms in one statement: the counted-opens subquery scanned `email_outbound_messages` once
  per contact (no `lead_id` index).
- `inbound reply match`, `decideSend counters`, every claim: index scans, < 2 ms.
- Company / deal sweeps: one short transaction per contact by design (4–5 statements each); the wall time is round
  trips from this laptop, ~0.2 s per 20 contacts in region.
- Statement counts are fixed per call everywhere (no N+1): Home 9, AI Results 11, WhatsApp numbers 9 (parallel).

## After the fixes (item 3, same data, `--label after`)

Fixes: migration 057 `email_outbound_lead_idx`; the task / meeting / proposal work lists join `leads` and `companies` with
the workspace equality (`l.workspace_id = t.workspace_id`, `c.workspace_id = l.workspace_id`) so the workspace indexes are
used; every multi-workspace worker claim is round-robin across workspaces (`fairPickSql`). Four paths measured slower in
the full run because migration 057 was re-applied (DDL locks) while it ran; they were re-measured alone (`--only`, marked *).

Before → after, server time (the 12 slowest at baseline, plus the claims changed by the fair ticks):

| Path | before server ms | after server ms | after p95 wall ms (laptop) | seq scan > 10k rows |
|---|---:|---:|---:|---|
| AI wake-up claim + tick (shadow, fake model) | 202.3 | 16.3 | 1,409 | — |
| hot-score sweep batch (200) | 161.5 | 44.3 | 1,535 | — |
| funnel 180 d by source | 70.6 | 69.6 | 556 | leads (planner choice, see below) |
| funnel 180 d by number | 45.0 | 42.3 | 660 | — |
| funnel 180 d by angle | 43.4 | 42.9 | 419 | — |
| funnel 180 d by channel | 42.5 | 42.9 | 474 | — |
| company sweep (20 contacts) | 36.4 | 34.7 | 10,470 (81 round trips) | — |
| tasks: Hottest first | 31.3 | 2.1 | 878 | leads → none |
| funnel 30 d by source | 29.6 | 18.9 | 554 | — |
| global search q=Seed 15 | 25.8 | 12.4 | 320 | — |
| deal sweep (10 contacts) | 20.9 | 12.6 | 4,164 (52 round trips) | — |
| AI Results stats | 15.3 | 15.9 | 556 | — |
| Home summary* | 10.9 | 18.7 | 772 | — |
| workflow action claim (20) | 0.3 | 0.5 | 544 | — |
| email outbound claim (10) | 0.5 | 0.5 | 561 | — |
| decideSend counters* | 1.1 | 1.7 | 117 | — |
| inbound reply match* | 0.3 | 0.3 | 137 | — |
| Settings → WhatsApp numbers* | 4.9 | 4.9 | 308 | — |

All targets met on server time: API reads ≤ 25 ms (p95 target 300 ms), funnel 180 days ≤ 70 ms (target 1 s), every worker
claim ≤ 1 ms and every batch ≤ 45 ms (target 500 ms). The one remaining sequential scan is the funnel's 180-day cohort on
`leads`: the planner reads the whole table while one workspace is 10 % of it; `leads_workspace_created_idx` serves it as
soon as workspaces are a smaller share (the funnel is an analytics page, not a hot path). Wall times from this laptop are
round trips to Mumbai (~40–60 ms each): the company / deal sweeps run one short transaction per contact by design, so
~4 round trips per contact (~5 ms per contact in region). Statement counts per call are fixed (no N+1 found).

## Worker loops (one sequential loop; sleeps `WORKER_POLL_INTERVAL_MS` = 10 s after each tick)

| Step | Per-tick limit | Fairness before → after |
|---|---|---|
| Workflow actions | 20 (`WORKER_BATCH_SIZE`) | global oldest due → round-robin per workspace |
| Email outbound | 10, ≤ 1 per workspace | 1 per workspace, unordered pick of 10 → longest-waiting workspaces first |
| IMAP inbound | 1 workspace | round-robin by `next_poll_at` (unchanged) |
| Proposal / meeting WhatsApp | 20 / 20 | global oldest → round-robin |
| Knowledge ingestion | 2 documents | global oldest → round-robin |
| Company sweep | 200 contacts | global oldest, one claim query per contact → candidates picked round-robin up front, each locked (`skip locked`) |
| Deal sweep | 100 contacts | same as company sweep |
| Hot-score sweep | 200 | global by id / staleness → round-robin |
| Reply labels / reply drafts | 10 / 5 per channel | global oldest → round-robin |
| Open events | 50 | global oldest → round-robin |
| Reply-draft sends / AI sends / AI wake-ups | 5 / 5 / 5 | global oldest → round-robin |
| Reply escalation | 20 per workspace, no total | 20 per workspace + 100 per tick, round-robin |
| Meeting outcome tasks | 50 | global oldest → round-robin |
| Health alerts (new) | every 15 min, all workspaces | one notification per workspace per day per problem |
| WhatsApp managers | every needed number, one start per tick | unchanged |

## Worker memory and connections per number (rule 6, `npm run staging:worker-capacity`)

Fake managers: the `BaileysManager` object (never started: no Baileys socket, nothing sent) plus its session-lock client
holding the number's advisory lock, as `start()` opens it. Staging's session pooler has 15 clients, so at 20 numbers the
last 9 lock clients were stand-ins on the transaction pooler (same client cost).

| numbers | RSS Δ MB | heap Δ MB | heap per number | DB clients held |
|---:|---:|---:|---:|---|
| 1 | -0.9 | 0.1 | 121 KB | 1 (session pooler) |
| 10 | 0.7 | 0.7 | 76 KB | 10 (session pooler) |
| 20 | -3.2 | 0.4 | 19 KB | 20 (11 session pooler + 9 stand-ins) |

Per number: ~0.1 MB of heap (within GC noise) and **one session-pooler client** for as long as its manager runs; sends use
the shared transaction pool (no extra connection). A real Baileys socket's memory (signal sessions, caches) was not measured
(no real socket allowed here): measure it on the first production numbers before raising the cap. The limit is the session
pooler, by the unchanged E4a/E4b formula: numbers ≤ session pooler clients − 2 × `DB_SESSION_POOL_MAX` (API + worker) − 3
= 15 − 4 − 3 = **8 numbers per worker on a 15-client pooler** (the Settings warning threshold).
