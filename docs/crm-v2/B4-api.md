# CRM v2 — List & record API (B4)

The contract the new frontend (C phases) builds on. Design: `B2-design.md` §4.
All paths are under `/api/v1`, need a signed-in CRM user (admin or salesperson) and the
`X-Workspace-Id` header; every query is scoped to that workspace. Errors use the usual
shape `{ error: { code, message, details? } }`. **A** = admin only (403 otherwise).

## 1. The list standard (`Backend/src/lists/listQuery.ts`)

| Rule | Detail |
|---|---|
| Response | `{ data: Row[], nextCursor: string \| null }` — `null` at the end. Totals come from the separate `/count` endpoint (`{ count }`), same filters, no `limit`/`cursor`/`sort` (sending them is a 400). |
| `limit` | 1–100, default 50. |
| `cursor` | Opaque. Pass back `nextCursor` unchanged with the **same** filters and sort. It is `base64url(JSON [sortValue, id, "field:dir"])`; timestamps are kept as Postgres text (microseconds). Malformed, tampered or from another sort → **400 "Invalid cursor."** |
| `sort` | `field:asc` or `field:desc` from the object's whitelist (below); anything else → 400. Ties break on `id` in the same direction. Nullable fields (deal `amount`, `expectedCloseDate`) sort **NULLs last in both directions**. |
| Filters | Flat query params, unknown params → 400 (`.strict()`). Multi-value = repeat the param (`ownerId=a&ownerId=b`). Booleans are exactly `true` / `false`. Timestamp ranges (`createdFrom/To`, `updatedFrom/To`, `lastActivityFrom/To`) need ISO 8601 with an offset (`2026-10-24T00:00:00+05:30`) and are inclusive. Date ranges (`expectedCloseFrom/To`) are `YYYY-MM-DD`, inclusive. Amounts are numbers ≥ 0, inclusive. |
| `ownerId` | User ids, `me` (the caller) and/or `none` (no owner), combinable. |
| `q` | Trimmed, min 2 characters (else 400), max 200. Case-insensitive "contains"; `%`, `_` and `\` match literally (`escapeLike`, audit B30 — also applied to the old `GET /leads?search=`). |
| Indexes | Every whitelisted sort has a `(workspace_id, field, id)` index (migrations 032/033), except companies `contactCount` (below). `q` uses trigram GIN indexes. |

Known limits (accepted 2026-10-24):
- **2-character searches may scan.** Trigram indexes need 3 characters to narrow anything; a 2-character `q` reads the workspace's rows. Fine at current sizes.
- **Companies `contactCount` has no index.** It is counted per row (lateral count over `leads(workspace_id, company_id)`), so sorting by it reads every company in the workspace. Fine at ~1,000 companies (see §8).
- Contact `q` also matches the full name `first_name || ' ' || last_name` (migration 034, C2): "Asha Rao" matches; the reverse order ("Rao Asha") does not.

## 2. Contacts (`leads` rows; UI says Contact)

Writes stay on the existing `/leads/:id/...` routes.

| Endpoint | Notes |
|---|---|
| `GET /contacts` | List standard. |
| `GET /contacts/count` | `{ count }`. |
| `GET /contacts/:id` | The existing Lead DTO, plus `company: {id, name, domain} \| null` and `deals: [{id, name, stage, amount, currency, closedAt}]` (newest updated first). The Lead DTO's text `company` is returned as **`companyText`** (the key `company` holds the object). 404 for another workspace. |
| `GET /contacts/:id/timeline` | C3. The contact's timeline, **newest first**, list standard on `(occurred_at, id)` (index `(lead_id, occurred_at, id)`, migration 035): `limit` 1–100, `cursor`, no `sort` (400). Optional `kind[]` = Activity groups `notes, calls, meetings, proposals, tasks, messages, ai, deals, system` (first match wins: `related_deal_id` → deals; actor "AI Agent" → ai; then by `event_kind`: note, call, meeting, proposal (C4: its own group, was under meetings), task, email/whatsapp; else system). Rows = the timeline DTO (`id, leadId, at, kind, title, detail, actor, source, related…Id, metadata`). 404 for another workspace. The old `GET /leads/:id/timeline` (everything, oldest first) is unchanged. D2: a row of a **matched** inbound WhatsApp reply also has `reply: { messageId, hasText, canRead }` (§7f), never the text. |
| `POST /contacts/bulk` | `{ ids: uuid[1..100], action: "assignOwner" \| "enrollAi", ownerId? }` → `{ data: [{ id, ok, error? }] }` in request order (duplicates removed). One failure never stops the others. `assignOwner` needs `ownerId` of an **active** user (else 400 for the whole request) and runs the normal lead update per contact (timeline "Lead Assigned"). `enrollAi` is **A** and calls the AI enroll service (`error` explains skips: already enrolled, not eligible, no email/phone, …). A contact in another workspace → `ok: false, error: "Contact not found."` |

Filters: `ownerId[]`, `leadStatus[]` (pipeline stage), `lifecycle[]` (default `active` + `long_term_nurture`; `all` = every state except merged; `merged` only when named), `source[]`, `companyId`, `agentStatus[]` (`none|active|paused|handed_off|stopped`), `hasOpenDeal`, `createdFrom/To`, `lastActivityFrom/To`, `q` (full name "first last", first name, last name, company, email, phone).

Sorts: `createdAt` (**default desc**), `lastActivityAt`, `updatedAt`, `name` (last name, then first name), `company`.

`ContactListItem`: `id, name, firstName, lastName, email, phone, jobTitle, source, company {id,name}|null, owner {id,name}|null, leadStatus, lifecycle, openDeal {id,name,stage,amount,currency}|null` (the most recently updated open deal), `agentStatus, nextAction {taskId,type,title,dueAt,ownerId,ownerName,origin}|null, lastActivityAt, createdAt`.

## 3. Companies

| Endpoint | Notes |
|---|---|
| `GET /companies` · `GET /companies/count` | List standard; merged companies excluded. |
| `GET /companies/:id` | All fields + `contactCount, openDealCount, openDealAmount`, `lastActivityAt` (latest `last_activity_at` of its non-merged contacts, C3). A merged company is still returned with `mergedIntoCompanyId` (follow it). |
| `GET /companies/industries` | C3. `{ data: string[] }`: up to 200 distinct industries of live companies, A–Z (the Industry filter's options). |
| `POST /companies` | `{ name, domain?, website?, industry?, revenueRange?, city?, state?, country?, linkedinUrl?, employeeRange?, description?, ownerId? }` → 201 detail. Same normaliser and unique rules as automatic linking: a placeholder name ("Not provided", "NA", …) → 400; a domain is normalised (`https://www.Acme.in/x` → `acme.in`), invalid or free-mail → 400. Same normalized name or domain as a live company → **409 with `details.companyId`** of that company. Owner defaults to the caller; `null` = no owner; must be active. Opens `similar_name` suggestions like an automatic create. |
| `PATCH /companies/:id` | Any field above (`""`/`null` clears). A **rename** re-normalizes and updates every linked contact's `leads.company` text in the same transaction; a name/domain that belongs to another live company → 409 with `details.companyId`. Merged company → 409. |
| `GET /companies/:id/contacts` | The contacts list standard with `companyId` fixed (passing `companyId` is a 400). 404 for a merged / other-workspace company. |
| `GET /companies/:id/deals` | The deals list standard with `companyId` fixed. |
| `GET /companies/:id/timeline` | C3. Same contract as `GET /contacts/:id/timeline`. Rows = events of the company's **non-merged** contacts plus every event with `related_deal_id` of one of its deals (even when that deal's contact is elsewhere), each with `contact {id, name}`. 404 for a merged / other-workspace company. |
| `POST /companies/:id/merge` **A** | `{ sourceId }` → `{ targetId, sourceId, movedContacts }`. `:id` is kept. See §5. |

