# 03 (part B) — Backend: domain rules, services, workflow engine

Line references are to `Backend/src/...`.

---

## 1. Domain modules (pure, no I/O)

### 1.1 Lifecycle and pipeline guards: `domain/pipeline.ts`

| Function | Rule |
|---|---|
| `isTerminalLifecycle(state)` | true for won, lost, discarded, do_not_contact, merged. `active` and `long_term_nurture` are non-terminal. |
| `assertValidPipelineStage(v)` | `v` must be in `PIPELINE_STAGES` (retired stages are rejected), else `InvalidTransitionError` 422. |
| `pipelineStageIndex(stage)` | Index in the TS `PIPELINE_STAGES` order (used to avoid regressing a stage when a meeting is booked). |
| `assertValidLifecycleState(v)` | Membership check. |
| `assertPipelineStageEditable(lifecycle)` | Throws 422 "Pipeline stage cannot be changed while the lead's lifecycle is X…" unless `lifecycle === 'active'`. |

TS stage order (`enums.ts:19-35`): new, ready_for_first_call, contact_attempted, not_connected_nurture, connected_qualifying, interested_later, future_possibility, objection_nurture, meeting_scheduling, meeting_scheduled, meeting_follow_up, proposal_preparation, proposal_sent, proposal_decision_pending, negotiation.

### 1.2 Call routing: `domain/callRouting.ts`

`routeNotConnected(reason)` (lines 48-58) applies to **every** not-connected reason:

| Effect | Value |
|---|---|
| stage | `not_connected_nurture` |
| automation | `active` |
| task | `call` "Retry call after nurture touch", due +2 days |
| workflowTrigger offered | `call_not_connected` |
| phone contactability | `invalid` if reason = `invalid_number`; `wrong_number` if reason = `wrong_number`; otherwise none |

`routeConnectedOutcome(outcome, capture)` (lines 84-191). The `do_not_contact` outcome never reaches this table; `calls.service` sends it through `markDnc`.

| Outcome | Stage | Automation | Task (type, title, due) | Trigger offered | Prompt meeting | Objection type |
|---|---|---|---|---|---|---|
| positive | meeting_scheduling | **manual** | schedule_meeting, "Schedule discovery meeting", +1d | — | yes | — |
| meeting_agreed | meeting_scheduling | active | schedule_meeting, "Schedule agreed meeting", +1d | `meeting_agreed` | yes | — |
| interested_later | interested_later | active | follow_up, "Reconnect per stated timing", due = round((restartAt − now)/1d) − 7, min 1; **30d** if no or invalid date | `call_outcome_interested_later` | — | — |
| future_possibility | future_possibility | active | follow_up, "Long-term low-intensity check-in", +90d | `call_outcome_future_possibility` | — | — |
| callback_requested | *(unchanged)* | **manual** | call, "Callback requested by lead", due = `callbackDueAt` | — | — | — |
| information_requested | connected_qualifying | active | follow_up, "Call after info sequence - gauge relevance", +10d | `call_outcome_information_requested` | — | — |
| commission_only | objection_nurture | active | follow_up, "Follow up: Commission-only objection", +5d | `objection_commission_only` | — | commission_only |
| internal_hiring | objection_nurture | active | follow_up, "Follow up: Internal hiring objection", +5d | `objection_internal_hiring` | — | internal_hiring |
| existing_team | objection_nurture | active | follow_up, "Follow up: Existing team objection", +5d | `objection_existing_team` | — | existing_team |
| budget_price | objection_nurture | active | follow_up, "Follow up: Budget/price objection", +5d | `objection_budget_price` | — | budget_price |
| internal_approval | objection_nurture | active | general_task, "Prepare decision-maker one-pager", +2d | `objection_internal_approval` | — | internal_approval |
| wrong_fit | *(unchanged)* | **manual** | general_task, "Confirm fit - archive or reroute", +2d | — | — | wrong_fit (reporting only) |
| wrong_person | connected_qualifying | *(unchanged)* | general_task, "Confirm correct contact person", +2d | — | — | — |

Notes:
- "+Nd" means `addDaysIso(N)` = now + N×24h in UTC, not an IST calendar day.
- Setting automation to `manual` cancels all of the lead's active runs (see §3.4).
- The comment on `wrong_person` says "No stage/automation change", but the code does set the stage to `connected_qualifying` (`callRouting.ts:182-189`).

### 1.3 Meeting outcome routing: `domain/meetingRouting.ts:19-91`

| Outcome | Stage | Lifecycle | Task (type, title, due) | Workflow trigger (**auto-enrolled**) | Objection type |
|---|---|---|---|---|---|
| won | — | **won** | — (markWon cancels open tasks) | — | — |
| highly_interested | proposal_preparation | — | general_task, "Schedule proposal/solution discussion", +2d | `meeting_highly_interested` | — |
| proposal_required | proposal_preparation | — | prepare_proposal, "Prepare and upload proposal", +2d | `meeting_proposal_requested` | — |
| needs_internal_discussion | objection_nurture | — | general_task, "Prepare decision-maker one-pager", +2d | `objection_internal_approval` | internal_approval |
| needs_more_information | meeting_follow_up | — | send_case_study, "Send evidence / case studies", +2d | `meeting_needs_more_information` | — |
| follow_up_required ("Not ready") | meeting_follow_up | — | follow_up, "Follow up after meeting", +3d | `meeting_not_ready` | — |
| second_meeting | meeting_scheduling | — | schedule_meeting, "Book the second meeting", +3d | — | — |
| not_interested ("Not fit") | — | **long_term_nurture** | re_engage, "Long-term re-engagement", +45d | `meeting_not_a_fit` (see 07: never sends) | — |
| no_proposal_required | — | — | internal_review, "Review meeting outcome - no proposal required", +2d | — | — |

