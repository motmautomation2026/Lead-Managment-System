import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import { DECISION_JSON_SCHEMA, parseModelOutput } from "../../src/agent/decisionSchema.js";

const ASSET = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const validate = new Ajv({ strict: true }).compile(DECISION_JSON_SCHEMA);

function zodAccepts(value: unknown) {
  try {
    parseModelOutput(value);
    return true;
  } catch {
    return false;
  }
}

const valid = [
  { action: "send_email", subject: "Quick question", body: "Hi Asha,\n\nFollowing up.", assetIds: [ASSET], nextWakeInDays: 3, reasoning: "r" },
  { action: "send_whatsapp", body: "Hi Asha", assetIds: [], nextWakeInDays: 2, reasoning: "r" },
  { action: "wait", nextWakeInDays: 0, reasoning: "r" },
  { action: "handoff", title: "Call them", urgency: "high", reasoning: "r" },
  { action: "update_stage", newStage: "meeting_scheduling", reasoning: "r" },
  { action: "stop", reason: "asked_to_stop", moveToLongTermNurture: false, reasoning: "r" },
];

// Structurally invalid: both validators must reject.
const invalid = [
  { action: "dance", reasoning: "r" },
  { action: "wait", reasoning: "r" }, // missing nextWakeInDays
  { action: "wait", nextWakeInDays: 1.5, reasoning: "r" },
  { action: "wait", nextWakeInDays: 1, reasoning: "r", extra: true },
  { action: "handoff", title: "t", urgency: "urgent", reasoning: "r" },
  { action: "update_stage", newStage: "won", reasoning: "r" },
  { action: "stop", reason: "no_response", reasoning: "r" },
  { action: "send_email", body: "b", assetIds: [], nextWakeInDays: 1, reasoning: "r" }, // no subject
  { action: "send_whatsapp", body: "b", assetIds: "x", nextWakeInDays: 1, reasoning: "r" },
];

describe("agent decision schema", () => {
  it.each(valid)("Zod and JSON Schema both accept %o", (decision) => {
    expect(validate({ decision })).toBe(true);
    expect(zodAccepts({ decision })).toBe(true);
  });

  it.each(invalid)("Zod and JSON Schema both reject %o", (decision) => {
    expect(validate({ decision })).toBe(false);
    expect(zodAccepts({ decision })).toBe(false);
  });

  it("both reject a root that isn't { decision }", () => {
    expect(validate(valid[2])).toBe(false);
    expect(zodAccepts(valid[2])).toBe(false);
    expect(validate({ decision: valid[2], extra: 1 })).toBe(false);
    expect(zodAccepts({ decision: valid[2], extra: 1 })).toBe(false);
  });

  it("strict-mode shape: object root, every object has all properties required and no additional properties", () => {
    expect(DECISION_JSON_SCHEMA.type).toBe("object");
    for (const branch of DECISION_JSON_SCHEMA.properties.decision.anyOf) {
      expect(branch.additionalProperties).toBe(false);
      expect([...branch.required].sort()).toEqual(Object.keys(branch.properties).sort());
    }
  });

  it.each([
    ["subject over 150 chars", { ...valid[0], subject: "x".repeat(151) }],
    ["blank body", { ...valid[1], body: "   " }],
    ["4 email assets", { ...valid[0], assetIds: [ASSET, ASSET, ASSET, ASSET] }],
    ["2 WhatsApp assets", { ...valid[1], assetIds: [ASSET, ASSET] }],
    ["non-uuid asset id", { ...valid[1], assetIds: ["abc"] }],
  ])("Zod-only bounds reject %s (the JSON Schema leaves these to Zod)", (_label, decision) => {
    expect(validate({ decision })).toBe(true);
    expect(zodAccepts({ decision })).toBe(false);
  });

  it("parseModelOutput accepts a JSON string and unwraps decision", () => {
    expect(parseModelOutput(JSON.stringify({ decision: valid[2] }))).toEqual(valid[2]);
    expect(() => parseModelOutput("not json")).toThrow();
  });
});
