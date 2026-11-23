SUM-1 — Lead summary card on the contact page (production is live; small, safe feature)

Goal (Govinda, 23 Nov): when a salesperson opens a lead, a short summary at the top tells them in 10 seconds: what the lead needs, what has happened so far, where it stands, and what to do next.

**Staging only. Never connect to production. Tests never call OpenAI. No OpenAI call inside a request handler (worker only).**

Rules:
1. **Card:** "Lead summary" at the top of the contact page main column (above the "Next" task card), collapsible (state remembered), also in the peek drawer if cheap. Shows "Updated <time>" and a "Refresh" button (admin or owner; queues a job, max once per 5 minutes per lead).
2. **Content (max ~80 words, plain bullets, no markdown headings):**
   - **Requirement:** what they asked for (enquiry form message, service, company/industry if known).
   - **So far:** key events with dates: calls (outcome + note gist), messages sent (AI / rep, channel), lead replies (gist only, never full quotes), meetings, proposals, deal stage.
   - **Status:** lifecycle/stage, hot band, AI status (live / shadow / stopped + why), opt-outs / DNC.
   - **Next step:** the next open task or meeting (or "No next step").
   - Facts only from CRM data; never invent; say "Not known" if missing. English.
3. **Two layers:**
   - **Quick facts (no AI, instant):** requirement text, last call outcome + date, last message + date, last reply date, next task — built by a backend service, always shown.
   - **AI summary (worker):** generated with the writer model (`OPENAI_DECISION_MODEL`, low effort), short prompt, cache-friendly (fixed instructions first). Stored per lead with `generated_at` and a hash of the inputs.
4. **When it is (re)generated:** a summary job is queued (debounced 2 min, max 1 per lead per 10 min) when: the lead is created, a call / note / meeting / proposal / deal-stage change is logged, a message is sent, or a reply arrives — **only for leads where `isAutomated` is true**, plus **any lead opened in the UI** whose summary is missing or older than its last activity (old leads are summarised only when someone opens them). Skip if the input hash is unchanged.
5. **Cost guard:** own daily cap per workspace (`summary_daily_cap`, default 200) separate from the AI decision cap; cost recorded and included in the AI spend/monthly budget view. Over the cap → only Quick facts, card says "AI summary paused for today".
6. **Privacy:** same visibility as the lead (workspace access rules, D2 reply-visibility rules). Lead reply text is summarised, never quoted; summary text never logged. Store it like other sensitive AI text (encrypted if inbound reply content is encrypted today — report what you do).
7. **The summary is for staff only:** never sent to the lead and never put into the writer prompt.

ITEM 0: read CLAUDE.md; `git checkout dev`; `git pull`; clean tree; .env → STAGING only (never `jorxltfwboabyjiydyhu`); no local API/worker running; `npm run check` both packages. Read only: contact page + record layout, timeline service, home/quick-facts sources, agent model client + cost tracking, worker job queue, `isAutomated`, D2 reply visibility. Report the plan in 5 lines, then continue.

ITEM 1 (commit): migration **064** (additive, re-runnable: summary table/columns, job queue rows if needed, `summary_daily_cap`); apply on staging twice + `npm run db:security-check`. Domain + service + worker job + route (`GET /leads/:id/summary`, `POST /leads/:id/summary/refresh`) + hook + card UI. Tests: quick facts builder, debounce/once-per-10-min, hash skip, cap reached, old lead only on open, visibility (non-member 403), prompt contains no raw reply text, component test (card, refresh, collapsed state, cap message).

FINISH: `npm run check` both packages; related integration files on staging only; one commit (or two: code + docs) on `dev`, push `dev` only (Govinda pushes `main`). Report: commit, files, migration 064 SQL for production, estimated cost per summary (tokens × price, in USD and INR at ₹95/$), tests, deploy steps.
