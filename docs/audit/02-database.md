# 02 — Database (Supabase Postgres)

Source of truth: `Supabase/migrations/001…018`. Apply them in filename order. Every statement was read. Comment-only lines are not reproduced here.

---

## 1. Migrations in order

| # | File | What it does |
|---|---|---|
| 001 | `001_initial_migration.sql` (1709 lines) | Creates `pgcrypto`, the trigger fn `set_updated_at()`, and all original enums. Creates tables `profiles`, `leads`, `lead_notes`, `lead_contact_channels`, `calls`, `tasks`, `meetings`, `proposals`, `message_templates`, `workflows`, `workflow_versions`, `workflow_steps`, `workflow_runs`, `scheduled_actions`, `timeline_events`, `dnc_events`, `notifications`. Creates fns `handle_new_user()` (trigger `on_auth_user_created` on `auth.users`), `is_active_salesperson()`, `enforce_workflow_steps_draft_only()`, `enforce_lead_terminal_automation()`, `cascade_lead_lifecycle_change()` (AFTER trigger). Creates views `lead_next_actions`, `active_leads_missing_next_action`, `overdue_tasks`, `tasks_due_today`. Enables RLS on every table, with policies gated on `is_active_salesperson()`. Adds deferred FKs `tasks.source_workflow_run_id/step_id`. |
| 002 | `002_fix_bugs_and_constraints.sql` | Replaces `cascade_lead_lifecycle_change()`: now also sets `new.dnc_reason := null` when leaving DNC, and the trigger is re-created as **BEFORE INSERT OR UPDATE**. Adds checks `workflow_runs_failed_has_error`, `scheduled_actions_failed_has_error`. Adds indexes `workflow_steps_template_id_idx`, `tasks_source_workflow_step_id_idx`, `timeline_events_related_{task,meeting,proposal,call}_id_idx`, `notifications_lead_id_idx`. |
| 003 | `003_admin_integrations_baileys.sql` | Adds `profiles.role text default 'salesperson'` with check `(admin, salesperson)` and index `profiles_role_active_idx`. Drops `profiles_select_authenticated`. Redefines `is_active_salesperson()` to also require `role='salesperson'`, and adds the policy `profiles_select_active_salesperson`. Adds `leads.phone_e164` with check `^[+][1-9][0-9]{7,14}$`, backfills it (Indian 10-digit, 91-prefixed, `+`-prefixed), and adds index `leads_phone_e164_idx`. Creates `integration_connections` (single row `'email'`), `admin_audit_events` (append-only trigger), `whatsapp_connection` (singleton `id boolean`), `whatsapp_auth_credentials` (singleton), `whatsapp_auth_keys`, `whatsapp_outbound_messages`, `whatsapp_inbound_events`. Enables RLS on all of these with **no policies**. |
| 004 | `004_template_attachments.sql` | Drops `message_templates.attachment_reference`. Creates the private storage bucket `template-attachments` and the table `template_attachments` (RLS select/insert/delete). |
| 005 | `005_proposal_send.sql` | Adds proposal document metadata columns, `email_template_id`/`whatsapp_template_id` FKs, email/WhatsApp send-status columns (with checks), and the queue index. Creates the private bucket `proposal-documents`. `whatsapp_outbound_messages.scheduled_action_id` becomes nullable, it gains `proposal_id` (unique, FK cascade), and gets the check "exactly one source". |
| 006 | `006_google_calendar_meeting_sync.sql` | Creates `google_calendar_connection` (singleton, RLS without policies). Adds meeting calendar columns (`calendar_event_id`, `meet_link`, `calendar_sync_status`, `calendar_sync_error`). Creates `meeting_participants`. Adds `message_templates.is_default_meeting_scheduled_{email,whatsapp}` with **global** partial unique indexes. Adds meeting notify columns and the queue index. Adds `whatsapp_outbound_messages.meeting_id`, and the exactly-one-source check now covers 3 sources. |
| 007 | `007_lead_hard_delete.sql` | Adds the policy `leads_delete_active_salesperson`. Creates `deleted_leads_audit` (no FK to leads). |
| 008 | `008_meeting_outcome_won.sql` | `meeting_outcome += 'won'`. |
| 009 | `009_lead_created_trigger.sql` | `workflow_trigger += 'lead_created'`. |
| 010 | `010_status_enums.sql` | `call_connected_outcome += interested_later, future_possibility, commission_only, internal_hiring, existing_team, budget_price, internal_approval, wrong_fit`. `pipeline_stage += connected_qualifying, interested_later, future_possibility, objection_nurture, negotiation`. `meeting_outcome += highly_interested, needs_internal_discussion, needs_more_information`. `workflow_trigger += call_outcome_interested_later, call_outcome_future_possibility, call_outcome_information_requested, objection_commission_only, objection_internal_hiring, objection_existing_team, objection_budget_price, objection_internal_approval, meeting_needs_more_information, meeting_not_ready`. |
| 011 | `011_objection_and_loss_types.sql` | Creates enums `objection_type` and `lead_loss_reason`. |
| 012 | `012_lead_fields.sql` | Adds `leads.objection_type`, `interested_later_reason`, `interested_later_restart_at (date)`, `interested_later_next_action`, `interested_later_decision_owner`, `loss_reason`, `loss_notes`. Adds checks `leads_lost_has_reason` and `leads_objection_stage_has_type`, plus 3 partial indexes. |
| 013 | `013_proposal_loss_fields.sql` | Adds `proposals.loss_reason`, `loss_notes`, check `proposals_loss_has_reason` (rejected/expired need a reason), and an index. |
| 014 | `014_meeting_agreed_call_outcome.sql` | `call_connected_outcome += 'meeting_agreed'`, `workflow_trigger += 'meeting_agreed'`. |
| 015 | `015_workspaces.sql` | Creates `workspaces` (id **without default**, name, slug, is_active; unique name and slug; RLS select/insert/update) and seeds `00000000-0000-0000-0000-000000000001 'MOTM'/'motm'`. Adds `workspace_id` (FK, backfilled to MOTM) to `leads`, `calls`, `tasks`, `meetings`, `proposals`, `workflows`, `workflow_runs`, `scheduled_actions`, `message_templates`, `whatsapp_outbound_messages`, `whatsapp_inbound_events` (all `NOT NULL`), and to `notifications` and `deleted_leads_audit` (**nullable**), with an index on each. Re-keys `integration_connections` to PK `(workspace_id, id)`. `whatsapp_connection`, `whatsapp_auth_credentials` and `google_calendar_connection` drop their boolean `id` and become PK `(workspace_id)`. `whatsapp_auth_keys` becomes PK `(workspace_id, key_type, key_id)`. Written idempotently (`if not exists`, `do $$` guards). Does **not** recreate the views, does **not** scope the default-meeting-template unique indexes, and does not add workspace_id to child tables. |
| 016 | `016_meeting_outcome_triggers.sql` | `workflow_trigger += meeting_highly_interested, meeting_proposal_requested, meeting_not_a_fit`. |
| 017 | `017_meeting_scheduled_trigger.sql` | `workflow_trigger += meeting_scheduled`. |
| 018 | `018_workspace_default_lead_owner.sql` | `workspaces.default_lead_owner_id uuid references profiles on delete set null` (nullable). |