Filters: `ownerId[]`, `industry[]` (exact text), `hasDomain`, `createdFrom/To`, `q` (name, domain).
Sorts: `name` (**default asc**), `createdAt`, `updatedAt`, `contactCount`.

`CompanyListItem`: `id, name, domain, industry, city, owner {id,name}|null, contactCount` (excludes merged contacts), `openDealCount, openDealAmount` (**INR only**: the sum of open deals in INR, the only currency for now), `createdAt, updatedAt`.

## 4. Deals

| Endpoint | Notes |
|---|---|
| `GET /deals` · `GET /deals/count` | List standard. |
| `GET /deals/board` | Same filters except `stage` (400). `{ data: [{ stage, count, amountTotal, items, nextCursor }] }` for **every** stage in pipeline order (qualified → … → won, lost); `items` = first 20 by `updatedAt desc`, `amountTotal` in INR. Load more in a column with `GET /deals?stage=<stage>&sort=updatedAt:desc&cursor=<nextCursor>` plus the board's other filters. Pass `status=all` to fill the Won/Lost columns. C4: **one query** (per-stage window `count` / INR `sum` / `row_number` over the filtered deals, first 21 rows per stage); same contract and cursors as before. |
| `GET /deals/:id` | All fields + `owner, company, contact {id,name,email,phone,lifecycle}`, `meetings [{id,title,at,status,outcome}]` and `proposals [{id,title,amount,currency,status,sentAt,updatedAt}]` linked by `deal_id`. |
| `POST /deals` | `{ leadId, name?, stage? (default qualified), amount?, currency? ("INR"), expectedCloseDate?, lossReason?, lossNotes?, ownerId? }` → 201 detail. Company and service interest come from the contact; the owner too unless `ownerId` is sent (C5: an **active** user id, or `null` = no owner; inactive/unknown → 400; same transaction as the create); the default name is `"<Company> – <service interest or New opportunity>"`. Lost needs `lossReason` (400). Contact in another workspace → 404. |
| `PATCH /deals/:id` | `name, amount (≥ 0 or null), currency ("INR" only, else 400), expectedCloseDate (YYYY-MM-DD or null), ownerId (active user or null), companyId (live company in this workspace, or null)`. `stage` → **400 "Change a deal's stage with POST /deals/:id/stage."** |
| `POST /deals/:id/stage` | `{ stage, lossReason?, lossNotes?, contactAction? }` → detail. A manual move: any stage, closed deals can be reopened. Lost needs `lossReason` (400); the current stage → 409. Deal won with no other open deal → the contact becomes Won (existing triggers fire); deal lost → contact unchanged (B3b rules) unless `contactAction` says otherwise. |
| `contactAction` (C4) | Only with `stage: "lost"` (any other stage → 400). `keep` (default): contact unchanged. `long_term_nurture`: the existing `moveToLongTermNurture` (timeline "Moved to Long-Term Nurture", detail "Deal lost: <deal name>"). `lost`: the existing `markLost` with the deal's `lossReason` / `lossNotes` — like every lost contact this also closes the contact's **other** open deals as lost (`other`, "Contact lost"). Same transaction as the deal move; a DNC contact fails the whole request (409, deal unchanged). |
| `GET /deals/:id/timeline` | C4. Same contract as the contact/company timelines (newest first, `limit`, `cursor`, `kind[]`, no `sort`). Rows = events with `related_deal_id = :id` plus the events of the meetings and proposals linked to the deal by `deal_id` (`related_meeting_id` / `related_proposal_id`; partial indexes from 002, no migration), each with `contact {id, name}`. Since C4 "Meeting Scheduled" / "Proposal Created" rows carry their meeting/proposal id; older creation rows don't, so they only show on the contact. 404 for another workspace. |