### 1.4 Proposal status routing: `domain/proposalRouting.ts:29-71`

| New status | Stage | Lifecycle | Task (type, title, due) | Cancel tasks | Trigger (**auto-enrolled**) |
|---|---|---|---|---|---|
| sent | proposal_decision_pending | — | proposal_follow_up, "Follow up on proposal", +3d | — | `proposal_pending` |
| revision_requested | proposal_preparation | — | prepare_proposal, "Revise proposal per customer feedback", +2d | open `proposal_follow_up` tasks | — |
| accepted | — | **won** | — | **all open tasks** | — |
| rejected | — | long_term_nurture | re_engage, "Re-engage after rejection", +45d | open `proposal_follow_up` | — |
| expired | — | long_term_nurture | re_engage, "Re-engage after proposal expired", +45d | open `proposal_follow_up` | — |
| draft, uploaded, ready_to_send, revised, withdrawn | — | — | — | — | — |

The service additionally does these things (`proposals.service.ts:223-291`):
- `sent` also sets `sent_at = now()` and `follow_up_at = now + 3d`.
- `rejected`/`expired` require `lossReason`, which is stored on the proposal along with `loss_notes`.
- Statuses accepted, rejected, withdrawn and expired are **terminal**: any further change is a 409.
- Setting the same status again is a no-op.
- Any non-terminal status can move to any other status (there is no transition graph).

### 1.5 Template rendering: `domain/templateRenderer.ts`

- Token pattern: `/\{\{\s*([\w.]+)\s*\}\}/g`.
- `KNOWN_TEMPLATE_VARIABLES` (16):
  - `lead.firstName`, `lead.lastName`, `lead.fullName` (falls back to firstName), `lead.company`, `lead.industry`, `lead.email`, `lead.phone`
  - `owner.name`
  - `current.date`, `tomorrow.date`, `current.time`
  - `meeting.title`, `meeting.date`, `meeting.time`, `meeting.duration` ("N minutes"), `meeting.link` (meet link, else meeting URL)
- Dates and times use `Intl en-IN`, Asia/Kolkata, `dateStyle medium` / `timeStyle short`.
- `renderTemplate(template, lead, meeting?, now)`:
  - **Throws** if the subject or body contains a known `meeting.*` token and no meeting is supplied.
  - Body substitutions are HTML-escaped (`& < > " '`). The subject is not escaped.
  - Unknown tokens are left as literal text and returned in `unknownTokens`.
  - Variables are held in a `Map`, which avoids prototype-key lookups.
- `findUnknownTemplateTokens(text)`: used by publish to reject unknown variables.

### 1.6 Other pure modules

- `htmlToWhatsAppText.ts`:
  - `<a href>` becomes `label: url`. Only http and https hrefs are kept; if the label equals the URL it is shown once.
  - strong/b becomes `*x*`; em/i becomes `_x_`; u is unwrapped.
  - ul/ol/li become `- ` or `N.` lines, indented by nesting level, honouring `start=`.
  - `<br>` becomes `\n`; `</p>` becomes a blank line.
  - Any other tag is stripped. Entities are decoded last. Three or more newlines collapse to two. The result is trimmed.
- `websiteForm.ts`:
  - `cleanLine` turns control chars into spaces, collapses whitespace, trims, and caps length.
  - `cleanMessage` keeps newlines, normalises CRLF, removes other control chars, collapses three or more blank lines, and caps at 5000.
  - `splitName` splits on the first space. The name is title-cased only if it is all-lowercase or all-uppercase. A blank name becomes "Unknown".
  - Phone: separators are stripped. `00…` becomes `+…`; a 12-digit `91…` becomes `+91…`. Then `normalizePhoneE164`.
  - `parseMessage` extracts the first `Industry:`, `Revenue range:` and `Diagnosis issue:` lines (case-insensitive). The other lines form the challenge text.
  - `formatSubmissionDetail` builds deterministic lines. This text is used for the 10-minute identical-resubmission check.
  - Caps: name 200, company 300 (blank becomes "Not provided"), industry 120, other fields 200, email 320, phone 50.
- `email.ts`: `normalizeEmail` = trim, lowercase, Zod email check, else null.
- `phone.ts`:
  - `normalizePhoneE164` uses libphonenumber with region `IN` unless the input starts with `+`, and requires `isValid()`.
  - `phoneE164ToJid` produces `digits@s.whatsapp.net`.
  - `jidToPhoneE164` accepts only `@s.whatsapp.net` JIDs, strips the `:device` suffix, and requires 8–15 digits.
- `baileys-policy.ts`: see 04.

---

## 2. Services

Conventions used below:
- **Workspace check**: almost every mutating service first loads the root row with `… where id=$1 and workspace_id=$2` (`getLeadRowOr404`, `getTaskOr404`, …). A miss is a 404. Later statements key off `id` alone.
- "TL" = `addTimelineEvent` row. Actor is "manual(actor)" via `actorEvent`, `AUTOMATION_ACTOR` ("Automation"), or `SYSTEM_ACTOR` ("System").
- Unless noted, the transaction boundary is the route's `withTransaction`; the service receives a client.