---

## 2. Enums: final value lists

Values marked **R** are retired: they still exist in Postgres but are never produced by application code and are absent from `Backend/src/domain/enums.ts` and `Frontend/src/types`. Values marked **(never written)** exist in both code and DB but no backend code path writes them (UI or manual only, or not at all).

| Enum | Values in Postgres order |
|---|---|
| `lead_source` | linkedin, email, website, cold_call, referral, event, inbound_form, other |
| `pipeline_stage` | new, ready_for_first_call *(never written)*, contact_attempted *(never written)*, not_connected_nurture, **maybe_nurture R**, **negative_nurture R**, meeting_scheduling, meeting_scheduled, meeting_follow_up, proposal_preparation, proposal_sent *(never written by backend; manual override only)*, proposal_decision_pending, connected_qualifying, interested_later, future_possibility, objection_nurture, negotiation *(manual override only, by design: `enums.ts:15-17`)* |
| `lead_lifecycle_state` | active, long_term_nurture, won, lost, discarded, do_not_contact, merged |
| `automation_mode` | active, paused, manual, stopped |
| `response_state` | no_response, responded, conversation_active, waiting_on_customer, waiting_on_us (only `responded` is written automatically, by inbound WhatsApp; the rest are manual) |
| `contact_channel` | phone, email, whatsapp |
| `call_not_connected_reason` | no_answer, busy, call_rejected, switched_off, temporarily_unreachable, voicemail, network_failure, invalid_number, wrong_number, other |
| `call_connected_outcome` | positive, **maybe R**, **negative R**, callback_requested, information_requested, wrong_person, do_not_contact, interested_later, future_possibility, commission_only, internal_hiring, existing_team, budget_price, internal_approval, wrong_fit, meeting_agreed |
| `task_type` | call, follow_up, send_information, send_case_study, send_email, send_whatsapp, schedule_meeting, confirm_meeting, reschedule, prepare_proposal, send_proposal, proposal_follow_up, nurture, re_engage, internal_review, general_task |
| `task_status` | open, completed, cancelled |
| `task_origin` | manual, automation |
| `meeting_status` | tentative *(never written; booking uses `scheduled`)*, scheduled, confirmed, rescheduled, completed, cancelled, no_show, failed |
| `meeting_outcome` | proposal_required, follow_up_required, second_meeting, not_interested, no_proposal_required, won, highly_interested, needs_internal_discussion, needs_more_information |
| `proposal_status` | draft, uploaded, ready_to_send, sent, revision_requested, revised, accepted, rejected, withdrawn, expired |
| `workflow_trigger` | call_not_connected, **call_outcome_maybe R**, **call_outcome_negative R**, proposal_pending, manual_enrollment, lead_created, call_outcome_interested_later, call_outcome_future_possibility, call_outcome_information_requested, objection_commission_only, objection_internal_hiring, objection_existing_team, objection_budget_price, objection_internal_approval, meeting_needs_more_information, meeting_not_ready, meeting_agreed, meeting_highly_interested, meeting_proposal_requested, meeting_not_a_fit, meeting_scheduled |
| `workflow_status` | active, paused |
| `workflow_version_status` | draft, published, previous |
| `workflow_step_action` | send_email, send_whatsapp, create_call_task, create_follow_up_task, change_lead_stage, stop_workflow |
| `workflow_run_status` | running, waiting, paused, completed, failed, cancelled |
| `scheduled_action_status` | pending, due *(read by the claim query, never written)*, executing, completed, failed, cancelled, paused, skipped |
| `template_channel` | email, whatsapp |
| `notification_kind` | info, warning, success, danger (only `info` and `warning` are ever written) |
| `objection_type` | commission_only, internal_hiring, existing_team, budget_price, internal_approval, wrong_fit |
| `lead_loss_reason` | price_budget, internal_hiring, project_postponed, competitor_selected, management_rejected, no_urgency, no_response, other |

