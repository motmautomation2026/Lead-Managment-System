/**
 * Maps Postgres errors to clear 4xx/503 responses (audit B24). Pure: takes the
 * error fields node-postgres exposes and returns what the API should send, or
 * null when the error is not a recognised database error (it stays a 500).
 *
 * User messages never contain SQL, table names or values. The constraint name
 * goes in `details` so support can still find it.
 */

export interface DbErrorLike {
  code?: unknown;
  constraint?: unknown;
  column?: unknown;
  detail?: unknown;
  message?: unknown;
}

export interface MappedDbError {
  status: number;
  code: string;
  message: string;
  details?: { constraint: string };
}

/** CHECK constraints and unique indexes a user can reach through the API. */
export const CONSTRAINT_MESSAGES: Record<string, { status: number; message: string }> = {
  // leads
  leads_objection_stage_has_type: { status: 400, message: "Choose an objection type before moving a lead to Objection Nurture." },
  leads_has_contact_channel: { status: 400, message: "A lead needs an email address or a phone number." },
  leads_lost_has_reason: { status: 400, message: "Choose a loss reason before marking a lead as Lost." },
  leads_dnc_has_reason: { status: 400, message: "Give a reason before marking a lead Do Not Contact." },
  leads_first_name_not_blank: { status: 400, message: "First name can't be blank." },
  leads_company_not_blank: { status: 400, message: "Company can't be blank." },
  leads_merge_target_not_self: { status: 400, message: "A lead can't be merged into itself." },
  leads_merged_has_target: { status: 400, message: "Choose the lead to merge into." },
  leads_phone_e164_valid: { status: 400, message: "The phone number isn't valid. Use the international format, for example +91 98765 43210." },
  lead_notes_body_not_blank: { status: 400, message: "A note can't be blank." },
  lead_contact_channels_unique_channel: { status: 409, message: "This contact channel was just updated by someone else. Reload and try again." },
  // calls
  calls_outcome_matches_connection: { status: 400, message: "Choose an outcome for a connected call, or a reason if the call didn't connect." },
  calls_callback_due_requires_outcome: { status: 400, message: "A callback time can only be set when the outcome is Callback requested." },
  // tasks
  tasks_title_not_blank: { status: 400, message: "Task title can't be blank." },
  // meetings
  meetings_title_not_blank: { status: 400, message: "Meeting title can't be blank." },
  meetings_duration_positive: { status: 400, message: "Meeting duration must be more than 0 minutes." },
  meetings_outcome_requires_completed: { status: 400, message: "A meeting outcome can only be recorded once the meeting is completed." },
  meeting_participants_email_valid: { status: 400, message: "One of the participants' email addresses isn't valid." },
  // proposals
  proposals_title_not_blank: { status: 400, message: "Proposal title can't be blank." },
  proposals_amount_non_negative: { status: 400, message: "Proposal amount can't be negative." },
  proposals_loss_has_reason: { status: 400, message: "Choose a loss reason before marking a proposal as Rejected or Expired." },
  // templates
  message_templates_name_not_blank: { status: 400, message: "Template name can't be blank." },
  message_templates_body_not_blank: { status: 400, message: "Template body can't be blank." },
  message_templates_whatsapp_no_subject: { status: 400, message: "WhatsApp templates can't have a subject." },
  message_templates_one_default_meeting_email_per_workspace: {
    status: 409,
    message: "Another email template is already this workspace's default Meeting Scheduled template. Unset it first.",
  },
  message_templates_one_default_meeting_whatsapp_per_workspace: {
    status: 409,
    message: "Another WhatsApp template is already this workspace's default Meeting Scheduled template. Unset it first.",
  },
  template_attachments_file_name_not_blank: { status: 400, message: "The attachment needs a file name." },
  // workflows
  workflows_name_not_blank: { status: 400, message: "Workflow name can't be blank." },
  workflow_steps_delay_non_negative: { status: 400, message: "A step's delay can't be negative." },
  workflow_steps_template_only_on_message_action: { status: 400, message: "Only email and WhatsApp steps can have a template." },
  workflow_versions_one_draft_per_workflow: { status: 409, message: "This workflow already has a draft. Edit or delete that draft first." },
  workflow_versions_one_published_per_workflow: { status: 409, message: "This workflow was published by someone else at the same time. Reload and try again." },
  workflow_versions_unique_number: { status: 409, message: "This workflow was changed by someone else at the same time. Reload and try again." },
  workflow_steps_unique_order: { status: 409, message: "This workflow was changed by someone else at the same time. Reload and try again." },
  // workspaces, profiles, connections
  workspaces_name_not_blank: { status: 400, message: "Workspace name can't be blank." },
  workspaces_slug_not_blank: { status: 400, message: "Workspace name must contain letters or numbers." },
  workspaces_name_unique: { status: 409, message: "A workspace with this name already exists." },
  workspaces_slug_unique: { status: 409, message: "A workspace with a very similar name already exists. Choose a different name." },
  profiles_full_name_not_blank: { status: 400, message: "Full name can't be blank." },
  whatsapp_daily_cap_positive: { status: 400, message: "The daily WhatsApp limit must be between 1 and 10,000." },
  whatsapp_delay_valid: { status: 400, message: "Minimum message spacing must be 1–300 seconds, and the maximum must be between the minimum and 600 seconds." },
};

