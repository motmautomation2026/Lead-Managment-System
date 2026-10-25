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
| `POST /contacts/bulk` | `{ ids: uuid[1..100], action: "assignOwner" \| "enrollAi", ownerId? }` → `{ data: [{ id, ok, error? }] }` in request order (duplicates removed). One failure never stops the others. `assignOwner` needs `ownerId` of an **active** user (else 400 for the whole request) and runs the normal lead update per contact (timeline "Lead Assigned"). `enrollAi` is **A** and calls the AI enroll service (`error` explains skips: already enrolled, not eligible, no email/phone, …). A contact in another workspace → `ok: false, error: "Contact not found."` |

Filters: `ownerId[]`, `leadStatus[]` (pipeline stage), `lifecycle[]` (default `active` + `long_term_nurture`; `all` = every state except merged; `merged` only when named), `source[]`, `companyId`, `agentStatus[]` (`none|active|paused|handed_off|stopped`), `hasOpenDeal`, `createdFrom/To`, `lastActivityFrom/To`, `q` (full name "first last", first name, last name, company, email, phone).

Sorts: `createdAt` (**default desc**), `lastActivityAt`, `updatedAt`, `name` (last name, then first name), `company`.

`ContactListItem`: `id, name, firstName, lastName, email, phone, jobTitle, company {id,name}|null, owner {id,name}|null, leadStatus, lifecycle, openDeal {id,name,stage,amount,currency}|null` (the most recently updated open deal), `agentStatus, nextAction {taskId,type,title,dueAt,ownerId,ownerName,origin}|null, lastActivityAt, createdAt`.

## 3. Companies

| Endpoint | Notes |
|---|---|
| `GET /companies` · `GET /companies/count` | List standard; merged companies excluded. |
| `GET /companies/:id` | All fields + `contactCount, openDealCount, openDealAmount`. A merged company is still returned with `mergedIntoCompanyId` (follow it). |
| `POST /companies` | `{ name, domain?, website?, industry?, revenueRange?, city?, state?, country?, linkedinUrl?, employeeRange?, description?, ownerId? }` → 201 detail. Same normaliser and unique rules as automatic linking: a placeholder name ("Not provided", "NA", …) → 400; a domain is normalised (`https://www.Acme.in/x` → `acme.in`), invalid or free-mail → 400. Same normalized name or domain as a live company → **409 with `details.companyId`** of that company. Owner defaults to the caller; `null` = no owner; must be active. Opens `similar_name` suggestions like an automatic create. |
| `PATCH /companies/:id` | Any field above (`""`/`null` clears). A **rename** re-normalizes and updates every linked contact's `leads.company` text in the same transaction; a name/domain that belongs to another live company → 409 with `details.companyId`. Merged company → 409. |
| `GET /companies/:id/contacts` | The contacts list standard with `companyId` fixed (passing `companyId` is a 400). 404 for a merged / other-workspace company. |
| `GET /companies/:id/deals` | The deals list standard with `companyId` fixed. |
| `POST /companies/:id/merge` **A** | `{ sourceId }` → `{ targetId, sourceId, movedContacts }`. `:id` is kept. See §5. |

Filters: `ownerId[]`, `industry[]` (exact text), `hasDomain`, `createdFrom/To`, `q` (name, domain).
Sorts: `name` (**default asc**), `createdAt`, `updatedAt`, `contactCount`.

`CompanyListItem`: `id, name, domain, industry, city, owner {id,name}|null, contactCount` (excludes merged contacts), `openDealCount, openDealAmount` (**INR only**: the sum of open deals in INR, the only currency for now), `createdAt, updatedAt`.

## 4. Deals

| Endpoint | Notes |
|---|---|
| `GET /deals` · `GET /deals/count` | List standard. |
| `GET /deals/board` | Same filters except `stage` (400). `{ data: [{ stage, count, amountTotal, items, nextCursor }] }` for **every** stage in pipeline order (qualified → … → won, lost); `items` = first 20 by `updatedAt desc`, `amountTotal` in INR. Load more in a column with `GET /deals?stage=<stage>&sort=updatedAt:desc&cursor=<nextCursor>` plus the board's other filters. Pass `status=all` to fill the Won/Lost columns. |
| `GET /deals/:id` | All fields + `owner, company, contact {id,name,email,phone,lifecycle}`, `meetings [{id,title,at,status,outcome}]` and `proposals [{id,title,amount,currency,status,sentAt,updatedAt}]` linked by `deal_id`. |
| `POST /deals` | `{ leadId, name?, stage? (default qualified), amount?, currency? ("INR"), expectedCloseDate?, lossReason?, lossNotes? }` → 201 detail. Company, owner and service interest come from the contact; the default name is `"<Company> – <service interest or New opportunity>"`. Lost needs `lossReason` (400). Contact in another workspace → 404. |
| `PATCH /deals/:id` | `name, amount (≥ 0 or null), currency ("INR" only, else 400), expectedCloseDate (YYYY-MM-DD or null), ownerId (active user or null), companyId (live company in this workspace, or null)`. `stage` → **400 "Change a deal's stage with POST /deals/:id/stage."** |
| `POST /deals/:id/stage` | `{ stage, lossReason?, lossNotes? }` → detail. A manual move: any stage, closed deals can be reopened. Lost needs `lossReason` (400); the current stage → 409. Deal won with no other open deal → the contact becomes Won (existing triggers fire); deal lost → contact unchanged (B3b rules). |