Text "enums" enforced by CHECK constraints:

| Column | Allowed values |
|---|---|
| `profiles.role` | admin, salesperson |
| `lead_contact_channels.status` | phone: valid, reachable, temporarily_unreachable, invalid, wrong_number, do_not_contact. email: valid, delivered, temporary_bounce, permanent_bounce, unsubscribed, invalid. whatsapp: valid, reachable, temporarily_unreachable, invalid, opted_out, do_not_contact |
| `timeline_events.actor_source` | manual, automation, system |
| `dnc_events.action` | suppressed, reactivated |
| `integration_connections.id` | email |
| `integration_connections.provider` | NULL, resend, smtp |
| `whatsapp_connection.desired_state` | connected, disconnected, restart |
| `whatsapp_connection.status` | disconnected, connecting, qr_ready, connected, reconnecting, reauth_required, error |
| `whatsapp_outbound_messages.status` | prepared, sent, failed |
| `whatsapp_inbound_events.disposition` | matched, ambiguous, unmatched, ignored (`ignored` is never written) |
| `google_calendar_connection.status` | disconnected, connected, error |
| `meetings.calendar_sync_status` | not_applicable, pending (never written), synced, failed |
| `meetings.notify_email_status`, `proposals.email_send_status` | not_applicable, pending, skipped, sent, failed |
| `meetings.notify_whatsapp_status`, `proposals.whatsapp_send_status` | not_applicable, skipped, queued, sending, sent, failed |

---

## 3. Final schema, table by table

Conventions:
- `NN` = NOT NULL.
- `ts` = timestamptz.
- "upd trg" = `BEFORE UPDATE … set_updated_at()`.
- "RLS(s/i/u/d)" = policies for authenticated users, each `using/with check (is_active_salesperson())` unless stated otherwise.
- Every `created_at`/`updated_at` column is `ts NN default now()`.
- Every `id uuid` primary key defaults to `gen_random_uuid()` unless stated otherwise.

### `workspaces` (015, 018)
| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| id | uuid PK | NN | **none** (the app supplies `gen_random_uuid()`) | |
| name | text | NN | | check not blank; `unique` (case-sensitive; the app also checks `lower(name)`) |
| slug | text | NN | | check not blank; `unique` |
| is_active | bool | NN | true | No API deactivates a workspace. |
| default_lead_owner_id | uuid | null | | FK → profiles ON DELETE SET NULL |
| created_at, updated_at | ts | NN | now() | upd trg `workspaces_set_updated_at` |

RLS(s/i/u). Seed row: MOTM.

### `profiles` (001, 003)
| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| id | uuid PK | NN | | FK → auth.users ON DELETE CASCADE |
| full_name | text | NN | | check not blank |
| email | text | NN | | |
| initials | text | NN | | check not blank |
| is_active | bool | NN | true | |
| role | text | NN | 'salesperson' | check (admin, salesperson) |
| created_at, updated_at | ts | NN | | upd trg |

Index: `profiles_role_active_idx (role, is_active)`. RLS: select only, salesperson-only after 003 (`profiles_select_active_salesperson`). Rows are created by trigger `on_auth_user_created` → `handle_new_user()`.

### `leads` (001, 003, 012, 015)
| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| id | uuid PK | NN | gen_random_uuid() | |
| workspace_id | uuid | NN | | FK → workspaces (no ON DELETE action) |
| first_name | text | NN | | check not blank |
| last_name | text | NN | '' | |
| company | text | NN | | check not blank |
| job_title, industry | text | null | | |
| email | text | null | | stored lowercase by the app |
| phone | text | null | | as entered |
| phone_e164 | text | null | | check `^[+][1-9][0-9]{7,14}$` |
| source | lead_source | NN | | |
| service_interest | text | null | | |
| owner_id | uuid | null | | FK → profiles SET NULL |
| pipeline_stage | pipeline_stage | NN | 'new' | |
| lifecycle_state | lead_lifecycle_state | NN | 'active' | |
| automation_mode | automation_mode | NN | **'manual'** | |
| response_state | response_state | NN | 'no_response' | |
| dnc_reason | text | null | | |
| dnc_by | uuid | null | | FK → profiles SET NULL |
| dnc_by_name | text | null | | |
| dnc_at | ts | null | | |
| objection_type | objection_type | null | | |
| interested_later_reason | text | null | | |
| interested_later_restart_at | **date** | null | | |
| interested_later_next_action, interested_later_decision_owner | text | null | | |
| loss_reason | lead_loss_reason | null | | |
| loss_notes | text | null | | |
| merged_into_lead_id | uuid | null | | FK → leads SET NULL |
| last_activity_at | ts | NN | now() | |
| created_by | uuid | null | | FK → profiles SET NULL |
| created_by_name | text | null | | |
| created_at, updated_at | ts | NN | now() | |