/** Messages our own triggers raise with errcode 23514. They are written for users, so they pass through. */
const TRIGGER_MESSAGE_PREFIXES = ["A Do Not Contact lead can only be reactivated", "Reactivating a Do Not Contact lead requires"];
/** The draft-only trigger names its table, so it gets a rewritten message instead. */
const DRAFT_ONLY_TRIGGER_PREFIX = "workflow_steps can only be modified while";

/** Labels for the referenced/referencing side of a foreign key, by column or table name. */
const REFERENCE_LABELS: Record<string, string> = {
  owner_id: "owner",
  assigned_to: "owner",
  default_lead_owner_id: "owner",
  lead_id: "lead",
  merged_into_lead_id: "lead",
  workflow_id: "workflow",
  workflow_version_id: "workflow version",
  workflow_run_id: "workflow enrollment",
  workflow_step_id: "workflow step",
  template_id: "template",
  email_template_id: "email template",
  whatsapp_template_id: "WhatsApp template",
  meeting_id: "meeting",
  proposal_id: "proposal",
  workspace_id: "workspace",
};
const REFERENCING_TABLE_LABELS: Record<string, string> = {
  workflow_runs: "workflow enrollments",
  workflow_steps: "workflow steps",
  workflow_versions: "workflow versions",
  scheduled_actions: "scheduled workflow steps",
  leads: "leads",
  tasks: "tasks",
  meetings: "meetings",
  proposals: "proposals",
  calls: "calls",
  message_templates: "templates",
};

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function humanize(identifier: string): string {
  const words = identifier.replace(/_id$/, "").replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function isDatabaseError(err: unknown): err is DbErrorLike {
  const code = (err as DbErrorLike | null)?.code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code);
}

export function mapDatabaseError(err: unknown): MappedDbError | null {
  if (!isDatabaseError(err)) return null;
  const code = err.code as string;
  const constraint = str(err.constraint);
  const details = constraint ? { constraint } : undefined;

  const known = constraint ? CONSTRAINT_MESSAGES[constraint] : undefined;
  if (known && (code === "23514" || code === "23505")) {
    return { status: known.status, code: known.status === 409 ? "conflict" : "invalid_input", message: known.message, details };
  }

  switch (code) {
    case "23505":
      return { status: 409, code: "duplicate", message: "This would create a duplicate of something that already exists.", details };

    case "23503": {
      const detail = str(err.detail) ?? "";
      // "Key (col)=(...) is still referenced from table "t"" → the row being deleted is in use.
      const referencedFrom = /is still referenced from table "?(\w+)"?/.exec(detail)?.[1];
      if (referencedFrom) {
        const users = REFERENCING_TABLE_LABELS[referencedFrom] ?? "other records";
        return { status: 409, code: "in_use", message: `This can't be deleted because ${users} still use it.`, details };
      }
      // "Key (col)=(...) is not present in table "t"" → the request points at something that doesn't exist.
      const column = /Key \((\w+)\)/.exec(detail)?.[1];
      const label = column ? (REFERENCE_LABELS[column] ?? humanize(column).toLowerCase()) : "record";
      return { status: 400, code: "invalid_reference", message: `The selected ${label} doesn't exist.`, details };
    }

    case "23514": {
      const message = str(err.message) ?? "";
      if (!constraint && TRIGGER_MESSAGE_PREFIXES.some((prefix) => message.startsWith(prefix))) {
        return { status: 400, code: "invalid_input", message };
      }
      if (!constraint && message.startsWith(DRAFT_ONLY_TRIGGER_PREFIX)) {
        return {
          status: 409,
          code: "invalid_transition",
          message: "Published and older workflow versions can't be changed. Create a draft and publish a new version.",
        };
      }
      return { status: 400, code: "invalid_input", message: "This change breaks a data rule and wasn't saved. Check the values and try again.", details };
    }

    case "23502": {
      const column = str(err.column);
      return { status: 400, code: "invalid_input", message: column ? `${humanize(column)} is required.` : "A required value is missing." };
    }

    case "22P02":
      return { status: 400, code: "invalid_input", message: "One of the values has an invalid format (for example, an id that isn't a valid UUID)." };

    case "40001":
    case "40P01":
      return { status: 503, code: "retry", message: "The database was busy with another change at the same moment. Please try again." };

    default:
      return null;
  }
}
