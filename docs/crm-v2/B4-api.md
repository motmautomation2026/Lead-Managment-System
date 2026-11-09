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
is never logged. (D4a: the worker also decrypts it once to label it, §7g; only the label is stored.)

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

## 7g. Reply labels — `reply.label…` and `PUT /contacts/:id/replies/:messageId/label` (D4a)

What a matched WhatsApp reply says, never the text or a quote of it (migration 040 on `whatsapp_inbound_events`).

- Labels: `asked_to_stop`, `not_interested`, `annoyed`, `positive`, `question`, `other`, `unclassified`. Sources:
  `keyword` (exact short phrase, every mode, no AI), `ai` (worker, grounding model, only for contacts the AI managed before
  the reply and a non-off mode within the monthly budget), `rep` (a correction).
- The contact timeline's `reply` (§7f) also has `label` (null = an older reply or still classifying), `labelSource`,
  `labelBy` (the rep's name when `labelSource = "rep"`, else null), `classifying` (AI step pending) and `canCorrect`
  (= `canRead`: admin or the contact's owner).
- `PUT /contacts/:id/replies/:messageId/label` `{ label }` (any label except `unclassified`, else 400) →
  `{ messageId, label, labelSource: "rep", labelBy }`. 403 "Only the contact owner and admins can change a reply's label."
  for anyone else; 404 like §7f. Records who and when, drops a pending AI step, and re-titles the contact's open reply task.
  It never undoes a WhatsApp opt-out, never restarts a permanently stopped AI and never applies new effects.
- Effects of an automatic label (same transaction, idempotent): `asked_to_stop` → WhatsApp contactability `opted_out`
  (reason "Asked to stop on WhatsApp"; a later reply keeps it), the owner is notified, an AI contact → `stopped`
  (`asked_to_stop`); `not_interested` / `annoyed` → an AI contact → `stopped` (`not_interested`). Never Do Not Contact.
  The open reply task is re-titled except for `other` / `unclassified`. An opted-out contact gets no WhatsApp from
  workflows, the agent rules, or the proposal / meeting sends.
- `GET /agent/stats` adds `replies: { byLabel: { <label>: n }, costUsd }` for replies labelled this IST month; the AI
  labelling cost is also part of `spend.spentUsd` (the monthly budget), never of the daily decision cap.

## 7h. WhatsApp safety — `/connections/whatsapp/*` and WhatsApp opt-out clearing (E1)

Migration 041. The send-time rules live in `Backend/src/domain/whatsappSafety.ts` (`decideSend`).

E4a (migration 054) replaced the single connection with **numbers**; see §7s. The safety fields below are per number
(`numbers[]`) except the send window, the master switch and the monitoring, which stay per workspace.
- `POST /leads/:id/contactability` (old route, unchanged otherwise): changing a WhatsApp `opted_out` to any other status is
  **admin only** (403 "Only an admin can clear a WhatsApp opt-out.") and needs a non-blank `reason` (400); the timeline row
  is "WhatsApp opt-out cleared by <admin>: <reason>". Every other contactability change stays open to every CRM user.
- Deferred sends (window, caps, new-chat limit, spacing, pause) are `ProviderDeferredError`s: no attempt is burned; a
  workflow step's `last_error` holds the reason. A first automated message with a link fails permanently with
  "First WhatsApp message can't contain a link".

## 7i. Email (SMTP only) — `/connections/email/*` (E1b)

Migration 042. The send-time rules live in `Backend/src/domain/emailSafety.ts` (`decideEmailSend`), the DNS grading in
`domain/emailDeliverability.ts`. Every email is queued in `email_outbound_messages` and sent only by the worker. The old
`GET|PUT /connections/email` and `POST /connections/email/test` are **removed** (Resend is gone).

- `GET /connections/email/settings` (every CRM user; never a secret): `configured` (SMTP saved; false = "Email is not set
  up"), `legacyProvider` (`"resend"` when the row was saved on Resend before E1b, else null), `enabled`, `smtpHost`,
  `smtpPort`, `smtpSecurity` (`ssl` = implicit TLS | `starttls`), `smtpUsernameConfigured`, `smtpPasswordConfigured`,
  `fromAddress`, `fromName` (default from name), `replyTo` ("" = the from address), `imapHost`, `imapPort` (993),
  `imapSecurity`, `imapSameLogin`, `imapUsernameConfigured`, `imapPasswordConfigured`, `imapFolder` ("INBOX"), `dailyCap`
  (100), `hourlyCap` (20), `minDelaySeconds`/`maxDelaySeconds` (30/90), `sendWindow { days, start, end }` (Mon–Sat
  09:30–19:00 IST), `alreadyWarmed`, `configuredAt` (warm-up start; null = never saved under E1b), `warmupDay` (null =
  no warm-up), `effectiveDailyCap` (min(cap, 20/40/70) for IST days 1–3/4–7/8–14 unless already warmed), `sentToday`,
  `sentThisHour` (IST clock hour), `pause` (null unless configured and `enabled` false: `{ reason, at, byName }`),
  `failures24h` (temporary send failures), `rejections24h` (5xx recipient rejections), `queuedCount`, `safetyEvents` (last
  20: `{ kind: send_failed|recipient_rejected|login_rejected|rate_limited|paused|resumed, detail, at }`), `daily` (last 14
  IST days, newest first: `{ date, sent, failed, rejected }`), `updatedAt`. Dry-run sends are not counted.
- `PUT /connections/email/settings` — **admin only** (403 otherwise). Body: `enabled`, `smtpHost`, `smtpPort` (1–65535),
  `smtpSecurity`, `smtpUsername?`, `smtpPassword?` (write-only; blank/omitted keeps the saved value; required on the first
  save), `fromAddress` (email), `fromName`, `replyTo?` (email | "" | null), `imapHost`, `imapPort`, `imapSecurity`,
  `imapSameLogin`, `imapUsername?`, `imapPassword?` (required unless `imapSameLogin`), `imapFolder`, `dailyCap` (1–10000),
  `hourlyCap` (1–1000), `minDelaySeconds` ≤ `maxDelaySeconds` (1–3600), `sendWindow { days (1–7 items), start < end }`,
  `alreadyWarmed`. `provider` may be omitted or `"smtp"`; `"resend"` → 400 "Email goes through SMTP only; Resend is no
  longer supported.". Saving sets provider `smtp` and `configuredAt` (first time only). `enabled` true → false records a
  pause "Paused by <admin>."; false → true is a resume. Returns the GET body.
- `POST /connections/email/test-smtp`, `POST /connections/email/test-imap` — **admin only**, read-only, 15 s: SMTP connect
  + TLS + AUTH (nothing sent); IMAP connect + login + open the folder read-only (EXAMINE) + logout (nothing read or
  changed). Always 200 `{ ok, message }`; `message` is plain English (host not found, refused port, TLS mismatch, login
  rejected + app-password hint, folder missing, timeout). Audited `connection.email.test_{smtp|imap}_{succeeded|failed}`.
- `POST /connections/email/test-send` — **admin only**: queues a test email to the admin's own address → 202
  `{ id, status: "queued" }`. `GET /connections/email/test-send/:id` (admin; 400 on a bad id, 404 if not this workspace's
  test) → `{ id, status: queued|sending|sent|failed|cancelled, to, lastError (why it waits or failed), sentAt, dryRun }`.
- `POST /connections/email/resume` — **admin only**: `enabled` = true, pause cleared, `resumed_at` = now (auto-pause
  signals count only after it). Returns the GET body.
- `GET /connections/email/deliverability?selector=` — **admin only**; 400 until SMTP (the from address) is saved, or for a
  selector outside `[A-Za-z0-9._-]{1,63}`. DNS for the from domain (5 s per lookup, cached 10 min): `{ domain, checkedAt,
  lines: [{ check: mx|spf|dkim|dmarc, status: green|amber|red, summary, fix }] }`. DKIM tries the given selector, else
  google, default, selector1, selector2, zoho, zmail, s1, s2, k1, mail, dkim. Never blocks sending.
- Proposals / meetings: `POST /proposals` and `POST /meetings` only queue the email. `emailSendStatus` /
  `notifyEmailStatus` stay `pending` (shown as "Queued") until the worker writes `sent` / `failed`; while waiting,
  `emailSendError` / `notifyEmailError` hold the reason (e.g. "Email is not set up. An admin must add the SMTP mailbox in
  Settings → Email.", "Hourly cap (20) reached.").

## 7j. Email replies, bounces and unsubscribes (IMAP) — D3

Migration 043. The worker (`services/emailInbound.service.ts`, `runEmailInbound`) reads one due workspace's mailbox per
tick, every `EMAIL_IMAP_POLL_SECONDS` (120) per workspace, read-only (EXAMINE + `BODY.PEEK`, never a flag / move / delete),
only mail after the IMAP login was saved; classification in `domain/emailInbound.ts`. Each message is one
`email_inbound_events` row (`kind` `reply|bounce|bounce_temporary|auto_reply|unsubscribe|ignored`, `match_status`
`matched|unmatched|ambiguous`); the reply text is stored only encrypted.

- Contact timeline (`GET /contacts/:id/timeline`): rows "Replied by email" (`kind` `email`) carry the same `reply` field as
  WhatsApp replies (§7f/§7g). `reply` now always has `channel` (`"whatsapp"` | `"email"`); for email, `messageId` is the
  email reply's id (uuid). Other D3 rows (no `reply`): "Email bounced (<reason>)" (detail = status + diagnostic),
  "Automatic email reply received (out of office or similar)", "Unsubscribed from email", "Email status cleared by
  <admin>: <reason>".
- `GET /contacts/:id/email-replies/:replyId` — same rules as §7f: **200** `{ replyId, receivedAt, subject, text, truncated }`
  (subject + text without the quoted history, ≤ 4,000 characters; never HTML or attachments) or `text: null` + `reason`
  `not_stored|unreadable`; **403** "Only the contact owner and admins can read replies." (audited `denied`); **404** unless a
  matched email reply of this contact; **400** for a non-uuid id; `Cache-Control: no-store`. Every read is audited in
  `inbound_message_views` with `channel = 'email'` and `email_event_id` (existing rows: `channel = 'whatsapp'`).
- `PUT /contacts/:id/email-replies/:replyId/label` `{ label }` — the §7g correction for email replies (own route; same
  body, response, 400/403/404 and rules; re-titles the reply task with the email titles).
- Effects (one transaction per message): **bounce** 5.x.x → the outbound email's `bounced_at` / `bounce_status`, the contact's
  email `invalid` (5.1.x) or `permanent_bounce`, a `recipient_rejected` safety event (counts toward the 5 % auto-pause);
  4.x.x / delayed → recorded only; unlinkable → `unmatched` only. **Auto-reply** → timeline row only. **Unsubscribe**
  (subject "unsubscribe" to our List-Unsubscribe address) → email `unsubscribed`, owner notified, AI `stopped`
  (`asked_to_stop`); never DNC, no task. **Reply** (matched to one contact: In-Reply-To, then References → our Message-ID →
  its contact, a merged contact → its target; else exactly one contact with the sender's address) → automation stopped
  (`response_state` responded, manual, runs/actions cancelled "Inbound email reply"), owner notification "Email reply
  received", AI contact → one open task "Lead replied by email — respond today" + handed off (`lead_replied`), D4a label
  (keyword, else the worker's AI step; `asked_to_stop` → email `unsubscribed`, task "Asked to stop by email — review
  today"). Our own sent copies and no-reply senders are `ignored`; unmatched / ambiguous messages keep metadata only.
- `POST /leads/:id/contactability`: changing an email `invalid` / `permanent_bounce` / `unsubscribed` to any other status is
  **admin only** (403 "Only an admin can clear an email bounce or unsubscribe.") and needs a non-blank `reason` (400).
- `GET /connections/email/settings` adds `imapStatus` (null until an IMAP login is saved): `{ lastCheckAt, lastSuccessAt,
  lastError (plain English, never a secret), nextCheckAt, today: { replies, bounces, autoReplies, unsubscribes, unmatched }
  (IST day), bounces24h }`. An IMAP login rejection is shown here and notifies admins once per IST day; it never pauses
  sending.
- `POST /connections/email/check-now` — **admin only**: the next worker tick reads the mailbox (the request never opens
  IMAP). Returns the GET body.
- `GET /agent/stats` `replies` counts WhatsApp and email replies; email labelling cost is part of the monthly AI spend.
- SMTP 451 (E1b fix): only a `4.7.x` code or rate-limit wording auto-pauses; other 451s are temporary retries. A queued
  meeting email is cancelled ("Meeting time has passed" / "Meeting was cancelled"; meeting `notify_email_status` `skipped`).

## 7k. AI Live mode — E2

Migration 044. Only admins change mode, scope or the test mark; reads are as before.

- `PUT /agent/settings` (admin) accepts `mode: "live"` and `liveScope` (`test_contacts` | `new_leads` | `all`). Switching into
  Live, or changing the scope while Live, to `new_leads` / `all` needs the go-live gate: **422** `invalid_transition` with
  the gate's reasons in `message` and `details.readiness` (`{ ready, rated, goodPct, seriousBad, reasons }`). Switching
  `new_leads` on sets `liveSince` (now). Off → Shadow/Live wakes the active AI contacts as before. Afterwards every live AI
  contact (status active / paused / handed off) leaves its unfinished workflow runs (cancel reason "Managed by AI agent",
  timeline "Workflow Cancelled"). Leaving Live cancels nothing directly: queued sends are cancelled at send time.
  GET/PUT responses add `liveScope`, `liveSince`, `liveContactCount` (AI contacts live now).
- `GET /agent/settings/live-preview?scope=<scope>` (admin, changes nothing) → `{ scope, readiness, allowed, message,
  liveContacts, workflowRunsToCancel }` — the confirm dialog's numbers (for `new_leads` not yet on: counted from now, i.e.
  marked test contacts only). **400** for an unknown scope.
- `PUT /agent/leads/:id/live-test` `{ enabled: boolean }` (admin; any lifecycle) → the lead AI panel (below). Timeline
  "Marked as AI live test by <admin>" / "AI live test removed by <admin>"; marking a contact that is then AI-live cancels its
  workflow runs. **400** bad body, **404** unknown lead.
- `POST /runs` (manual workflow enrolment, with or without `workflowId`) for a live AI contact → **409** "This contact is
  managed by the AI agent. Stop the AI for this contact first." `autoEnroll` (every trigger) skips such contacts silently.
- Decisions (`GET /agent/decisions` rows, `GET /agent/decisions/:id`, lead panel rows) add `mode` (rows), `sendStatus`
  (`queued|sending|sent|failed|cancelled|dry_run`, null = draft / not a send), `sentAt`, `sendError` (failure or the
  current deferral reason), `cancelReason`, `channel` (`email|whatsapp|null`). A live decision's `outcome` is `executed`
  (acted on), `sent` once really sent.
- `GET /agent/stats` adds `live: { scope, liveSince, liveContacts (0 unless the mode is live), sentToday (IST),
  sentThisMonth (IST) }` (real sends only).
- `GET /agent/leads/:id` adds `liveTest` and `effectiveMode` (`off|shadow|live`: how the AI runs for this contact now).
- Timeline (kind `automation`, actor "AI Agent"): "AI sent WhatsApp", "AI sent email: <subject>", "AI handed off: <reason>",
  "AI stopped" (detail = reason), "AI moved stage to <stage>". Shadow contacts keep the "AI drafted…/suggested…" rows.
- Email queue: `email_outbound_messages` rows with `source = 'agent'`, `source_id` = decision id (From "<owner> | <company
  display name>", automated: send window applies). A cancelled AI email has `status cancelled` + the reason in `last_error`.

## 7l. AI message quality — E2b

Migration 045.

- `GET|PUT /agent/settings` (PUT admin-only) add `bannedPhrases: string[]` (PUT: trimmed, blanks and case-insensitive
  duplicates dropped, ≤ 100, each ≤ 60 characters, else **400**). `emailMaxWords` / `whatsappMaxWords` are now 1–500 (else
  **400**); defaults 160 / 75.
- `GET /agent/stats` (every CRM user) adds `messageRules: { bannedPhrases, emailMaxWords, whatsappMaxWords }` (null without a
  settings row), so non-admins can read the rules.
- `GET /agent/decisions/:decisionId` adds `qualityChecks: [{ problems: string[] }] | null` — one entry per drafting attempt
  (empty `problems` = passed; null before E2b). Message-check failures also appear in `rulesResult.violations` (rules
  `banned_phrase`, `length`, `one_question`, `compound_question`, `exclamation`; E2c adds `not_thanking_inbound`,
  `introduction_mid_conversation`, `internal_info_leak`; `length` was a `rules.ts` rule before).
- `groundingResult` (detail) and the lead panel rows' `grounding` add `styleViolations: [{ rule, quote }]` (absent before
  E2b); rules `asks_lead_to_describe_business`, `introduction_mid_conversation`, `unsupported_sector_claim`
  (`not_thanking_inbound` only on decisions before E2c; it is checked in code since).
- New handoff title: "AI couldn't write a message that meets the playbook".

## 7m. AI quality round 2 — E2f

Migration 046.

- `GET|PUT /agent/settings` and `GET /agent/stats` add read-only `readinessSince: string | null` (ISO; null = all time).
  The go-live gate (`readiness` in stats and `GET /agent/settings/live-preview`, and the scope gate of `PUT /agent/settings`)
  and `stats.ratings` count only rated, non-failed decisions **created** on/after it. Earlier ratings stay stored.
- `POST /agent/settings/reset-readiness` (admin, no body) sets `readinessSince` to now and returns the settings DTO.
- Decisions: `rulesResult.adjustments` may contain `{ rule: "signal", message: "<title>: handing off|stopping instead of
  sending." }` — a send turned into the signalled action. New handoff titles: "Lead asked about price", "Lead asked for a
  visit or in-person meeting", "Lead is ready for a call or next step"; a consumer business → `stop` reason `not_a_fit`
  with reasoning "Not a B2B business. …".
- `qualityChecks` may have three entries (two regenerations when the latest attempt failed only fixable code checks).
- Company linking (B2-design §2.1 step 4): a contact whose company name differs from the domain company's (similarity
  < 0.6) gets its own company and a pair candidate `same_domain_different_name` (`/company-duplicates` `kind: "pair"`).

## 7n. AI attachments (asset library) — E2g

Migration 047.

- `POST /knowledge/assets` (admin, multipart): `channels` is optional; omitted = `["email"]` (the column default is also
  email only). `PATCH /knowledge/assets/:id` unchanged (`title`, `useWhen`, `tags`, `channels`, `isActive`).
- `GET /agent/decisions/:decisionId` and each `GET /agent/leads/:id` `decisions[]` row add `attachments` (null for non-send
  actions):
  `{ assets: [{ id, title | null (asset deleted), sent: boolean }], removed: [{ assetId, reason, title | null }],
  issues: [{ assetId, title | null, reason }] }`. `assets` = the decision's (rules-checked) `assetIds` in order, `sent` =
  really went out with the message; `removed` = dropped by the rules (the last attempt's `qualityChecks[].attachmentsRemoved`;
  `reason` `first_message | whatsapp_no_reply | already_sent | count_limit | size_limit`; the message was kept); `issues` =
  left out at send time (asset deleted/turned off, file missing from Storage, E2h: file over 10 MB). The message went out
  without it, unless its text mentioned an attachment (E2h): then `sendStatus` `cancelled`, `cancelReason`
  `attachment_missing`, nothing sent, no touch counted, a new wake-up queued; `issues` says which file.
- E2h: a new check `attachment_mention` can appear in `rulesResult.violations` and `qualityChecks[].problems`
  ("attachment_mention: No file will be attached…"). `sizeBytes` on assets is unchanged (null = unknown; the agent then reads
  the size from Storage).
- `qualityChecks[]` entries may carry `attachmentsRemoved: [{ assetId, reason, title }]`; `rulesResult.attachmentsRemoved`
  (same items without `title`) when the rules dropped any.
- Timeline: "AI sent email: <subject>" / "AI sent WhatsApp" rows get `detail` "With attachment: <title>[, <title>]" and/or
  "Attachment not sent: <title> (<reason>)"; `metadata.assetIds` lists the assets sent.
- `GET /knowledge/search` (Test retrieval) still includes asset documents; the agent's own retrieval never does.

## 7o. AI writing quality — E3a

- `GET|PUT /agent/settings` (PUT admin-only): `styleExamples: string` (trimmed, ≤ 6,000 characters, else **400**; empty = none).
  `decisionModel` / `groundingModel` take `name` or `name@effort` (`none|minimal|low|medium|high|xhigh`); an unknown effort, or an
  effort on a model without reasoning (GPT-4.x), is **400**. Word-limit defaults are 120 / 50.
- `GET /agent/stats` (every CRM user): `messageRules.styleExamples`, and `quality: { sinceReadiness, last7Days }`, each
  `{ sendDecisions, passedFirstTry, passedFirstTryPct, regenerated, checkHandoffs, checkHandoffsByReason, autoFixes, avgCostUsd,
  cachedInputPct }`. Failed decisions don't count. `sendDecisions` = decisions that wrote a message (a send, or a handoff that keeps
  the text the checks refused); `passedFirstTryPct` is null without any; `sinceReadiness` is all time when `readinessSince` is null;
  `cachedInputPct` is null without recorded tokens (decisions before E3a).
- Decision detail: `qualityChecks[]` entries gain `inputTokens`, `cachedInputTokens` and, when code fixed something,
  `autoFixes: [{ rule: dash|exclamation|ellipsis|sign_off|contact_details|spacing, before, after }]`. New problem rules
  `subject_style`, `contact_details`.
- `messageSubject` of an AI follow-up is the subject really used ("Re: <first subject>").

## 7p. AI conversion core — E3b-1

- `GET|PUT /agent/settings` (PUT admin-only): `firstChannel: "whatsapp" | "email"` (default `whatsapp`, else **400**): the channel of a
  contact's first AI message when both channels are usable; later messages alternate.
- Decision list, decision detail and the contact's AI panel rows: `stageKey` (`new_no_contact | after_call | meeting_scheduled |
  meeting_held_no_proposal | meeting_no_show | proposal_sent | rep_owned | long_term`, null before E3b-1) and `angle` (`welcome |
  insight | client_experience | check_in | final_check | call_followup | meeting_recap | reschedule | proposal_questions |
  proposal_timing`, only on send decisions). New rule notes: adjustment `stage_plan` (the stage allows no message now → wait / the one
  rep-owned handoff), adjustment `channel_balance` + violation `channel_switch` (fixable; the other channel is due).
- Decision detail `composed` gains `bookingLinkAdded: boolean` (the owner's current booking link was added, before the signature).
  The WhatsApp signature is now "<owner first name>, <company>" on its own line (no dash).
- `GET /me` adds `bookingUrl: string | null`. `PATCH /me` `{ bookingUrl: string | null }` (every signed-in user, own profile only):
  https only, ≤ 300 characters, blank → null, else **400**; returns `{ bookingUrl }`.
- `GET /admin/users` rows add `bookingUrl`; `PATCH /admin/users[/:id]` accepts `bookingUrl` (same validation; omitted = unchanged,
  null = removed).

## 7q. Suggested replies for reps — E3b-2a

`ReplyDraft` = `{ id, channel: "whatsapp" | "email", status: "open" | "sent" | "discarded" | "superseded" | "failed", subject
(email: our thread's "Re: …"), body (the AI's text, without signature), edited, sentBody, sentByName, queuedAt, sendStatus: "queued" |
"sending" | "sent" | "failed" | "cancelled" | null, sendAt (while queued: the channel's send-window opening, shown as "Will send at …"),
sentAt, sendError, createdAt, canSend }`. Never the lead's reply text.

- Contact timeline (`GET /contacts/:id/timeline`) reply rows (§7f/§7g) add `reply.drafting: boolean` (the worker is writing one) and
  `reply.draft: ReplyDraft | null` (the reply's open or sent draft; always null for others than the owner and admins).
- `GET /contacts/:id/reply-drafts/latest` → `{ draft: ReplyDraft | null }`: the contact's open draft, else the latest sent one (the
  reply task's Sheet). **403** for others than the owner and admins, **404** unknown contact.
- `POST /contacts/:id/reply-drafts/:draftId/send` `{ body }` (owner or admin): queues the text as edited (WhatsApp source
  `reply_draft` / email source `reply_draft`); the worker sends it through every channel safety rule (send window, spacing, caps,
  warm-up, pause, opt-out, DNC, channel status, re-check before sending). Not the AI touch limits (48 h gap, 2 per week, 8 total).
  Marks the open reply task done. Returns the `ReplyDraft` (`status: "sent"`, `sendStatus: "queued"`, `sendAt`). A second Send
  returns the same state (one send per draft). **400** empty text or over the channel word limit (`agent_settings`
  `whatsapp_max_words` / `email_max_words`, default 60 / 120: "WhatsApp replies can be at most 60 words; this one has 72."),
  **403** not owner/admin, **404** not this contact's draft, **409** draft not open ("This suggested reply was discarded.") or the
  contact is Do Not Contact / opted out / bounced / unsubscribed / has no address.
- `POST /contacts/:id/reply-drafts/:draftId/discard` (owner or admin) → `ReplyDraft` (`status: "discarded"`); the reply task stays
  open. **403 / 404** as above, **409** when not open.
- Timeline on delivery: "Reply sent on WhatsApp" / "Reply sent on email" (detail "Suggested reply[, edited], sent by <rep>",
  `metadata.replyDraftId`, `edited`). A failed send notifies the rep who sent it.
- Notifications (no endpoint change): admins get "<Rep> hasn't answered <Name>'s reply yet (2 h)" once per reply task; the owner
  gets the task "Log the meeting outcome" 2 days after a meeting with no outcome.

## 7r. Tracking, hot-lead score and funnel — E3b-2b

- `ReplyDraft` (§7q) adds `newerReplyAt` (open draft only: the contact wrote again after the daily draft limit of 3, so the draft was
  kept, not superseded; the card says "<Name> wrote again after this draft. Read the newer reply before sending.") and
  `contactFirstName`. `POST …/reply-drafts/:draftId/send` on a draft made by `staging:seed-reply-draft` (model `staging-seed`) →
  **409** "Seeded test draft — sending is disabled" (both channels).
- **Public open pixel** `GET /t/o/<token>.gif` (outside `/api/v1`: no auth, no `X-Workspace-Id`). Always **200**, the same 1×1
  transparent GIF, `Cache-Control: no-store, private`, `Referrer-Policy: no-referrer` — also for unknown or malformed tokens, errors and
  over 60 requests per minute from one IP (then nothing is recorded). The token (22 URL-safe characters, 128 bits, no personal data)
  is checked before the database; then one UPDATE (`open_count`, first / last open; the first open more than 60 s after sending is the
  first counted open). No IP address or user agent is stored. The pixel is only in AI agent and workflow emails, only when the API has
  `PUBLIC_API_BASE_URL` and the workspace's "Track email opens" is on. Opens are a soft signal.
- Email settings (`GET /connections/email/settings`, §7i) add `trackOpens` (default false) and `openTrackingAvailable`
  (`PUBLIC_API_BASE_URL` set). `PUT /connections/email/track-opens` `{ enabled: boolean }` (**admin**, audited) → the settings;
  **400** not a boolean, **403** others.
- AI send states (`GET /agent/decisions`, `GET /agent/decisions/:id`, §7k) add `openedAt` (the AI email's first counted open, else null).
- Contacts (§2): row fields `hotScore` (0–100, null until the worker's first sweep), `hotBand` (`hot` ≥ 60 | `warm` 30–59 | `cold`),
  `hotReasons` (codes: `closed`, `stopped`, `enquiry`, `enquiry_detailed`, `enquiry_need`, `enquiry_signal`, `consumer`,
  `corporate_email`, `company`, `target_industry`, `revenue`, `opened`, `opened_often`, `replied`, `replied_positive`, `meeting`,
  `proposal`); sort `hotScore` (NULLs last; index `(workspace_id, hot_score desc nulls last, id desc)`); column id `hotScore`.
  `GET /contacts/:id` adds the same three fields.
- Tasks (§7a): sort `hotScore` (the contact's score; a joined column, no `(workspace_id, field, id)` index, like companies
  `contactCount`).
- Agent settings (`GET|PUT /agent/settings`) add `targetIndustryKeywords: string[]` (lower case, de-duplicated, ≤ 100, each ≤ 60
  characters; empty = fit uses the email domain, company and revenue only). The score is never given to the AI.
- **Funnel** `GET /analytics/funnel?from&to&groupBy=` (any CRM user, the selected workspace). `from` / `to` ISO 8601 with offset;
  default the last 30 days; **400** when `from` ≥ `to`, the range is over 180 days or `groupBy` is not `source | channel | number |
  angle`. Returns `{ from, to, groupBy, totals, websiteMeetingRate: { websiteLeads, bookedWithin14Days, pct }, medianMinutesReplyToAnswer,
  groups }`. `totals` (leads created in the period): `leadsCreated, contacted, firstMessageWithin15Min: { count, pct }` (% of leads
  created), `medianMinutesToFirstMessage, emailsSent, countedOpens` (soft signal), `replies, positiveReplies,
  meetingsBookedWithin14Days, proposals, won`. `groupBy=source` groups have the same fields per lead source; `channel` / `number`
  (WhatsApp connection, labelled by its number) / `angle` groups count messages sent in the period and their last-touch outcomes:
  `{ key, label, messagesSent, emailsSent, countedOpens, replies, positiveReplies, meetingsBooked, dealsCreated, won }`. Website =
  sources `website` + `inbound_form`. Reply → answer = the first message we sent after a matched reply or its reply task done,
  whichever is first. Messages count only from E3b-2b on (no backfill).

## 7s. Several WhatsApp numbers — E4a

Migration 054. One row per number in `whatsapp_numbers` (own QR pairing, Baileys auth, socket, session-lock client,
`paired_at` / warm-up, daily cap, spacing, new-chat limit, pause); `whatsapp_connection` keeps the workspace's send window,
`outbound_enabled` (master switch for every number) and `max_numbers` (1–20, default 5). A contact's **sticky number**
(`leads.whatsapp_number_id`) is set on its first send (any source; `domain/whatsappNumbers.ts`: the owner's usable number with
room today, else the most room after warm-up → fewest new chats → oldest pairing; none → the send waits, no attempt burned) or
on its first matched inbound, whichever is first, and never changes automatically: a paused / disconnected sticky number makes
its contacts' sends wait. Inbound on another number is recorded and handled as usual with `other_number = true`.

- `GET /connections/whatsapp/settings` (every CRM user): `{ enabled (master switch), maxNumbers, sendWindow { days, start, end },
  numbers[], sessionSlots { numbers, headroom, overHeadroom }, todayCount, pendingCount, invalidPhoneCount, newChatsToday,
  failures24h, stops24h, safetyEvents[] ({ kind, detail, at, numberLabel }), daily[], inboundReview[] }`. Each `numbers[]` item
  (not removed, oldest first): `{ id, label, ownerUserId, ownerName, enabled, desiredState, status, connectedPhone, displayName,
  qr (only while valid), qrExpiresAt, lastError, workerHeartbeatAt, lastConnectedAt, lastDisconnectedAt, outboundRestricted,
  pairedAt, warmupDay, dailyCap, effectiveDailyCap, minDelaySeconds, maxDelaySeconds, maxNewChatsPerDay, sentToday,
  newChatsToday, leadCount, queuedSends (prepared rows), pause }`. `sessionSlots.numbers` = numbers of active workspaces that
  want a session (desired connected / restart, not removed) across **all** workspaces; `headroom` = 15 − 2 × DB_SESSION_POOL_MAX
  − 3 (8 with the defaults); `overHeadroom` when numbers > headroom.
- `PUT /connections/whatsapp/settings` — **admin only**. Body `{ enabled, maxNumbers? (1–20), sendWindow? { days, start < end } }`
  (strict; 400 otherwise). `enabled` is the master switch: off = every number's sends wait. Returns the GET body.
- `POST /connections/whatsapp/numbers` — **admin only**. Body `{ label? (1–60), ownerUserId? }`; label default `#<n>`; the new
  number asks for pairing (desired connected), the worker shows its QR within a tick. **409** at `maxNumbers`. **201** + GET body.
- `PUT /connections/whatsapp/numbers/:numberId` — **admin only**. Body (all optional, strict) `{ label, ownerUserId (null clears;
  must be an active user, 400), dailyCap (1–10000), minDelaySeconds (1–300), maxDelaySeconds (1–600, ≥ min), maxNewChatsPerDay
  (0–1000) }`. 404 for a removed / other workspace's number.
- `POST /connections/whatsapp/numbers/:numberId/pause|resume` — **admin only**. Pause = "Paused by <admin>."; resume sets
  `resumed_at` (auto-pause signals count only after it). Auto-pause notifications name the number ("WhatsApp number #2 paused
  automatically").
- `POST /connections/whatsapp/numbers/:numberId/connect|restart|logout` — every CRM user (as before, now per number).
- `DELETE /connections/whatsapp/numbers/:numberId` — **admin only**, rule 10. Body `{ leads?: "move" | "unassign",
  moveToNumberId? }`. With queued (prepared) sends and no `leads` → **409** (`details.queuedSends`). `move` (needs
  `moveToNumberId`, 400) moves each contact as `POST /contacts/:id/whatsapp-number` does (timeline event each); otherwise its
  contacts are left without a number (they get one by the rule above at their next send). Soft delete (`removed_at`; history
  keeps the id), auth state deleted, the worker logs it out. **409** for the workspace's last number.
- `POST /contacts/:id/whatsapp-number` — **admin only**, rule 6. Body `{ numberId, reason (1–500) }`. 400 for a blank reason,
  the same number or one not in this workspace. Moves the contact and its prepared WhatsApp rows; timeline "WhatsApp number
  changed to <label>" (detail = reason, actor = the admin); audit `lead.whatsapp_number_changed`. Returns `{ whatsappNumber:
  { id, label } }`.
- `GET /contacts/:id` adds `whatsappNumber: { id, label } | null`.
- `GET /analytics/funnel?groupBy=number` groups by `message_facts.whatsapp_number_id`, labelled by the number's label.
- No WhatsApp test send exists (only the email test); the old `/connections/whatsapp/resume` and `/connect|restart|logout`
  routes were replaced by the per-number ones.

## 7t. Workspace access — E4b

Every workspace-scoped route checks membership in ONE middleware (`requireWorkspace`): `X-Workspace-Id` must name an
active workspace the user is a member of (`workspace_members`), or the user is a super-admin (`profiles.is_super_admin`);
otherwise **403** `You don't have access to this workspace` (unknown / inactive workspace: 404 as before). The middleware
replaces `req.actor.role` with the role in that workspace (super-admin = admin), so every admin-only route is per workspace.

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/me` | any user | adds `isSuperAdmin` and `workspaces: [{id, name, …, role}]` (super-admin: all, role admin). `role` stays the global role (only `/admin` user management uses it). |
| GET | `/workspaces` | any user | only the user's workspaces, each with `role` (super-admin: all). |
| POST | `/workspaces` | any user | `{name}`; the creator becomes its admin (audited); super-admins are never auto-added. Response has `role: "admin"`. |
| PATCH | `/workspaces/:id` | super-admin | rename. |
| GET | `/profiles` | member | now workspace-scoped: active members (`member: true`, `role` in this workspace) + active non-members who still own contacts/companies/deals/tasks/meetings here (`member: false`, shown "(not in this workspace)"; never offered in pickers). |
| GET | `/team/members` | admin | `{data: [{userId, name, email, active, role, since}]}` |
| POST | `/team/members` | admin | `{email, role}` an existing ACTIVE user → 201 with the list; unknown → 404; already a member → 409. |
| PATCH | `/team/members/:userId` | admin | `{role}`; demoting the last admin → 409. |
| DELETE | `/team/members/:userId` | admin | 409 while they own active contacts / open deals / open tasks here ("still owns N active contact(s), N open deal(s) and N open task(s)…"), or for the last admin. |
| GET | `/super-admin/memberships` | super-admin | `{workspaces: [{id, name}], data: [{id, name, email, isSuperAdmin, roles: {<workspaceId>: role}}], nextCursor}`; active users, keyset by `sort=name:asc|desc`, `limit` 1–100, `q` ≥ 2 chars (name/email). No X-Workspace-Id. |
| PUT | `/super-admin/memberships` | super-admin | `{workspaceId, userId, role: "admin"|"salesperson"|null}` adds / changes / removes (null) with the same guards as Team. |

Assignment (rule 5): every new owner / assignee (contacts create/edit/bulk assign, companies, deals, manual tasks, meetings,
revenue rules + fallback, website default owner, WhatsApp number owner) must be an active member → 400 `The owner must be an
active member of this workspace.` (rules: `Every owner must be an active member of this workspace.`). An unchanged owner who
is no longer a member is kept. Every membership change is a row in `workspace_member_events`.

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