Checks:
- `leads_first_name_not_blank`, `leads_company_not_blank`
- `leads_has_contact_channel`: email or phone is non-blank
- `leads_merge_target_not_self`
- `leads_merged_has_target`: merged ⇒ target not null
- `leads_dnc_has_reason`: DNC ⇒ dnc_reason not null
- `leads_phone_e164_valid`
- `leads_lost_has_reason`: lost ⇒ loss_reason
- `leads_objection_stage_has_type`: stage objection_nurture ⇒ objection_type not null

Indexes: `owner_id`, `pipeline_stage`, `lifecycle_state`, `automation_mode`, `created_at desc`, `lower(email)` partial, `phone` partial, `merged_into_lead_id` partial, `phone_e164` partial, `objection_type` partial, `loss_reason` partial, `interested_later_restart_at` partial, `workspace_id`. **No unique index on email or phone** (dedupe is done in app code).

Triggers (all BEFORE; Postgres fires them alphabetically):
1. `leads_cascade_lifecycle_change` (BEFORE INSERT OR UPDATE): see §4.
2. `leads_enforce_terminal_automation` (BEFORE INSERT OR UPDATE).
3. `leads_set_updated_at` (BEFORE UPDATE).

RLS(s/i/u/d).

### `lead_notes` (001)
`id`, `lead_id uuid NN` FK → leads CASCADE, `author_id` FK profiles SET NULL, `author_name text NN`, `body text NN` (check not blank), `created_at`. Index `(lead_id, created_at desc)`. RLS(s/i). No `workspace_id` (scoped through the lead).

### `lead_contact_channels` (001)
`id`, `lead_id NN` FK CASCADE, `channel contact_channel NN`, `status text NN`, `reason text`, `updated_at ts NN default now()`, `updated_by` FK SET NULL, `updated_by_name text`. `unique (lead_id, channel)`; check `lead_contact_channels_valid_status` (per-channel lists in §2). Index `lead_id`. RLS(s/i/u). No `updated_at` trigger (the app sets it).

### `calls` (001, 015)
`id`, `workspace_id NN` FK, `lead_id NN` FK CASCADE, `salesperson_id` FK SET NULL, `salesperson_name text NN`, `connected bool NN`, `not_connected_reason`, `connected_outcome`, `notes`, `callback_due_at ts`, `created_at`.
Checks:
- `calls_outcome_matches_connection`: exactly one of reason or outcome, consistent with `connected`.
- `calls_callback_due_requires_outcome`: `callback_due_at` only allowed with `callback_requested`.

Indexes `(lead_id, created_at desc)`, `salesperson_id`, `callback_due_at` partial, `workspace_id`. RLS(s/i).

### `tasks` (001, 002, 015)
| Column | Type | Null | Default |
|---|---|---|---|
| id | uuid PK | NN | |
| workspace_id | uuid | NN | FK |
| lead_id | uuid | NN | FK CASCADE |
| owner_id | uuid | null | FK SET NULL |
| owner_name | text | null | (denormalised; mostly never populated, see 07) |
| task_type | task_type | NN | |
| title | text | NN | check not blank |
| due_at | ts | NN | |
| status | task_status | NN | 'open' |
| origin | task_origin | NN | 'manual' |
| created_by / created_by_name | uuid / text | null | |
| source_workflow_run_id | uuid | null | FK → workflow_runs SET NULL |
| source_workflow_step_id | uuid | null | FK → workflow_steps SET NULL |
| completed_at, cancelled_at | ts | null | |
| cancel_reason | text | null | |
| created_at, updated_at | ts | NN | |

Checks: completed_at ⇔ status completed; cancelled_at ⇔ status cancelled; origin automation ⇒ `source_workflow_run_id` not null. Indexes `lead_id`, `due_at` where open, `(owner_id, due_at)` where open, `source_workflow_run_id` partial, `source_workflow_step_id` partial, `workspace_id`. upd trg. RLS(s/i/u).