### 2.1 `leads.service.ts`

| Function | Reads / writes | Side effects | Throws |
|---|---|---|---|
| `validateLeadFields(input)` (150-184) | pure | — | `ValidationError` (with `{field}`): first name or company blank; neither email nor phone; invalid email; invalid phone ("Indian local numbers default to +91…"); unknown source |
| `createLead(db, actor, ws, input)` (186-253) | INSERT leads (owner = `input.ownerId ?? actor.id`; `created_by` = actor). Reads the owner name. | TL "Lead Created" (`Source: x`), TL "Lead Assigned" (`Owner: name`). `createTask` call "First call", due now, origin manual. **`autoEnroll(..., "lead_created")`**. | validation; FK error (500) for an unknown ownerId |
| `getLeadRowOr404` | SELECT lead plus owner name, scoped to ws | — | 404 |
| `importLeads(db, actor, ws, rows)` (294-399) | Validates every row (failures are collected). One query loads existing email/phone keys in the ws. Rows that duplicate the DB or an earlier row in the file are skipped. INSERT per row with owner = actor. | Per row: TL "Lead Created" (`(CSV import)`), TL "Lead Assigned", task "First call", **`autoEnroll lead_created`** | partial: only unexpected errors abort the whole batch |
| `listLeads(db, ws, filters)` (412-483) | SELECT with filters. Search is `ilike %q%` on first, last, company, email and phone (wildcards are not escaped). Limit default 200, max 500. Next actions come from the `lead_next_actions` view. | — | — |
| `updateLead(db, actor\|null, ws, id, patch)` (521-615) | If `pipelineStage` is set: `assertValidPipelineStage` and `assertPipelineStageEditable` (lead must be active). Validates firstName, company, email, phone, source. Builds a dynamic UPDATE (also `objection_type` and `interested_later_*` for internal callers) and sets `last_activity_at = now()`. | TL "Stage changed to X" (kind `stage`) when the stage changed. TL "Lead Assigned" when the owner changed. | 422 transition; 400 validation; **500 when the stage is set to `objection_nurture` without an objection type** (DB check) |
| `deleteLead` (626-636) | INSERT `deleted_leads_audit` (snapshot = `leadToDto`), then DELETE lead (cascade) | — | 404 |
| `addNote` / `listNotes` | INSERT `lead_notes`; bump `last_activity_at` | TL "Note Added" (kind note, detail = body) | 400 on blank |
| `setAutomationMode` (676-700) | Refuses terminal lifecycles (409). Updates `automation_mode`. | TL "Automation Resumed / Paused / Stopped / Switched to Manual". `applyAutomationModeToRuns(leadId, mode)`. | 409 |
| `markDnc` (713-737) | Reason required. A no-op if already DNC. Sets lifecycle `do_not_contact`, `dnc_reason`, `dnc_by`, `dnc_by_name`, `dnc_at`. | DB triggers: automation set to `stopped`, runs and actions cancelled, `dnc_events` 'suppressed'. App: `cancelOpenTasksForLead` ("Lead marked Do Not Contact"), TL "Do Not Contact". | 400 |
| `reactivateFromDnc` (746-764) | Must currently be DNC (else 409). Sets lifecycle active, **automation manual**, and the dnc_* fields to the new reason and actor. | The trigger writes `dnc_events` 'reactivated' (new reason) and nulls `dnc_reason`. TL "Reactivated". | 400 / 409 |
| `setTerminalLifecycle` (internal, 766-790), used by `markWon`, `markLost` (with `loss_reason`, `loss_notes` in the same UPDATE), `markDiscarded` | A no-op if already in that state. **No guard against the current state being DNC or merged.** | Trigger: automation `stopped`, runs and actions cancelled. App: `cancelOpenTasksForLead("Lead Won\|Lost\|Discarded")`, TL "Won" / "Lost" / "Discarded" (detail = reason, or notes and lossReason for Lost). | — |
| `moveToLongTermNurture` (807-813) | A no-op if already LTN. Sets lifecycle LTN. **No terminal or DNC guard, and it does not touch automation, runs or tasks.** | TL "Moved to Long-Term Nurture" | — |
| `reactivateLead` (819-835) | DNC gives 409 (use the DNC endpoint). Merged gives 409. Already active is a no-op. Otherwise sets lifecycle active and **automation manual**. | TL "Reactivated" | 409 |
| `mergeLead` (845-873) | Source must differ from target, and neither may already be merged. Sets source to `merged` with `merged_into_lead_id`. **Nothing is reparented.** | Trigger cancels the source's runs. App cancels the source's open tasks. TL "Merged" on the source and "Absorbed Duplicate Lead" on the target. | 400 / 409 |
| `setContactability` (885-910) | Status must be in the per-channel list. Upserts `lead_contact_channels`. | TL "`<channel>` contactability: `<status>`" | 400 |
| `logManualCommunication` (923-944) | DNC gives 409 `do_not_contact`. | TL "Email Sent" / "WhatsApp Sent" (kind email or whatsapp; detail = text, or "Manual email from lead record"). Bumps `last_activity_at`. **No provider call.** | 409 |

### 2.2 `calls.service.ts`, `logCall(db, actor, ws, leadId, input)` (60-195), one transaction