Filters: `stage[]`, `ownerId[]`, `companyId`, `leadId`, `status` (`open` | `won` | `lost` | `all`; **default `open`**, or `all` when `stage` is given), `amountMin/Max`, `expectedCloseFrom/To`, `createdFrom/To`, `q` (deal name, company name).
Sorts: `updatedAt` (**default desc**), `createdAt`, `amount`, `expectedCloseDate` (both nullable: NULLs last), `name`.

`DealListItem`: `id, name, stage, amount, currency, expectedCloseDate (YYYY-MM-DD|null), owner {id,name}|null, company {id,name}|null, contact {id,name}, source, closedAt, createdAt, updatedAt`.

## 5. Duplicate review — `/company-duplicates` (all **A**)

| Endpoint | Notes |
|---|---|
| `GET /company-duplicates` | List standard (sort `createdAt`, default desc). Filters: `status[]` (`open` default, `merged`, `dismissed`, `all`), `reason[]`, `kind` (`pair` \| `contact`), `companyId` (C3: rows where it is company A or B). Row: `id, kind, reason, score, status, createdAt, resolvedAt, companyA {id,name,domain,industry,merged,contactCount,openDealCount}, companyB {…}\|null, contact {id,name,email,company}\|null, observedName, observedDomain`. |
| `GET /company-duplicates/count` | C3. `{ count }` with the same filters (no `limit`/`cursor`/`sort`). Used for the review button, the per-kind tabs and the admin nav badge. |
| `POST /company-duplicates/:id/merge` | Pair rows only (contact row → 400). `{ targetId? }` (default company A; must be A or B, else 400) → the merge result. Not open → 409. |
| `POST /company-duplicates/:id/dismiss` | → 204. Not open → 409. |
| `POST /company-duplicates/:id/relink` | Contact rows only. `{ companyId? }`: link the contact to that live company, or (omitted) to a **new** company named after `observedName` (same rules as `POST /companies`, a clash → 409 with `details.companyId`; created without a domain, which belongs to the company it was matched to). The contact's company text follows; timeline "Company changed". The row is resolved as `dismissed` (there is no separate "relinked" status). |