Filters: `stage[]`, `ownerId[]`, `companyId`, `leadId`, `status` (`open` | `won` | `lost` | `all`; **default `open`**, or `all` when `stage` is given), `amountMin/Max`, `expectedCloseFrom/To`, `createdFrom/To`, `q` (deal name, company name).
Sorts: `updatedAt` (**default desc**), `createdAt`, `amount`, `expectedCloseDate` (both nullable: NULLs last), `name`.

`DealListItem`: `id, name, stage, amount, currency, expectedCloseDate (YYYY-MM-DD|null), owner {id,name}|null, company {id,name}|null, contact {id,name}, source, closedAt, createdAt, updatedAt`.

## 5. Duplicate review — `/company-duplicates` (all **A**)

| Endpoint | Notes |
|---|---|
| `GET /company-duplicates` | List standard (sort `createdAt`, default desc). Filters: `status[]` (`open` default, `merged`, `dismissed`, `all`), `reason[]`, `kind` (`pair` \| `contact`). Row: `id, kind, reason, score, status, createdAt, resolvedAt, companyA {id,name,domain,merged,contactCount}, companyB {…}\|null, contact {id,name,email,company}\|null, observedName, observedDomain`. |
| `POST /company-duplicates/:id/merge` | Pair rows only (contact row → 400). `{ targetId? }` (default company A; must be A or B, else 400) → the merge result. Not open → 409. |
| `POST /company-duplicates/:id/dismiss` | → 204. Not open → 409. |
| `POST /company-duplicates/:id/relink` | Contact rows only. `{ companyId? }`: link the contact to that live company, or (omitted) to a **new** company named after `observedName` (same rules as `POST /companies`, a clash → 409 with `details.companyId`; created without a domain, which belongs to the company it was matched to). The contact's company text follows; timeline "Company changed". The row is resolved as `dismissed` (there is no separate "relinked" status). |

**Merge re-pointing.** After any merge (either route), the source company's other **open** suggestions move to the target: a pair `(source, X)` becomes `(target, X)`; a contact-level row on the source moves to the target. If the re-pointed row would be `(target, target)`, or a row for it **already exists in any status** (the unique keys ignore status), the source's row is **dismissed** instead. Resolved rows are left as history.

## 6. Global search — `GET /search?q=`

`q` as in §1 (min 2). → `{ contacts: [{id,name,email,company,lifecycle}], companies: [{id,name,domain}], deals: [{id,name,stage,amount,currency,company}] }`, at most 5 each, best trigram match first, then most recent activity / update. Merged contacts and companies are excluded; deals of every status are included.

## 7. Saved views — `/saved-views`

| Endpoint | Notes |
|---|---|
| `GET /saved-views?object=contacts\|companies\|deals` | `{ data }`: the caller's views plus views shared in the workspace, by `position`. Row: `id, object, name, filters, sort, columns, isShared, position, ownerId, isMine, createdAt, updatedAt`. |
| `POST /saved-views` | `{ object, name, filters?, sort?, columns?, isShared?, position? }` → 201. **Max 30 per user per object** (409). |
| `PATCH /saved-views/:id` | Any field except `object`. |
| `DELETE /saved-views/:id` | → 204. |

`filters` are stored **exactly as the list endpoint's query params** (strings and string arrays, e.g. `{"ownerId": "me", "leadStatus": ["new"], "hasOpenDeal": "false"}`) and validated by the same Zod schema as that object's list (no `limit`/`cursor`); `sort` by the same sort whitelist; `columns` must be known column ids for the object (no repeats). Invalid → 400. The owner may edit/delete; admins may also edit/delete **shared** views; anyone else → 403 on a shared view, 404 on a private one.

Column ids — contacts: `name, email, phone, jobTitle, company, owner, leadStatus, lifecycle, openDeal, agentStatus, nextAction, lastActivityAt, createdAt`; companies: `name, domain, industry, city, owner, contactCount, openDealCount, openDealAmount, createdAt, updatedAt`; deals: `name, stage, amount, expectedCloseDate, owner, company, contact, source, closedAt, createdAt, updatedAt`.

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
| Global search `perf12` | 23 + 3 + 4 ms | 164 ms | seq scans at this size |

\* HTTP includes the network round trips from the local API to the staging pooler (~100 ms each); server execution is the target (< 300 ms, met everywhere).