1. Load the lead. DNC gives 409 `do_not_contact`.
2. Validate: connected requires `connectedOutcome`; not connected requires `notConnectedReason`; `callback_requested` requires `callbackDueAt`; `callbackDueAt` must be in the future. Each failure is a 400.
3. INSERT `calls` (`callback_due_at` is kept only for callback_requested).
4. TL "Call Connected - `<outcome>`" or "Call Not Connected" (detail = reason and notes), related to the call.
5. If `taskId` is given: the task must exist in the ws, belong to this lead, be `call` type and be open (else 404/400). Then `completeTask`.
6. If the outcome is `do_not_contact`: `markDnc(reason = notes or "Requested on call")`, then return with `workflowTrigger: undefined`.
7. Otherwise look up the routing (§1.2):
   - If `phoneContactStatus` is set: `setContactability(phone, status, "Call outcome: <reason>")`.
   - If a stage or objection type is set: **one** `updateLead` call with the stage, the objectionType and, for interested_later, the four capture fields. This requires the lead to be **active**; otherwise a 422 rolls back the whole call.
   - If an automation mode is set: `setAutomationMode` (refuses terminal lifecycles with a 409).
   - If a task is set: `createTask` with owner = lead owner, due = `callbackDueAt` for callbacks, else +N days; origin manual.
   - For `positive`: `cancelOpenTasksForLead(["follow_up","nurture"], "Superseded by positive call outcome")`.
8. Returns `{call, lead, workflowTrigger, promptScheduleMeeting}`. **No enrollment happens here.** The frontend asks the rep (see 05).

`listCallsForLead`: newest first.

### 2.3 `tasks.service.ts`

| Function | Behaviour |
|---|---|
| `createTask(db, actor\|null, ws, input)` | Title required. Origin `automation` requires `sourceWorkflowRunId`. The lead must be in the ws (404). INSERT (`owner_name` is only what the caller passes). TL "Task Created" (actor = Automation for automation-origin or a null actor). |
| `updateTask` | Open tasks only (409 otherwise). Dynamic update of owner_id, task_type, title, due_at (does **not** refresh `owner_name`). TL "Task Updated". |
| `completeTask` | Idempotent (a non-open task is returned unchanged). Sets status completed, `completed_at`. TL "Task Completed". |
| `cancelTask` | Idempotent. Sets cancelled, `cancelled_at`, `cancel_reason`. TL "Task Cancelled". |
| `cancelOpenTasksForLead(db, actor, leadId, reason, types?)` | Bulk-cancels open tasks, optionally filtered by type. TL per task "Task Cancelled" (`<title> - <reason>`). |
| `listTasks` | Filters as in the route. `dueTodayOnly` uses Asia/Kolkata day bounds. `order by due_at`. |
| `getLeadNextAction(db, leadId)` | `lead_next_actions` view: the earliest open task. |

### 2.4 `meetings.service.ts`

`scheduleMeeting(db, actor, ws, input)` (93-152), one transaction:
1. Title required. Lead in the ws. DNC gives 409.
2. Owner = `input.ownerId ?? lead.owner_id ?? actor.id`. The owner name is resolved without a query when it is the lead owner or the actor.
3. INSERT meeting with status **`scheduled`** and duration default 30. INSERT participants (blank emails are skipped).
4. TL "Meeting Scheduled".
5. If the stage index is below `meeting_scheduled`: `updateLead(stage = meeting_scheduled)`. This needs an active lead; otherwise 422.
6. `cancelRunsForLead(lead, "Meeting booked - nurture objective reached")`. This cancels **all** non-terminal runs.
7. `cancelOpenTasksForLead(["follow_up","nurture","schedule_meeting","call"], "Superseded by scheduled meeting")`.
8. `createTask(confirm_meeting, "Prepare for the meeting", due = meeting time)`.
9. **`autoEnroll(..., "meeting_scheduled")`**.

After commit, the route calls `syncMeetingCreated` and then `notifyMeetingScheduled` (see 04).

| Other function | Behaviour |
|---|---|
| `updateMeeting` | Dynamic update of title, `scheduled_at`, duration, url, status, notes. Any status other than `completed` also sets **outcome = NULL**. On a status change: TL "Meeting Rescheduled" / "Meeting Cancelled" / "Meeting <status>". For cancelled, no_show or failed it cancels open `confirm_meeting` tasks. **Participants cannot be edited.** |
| `recordMeetingOutcome` | Idempotent only for an exact repeat (same outcome while already completed). Sets status completed and the outcome; `notes = coalesce(new, old)`. TL "Meeting Completed" ("Outcome: x"). Routing (§1.3): `updateLead(stage, objectionType)`, `moveToLongTermNurture`, `markWon`, `createTask` (owner = meeting owner), and **`autoEnroll(trigger)`**. There is no lifecycle guard; a non-active lead fails with 422 if the routing changes the stage. |
| `getLatestMeetingForLead(leadId)` | The most recently **created** meeting whose status is not cancelled or failed. Used by worker template rendering. |
| `listMeetings`, `getMeetingOr404`, `getMeetingRowOr404`, `toRenderMeeting` | Reads and DTOs. |

### 2.5 `proposals.service.ts` and `proposalSending.service.ts`