### `meetings` (001, 006, 015)
Base columns: `id`, `workspace_id NN`, `lead_id NN` FK CASCADE, `owner_id` FK SET NULL, `owner_name`, `title NN`, `scheduled_at ts NN`, `duration_minutes int NN default 30`, `meeting_url`, `status meeting_status NN default 'tentative'`, `outcome meeting_outcome`, `notes`, `created_by`, `created_by_name`, `created_at`, `updated_at`.
Calendar columns: `calendar_event_id`, `meet_link`, `calendar_sync_status text NN default 'not_applicable'`, `calendar_sync_error`.
Notify columns: `notify_email_status text NN default 'not_applicable'`, `notify_email_sent_at`, `notify_email_error`, `notify_whatsapp_status text NN default 'not_applicable'`, `notify_whatsapp_sent_at`, `notify_whatsapp_error`, `notify_whatsapp_next_attempt_at`, `notify_whatsapp_attempt_count int NN default 0`.
Checks: title not blank; duration > 0; **`meetings_outcome_requires_completed`** (outcome ⇒ status completed); the three status-list checks.
Indexes `(lead_id, scheduled_at desc)`, `(owner_id, scheduled_at)`, `notify_whatsapp_next_attempt_at` where queued, `workspace_id`. upd trg. RLS(s/i/u).

### `meeting_participants` (006)
`id`, `meeting_id NN` FK CASCADE, `name`, `email NN` (check regex `^[^@\s]+@[^@\s]+\.[^@\s]+$`), `created_at`. Index `meeting_id`. RLS(s/i/d).

### `proposals` (001, 005, 013, 015)
Base columns: `id`, `workspace_id NN`, `lead_id NN` FK CASCADE, `owner_id` FK SET NULL, `owner_name` (**never written by the app**), `title NN`, `document_reference text`, `amount numeric(14,2)`, `currency text NN default 'INR'`, `status proposal_status NN default 'draft'`, `sent_at`, `follow_up_at`, `next_action` (never written), `notes`, `created_by`, `created_by_name`, `created_at`, `updated_at`.
005 document columns: `document_storage_path`, `document_file_name`, `document_mime_type`, `document_size_bytes int`, `email_template_id` FK → message_templates SET NULL, `whatsapp_template_id` FK SET NULL.
005 send columns: `email_send_status text NN default 'not_applicable'`, `email_sent_at`, `email_send_error`, `whatsapp_send_status text NN default 'not_applicable'`, `whatsapp_sent_at`, `whatsapp_send_error`, `whatsapp_next_attempt_at`, `whatsapp_attempt_count int NN default 0`.
013: `loss_reason lead_loss_reason`, `loss_notes`.
Checks: title not blank; amount ≥ 0; `sent_at` only with status in (sent, revision_requested, revised, accepted, rejected, withdrawn, expired); send-status lists; `proposals_loss_has_reason` (rejected/expired ⇒ loss_reason).
Indexes `(lead_id, updated_at desc)`, `(owner_id, status)`, `follow_up_at` partial, `whatsapp_next_attempt_at` where queued, `loss_reason` partial, `workspace_id`. upd trg. RLS(s/i/u).

### `message_templates` (001, 004, 006, 015)
`id`, `workspace_id NN`, `name NN` (check not blank; **no uniqueness**), `channel template_channel NN`, `subject` (check: WhatsApp ⇒ subject null), `body NN` (check not blank), `is_active bool NN default true`, `is_default_meeting_scheduled_email bool NN default false`, `is_default_meeting_scheduled_whatsapp bool NN default false`, `created_by`, `created_by_name`, `created_at`, `updated_at`.
Indexes `(channel, is_active)`, `workspace_id`. **Global** partial unique `message_templates_one_default_meeting_email (is_default_meeting_scheduled_email) where …` and `…_whatsapp`. These allow at most one default per channel **across all workspaces**. upd trg. RLS(s/i/u).

### `template_attachments` (004)
`id`, `template_id NN` FK CASCADE, `file_name NN` (not blank), `storage_path NN unique`, `mime_type NN`, `size_bytes int NN` (> 0), `created_at`. Index `template_id`. RLS(s/i/d).

### `workflows` (001, 015)
`id`, `workspace_id NN`, `name NN` (not blank), `description`, `trigger workflow_trigger NN`, `status workflow_status NN default 'paused'`, `owner_id` FK SET NULL, `created_by`, `created_by_name`, `created_at`, `updated_at`. Indexes `(trigger, status)`, `workspace_id`. upd trg. RLS(s/i/u).

### `workflow_versions` (001)
`id`, `workflow_id NN` FK CASCADE, `version_number int NN` (> 0), `status workflow_version_status NN default 'draft'`, `created_by`, `created_by_name`, `created_at`, `published_at`.
Constraints: `unique (workflow_id, version_number)`; check draft ⇔ `published_at` null.
Partial unique indexes: **one draft per workflow**, **one published per workflow**. Index `workflow_id`. RLS(s/i/u). No `workspace_id`.

### `workflow_steps` (001, 002)
`id`, `workflow_version_id NN` FK CASCADE, `step_order int NN` (≥ 0), `delay_days int NN default 0` (≥ 0), `action workflow_step_action NN`, `template_id` FK → message_templates SET NULL, `config text`, `is_enabled bool NN default true`.
Constraints: `unique (workflow_version_id, step_order)`; check `template_id` only on send_email/send_whatsapp.
Indexes `(workflow_version_id, step_order)`, `template_id` partial.
Trigger `workflow_steps_draft_only_edit` BEFORE INSERT/UPDATE/DELETE → `enforce_workflow_steps_draft_only()`. RLS(s/i/u/d).

