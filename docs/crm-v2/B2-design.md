# CRM v2 — Design (B2)

Status: **APPROVED by Govinda 2026-10-24** (all §9 answers: yes) · Written 2026-10-24 from `crm-v2/B1-inventory.md` (code at `dev@2a8d151`).
Goal: turn Northbeam / MOTM Flow into a HubSpot-style, AI-first CRM with **Contacts, Companies and Deals**, fast server-side lists and a production-grade frontend — without breaking anything that works today.

---

## 0. The 10 decisions in one table

| # | Decision | Why |
|---|---|---|
| 1 | **A contact is a row in `leads`.** UI says "Contact"; SQL keeps `leads`. | 14 tables, 3 triggers, the AI agent, workflows and WhatsApp matching all point at `leads.id`. Renaming the table is all risk, no user benefit. |
| 2 | **New `companies` table**; `leads.company_id` links a contact to one company. `leads.company` (text) stays and is kept in sync with the company name. | Templates, the AI prompt and grounding read `leads.company`; it is NOT NULL. |
| 3 | **New `deals` table** (one opportunity = one deal). Meetings and proposals get a `deal_id`. | Won/lost and money belong to an opportunity, not to a person; repeat business becomes possible. |
| 4 | **Deals are created automatically** when a meeting is booked or a proposal is created (attached to the contact's open deal if there is one), and **manually** by reps. | Agreed 2026-10-24. |
| 5 | **Existing contact routing does not change in B3.** Calls/meetings/proposals still move `leads.pipeline_stage` exactly as today; deals are added *alongside*. | Zero regressions; the old screens keep working until C6. |
| 6 | **Companies are auto-created** from the lead's company name; exact matches link automatically; anything doubtful goes to a **duplicate-review** list. Never auto-merge on a guess. | Agreed 2026-10-24; deterministic and explainable. |
| 7 | **One deal pipeline per workspace** with fixed stages (V1). Custom pipelines/stages later. | Keeps routing in code simple and testable. |
| 8 | **One list standard** for every list: keyset cursor, whitelisted sort, Zod-validated filters, escaped search + trigram index, `{data, nextCursor}` + a separate count. | Fast at any size; fixes the 500-row cap (B11) and wildcard search (B30). |
| 9 | **New frontend shell built next to the old one**; pages switch over one by one; old pages removed in C6. | No big-bang; nothing breaks mid-way. |
| 10 | **AI is part of every record** (summary, next step, ask-the-CRM, drafts), but AI never sends, never changes Won/Lost/DNC, and every AI output is checked by code. | AI-first without giving up today's safety rules. |

---

## 1. Data model

### 1.1 `companies` (new, migration 032)

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| workspace_id | uuid NN FK workspaces | every query scoped |
| name | text NN, not blank | display name (first seen spelling) |
| normalized_name | text NN | lower, trim, punctuation removed, legal suffixes removed (pvt ltd, private limited, ltd, llp, inc, llc, corp, co, company) — same function in SQL and TS |
| domain | text null | corporate email/website domain, lowercase; never free mail |
| website | text null | |
| industry | text null | |
| revenue_range, revenue_min_cr, revenue_max_cr | text / numeric | same meaning as on leads (021) |
| city, state, country | text null | country default null (not assumed) |
| linkedin_url | text null | |
| employee_range | text null | free text for now |
| description | text null | |
| owner_id | uuid null FK profiles SET NULL | company owner (default = first contact's owner) |
| merged_into_company_id | uuid null FK companies SET NULL | merge target; merged companies are hidden |
| created_by, created_by_name, created_at, updated_at | | standard; updated_at trigger |

Indexes / constraints:
- Unique `(workspace_id, normalized_name)` where `merged_into_company_id is null`.
- Unique `(workspace_id, domain)` where `domain is not null and merged_into_company_id is null`.
- List indexes `(workspace_id, name, id)`, `(workspace_id, created_at, id)`, `(workspace_id, updated_at, id)`; trigram GIN on `name` and `domain`.
- RLS enabled, no policies (021+ pattern; backend only).

### 1.2 Link contacts to companies

- `leads.company_id uuid null FK companies ON DELETE SET NULL` + index `(workspace_id, company_id)`.
- `leads.company` (text) stays. Rule: when a contact is linked, `leads.company = companies.name`; renaming a company updates its contacts' text in the same transaction. Placeholder names (`Not provided`, `NA`, `-`, `none`, `unknown`) → no company.
- Company fields on `leads` (`industry`, revenue) stay as "as submitted" values. The company record is the source of truth for company facts; readers (AI context, templates later) use **company first, lead fallback**.

### 1.3 `deals` (new, migration 032)

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| workspace_id | uuid NN | |
| name | text NN | default `"<Company> – <service interest or 'New opportunity'>"` |
| lead_id | uuid NN FK leads **CASCADE** | primary contact (same delete behaviour as every other lead child) |
| company_id | uuid null FK companies SET NULL | copied from the contact at creation; editable |
| owner_id | uuid null FK profiles SET NULL | default = contact owner |
| stage | `deal_stage` NN | see 1.4 |
| amount | numeric(14,2) null ≥ 0 | |
| currency | text NN default `'INR'` | |
| expected_close_date | date null | |
| service_interest | text null | copied from the contact |
| source | text NN | `meeting` / `proposal` / `manual` / `backfill` |
| loss_reason | `lead_loss_reason` null | required when stage = lost (reuse existing enum) |
| loss_notes | text null | |
| closed_at | timestamptz null | set when won/lost, cleared if reopened |
| created_by, created_by_name, created_at, updated_at | | |

Indexes: `(workspace_id, stage, updated_at, id)`, `(workspace_id, created_at, id)`, `(workspace_id, amount, id)`, `(workspace_id, expected_close_date, id)`, `(lead_id)`, `(company_id)`, trigram GIN on `name`. Check: `stage='lost' ⇒ loss_reason not null`; `closed_at` not null iff stage in (won, lost). RLS on, no policies.

Also:
- `meetings.deal_id`, `proposals.deal_id` — uuid null FK deals SET NULL, indexed.
- `timeline_events.related_deal_id` — uuid null FK deals SET NULL (deal page activity = timeline rows with this id + its meetings/proposals).
- V1 has **one primary contact per deal**. Many contacts per deal (`deal_contacts`) is backlog.

### 1.4 Deal stages (fixed V1 pipeline)

| Order | `deal_stage` | Board column | Comes from today's lead stage |
|---|---|---|---|
| 1 | qualified | Qualified | (manual deals only) |
| 2 | meeting_scheduled | Meeting scheduled | meeting_scheduled |
| 3 | meeting_follow_up | Meeting done / follow-up | meeting_follow_up |
| 4 | proposal_preparation | Preparing proposal | proposal_preparation |
| 5 | proposal_sent | Proposal sent | proposal_sent, proposal_decision_pending |
| 6 | negotiation | Negotiation | negotiation |
| 7 | won | Won | lifecycle won |
| 8 | lost | Lost | lifecycle lost / proposal rejected/expired |

### 1.5 Duplicate review + saved views

- `company_duplicate_candidates`: workspace_id, company_a_id, company_b_id (a < b), reason (`similar_name` / `same_domain_different_name` / `name_domain_conflict`), score numeric, status (`open` / `merged` / `dismissed`), resolved_by, resolved_at; unique (company_a_id, company_b_id).
- `saved_views`: workspace_id, owner_id, object (`contacts`/`companies`/`deals`), name, filters jsonb, sort text, columns jsonb, is_shared bool, position int. Validated by the same Zod schema as the list endpoint.
- Extension **pg_trgm** (in `extensions` schema, like pgvector) — B3 preflight checks staging; production pre-check added to the deploy list.

---

## 2. Business rules (all in `Backend/src/domain`, pure + unit-tested)

### 2.1 Company matching — `domain/companyMatch.ts`

For a contact being created or edited, in order:
1. Company text is a placeholder → **no company**.
2. Compute `normalized_name` and `corporate_domain` (email domain unless free mail; list shared with the AI/inventory).
3. A company with the same normalized name exists:
   - domain empty / same / company has no domain → **link**.
   - company has a *different* domain → link by name **and** open a `name_domain_conflict` candidate.
4. Else a company with the same domain exists (different name) → **link** and open a `same_domain_different_name` candidate (e.g. "TML" vs "Tata Motors").
5. Else → **create** a company (name, normalized name, domain, industry, revenue from the contact) and link.
6. After creating, if any existing company has trigram similarity ≥ 0.6 on `normalized_name` → open a `similar_name` candidate.

Merge (`mergeCompanies(target, source)`): re-point `leads.company_id` and `deals.company_id`, update linked contacts' `leads.company` text, fill empty target fields from source, set `source.merged_into_company_id`, timeline note on each moved contact, candidate → merged. **Never deletes contacts.**

Runs in the same transaction as: `createLead`, `importLeads` (per row), `ingestWebsiteLead`, and `updateLead` when `company` changes. Existing duplicate-*contact* rules on each entry path stay exactly as they are.

### 2.2 Deal routing — `domain/dealRouting.ts`

Deal creation/attachment (same transaction as the event):
- **Meeting booked** (`scheduleMeeting`) → attach to the request's `dealId` if given, else the contact's most recently updated **open** deal, else create a deal at `meeting_scheduled` (source `meeting`).
- **Proposal created** → same attach rule, else create at `proposal_preparation` (source `proposal`); set `amount/currency` from the proposal if the deal has none.
- **Manual** → `POST /deals` (stage default `qualified`).

Stage moves (never backwards, except where marked):

| Event | Deal stage → |
|---|---|
| Meeting outcome highly_interested / proposal_required | proposal_preparation |
| Meeting outcome needs_more_information / follow_up_required / needs_internal_discussion | meeting_follow_up |
| Meeting outcome second_meeting | meeting_scheduled (allowed backwards) |
| Meeting outcome won | won |
| Meeting outcome not_interested | lost (`loss_reason` = not_interested-equivalent) |
| Proposal sent | proposal_sent |
| Proposal revision_requested | proposal_preparation (allowed backwards) |
| Proposal accepted | won (amount = proposal amount) |
| Proposal rejected / expired | lost (`loss_reason` from the proposal) |
| Rep drags on the board / edits stage | any stage; won/lost need the closing dialog |

Deal ↔ contact sync (the only places they touch):
- Deal → **won** and the contact has no other open deal → contact lifecycle → won (same as today's won flows, so the existing triggers fire as they do today).
- Deal → **lost** → contact **unchanged**; the UI asks "Move contact to long-term nurture / mark lost / keep active?" (rep decides). Today's automatic contact routing for meetings/proposals still runs unchanged in V1.
- Contact → lost / discarded / do-not-contact / merged → its open deals → lost (reason `contact_closed` note) in the same transaction.
- Contact → won via the old button → if exactly one open deal, it becomes won.
- A deal **never** changes DNC, owner of the contact, or AI status.

### 2.3 Contact "lead status"

`leads.pipeline_stage` stays and is shown as **Lead status** on contacts. The deal-level values (`meeting_scheduled`…`negotiation`) keep being written by today's routing during V1 so nothing breaks; the contacts list shows **Lead status** + **Open deal stage** side by side. A later cleanup (backlog, after Release) can stop writing deal-level values to contacts.

---

## 3. Backfill (B3) — automatic, idempotent, runs in the worker

**Companies — a continuous sweeper (replaces a one-off job):**
- New columns `leads.company_link_checked_at timestamptz null` and `leads.company_link_attempts smallint not null default 0`.
- New contacts are linked inline (2.1) inside a SAVEPOINT: a company error never blocks creating a contact; on success or "no company" the row gets `company_link_checked_at = now()`.
- The worker tick sweeps contacts with `company_link_checked_at is null and company_link_attempts < 3`, oldest first, 200 per tick, one connection. That is the backfill for old data **and** the safety net for any inline failure. Production gets backfilled automatically after the release — no script is ever pointed at production.

**Deals — one-off per workspace (B3b):** flag `workspaces.crm_deals_backfilled_at`. For each contact with ≥1 meeting or proposal and no deal: create **one** deal (source `backfill`), attach all its meetings and proposals; stage = from the latest proposal status, else the latest meeting status/outcome, else the contact's stage mapped by 1.4; won if the contact lifecycle is won (closed_at = updated_at); lost if the latest proposal is rejected/expired or the contact is lost; amount/currency from the latest proposal. Batched, idempotent, one connection.

Admins see counts (companies, open duplicate candidates, deals) on the duplicate-review page (C3).

Note: staging has only 4 contacts (B1). Before release, Govinda runs the read-only profile query from B1 Appendix in the **production SQL editor himself** (read-only, counts only) to sanity-check the numbers. Claude Code never connects to production.

---

## 4. List API standard (B4)

New endpoints (reads only; all existing `/leads/:id/...` actions stay as they are — no duplication):

| Endpoint | Returns |
|---|---|
| `GET /contacts` · `GET /contacts/count` | ContactListItem page / `{count}` |
| `GET /companies` · `/count` · `GET /companies/:id` · `POST/PATCH /companies…` · `POST /companies/:id/merge` | |
| `GET /deals` · `/count` · `GET /deals/:id` · `POST/PATCH /deals…` · `POST /deals/:id/stage` | |
| `GET /search?q=` | top 5 contacts + 5 companies + 5 deals (global search) |
| `GET/POST/PATCH/DELETE /saved-views` | per object |
| `GET /company-duplicates` · `POST /company-duplicates/:id/{merge,dismiss}` | admin review |

Query contract (shared helper `lists/listQuery.ts`):
- `limit` 1–100 (default 50); `cursor` opaque (base64url of `[sortValue, id]`, same as AI Activity).
- `sort=field:asc|desc` from a **whitelist per object**; every whitelisted field has a `(workspace_id, field, id)` index; nulls last.
- Filters: flat query params, Zod `.strict()`. Multi-value repeats (`ownerId=a&ownerId=b`), ranges `createdFrom/createdTo`, `amountMin/amountMax`, booleans `true/false` only, special `ownerId=me`, `ownerId=none`.
- `q` search: escaped `ilike` (fixes B30) on name/company/email/phone (+ trigram index), min 2 chars.
- Response `{data, nextCursor}`; counts via `/count` (same filters) so the table loads fast.
- Row DTOs are **light** (only list columns). Example ContactListItem: id, name, email, phone, jobTitle, company `{id,name}|null`, owner `{id,name}|null`, leadStatus, lifecycle, openDeal `{id,stage,amount}|null`, agentStatus, nextAction, lastActivityAt, createdAt.
- Bulk actions: `POST /contacts/bulk` (`ids` ≤ 100; `assignOwner`, `enrollAi` via the existing service). More later.

---

## 5. Frontend (C phases)

### 5.1 Libraries (added in C1)
- `@tanstack/react-table` (headless table) + `@tanstack/react-virtual` (long lists).
- `react-hook-form` + `@hookform/resolvers` (Zod) for all new forms.
- `@dnd-kit/core` for the deal board.
- Keep: shadcn/Radix, Tailwind 4 tokens, cmdk, sonner, lucide, TanStack Router/Query. Charts (Recharts) only when dashboards are redone.

### 5.2 App shell (C1) — HubSpot-like
- **Left sidebar**, collapsible to icons; groups: *CRM* (Contacts, Companies, Deals), *Work* (Tasks, Meetings, Proposals), *Automation* (Workflows, AI Activity, Knowledge), *Settings/Admin*. Mobile (< lg): slide-in drawer + top bar (fixes "no mobile nav").
- **Top bar**: global search (⌘K, server-side `/search`), "+ Create" menu (contact, company, deal, task, meeting), notifications, user/workspace menu.
- Light + **dark mode** toggle (tokens already exist), density setting (comfortable/compact).
- Route-level code splitting; prefetch record data on row hover.

### 5.3 Index page pattern (Contacts, Companies, Deals)
Page header (title, total count, primary action, import) → **view tabs** (All · My · Recently added · saved views) → **filter bar** (quick filters: owner, lead status / stage, created date; "More filters" drawer) → **table** (sticky header, sortable columns from the whitelist, column picker, resizable, row checkbox + **bulk-action bar**, owner/stage chips, "Load more" + infinite scroll, skeleton loading, empty states with a clear next action). Deals also get a **Board** view (columns = stages, drag to move, won/lost dialog, column totals).

### 5.4 Record page pattern
- **Left panel**: identity header (name, company, owner, lead status / deal stage), quick actions (Log call, Note, Meeting, Task, Email/WhatsApp log, Enroll in AI), editable **About** properties.
- **Middle**: tabs — **Overview** (AI summary card, next action, key facts) · **Activity** (one timeline with type filters: notes, calls, meetings, tasks, messages, AI, system) · **Notes** · **Meetings & proposals** · **Automation**.
- **Right panel**: associations — Company ↔ Contacts ↔ Deals, proposals/files, AI tab (status, last decision, replies).
- Contacts record reuses today's dialogs (LogCall, ScheduleMeeting, SendProposal, Enroll) after porting them to fetch by id (fixes B11).

### 5.5 Quality bar ("production grade")
Every page: loading / empty / error states; keyboard navigation in tables; accessible labels; no list ever fetches "everything"; URL holds filters/sort/view (shareable links, back button works); optimistic updates only where safe; consistent toasts and error display; 375 px phone width works.

---

## 6. AI-first features (D phase)

| Feature | How | Guardrails |
|---|---|---|
| D1 Agent understands company + deal | `buildAgentContext` adds company facts + open deal stage; prompt/grounding allow-list adds company fields | same rules/grounding; company name stays an ignored claim |
| D2 Replies on the record | decrypt + show inbound text on the contact Activity tab (owner + admins), audit each view | never in list endpoints or logs |
| D5a Record summary | short summary of a contact/company/deal from timeline + notes; cached in `ai_summaries`, refreshed in the worker after new activity | counts toward monthly budget + daily cap; shows "AI summary · updated <time>" |
| D5b Next best action | suggestion chip on the record ("Call — they asked for the proposal") | suggestion only; rep clicks to act |
| D5c Ask the CRM | plain English → **structured filter JSON** validated by the list Zod schema → normal list endpoint | never raw SQL; respects workspace scope |
| D5d Draft for rep | AI writes an email/WhatsApp in the owner's tone; rep edits and sends/logs | rep sends; never automatic |

Interactive AI calls (summaries on demand, ask-the-CRM, drafts) may run in the API with a 30 s timeout and the budget check — they never send anything, so the "no sends in request handlers" rule still holds.

---

## 7. Must not break (checked in every prompt)

DNC exit only via reactivation; the three `leads` lifecycle triggers and trigger 026; AI safety rules (never Won/Lost/DNC, never owner change, only `agent_status=active`); routing only in backend `domain/*` (deal stages included); website/CSV dedupe + advisory lock; WhatsApp matching to exactly one active contact + encrypted body + owner task; `leads.company` always populated; workflow sends only in the worker; published versions immutable; auto-enrolment triggers; hard delete + `deleted_leads_audit`; workspace scoping on every query; additive migrations; the 15-connection budget.

---

## 8. Build steps (one Claude Code prompt each)

| Step | Scope | Done when |
|---|---|---|
| **B3** | **B3a**: migration 032 (pg_trgm, companies, deals, deal_stage, link columns, duplicate candidates, saved views, sweeper columns, indexes) · `companyNormalize.ts`, `companyMatch.ts` · company link on create/import/website/update · merge companies · worker company sweeper. **B3b**: `dealRouting.ts` · deal attach on meeting/proposal + stage moves + contact sync · deal backfill | All existing tests still pass; new unit + integration tests; staging backfilled; old UI unchanged |
| **B4** | `lists/listQuery.ts` standard; `/contacts`, `/companies`, `/deals` (+count, detail, create/edit for companies & deals, stage move, merge), `/search`, `/saved-views`, `/company-duplicates`, bulk; B30 fix | Contract tests for sort/cursor/filters; performance check with a seeded `[test]` workspace of 5,000 contacts |
| **C1** | Libraries; new app shell (sidebar groups, mobile drawer, top bar, global search, + Create, dark mode); shared DataTable, FilterBar, ViewTabs, PageHeader, EmptyState, RecordLayout, Sheet | Shell live behind new routes; old pages still reachable |
| **C2** | Contacts index (server list, views, filters, bulk) + Contact record page (ported dialogs, fetch by id) | Nav "Contacts" points to new pages |
| **C3** | Companies index + record + duplicate-review screen (admin) | |
| **C4** | Deals index (table + board) + record + create/close dialogs | |
| **C5** | Global search polish, saved views UX, keyboard shortcuts | |
| **C6** | Tasks/Meetings/Proposals/Workflows/AI Activity/Settings inside the new shell; agent task origin type; remove old Leads pages | No old pages left; full regression pass |
| D1–D5, E1–E2, F | as in the master plan (handoff §8) | |

---

## 9. Questions for Govinda — ANSWERED 2026-10-24: all yes

1. **Deal name** default `"<Company> – <service interest>"` — OK?
2. **Currency** default INR only for now — OK?
3. **Deal lost → contact**: rep decides (dialog), not automatic — OK?
4. **Dark mode** in C1 — want it, or light only?
5. **One contact per deal** in V1 (many contacts per deal later) — OK?
