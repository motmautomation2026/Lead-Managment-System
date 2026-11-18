import { describe, expect, it } from "vitest";
import { CONSTRAINT_MESSAGES, mapDatabaseError } from "../../src/domain/dbErrorMessages.js";

// Shapes as node-postgres reports them (DatabaseError fields).
const pg = (fields: Record<string, string>) => Object.assign(new Error(fields.message ?? "db error"), fields);

describe("mapDatabaseError", () => {
  it("ignores anything that is not a Postgres error", () => {
    expect(mapDatabaseError(new Error("boom"))).toBeNull();
    expect(mapDatabaseError({ code: "ECONNRESET" })).toBeNull();
    expect(mapDatabaseError(null)).toBeNull();
    expect(mapDatabaseError(pg({ code: "XX000" }))).toBeNull();
  });

  it.each([
    ["leads_objection_stage_has_type", "23514", 400, "Choose an objection type before moving a lead to Objection Nurture."],
    ["leads_has_contact_channel", "23514", 400, "A lead needs an email address or a phone number."],
    ["leads_lost_has_reason", "23514", 400, "Choose a loss reason before marking a lead as Lost."],
    ["leads_dnc_has_reason", "23514", 400, "Give a reason before marking a lead Do Not Contact."],
    ["proposals_loss_has_reason", "23514", 400, "Choose a loss reason before marking a proposal as Rejected or Expired."],
    ["meetings_outcome_requires_completed", "23514", 400, "A meeting outcome can only be recorded once the meeting is completed."],
    ["message_templates_body_not_blank", "23514", 400, "Template body can't be blank."],
    ["workflows_name_not_blank", "23514", 400, "Workflow name can't be blank."],
    [
      "message_templates_one_default_meeting_whatsapp_per_workspace",
      "23505",
      409,
      "Another WhatsApp template is already this workspace's default Meeting Scheduled template. Unset it first.",
    ],
  ])("gives %s (%s) its human message", (constraint, code, status, message) => {
    expect(mapDatabaseError(pg({ code, constraint }))).toEqual({
      status,
      code: status === 409 ? "conflict" : "invalid_input",
      message,
      details: { constraint },
    });
  });

  it("has a message for every listed constraint that never mentions SQL or table internals", () => {
    for (const [constraint, { message }] of Object.entries(CONSTRAINT_MESSAGES)) {
      expect(message, constraint).not.toMatch(/_|\bconstraint\b|violat|\brelation\b|\btable\b|\bselect\b|\binsert\b|\bupdate\b/i);
    }
  });

  it("passes our DNC trigger messages through unchanged", () => {
    const message = "A Do Not Contact lead can only be reactivated to active (with a reason), not moved to won.";
    expect(mapDatabaseError(pg({ code: "23514", message }))).toEqual({ status: 400, code: "invalid_input", message });
    const reason = "Reactivating a Do Not Contact lead requires dnc_reason to explain why.";
    expect(mapDatabaseError(pg({ code: "23514", message: reason }))?.message).toBe(reason);
  });

  it("rewrites the draft-only trigger, whose own text names the table", () => {
    const mapped = mapDatabaseError(pg({ code: "23514", message: "workflow_steps can only be modified while their workflow_version is Draft (version status: previous)" }));
    expect(mapped).toMatchObject({ status: 409, message: "Published and older workflow versions can't be changed. Create a draft and publish a new version." });
  });

  describe("unknown constraints fall back per error type, with the constraint in details only", () => {
    it.each([
      ["23505", 409, "duplicate", "This would create a duplicate of something that already exists."],
      ["23514", 400, "invalid_input", "This change breaks a data rule and wasn't saved. Check the values and try again."],
    ])("%s", (code, status, errorCode, message) => {
      const mapped = mapDatabaseError(pg({ code, constraint: "some_new_constraint", message: `violates "some_new_constraint" on secret_table` }));
      expect(mapped).toEqual({ status, code: errorCode, message, details: { constraint: "some_new_constraint" } });
    });
  });

  it("maps a foreign key pointing at a missing row to 400 not found, by column", () => {
    const mapped = mapDatabaseError(
      pg({
        code: "23503",
        constraint: "leads_owner_id_fkey",
        detail: 'Key (owner_id)=(6d1f3f6e-0000-4000-8000-000000000000) is not present in table "profiles".',
      }),
    );
    expect(mapped).toEqual({ status: 400, code: "invalid_reference", message: "The selected owner doesn't exist.", details: { constraint: "leads_owner_id_fkey" } });
  });

  it("maps deleting a row that is still referenced to 409 in use", () => {
    const mapped = mapDatabaseError(
      pg({
        code: "23503",
        constraint: "workflow_runs_workflow_id_fkey",
        detail: 'Key (id)=(6d1f3f6e-0000-4000-8000-000000000000) is still referenced from table "workflow_runs".',
      }),
    );
    expect(mapped).toMatchObject({ status: 409, code: "in_use", message: "This can't be deleted because workflow enrollments still use it." });
  });

  it("never echoes the offending value", () => {
    const mapped = mapDatabaseError(pg({ code: "23503", detail: 'Key (owner_id)=(SECRET-VALUE) is not present in table "profiles".' }));
    expect(JSON.stringify(mapped)).not.toContain("SECRET-VALUE");
    expect(JSON.stringify(mapDatabaseError(pg({ code: "22P02", message: 'invalid input syntax for type uuid: "SECRET-VALUE"' })))).not.toContain("SECRET-VALUE");
  });

  it("names the missing column for not-null violations", () => {
    expect(mapDatabaseError(pg({ code: "23502", column: "first_name" }))).toEqual({ status: 400, code: "invalid_input", message: "First name is required." });
  });

  it("maps invalid text format to 400", () => {
    expect(mapDatabaseError(pg({ code: "22P02" }))).toMatchObject({ status: 400, code: "invalid_input" });
  });

  it.each(["40001", "40P01"])("asks the user to retry on %s", (code) => {
    expect(mapDatabaseError(pg({ code }))).toMatchObject({ status: 503, code: "retry", message: expect.stringContaining("try again") });
  });
});
