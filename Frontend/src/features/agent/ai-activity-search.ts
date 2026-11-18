import { z } from "zod";
import type { AgentDecisionFilters } from "@/lib/backend-client";
import { toIsoFromIst } from "@/lib/dates";

/**
 * /ai-activity URL state: the same filters as before C6b (action, outcome, rating, open
 * report, IST from/to days), so links like Home's "drafts to review" open the right list.
 */
export const aiActivitySearchSchema = z.object({
  action: z
    .enum(["send_email", "send_whatsapp", "wait", "handoff", "update_stage", "stop"])
    .optional(),
  outcome: z.enum(["draft", "sent", "skipped", "blocked", "executed", "failed"]).optional(),
  rating: z.enum(["good", "bad", "unrated"]).optional(),
  openReport: z.literal(true).optional(),
  /** YYYY-MM-DD, whole IST days. */
  from: z.string().optional(),
  to: z.string().optional(),
  /** E3b-2b: the Results tab (funnel numbers); absent = the decisions list. */
  tab: z.enum(["results"]).optional(),
});
export type AiActivitySearch = z.infer<typeof aiActivitySearchSchema>;

export const validateAiActivitySearch = (search: Record<string, unknown>): AiActivitySearch => {
  const parsed = aiActivitySearchSchema.safeParse(search);
  return parsed.success ? parsed.data : {};
};

export function toDecisionFilters(state: AiActivitySearch): AgentDecisionFilters {
  return {
    action: state.action,
    outcome: state.outcome,
    rating: state.rating,
    hasOpenReport: state.openReport,
    from: state.from ? toIsoFromIst(state.from, "00:00:00") : undefined,
    to: state.to ? toIsoFromIst(state.to, "23:59:59") : undefined,
  };
}
