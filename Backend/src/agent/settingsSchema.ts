import { z } from "zod";
import { LIVE_SCOPES } from "./liveMode.js";

/**
 * A partial agent_settings update (PUT /agent/settings), camelCase. Mirrors the
 * DB checks in migrations 024/025. Cross-field rules are checked here when both
 * fields are sent; the service re-checks them on the merged row
 * (settingsCrossFieldProblem) so a single-field update can't break them either.
 */

const positiveInt = z.number().int().positive();
const maxWords = z.number().int().min(1).max(500);
const nonBlank = z.string().trim().min(1, "Can't be blank.").max(1000);
// "HH:MM" or "HH:MM:SS", normalised to "HH:MM:SS" (how pg returns `time`) so strings compare in order.
const timeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, "Use HH:MM (24-hour).")
  .transform((value) => (value.length === 5 ? `${value}:00` : value));
const modelName = z.string().trim().min(1).max(100).nullable();

export const settingsUpdateSchema = z
  .object({
    mode: z.enum(["off", "shadow", "live"]),
    // E2: which AI contacts are live in a live workspace; new_leads / all need the go-live gate (checked by the service).
    liveScope: z.enum(LIVE_SCOPES),
    sendDays: z
      .array(z.number().int().min(1).max(7))
      .min(1, "Pick at least one day.")
      .refine((days) => new Set(days).size === days.length, "Days must be unique."),
    sendWindowStart: timeOfDay,
    sendWindowEnd: timeOfDay,
    minGapHours: positiveInt,
    maxTouches7d: positiveInt,
    maxTouchesTotal: positiveInt,
    // E2b: 1–500 (migration 045).
    emailMaxWords: maxWords,
    whatsappMaxWords: maxWords,
    // E2b: ≤ 100 phrases, each 1–60 characters; blanks dropped, case-insensitive duplicates removed.
    bannedPhrases: z
      .array(z.string().trim().max(60, "Each phrase can be at most 60 characters."))
      .transform((phrases) => phrases.filter((p, i) => p && phrases.findIndex((q) => q.toLowerCase() === p.toLowerCase()) === i))
      .pipe(z.array(z.string()).max(100, "At most 100 banned phrases.")),
    wakeMinDays: positiveInt,
    wakeMaxDays: positiveInt,
    nurtureLongTerm: z.boolean(),
    // The DB requires > 0 (migration 024).
    monthlyBudgetUsd: z.number().positive().max(99_999_999),
    maxDecisionsPerDay: z.number().int().min(1).max(10_000),
    decisionModel: modelName,
    groundingModel: modelName,
    emailOptOutText: nonBlank,
    whatsappOptOutText: nonBlank,
    repQuietHours: z.number().int().min(0).max(168),
    autoEnrollNewLeads: z.boolean(),
    // null = use the workspace name.
    companyDisplayName: z.string().trim().min(1, "Can't be blank.").max(120).nullable(),
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