`createAndSendProposal(actor, ws, input, file)` (`proposalSending.service.ts:124-176`). It manages its **own** transactions:
1. Validate the title and both template ids.
2. Load the lead on the pool. DNC gives 409.
3. Load both templates (same ws, correct channel, active; else 404/400).
4. Neither an email nor a `phone_e164` gives 400.
5. **Upload the document to Storage** at `proposal-documents/${leadId}/${uuid}-${name}` (outside any DB tx).
6. tx `createProposal`: INSERT proposal (status `draft`, `owner_id = lead.owner_id`, owner_name not set, the template ids, email status `pending` or `skipped`, WhatsApp status `queued` or `skipped`). TL "Proposal Created". **`updateLead(stage = proposal_preparation)` unconditionally.** This can move the stage backwards, and it fails with 422 for a non-active lead after the file is already uploaded.
7. If email is eligible: `sendProposalEmailNow` **inline in the request**. It renders the template (no meeting), downloads the document, and calls `sendEmail` with the document as an attachment. On success: `email_send_status = sent`, then `tryAdvanceToSent` (its own tx, `updateProposalStatus(..., "sent")`; errors are swallowed and logged). On any error: `email_send_status = failed` with the message (a deferred error, such as email disabled, is also marked **failed**).
8. WhatsApp stays `queued` for the worker (see 04).
9. Returns the ProposalDTO.

| Other function | Behaviour |
|---|---|
| `createProposal(db, actor, ws, input)` | See step 6. |
| `updateProposal` | Edits title, `document_reference` (from `fileName`), amount, notes. No timeline entry. |
| `updateProposalStatus(db, actor\|null, ws, id, status, {lossReason, lossNotes})` | §1.4. TL "Proposal <status>". Then in order: lifecycle routing (`markWon` or `moveToLongTermNurture`), stage routing via `updateLead` (422 if not active), task cancellation, `createTask` (owner = proposal owner), **`autoEnroll(proposal_pending)` for sent**. |
| `claimQueuedProposalWhatsappSends`, `processQueuedProposalWhatsappSend` | See 04. |

### 2.6 `runs.service.ts`

See §3 (workflow engine). Public functions: `listRuns`, `getRunRowOr404`, `autoEnroll`, `enrollLeadInWorkflow`, `scheduleStepAfter`, `pauseRun`, `resumeRun`, `cancelRun`, `retryRun`, `applyAutomationModeToRuns`, `cancelRunsForLead`, `listScheduledActions`, `runToDto`.

### 2.7 `workflows.service.ts`

| Function | Behaviour |
|---|---|
| `listWorkflows` / `getWorkflow` / `workflowToDto` | Per workflow: all versions and their steps, plus counts of active and failed runs (N+1 queries). |
| `findActiveWorkflowsForTrigger(ws, trigger)` | Workflows in the ws with this trigger, `status='active'`, joined to their **published** version. |
| `createWorkflow` | Name required. INSERT with status `paused`, owner = `input.ownerId ?? actor`. INSERT v1 `draft`. |
| `updateWorkflow` | name (non-blank), description, status, ownerId, trigger. Changing the trigger or status takes effect for future enrollments only. |
| `createDraft` | Idempotent: if a draft exists it is returned. Otherwise it creates version `max+1` as a draft and copies the published version's steps (or none if nothing is published). |
| `updateDraftSteps(ws, wfId, version, steps)` | Locks the version row with `FOR UPDATE`. Must be a draft (422). Every templateId must belong to the ws (400). DELETEs all steps, then INSERTs them in **array order** (`step_order` 0..n-1; the client `order` is ignored). `delay_days` is clamped to ≥ 0. send_email and send_whatsapp require a template (400 "Step N … requires a template"). **The template channel is not checked against the action.** |
| `deleteWorkflowVersion` | Locks all versions. Target must exist (404), be a draft (422), and not be the only version (409 `only_version`). Deletes its steps, then the version. |
| `publishVersion(..., enrollmentMode="keep_existing")` | Any other mode gives 422 "not implemented". Must be a draft with at least 1 step (400). `assertNoUnknownTemplateVariables` checks every send-step template's body and subject against `KNOWN_TEMPLATE_VARIABLES` (400 listing the step and template). Demotes the current published version to `previous`, promotes the target to `published` with `published_at`. **Existing runs keep their version.** |
| `duplicateWorkflow` | New workflow "<name> (copy)", status paused, same trigger and owner, v1 draft copying the published version's steps (or the highest version's). |
| `deleteWorkflow(ws, id, {force})` | If any runs exist and `force` is not set: 409 `{reason:"has_enrollment_history", runCount}`. If forced: DELETE runs (which cascades to scheduled_actions). Then, for each version (draft first): flip to draft if needed, delete its steps, delete the version. Then DELETE the workflow. |
| `listTemplates`, `listTemplatesWithAttachments` | Templates of the ws ordered by name. Attachments get a fresh signed URL (300 s). |
| `createTemplate` | Name and body required. A WhatsApp template may not have a subject (400). The subject is stored only for email. |
| `updateTemplate` | name, subject, body, active, isDefaultMeetingScheduled. When setting the default flag it first clears the same column on **every template in the database where the flag is true, not just this workspace's** (`workflows.service.ts:644-646`). |
| `createTemplateAttachment` | WhatsApp: at most 1 attachment and at most 10 MB. Email: at most 15 MB. Uploads to Storage first, then INSERTs the row. |
| `deleteTemplateAttachment` | Removes the Storage object (an error gives 500), then the row. |
| `deleteTemplate` | 409 if referenced by a step in a **published** version. Otherwise DELETE. That runs `SET NULL` on `workflow_steps` rows of *previous* versions, which the draft-only trigger rejects, giving **500** (see 07). Storage objects are not removed. |
| `listTemplateAttachments` | **Unused.** |

