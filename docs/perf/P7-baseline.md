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