**Merge re-pointing.** After any merge (either route), the source company's other **open** suggestions move to the target: a pair `(source, X)` becomes `(target, X)`; a contact-level row on the source moves to the target. If the re-pointed row would be `(target, target)`, or a row for it **already exists in any status** (the unique keys ignore status), the source's row is **dismissed** instead. Resolved rows are left as history.

## 6. Global search — `GET /search?q=`

`q` as in §1 (min 2). → `{ contacts: [{id,name,email,company,lifecycle}], companies: [{id,name,domain}], deals: [{id,name,stage,amount,currency,company}] }`, at most 5 each, best trigram match first, then most recent activity / update. Merged contacts and companies are excluded; deals of every status are included.

## 7. Saved views — `/saved-views`

| Endpoint | Notes |
|---|---|
| `GET /saved-views?object=contacts\|companies\|deals\|tasks\|meetings\|proposals` | `{ data }`: the caller's views plus views shared in the workspace, by `position`. Row: `id, object, name, filters, sort, columns, isShared, position, ownerId, isMine, createdAt, updatedAt`. |
| `POST /saved-views` | `{ object, name, filters?, sort?, columns?, isShared?, position? }` → 201. **Max 30 per user per object** (409). |
| `PATCH /saved-views/:id` | Any field except `object`. |
| `DELETE /saved-views/:id` | → 204. |

`filters` are stored **exactly as the list endpoint's query params** (strings and string arrays, e.g. `{"ownerId": "me", "leadStatus": ["new"], "hasOpenDeal": "false"}`) and validated by the same Zod schema as that object's list (no `limit`/`cursor`); `sort` by the same sort whitelist; `columns` must be known column ids for the object (no repeats). Invalid → 400. The owner may edit/delete; admins may also edit/delete **shared** views; anyone else → 403 on a shared view, 404 on a private one.

Column ids — contacts: `name, email, phone, jobTitle, company, owner, leadStatus, lifecycle, openDeal, agentStatus, nextAction, lastActivityAt, createdAt, source`; companies: `name, domain, industry, city, owner, contactCount, openDealCount, openDealAmount, createdAt, updatedAt`; deals: `name, stage, amount, expectedCloseDate, owner, company, contact, source, closedAt, createdAt, updatedAt`.

## 7a. Tasks, Meetings, Proposals (C6a)