### `workflow_runs` (001, 002, 015)
`id`, `workspace_id NN`, `workflow_id NN` FK **RESTRICT**, `workflow_version_id NN` FK **RESTRICT**, `lead_id NN` FK CASCADE, `current_step_id` FK → workflow_steps SET NULL, `status workflow_run_status NN default 'running'`, `started_at ts NN default now()`, `next_run_at`, `completed_at`, `cancelled_at`, `cancel_reason`, `last_error`, `created_by`, `created_by_name` (never written), `created_at`, `updated_at`.
Checks: completed_at ⇔ completed; cancelled_at ⇔ cancelled; failed ⇒ `last_error` not null.
Indexes `lead_id`, `workflow_id`, `(status, next_run_at)` where running/waiting, `workspace_id`. upd trg. RLS(s/i/u).

### `scheduled_actions` (001, 002, 015)
`id`, `workspace_id NN`, `lead_id NN` FK CASCADE, `workflow_run_id NN` FK CASCADE, `workflow_step_id NN` FK **RESTRICT**, `action_type workflow_step_action NN`, `scheduled_for ts NN`, `status scheduled_action_status NN default 'pending'`, `payload jsonb NN default '{}'` (the app stores `{templateId, config}`), `attempt_count int NN default 0`, `max_attempts int NN default 3`, `last_attempt_at`, `last_error`, `executed_at`, `cancelled_at`, `cancel_reason`, `created_at`, `updated_at`.
Constraints: `unique (workflow_run_id, workflow_step_id)` (each step runs at most once per run); attempt ≥ 0; max > 0; executed_at ⇔ completed; cancelled_at ⇔ cancelled; failed ⇒ `last_error`.
Indexes `scheduled_for` where pending/due, `lead_id`, `workflow_run_id`, `workspace_id`. upd trg. RLS(s/i/u).

### `timeline_events` (001, 002)
`id`, `lead_id NN` FK CASCADE, `occurred_at ts NN default now()`, `event_kind text NN` (not blank; free text), `title NN` (not blank), `detail`, `actor_id` FK SET NULL, `actor_name text NN`, `actor_source text NN` (check manual/automation/system), `related_task_id`/`related_meeting_id`/`related_proposal_id`/`related_call_id`/`related_workflow_run_id` (all FK SET NULL), `metadata jsonb`, `created_at`.
Indexes `(lead_id, occurred_at desc)`, `actor_id` partial, related task/meeting/proposal/call partial (no index on `related_workflow_run_id`). RLS(s/i). Append-only by convention.

Values of `event_kind` used by the app: system, stage, task, call, note, automation, meeting, proposal, email, whatsapp.

### `dnc_events` (001)
`id`, `lead_id NN` FK CASCADE, `action text NN` (suppressed/reactivated), `reason`, `actor_id` FK SET NULL, `actor_name`, `created_at`. Index `(lead_id, created_at desc)`. RLS(s). Written **only** by the lifecycle trigger.

### `notifications` (001, 002, 015)
`id`, `workspace_id` (**nullable**) FK, `recipient_id NN` FK → profiles CASCADE, `title NN`, `detail`, `kind notification_kind NN default 'info'`, `lead_id` FK → leads CASCADE, `href`, `read bool NN default false`, `created_at`.
Indexes `(recipient_id, read, created_at desc)`, `lead_id` partial, `workspace_id` partial.
RLS:
- select: `recipient_id = auth.uid() and is_active_salesperson()`
- insert: active salesperson
- update: `using` own and active, `with check` own.

### `integration_connections` (003, 015)
PK `(workspace_id, id)`. Columns: `id text` (check `in ('email')`), `workspace_id NN` FK, `provider text` (check NULL/resend/smtp), `enabled bool NN default false`, `settings jsonb NN default '{}'` (`senderName`, `senderAddress`, `smtpHost`, `smtpPort`, `smtpSecurity`), `secret_ciphertext/iv/tag bytea` (all-or-none check), `key_version int NN default 1`, `updated_by` FK SET NULL, `created_at`, `updated_at`. upd trg. RLS on, **no policies**.

### `admin_audit_events` (003)
`id`, `actor_id` FK SET NULL, `actor_email text NN`, `action text NN` (not blank), `target_type text NN` (not blank), `target_id text`, `metadata jsonb`, `created_at`. Index `created_at desc`. Trigger `admin_audit_events_immutable` BEFORE UPDATE/DELETE raises "admin_audit_events is append-only". RLS on, no policies. No `workspace_id`. Workspace-scoped actions put the workspace id in `target_id`.

### `whatsapp_connection` (003, 015)
PK `workspace_id` (FK).
| Column | Type | Null | Default |
|---|---|---|---|
| enabled | bool | NN | false (the emergency outbound switch) |
| desired_state | text | NN | 'disconnected' |
| status | text | NN | 'disconnected' |
| command_version | bigint | NN | 0 |
| connected_jid, connected_phone, display_name | text | null | |
| qr_ciphertext, qr_iv, qr_tag | bytea | null | (all-or-none, together with `qr_expires_at`) |
| qr_key_version | int | NN | 1 |
| qr_expires_at | ts | null | |
| last_error | text | null | |
| reachout_lock, new_chat_cap | jsonb | null | |
| worker_heartbeat_at, last_connected_at, last_disconnected_at | ts | null | |
| daily_cap | int | NN | 200 (1–10000) |
| min_delay_seconds | int | NN | 5 (1–300) |
| max_delay_seconds | int | NN | 15 (≥ min, ≤ 600) |
| updated_by | uuid | null | FK |
| created_at, updated_at | ts | NN | |

