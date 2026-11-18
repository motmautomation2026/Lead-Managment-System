import { z } from "zod";
import { PIPELINE_STAGES } from "../domain/enums.js";

/**
 * The one action the agent picks per wake-up. Zod is the source of truth;
 * DECISION_JSON_SCHEMA mirrors it for OpenAI strict structured outputs.
 *
 * Enforced by Zod (and the rules engine) only, NOT in the JSON Schema, because
 * strict mode doesn't reliably support them: string maxLength / minLength
 * (subject ≤ 150, non-blank texts), array maxItems (assetIds ≤ 3 / ≤ 1),
 * format "uuid" on asset ids. Bounds on nextWakeInDays are deliberately absent
 * everywhere: the rules engine clamps it to [wake_min_days, wake_max_days].
 * Plain text / no HTML / no signature is checked by the rules engine, so a bad
 * body becomes a recorded violation rather than a parse failure.
 */

const text = z.string().trim().min(1);
const reasoning = text;
const nextWakeInDays = z.number().int();
// Strict like the JSON Schema (additionalProperties: false).
const strictObject = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export const AGENT_ACTIONS = ["send_email", "send_whatsapp", "wait", "handoff", "update_stage", "stop"] as const;
export type AgentAction = (typeof AGENT_ACTIONS)[number];
export const HANDOFF_URGENCIES = ["low", "normal", "high"] as const;
export const STOP_REASONS = ["not_a_fit", "no_response", "asked_to_stop", "other"] as const;

export const decisionSchema = z.discriminatedUnion("action", [
  strictObject({
    action: z.literal("send_email"),
    subject: text.max(150),
    body: text,
    assetIds: z.array(z.string().uuid()).max(3),
    nextWakeInDays,
    reasoning,
  }),
  strictObject({
    action: z.literal("send_whatsapp"),
    body: text,
    assetIds: z.array(z.string().uuid()).max(1),
    nextWakeInDays,
    reasoning,
  }),
  strictObject({ action: z.literal("wait"), nextWakeInDays, reasoning }),
  strictObject({ action: z.literal("handoff"), title: text, urgency: z.enum(HANDOFF_URGENCIES), reasoning }),
  strictObject({ action: z.literal("update_stage"), newStage: z.enum(PIPELINE_STAGES), reasoning }),
  strictObject({
    action: z.literal("stop"),
    reason: z.enum(STOP_REASONS),
    moveToLongTermNurture: z.boolean(),
    reasoning,
  }),
]);

export type AgentDecision = z.infer<typeof decisionSchema>;
export type SendDecision = Extract<AgentDecision, { action: "send_email" | "send_whatsapp" }>;

function variant(action: AgentAction, properties: Record<string, object>) {
  const all = { action: { type: "string", enum: [action] }, ...properties, reasoning: { type: "string" } };
  return { type: "object", properties: all, required: Object.keys(all), additionalProperties: false };
}

const assetIdsJson = { type: "array", items: { type: "string" } };

/** Root must be an object (strict mode forbids a root-level union): `{ decision: anyOf[...] }`. */
export const DECISION_JSON_SCHEMA = {
  type: "object",
  properties: {
    decision: {
      anyOf: [
        variant("send_email", { subject: { type: "string" }, body: { type: "string" }, assetIds: assetIdsJson, nextWakeInDays: { type: "integer" } }),
        variant("send_whatsapp", { body: { type: "string" }, assetIds: assetIdsJson, nextWakeInDays: { type: "integer" } }),
        variant("wait", { nextWakeInDays: { type: "integer" } }),
        variant("handoff", { title: { type: "string" }, urgency: { type: "string", enum: [...HANDOFF_URGENCIES] } }),
        variant("update_stage", { newStage: { type: "string", enum: [...PIPELINE_STAGES] } }),
        variant("stop", { reason: { type: "string", enum: [...STOP_REASONS] }, moveToLongTermNurture: { type: "boolean" } }),
      ],
    },
  },
  required: ["decision"],
  additionalProperties: false,
} as const;

/** Parses the model's `{ decision }` output (a JSON string or an object). Throws on invalid input. */
export function parseModelOutput(json: unknown): AgentDecision {
  const value: unknown = typeof json === "string" ? JSON.parse(json) : json;
  return z.object({ decision: decisionSchema }).strict().parse(value).decision;
}