Read-only lists on the list standard, mounted on the existing routers (new paths; the old `GET /tasks`,
`GET /meetings`, `GET /proposals` keep their unpaginated `{ data }` shape but are deprecated, §9).
Writes are unchanged (`POST/PATCH /tasks…`, `/meetings…`, `/proposals…`). Every row's owner name comes from
`profiles` (`ownerName`, null = no owner) — the denormalised `owner_name` columns are not read (B25/B26 display).
"Today", "overdue" and "upcoming" are **IST days computed in SQL** (`date_trunc('day', now() at time zone
'Asia/Kolkata')`, the dashboard's expression); the client only passes the bucket.

| Endpoint | Notes |
|---|---|
| `GET /tasks/list` · `GET /tasks/count` | Filters: `ownerId[]` (ids / `me` / `none`), `status` (`open` **default**, `completed`, `cancelled`, `all`), `due` (`overdue` = due before now; `today` = due within today IST; `upcoming` = due from tomorrow 00:00 IST), `dueFrom/To`, `type[]`, `origin[]` (`manual`, `automation`, `agent`), `contactId`, `companyId` (the contact's company), `dealId` (tasks of that deal's contact — tasks have no deal link), `q` (title or contact name). `due_at` is NOT NULL, so there is no "no due date" bucket. Sorts: `dueAt` (**default asc**), `createdAt`, `updatedAt`. Row = the Task DTO + `ownerName`, `contact {id,name}`, `company {id,name}\|null`, `deal {id,name}\|null` (the contact's most recently updated open deal), `isOverdue` (open and past due, same rule as `due=overdue`). |
| `GET /meetings/list` · `GET /meetings/count` | Filters: `ownerId[]`, `status[]`, `when` (`upcoming` = from now, not completed/cancelled/no-show/failed; `today` = today IST, any status; `past`; `needs_outcome` = past, not cancelled/no-show/failed, no outcome), `from/to` (scheduled time), `contactId`, `companyId`, `dealId` (`meetings.deal_id`), `q`. Sorts: `at` (scheduled time, **default asc**), `createdAt`. Row = the Meeting DTO (incl. `outcome`, `calendarSyncStatus/Error`, `notifyEmail/WhatsappStatus/Error`, `meetLink`) + `ownerName`, `contact`, `company`, `deal`. Participants are still not returned (A18 unchanged). |
| `GET /proposals/list` · `GET /proposals/count` | Filters: `ownerId[]`, `status[]`, `group` (`open` = every non-terminal status; `awaiting_decision` = `sent`; `won` = `accepted`; `lost` = `rejected`, `expired`, `withdrawn`; `PROPOSAL_STATUS_GROUPS` in `domain/proposalRouting.ts`), `contactId`, `companyId`, `dealId`, `updatedFrom/To`, `q`. Sorts: `updatedAt` (**default desc**), `sentAt`, `amount` (both nullable: NULLs last). Row = the Proposal DTO + `ownerName`, `contact`, `company`, `deal`, **`allowedNextStatuses`**, **`lossReasonStatuses`** (C6b). |
| `GET /proposals/:id/document` | C6b. `{ url, fileName, expiresAt }`: a **5-minute signed URL** for the proposal's file in the private `proposal-documents` bucket. The row is read with the workspace check (another workspace → 404); no file, or the object is gone → 404. The client fetches it on click and opens it at once (never stored). |
| `GET /proposals/summary` | Same filters as the list (no sort/limit/cursor) → `{ openCount, sentCount, openValue }`: open group count, `sent` count, sum of open amounts in **INR**. The page sends its filters without `group`/`status`. |

**`allowedNextStatuses`** = `allowedNextProposalStatuses(status)` (`domain/proposalRouting.ts`), the same table
`POST /proposals/:id/status` enforces: a terminal status (`accepted`, `rejected`, `withdrawn`, `expired`) allows
nothing (409); any other status allows every other status (the same status is a no-op). `rejected` / `expired`
need `lossReason` (`LOSS_REASON_PROPOSAL_STATUSES`; 400 without, and the DB check). **`lossReasonStatuses`** (C6b) =
`lossReasonStatusesFrom(status)`: which of the allowed statuses need it, so the UI keeps no copy of the rule.
Integration tests check that the rows and the endpoint agree (`workListsApi.test.ts`, `automationHomeApi.test.ts`).

Indexes (migration **036**): tasks `(workspace_id, due_at|created_at|updated_at, id)`, meetings
`(workspace_id, scheduled_at|created_at, id)`, proposals `(workspace_id, updated_at|sent_at|amount, id)`.
`q` has no trigram index on titles (an OR with the contact name, small tables). Saved views accept the objects
`tasks`, `meetings`, `proposals` (036 widens `saved_views_object_valid`); column ids — tasks: `title, type, dueAt,
contact, company, deal, owner, origin, status, createdAt, updatedAt`; meetings: `title, at, contact, company, deal,
owner, status, outcome, calendar, notify, link, createdAt`; proposals: `title, contact, company, deal, amount, status,
sentAt, owner, updatedAt, sendStatus, document`.

## 7b. Runs and scheduled steps (C6b)

Read-only lists (`services/automationLists.service.ts`); run actions stay on `POST /runs/:id/pause|resume|cancel|retry`.

| Endpoint | Notes |
|---|---|
| `GET /runs/list` · `GET /runs/count` | Filters: `workflowId`, `status[]` (`running, waiting, paused, completed, failed, cancelled`), `contactId`, `startedFrom/To`, `q` (contact name). Sort: `startedAt` (**default desc**). Row = the Run DTO + `contact {id,name}`, `workflow {id,name}`, `currentStepAction` (the action of the step the run is on, or null). |
| `GET /scheduled-actions/list` · `GET /scheduled-actions/count` | Filters: `status[]`, `runId`, `workflowId` (via the run), `contactId`, `dueFrom/To` (on `scheduled_for`), `q` (contact name). Sort: `scheduledFor` (**default asc**). Row = the scheduled action DTO + `contact`, `workflow`, `stepOrder` (0-based; null if the step is gone). The UI calls these "Scheduled steps". |

Indexes (migration **037**): `workflow_runs (workspace_id, started_at, id)`, `scheduled_actions (workspace_id, scheduled_for, id)`.

## 7c. Home summary — `GET /home/summary` (C6b)

For the signed-in user, built from the list services so every number equals the list it links to (IST days in SQL):
`{ tasks: { overdue, dueToday, next[5] (task list rows) }, meetings: { today[≤10], todayCount, needsOutcome },
deals: { openCount, openAmount (INR), stages: [{ stage, count, amountTotal }] (open stages, from the board query) },
proposals: { awaitingDecision }, ai: { mode, draftsToReview } | null }`. Tasks/meetings/deals/proposals are the caller's own
(`ownerId=me`). "Today's meetings" are scheduled / confirmed / rescheduled only (**B38**: never cancelled, no-show, failed;
completed ones are done). `ai` is null while the agent mode is `off`; `draftsToReview` = unrated `draft` decisions in the
workspace (the AI Activity list is workspace-wide).

## 7d. Workflows list — `GET /workflows` (C6b)

Same response as before (every workflow with every version and its steps, `activeLeads`, `failures`), now built in **4 queries**
whatever the number of workflows (audit D: it was 1 + N × (3 + versions)). Staging, 20 workflows / 29 versions: **681 → 33 ms**
(`tests/integration/automationHomeApi.test.ts` compares the body with the old code and times both).

## 7e. AI decision context — `GET /agent/decisions/:decisionId`, `GET /agent/leads/:id` (D1)

The decision detail and each row of the lead AI panel's `decisions` carry
`context: { company: { id, name } | null, deal: { id, name, stage } | null }`: the company (after following a merge once)
and the open deal the decision saw (migration 038: `agent_decisions.context_company_id` / `context_deal_id` /
`context_deal_stage`). `name` is the current name; `stage` is the deal's stage **when the decision was made**. Both are
null for decisions without a company / open deal and for every row from before D1. `null` also when the company or deal
was deleted later.

## 7f. Inbound WhatsApp reply text — `GET /contacts/:id/replies/:messageId` (D2)

The **only** way to read the text of an inbound WhatsApp reply. It returns one message per request, and the frontend calls it
only after a click. The text is never part of list, timeline, search, notification, task, AI or export responses, and it
is never logged.

- `messageId` = the contact timeline row's `reply.messageId`. The contact timeline (`GET /contacts/:id/timeline`) adds
  `reply: { messageId, hasText, canRead }` to rows whose `metadata.messageId` is a `matched` `whatsapp_inbound_events`
  row of the workspace. `hasText` = text stored (encrypted, since 4A). `canRead` = the caller is an admin or the
  contact's current owner. Company and deal feeds don't add `reply`.
- **200** `{ messageId, receivedAt, text, truncated }`. `truncated` = stored text was cut to 4,000 characters.
  `{ …, text: null, reason: "not_stored" }` when no text was stored (stickers, voice notes, replies before 4A).
  `{ …, text: null, reason: "unreadable" }` when decryption fails (e.g. `INTEGRATION_ENCRYPTION_KEY` changed), with a
  warning log that carries only the message id and key version.
- **403** "Only the contact owner and admins can read replies." for anyone else (CRM user, not owner, not admin).
- **404** when the contact is not in this workspace, or the message is not a matched reply of this contact (another
  contact's, another workspace's, ambiguous/unmatched or unknown). It never reveals that the message exists elsewhere.
- Headers: `Cache-Control: no-store` (also on 403).
- Audit (migration 039, `inbound_message_views`): one row per request that reached a matched reply of the contact,
  with `workspace_id, lead_id, message_id, viewer_id, outcome` (`shown` | `denied` | `no_text` | `decrypt_failed`) and
  `viewed_at`. 404s are not audited. The text is never stored there. RLS is on with no policies (backend only). No UI yet.

## 8. Performance (B4 check)

`tests/integration/listPerformance.test.ts` (`RUN_PERF_TESTS=true`; skipped by default). Run on staging 2026-10-24 with a
`[test]` workspace of 5,000 contacts, 1,000 companies and 1,500 deals (seeded in ~1 s, removed afterwards).

| Query | Server execution (EXPLAIN ANALYZE) | HTTP from a dev laptop* | Plan |
|---|---|---|---|
| Contacts, first page (50, default sort) | 1.1 ms | 288 ms | `leads_workspace_created_idx` |
| Contacts, deep page (after 20 pages) | 0.9 ms | 201 ms | `leads_workspace_created_idx` |
| Contacts `q=User12` (~111 matches) | 6.5 ms | 245 ms | ordered created-at index + filter (chosen over trigram for a common term) |
| Contacts count | — | 166 ms | |
| Companies, first / deep page (40) | 0.7 ms | 104 / 133 ms | `companies_workspace_name_idx` |
| Companies by `contactCount` | 11.9 ms | 183 ms | seq scan of companies + per-row count (the accepted exception) |
| Deals, first / deep page (50, all) | 0.8 ms | 123 / 134 ms | `deals_workspace_updated_idx` |
| Deals by `amount desc` (NULLs last) | 12.4 ms | 173 ms | seq scans (nullable desc order can't use the index; small table) |
| Deals board (8 columns) | — | 546 ms | 1 totals query + 1 page per non-empty stage |
| Deals board, C4 single query (2026-10-26) | — | 39–43 ms (was 103–162 ms the same day) | one window query; first call after warm-up, 1,500 deals |
| Global search `perf12` | 23 + 3 + 4 ms | 164 ms | seq scans at this size |

\* HTTP includes the network round trips from the local API to the staging pooler (~100 ms each); server execution is the target (< 300 ms, met everywhere).

## 9. Deprecated endpoints — remove after the production release (C6b)

The C6b frontend no longer calls these. They stay unchanged so the production rollback plan can
run the previous frontend; remove them (and this section) after the C6b release has settled.

| Endpoint | Replaced by |
|---|---|
| `GET /leads` (whole list, ≤ 500) | `GET /contacts` (§2) |
| `GET /leads/:id/timeline`, `/leads/:id/calls`, `/leads/:id/meetings`, `/leads/:id/proposals`, `/leads/:id/runs` | `GET /contacts/:id/timeline`, the work lists with `contactId` (§7a), `GET /runs/list?contactId=` (§7b) |
| `GET /tasks`, `GET /meetings`, `GET /proposals` (unpaginated `{ data }`) | `/tasks/list`, `/meetings/list`, `/proposals/list` (§7a) |
| `GET /runs`, `GET /scheduled-actions` (unpaginated `{ data }`) | `/runs/list`, `/scheduled-actions/list` (§7b) |
| `GET /dashboard/summary` (B38 fixed in C6b: no-show / failed meetings and cancelled funnel rows no longer count) | `GET /home/summary` (§7c) |

Also without a UI caller (not list endpoints, kept as they are): `PATCH /workspaces/:id` (rename) and
`POST /notifications/:id/read` (audit C).
