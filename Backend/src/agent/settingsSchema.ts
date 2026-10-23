import { z } from "zod";

/**
 * A partial agent_settings update (PUT /agent/settings), camelCase. Mirrors the
 * DB checks in migrations 024/025. Cross-field rules are checked here when both
 * fields are sent; the service re-checks them on the merged row
 * (settingsCrossFieldProblem) so a single-field update can't break them either.
 */

export const LIVE_MODE_UNAVAILABLE = "Live mode isn't available yet.";

const positiveInt = z.number().int().positive();
const nonBlank = z.string().trim().min(1, "Can't be blank.").max(1000);
// "HH:MM" or "HH:MM:SS", normalised to "HH:MM:SS" (how pg returns `time`) so strings compare in order.
const timeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, "Use HH:MM (24-hour).")
  .transform((value) => (value.length === 5 ? `${value}:00` : value));
const modelName = z.string().trim().min(1).max(100).nullable();

export const settingsUpdateSchema = z
  .object({
    mode: z.enum(["off", "shadow", "live"]).refine((mode) => mode !== "live", LIVE_MODE_UNAVAILABLE),
    sendDays: z
      .array(z.number().int().min(1).max(7))
      .min(1, "Pick at least one day.")
      .refine((days) => new Set(days).size === days.length, "Days must be unique."),
    sendWindowStart: timeOfDay,
    sendWindowEnd: timeOfDay,
    minGapHours: positiveInt,
    maxTouches7d: positiveInt,
    maxTouchesTotal: positiveInt,
    emailMaxWords: positiveInt,
    whatsappMaxWords: positiveInt,
    wakeMinDays: positiveInt,
    wakeMaxDays: positiveInt,
    nurtureLongTerm: z.boolean(),
    // The DB requires > 0 (migration 024).
    monthlyBudgetUsd: z.number().positive().max(99_999_999),
    decisionModel: modelName,
    groundingModel: modelName,
    emailOptOutText: nonBlank,
    whatsappOptOutText: nonBlank,
    repQuietHours: z.number().int().min(0).max(168),
    autoEnrollNewLeads: z.boolean(),
  })
  .partial()
  .superRefine((value, ctx) => {
    for (const problem of settingsCrossFieldProblems(value)) ctx.addIssue({ code: z.ZodIssueCode.custom, ...problem });
  });

export type SettingsUpdate = z.infer<typeof settingsUpdateSchema>;

type CrossFields = Pick<SettingsUpdate, "sendWindowStart" | "sendWindowEnd" | "wakeMinDays" | "wakeMaxDays">;

/** Cross-field rules; each is skipped unless both of its fields are present. */
export function settingsCrossFieldProblems(value: CrossFields): { path: string[]; message: string }[] {
  const problems: { path: string[]; message: string }[] = [];
  if (value.sendWindowStart !== undefined && value.sendWindowEnd !== undefined && value.sendWindowStart >= value.sendWindowEnd) {
    problems.push({ path: ["sendWindowEnd"], message: "The send window must end after it starts." });
  }
  if (value.wakeMinDays !== undefined && value.wakeMaxDays !== undefined && value.wakeMinDays > value.wakeMaxDays) {
    problems.push({ path: ["wakeMaxDays"], message: "Maximum wake days can't be less than minimum wake days." });
  }
  return problems;
}