### 2.8 `automation.service.ts` (used only by the worker)

See §3.5 and 04. Exports: `claimDueActions`, `getActionContext`, `skipAction`, `deferAction`, `executeInternalAction`, `recordActionResult`, types `ActionContext` and `Eligibility`.

### 2.9 `timeline.service.ts`

`addTimelineEvent` inserts one row (`occurred_at` defaults to now; metadata is JSON-stringified). `listTimelineForLead` returns events oldest first, joined to leads for the ws check. Actor constants: `SYSTEM_ACTOR` (null id, "System", system) and `AUTOMATION_ACTOR` (null id, "Automation", automation).

### 2.10 `leadIngest.service.ts`, `ingestWebsiteLead(db, ws, raw)`, inside the route transaction

1. `normalizeWebsiteForm`. With no valid email **and** no valid phone it returns `rejected` (nothing is written).
2. `lockSubmitter`: `pg_advisory_xact_lock(hashtextextended("<ws>:email:<email>" | "<ws>:phone:<e164>", 0))`, taken in sorted key order.
3. `findExistingLead`: same ws, lifecycle ≠ merged, `lower(email)` = email **or** `phone_e164` = phone. An email match ranks first, then newest.
4. **Existing lead**: if a TL titled "Website form submission" or "…submitted again" with an identical `detail` exists within 10 min, it returns `duplicate` silently. Otherwise: TL "Website form submitted again" (SYSTEM, metadata `{channel:"website_form", industry, revenueRange, diagnosisIssue, invalidPhone, rawMessage}`), bump `last_activity_at`, and `notifyAboutLead(owner or everyone)`, adding a state note if the lead is not active. Returns `duplicate`. Stage, lifecycle and DNC state are never changed.
5. **New lead**: `validateLeadFields` with source `website` (a ValidationError returns `rejected`). `resolveOwner`, inside a **savepoint** so a failure such as migration 018 missing does not abort the tx: uses `workspaces.default_lead_owner_id` only while that user is an active salesperson, else null with a warning log. INSERT the lead (`created_by` null, `created_by_name` "Website form"). TL "Lead Created" (SYSTEM). TL "Lead Assigned" **only if there is an owner**. TL "Website form submission" with metadata. `createTask(call "First call", due now, owner, ownerName)`. `notifyAboutLead("New website lead")`. **No `autoEnroll`.**
6. `notifyAboutLead`: inserts one notification per active salesperson, or only the owner. If the owner row no longer qualifies it falls back to everyone. Kind `info`, href `/leads/<id>`.

### 2.11 `connections.service.ts`, `websiteLeadSettings.service.ts`, `workspaces.service.ts`, `admin-users.service.ts`, `admin-audit.service.ts`

- **Email**:
  - `loadEmailConnection(ws)` reads the row `('email', ws)` and decrypts secrets with AAD `"integration:email"`. It assumes the row exists (`rows[0]!`).
  - `updateEmailConnection` merges secrets: a non-empty input replaces the saved value; empty or absent keeps it. Requires sender name and address; Resend requires a key; SMTP requires host, port, security, username and password. Re-encrypts all secrets, then writes UPDATE and the audit row `connection.email.updated` in a tx.
- **WhatsApp**:
  - `getWhatsAppConnection` decrypts the QR (AAD `"whatsapp:pairing-qr"`) only while unexpired. Counts: today's sent (IST), pending `send_whatsapp` actions (pending/due/executing/paused), and leads with a phone but no `phone_e164`.
  - `updateWhatsAppSettings` updates `enabled` and `daily_cap` (min/max delay **cannot** be changed through the API) and writes audit `connection.whatsapp.settings_updated`.
  - `commandWhatsApp` sets the desired state, increments `command_version`, clears the QR, and writes audit `connection.whatsapp.<cmd>`.
- **Google Calendar**:
  - `loadGoogleCalendarConnection` uses the workspace's own client (id, secret and redirect all present) if any, else the platform env client.
  - `startGoogleCalendarOAuth` stores a 24-byte hex state with a 10-minute expiry on the row and returns the auth URL.
  - `completeGoogleCalendarOAuth(code, state)` finds the workspace by `pending_oauth_state`. Expired or missing state returns an error result. It exchanges the code, encrypts the refresh token (AAD `"integration:google_calendar:refresh_token"`), and sets status connected, enabled true, email, and `last_synced_at`. It clears the state either way and writes audit `connected` or `connect_failed`, attributed to `row.updated_by`.
  - `markGoogleCalendarReauthRequired` sets status error, enabled false, and nulls the refresh token (only while status = connected).
  - `disconnectGoogleCalendar` clears the account and state but keeps the client credentials.
  - `updateGoogleCalendarCredentials` requires a secret unless one is saved, and keeps the existing refresh token.
- **Website leads**: `get` returns the owner id, name and `ownerAvailable`. `update` validates that the owner is an active salesperson (400), updates the workspace, and writes audit `workspace.default_lead_owner_changed`.
- **Workspaces**:
  - `createWorkspace` (one tx): name required; case-insensitive duplicate name gives 409; slugify plus a uniqueness suffix `-2`, `-3`, …; INSERT with `gen_random_uuid()`; seeds `integration_connections('email')`, `whatsapp_connection` and `google_calendar_connection` rows; audit `workspace.created`.
  - `renameWorkspace`: 404 or 409; name only, the slug is unchanged.
  - `listWorkspaces`: active only.