upd trg. RLS on, no policies.

### `whatsapp_auth_credentials` (003, 015)
PK `workspace_id`. `ciphertext`, `iv`, `tag bytea NN`, `key_version int NN default 1`, `updated_at ts NN default now()`. RLS on, no policies.

### `whatsapp_auth_keys` (003, 015)
PK `(workspace_id, key_type, key_id)`. `ciphertext`, `iv`, `tag NN`, `key_version`, `updated_at`. RLS on, no policies.

### `whatsapp_outbound_messages` (003, 005, 006, 015)
Columns:
- `id`
- `workspace_id NN`
- `scheduled_action_id uuid` (unique, FK CASCADE, nullable)
- `proposal_id uuid` (unique, FK CASCADE)
- `meeting_id uuid` (unique, FK CASCADE)
- `message_id text NN unique` (global)
- `remote_jid text NN`
- `payload_ciphertext/iv/tag bytea` (all-or-none)
- `key_version`
- `status text NN default 'prepared'` (prepared/sent/failed)
- `last_error`
- `prepared_at ts NN default now()`
- `sent_at`
- `updated_at ts NN default now()` (no trigger; the app sets it)

Check `whatsapp_outbound_exactly_one_source`: exactly one of the three source columns is set. Indexes `sent_at desc`, `workspace_id`. RLS on, no policies.

### `whatsapp_inbound_events` (003, 015)
PK `message_id text` (**global**, not per workspace). Columns: `workspace_id NN`, `sender_jid NN`, `sender_phone_e164`, `message_type text NN`, `received_at ts NN`, `match_count int NN default 0` (≥ 0), `disposition text NN`, `created_at`. Indexes `received_at desc`, `workspace_id`. RLS on, no policies. **No message body column** (metadata only).

### `google_calendar_connection` (006, 015)
PK `workspace_id`.
| Column | Type | Null | Default |
|---|---|---|---|
| enabled | bool | NN | false |
| status | text | NN | 'disconnected' (disconnected/connected/error) |
| client_id, redirect_uri | text | null | |
| client_secret_ciphertext/iv/tag | bytea | null | (all-or-none) |
| client_secret_key_version | int | NN | 1 |
| connected_email | text | null | |
| connected_calendar_id | text | NN | 'primary' |
| refresh_token_ciphertext/iv/tag | bytea | null | (all-or-none) |
| refresh_token_key_version | int | NN | 1 |
| pending_oauth_state | text | null | |
| pending_oauth_state_expires_at | ts | null | |
| last_error | text | null | |
| last_synced_at | ts | null | |
| updated_by | uuid | null | FK |
| created_at, updated_at | ts | NN | |

upd trg. RLS on, no policies.

### `deleted_leads_audit` (007, 015)
`id`, `workspace_id` (nullable FK), `lead_id uuid NN` (**no FK**, so it survives the cascade), `snapshot jsonb NN` (the `leadToDto` output), `deleted_by` FK SET NULL, `deleted_by_name`, `deleted_at ts NN default now()`. Indexes `lead_id`, `workspace_id` partial. RLS(s/i).

### Foreign-key delete behaviour (summary)
- Deleting a **lead** cascades to notes, contact channels, calls, tasks, meetings (→ participants, outbound WhatsApp rows), proposals (→ outbound WhatsApp rows), workflow_runs (→ scheduled_actions → outbound WhatsApp rows), timeline_events, dnc_events and notifications. `leads.merged_into_lead_id` on other leads is set to NULL.
- Deleting a **workflow** cascades to its versions and steps, but `workflow_runs.workflow_id`/`workflow_version_id` are **RESTRICT**, and `scheduled_actions.workflow_step_id` is **RESTRICT**.
- Deleting a **template** sets `workflow_steps.template_id` and the proposal template FKs to NULL, and cascades to `template_attachments`.
- Deleting a **profile** (= deleting the auth user) cascades to notifications. Every other actor/owner FK is SET NULL.

---

## 4. Functions and triggers