- **Admin users**:
  - `createSalesperson`: `auth.admin.createUser` (email lowercased, `email_confirm: true`, metadata full_name). An error gives 409 with the Supabase message. Then a tx UPDATEs the auto-created profile (name, email, initials, role salesperson, active) and writes audit `user.created`. If the tx fails it deletes the auth user (compensation).
  - `updateSalesperson`: the target must be a salesperson (404). Patches Auth (email, password, metadata, `ban_duration` "none" or "876000h") and then the profile in a tx, writing audits `user.profile_updated`, `user.password_reset`, and `user.reactivated` or `user.deactivated`. If the tx fails it reverts the Auth email and ban (a password change cannot be reverted).
- **Admin audit**: `recordAdminAudit` inserts `(actor.id, actor.email, action, targetType, targetId, metadata)`.

### 2.12 `dashboard.service.ts`, `notifications.service.ts`, `profiles.service.ts`, `whatsapp-inbound.service.ts`, `meeting-calendar-sync.service.ts`, `meetingScheduledNotification.service.ts`

- **Dashboard** (all ws-scoped):

  | Metric | Definition |
  |---|---|
  | activeLeads | lifecycle active |
  | tasksDueToday | open tasks with `due_at` in today's IST bounds |
  | overdueActions | open tasks with `due_at < now()` |
  | meetingsToday | status ≠ cancelled, scheduled today (IST) |
  | proposalFollowUps | status in (sent, revision_requested, revised) |
  | leadsWithNoNextAction | active leads with no open task |
  | automationFailures | runs with status failed |
  | funnel | Leads (all) / Called (distinct leads with calls) / Connected / Meetings (distinct leads with any meeting) / Proposals / Won |
  | todaysQueue | open tasks due before the end of today (IST), including overdue, limit 10 |

- **Notifications**: see 03-A §4.10. Only website ingest and inbound WhatsApp create them.
- **Profiles**: `listProfiles` (salespeople, including inactive). `getProfile` is **unused**.
- **Inbound WhatsApp, calendar sync, meeting notifications**: see 04.

---

## 3. Workflow engine

### 3.1 Versions, drafts, publish
- A workflow has at most one `draft` and one `published` version (partial unique indexes), plus any number of `previous` versions.
- Steps can only be inserted, updated or deleted while their version is a draft (DB trigger, plus service checks).
- Lifecycle: create (v1 draft) → edit steps (full replace) → publish (draft becomes published, the old published becomes previous) → "edit" means `createDraft` (vN+1, a copy of the published steps) → publish again.
- A workflow only enrolls leads when `workflows.status = 'active'` **and** a published version exists. New workflows start `paused`.

### 3.2 Enrollment

`enrollLeadInVersion(ws, lead, workflow, version, reason)` (`runs.service.ts:205-245`):
1. If the lead already has a run for this **workflow** in running, waiting or paused, it returns null (no duplicate).
2. INSERT `workflow_runs(status running)`.
3. `scheduleFirstStep`: the first enabled step by `step_order` gets a `scheduled_actions` row with `scheduled_for = now + delay_days × 24h` and `payload {templateId, config}`. The run status becomes `waiting` if the delay is > 0, else `running`, and `current_step_id` and `next_run_at` are set. If there are no enabled steps, the run stays `running` with no current step forever (a "harmless no-op").
4. TL "Workflow Enrolled" (Automation).
5. `activateAutomationForEnrollment`: if the lead's automation is not `active` and the lifecycle is not terminal, it sets automation `active`, writes TL "Automation Resumed", and calls `applyAutomationModeToRuns(active)`, which resumes the lead's paused runs. **This also flips leads in `long_term_nurture` to active automation.**
- The lead is **not** checked against the workspace or its lifecycle in this function.

`autoEnroll(ws, lead, trigger, reason)`: for every active workflow with a published version for that trigger in the ws, call `enrollLeadInVersion`. It quietly returns `[]` if there are none. Multiple matching workflows mean multiple runs.

`enrollLeadInWorkflow(ws, lead, workflowId, reason)`: the workflow must be in the ws (404), have status `active` (409) and have a published version (409). The trigger is irrelevant. Used by manual enrollment (`POST /runs` with `workflowId`).

Where enrollment happens:

| Caller | Trigger | Automatic? |
|---|---|---|
| `createLead` (`leads.service.ts:250`) | `lead_created` | **auto** |
| `importLeads` per created row (`:393`) | `lead_created` | **auto** |
| `scheduleMeeting` (`meetings.service.ts:149`) | `meeting_scheduled` | **auto** (after cancelling all of the lead's runs) |
| `recordMeetingOutcome` (`:317-319`) | `meeting_highly_interested`, `meeting_proposal_requested`, `objection_internal_approval`, `meeting_needs_more_information`, `meeting_not_ready`, `meeting_not_a_fit` | **auto** |
| `updateProposalStatus("sent")` (`proposals.service.ts:286-288`) | `proposal_pending` | **auto** (reached by `tryAdvanceToSent` after the first channel succeeds, or by a manual status change) |
| `logCall` | `call_not_connected`, `call_outcome_*`, `objection_*`, `meeting_agreed` | **not automatic**: the trigger is returned to the UI, and the rep chooses in `EnrollWorkflowDialog`, which calls `POST /runs {workflowId}` |
| `POST /runs` without `workflowId` | `manual_enrollment` | manual (no UI uses this variant) |
| `ingestWebsiteLead` | — | **never** |

### 3.3 `scheduled_actions` lifecycle

```
pending ──(worker claim: scheduled_for <= now)──▶ executing
executing ──success──▶ completed (executed_at)  → advanceRun
executing ──ineligible──▶ skipped (last_error=reason) → advanceRun   [or paused, if the run is paused]
executing ──provider deferred──▶ pending (scheduled_for = retryAt, last_attempt_at = null; attempt not consumed)
executing ──failure, retryable, attempt+1 < max_attempts(3)──▶ pending (scheduled_for = now + min(15·2^(n-1), 240) min)
executing ──failure, final──▶ failed (run → failed, last_error)
executing stuck > 15 min (last_attempt_at) ──▶ re-claimed by the next tick
pending/due/paused ──run paused──▶ paused ;  paused ──run resumed──▶ pending (scheduled_for unchanged)
pending/due/paused ──run cancelled / lifecycle terminal / stop_workflow / inbound reply──▶ cancelled
failed ──retryRun──▶ pending (attempt_count 0, last_error null); run → waiting
```

The `due` status exists but is never written.

### 3.4 Run state changes

| Operation | Allowed from | Effect |
|---|---|---|
| `pauseRun` | running, waiting (else 409) | run paused; actions pending/due/paused become paused; TL "Workflow Paused" |
| `resumeRun` | paused (else 409) | run becomes `waiting` if `next_run_at` is in the future, else `running`; paused actions become pending; TL "Workflow Resumed". Lead automation and lifecycle are not checked. |
| `cancelRun` | any non-terminal (completed or cancelled are returned unchanged) | run cancelled with `cancelled_at` and reason; actions pending/due/paused become cancelled; TL "Workflow Cancelled" |
| `retryRun` | failed (else 409) | run `waiting`, `last_error` null; failed actions become pending with attempt 0; TL "Workflow Retried" |
| `applyAutomationModeToRuns(lead, mode)` | — | `paused`: pause running/waiting runs. `active`: resume paused runs. `manual` or `stopped`: **cancel** all non-terminal runs. |
| `cancelRunsForLead` | — | cancel every run not completed or cancelled (used by `scheduleMeeting`) |
| Lifecycle trigger | lead becomes terminal | runs and actions cancelled in SQL (no timeline entries) |
| Inbound WhatsApp reply | — | lead automation becomes `manual`; runs cancelled; actions pending/due/paused/**executing** cancelled (direct SQL) |

### 3.5 How steps advance (`automation.service.ts`)

- `advanceRun(run)`:
  - Finds the step after `current_step_id`'s `step_order` (the next **enabled** step in the **same version**).
  - If one is found: inserts its scheduled action with `scheduled_for = now + delay_days` (so **delays are relative to when the previous step executed**, not to enrollment). Sets the run to waiting or running with `current_step_id` and `next_run_at`. TL "Workflow Advanced".
  - Otherwise: run completed (`current_step_id` null, `completed_at`). TL "Workflow Completed".
- `executeInternalAction(actionId)` for create_call_task, create_follow_up_task, change_lead_stage, stop_workflow:
  - The action must be `executing` (409).
  - If the lead is not `active` or the run is not running/waiting, it calls `skipAction` and returns `skipped`.
  - `config` = `payload.config`, trimmed.
  - `create_call_task` / `create_follow_up_task`: `createTask(type call or follow_up, title = config or "Follow-up call"/"Follow-up task", due now, origin automation, source run and step, owner = lead owner and name)`.
  - `change_lead_stage`: config required (400); valid stage; lead editable; direct `UPDATE leads set pipeline_stage`; TL "Stage changed to X" (Automation). No `objection_type` handling.
  - `stop_workflow`: run completed; remaining pending/due/paused actions cancelled; TL "Workflow Stopped".
  - Then the action is marked completed, and `advanceRun` runs unless the step was `stop_workflow` or the run is terminal.
- `recordActionResult(actionId, {outcome, …})` for send_email and send_whatsapp:
  - `deferred`: `deferAction(retryAt ?? now + 60 s)`.
  - `success`: action completed; TL "Email Sent" / "WhatsApp Sent" (kind email or whatsapp, detail "Provider message id: …"); advance the run if it is still non-terminal.
  - `failure`: attempt + 1. If retryable and under `max_attempts`: back to pending with backoff, TL "Automation Step Failed - Retry Scheduled". Else: action failed, run failed, TL "Workflow Failed".
- `skipAction(actionId, reason)`: if the run is paused, the action becomes `paused` (TL "Automation Step Paused"). Otherwise the action becomes `skipped` (TL "Automation Step Skipped") and the run advances if it is running or waiting.
- Eligibility (`computeEligibility`, evaluated **at claim time**):
  - run status running/waiting
  - lead lifecycle **`active`** (so `long_term_nurture` leads are ineligible)
  - automation mode `active`
  - email: lead has an email; email contactability is not permanent_bounce, unsubscribed or invalid; a template resolved and active
  - WhatsApp: lead has `phone_e164`; WhatsApp contactability is not invalid, opted_out or do_not_contact; a template resolved and active
  - The template id comes from `payload.templateId`, else the step's `template_id`. It is not workspace-scoped (it was validated when saved).
  - Template channel vs action is **not** checked.
- There is **no debounce** in the backend engine. The only "debounce" is the frontend builder's 500 ms autosave queue (see 05). Delays are whole days (`delay_days` integers); a delay of 0 means due immediately, i.e. the next worker tick.