| Function | Used by | Behaviour |
|---|---|---|
| `set_updated_at()` | upd trg on profiles, leads, tasks, meetings, proposals, message_templates, workflows, workflow_runs, scheduled_actions, integration_connections, whatsapp_connection, google_calendar_connection, workspaces | `new.updated_at := now()`. |
| `handle_new_user()` (SECURITY DEFINER, `search_path=public`) | `on_auth_user_created` AFTER INSERT on `auth.users` | Inserts a `profiles` row. `full_name` = trimmed `raw_user_meta_data->>'full_name'`, else the email local-part. `initials` = first letter of the first two space-separated parts, uppercased, falling back to the first two characters. `role` takes its default `'salesperson'`. |
| `is_active_salesperson()` (SECURITY DEFINER, STABLE) | All RLS policies | After 003: `exists (profiles where id = auth.uid() and is_active and role='salesperson')`. Admins therefore have **no** RLS access to anything, including `profiles`. |
| `enforce_workflow_steps_draft_only()` | `workflow_steps_draft_only_edit` BEFORE I/U/D | Looks up the parent version's status (using NEW or OLD). If it is not `'draft'`, it raises errcode `23514` "workflow_steps can only be modified while their workflow_version is Draft". This also fires on FK-driven `SET NULL` updates (see 07: template deletion) and on cascade deletes, which is why `deleteWorkflow` flips each version to draft first. |
| `enforce_lead_terminal_automation()` | `leads_enforce_terminal_automation` BEFORE I/U | If `new.lifecycle_state` is in (won, lost, discarded, do_not_contact, merged), it forces `new.automation_mode := 'stopped'`. It does nothing for `long_term_nurture` and `active`. |
| `cascade_lead_lifecycle_change()` (SECURITY DEFINER), final version from 002 | `leads_cascade_lifecycle_change` **BEFORE** I/U | (1) When entering a terminal lifecycle (won/lost/discarded/do_not_contact/merged, changed from the old value): runs `workflow_runs` set status cancelled, `cancelled_at` now, `cancel_reason` 'Lead lifecycle changed to X' where status in running/waiting/paused; and `scheduled_actions` set cancelled where status in pending/due/paused. **It does not touch `executing` actions.** (2) When entering DNC: inserts `dnc_events('suppressed', new.dnc_reason, new.dnc_by, new.dnc_by_name)`. (3) When leaving DNC for any other state: if `new.dnc_reason` is null it raises `23514`, otherwise it inserts `dnc_events('reactivated', new.dnc_reason, …)` and then sets `new.dnc_reason := null`. Side effect: leaving DNC by **any** route (won/lost/discarded/long_term_nurture, not only `reactivateFromDnc`) succeeds, because the old reason is still on the row, and it logs a "reactivated" event using the *original* DNC reason (see 07). On INSERT of a DNC lead, the `dnc_events` insert runs before the lead row exists, which would violate the FK. The app never does this. |
| `prevent_admin_audit_mutation()` | `admin_audit_events_immutable` BEFORE U/D | Raises "admin_audit_events is append-only". |

Views (created in 001, never recreated; their column lists are frozen without `workspace_id`):

| View | Definition | Used by app? |
|---|---|---|
| `lead_next_actions` | `distinct on (lead_id)` open tasks ordered by `due_at asc` (lead_id, task_id, task_type, title, due_at, owner_id, owner_name, origin) | **Yes**: `tasks.service.getLeadNextAction`, `leads.service.listLeads`. Not workspace-scoped, but always filtered by lead ids. |
| `active_leads_missing_next_action` | active leads with no open task | No (dashboard inlines it; comment at `dashboard.service.ts:9-17`). |
| `overdue_tasks` | open tasks with `due_at < now()` | No. |
| `tasks_due_today` | open tasks due today by `date_trunc('day', now())` (server TZ, i.e. UTC, **not IST**) | No. |

---

## 5. Row-Level Security model

- The backend connects with an RLS-bypassing role (`DATABASE_URL`), so none of these policies applies to the app. They only constrain direct PostgREST or anon-key clients.
- CRM tables: policies for the `authenticated` role, all gated on `is_active_salesperson()`. Policies are **not workspace-aware**: a salesperson using PostgREST directly could read every workspace.
- Integration, secret and audit tables (`integration_connections`, `admin_audit_events`, `whatsapp_*`, `google_calendar_connection`): RLS is enabled with **no policies**, which denies all non-bypass access.
- `timeline_events`: select and insert only. `dnc_events`: select only. Several tables have no delete policy (by design).

---

## 6. Storage buckets

| Bucket | Created in | Public? | Path format written by the app | Read by | Notes |
|---|---|---|---|---|---|
| `template-attachments` | 004 | private | `${templateId}/${randomUUID()}-${sanitizedName}` (`workflows.service.ts:703`; sanitised to `[a-zA-Z0-9._-]`, at most 150 chars) | API: `createSignedUrl(path, 300s)` for the template list. Worker: `download()` for email attachments (base64) and the WhatsApp media attachment (the first one only). | Upload limit 15 MB by multer. WhatsApp templates: at most 1 attachment, at most 10 MB. Allowed MIME types: PDF, DOC/DOCX, XLS/XLSX, PNG/JPEG/GIF/WEBP. Template deletion does **not** remove the storage objects. |
| `proposal-documents` | 005 | private | `${leadId}/${randomUUID()}-${sanitizedName}` (`proposalSending.service.ts:146`) | API: `download()` for the inline proposal email. Worker: Baileys downloads it as a WhatsApp document or image. | Upload limit 10 MB; same MIME allow-list. There is no download or signed-URL endpoint for users, and no delete (lead hard-delete leaves the objects behind). |

The migrations define no storage policies (`storage.objects`), so only the service role can access the buckets.
