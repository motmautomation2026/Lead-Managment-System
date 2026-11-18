import { z } from "zod";
import type { DuplicateReason, DuplicateStatus } from "@/types";

export const REASON_LABEL: Record<DuplicateReason, string> = {
  similar_name: "Similar name",
  same_domain_different_name: "Same domain, different name",
  name_domain_conflict: "Same name, different domain",
};
export const STATUSES: DuplicateStatus[] = ["open", "merged", "dismissed"];

/** /companies/duplicates URL state: kind tab, reason and status filters (status default open). */
export const duplicatesSearchSchema = z.object({
  kind: z.enum(["pair", "contact"]).optional(),
  reason: z
    .array(z.enum(["similar_name", "same_domain_different_name", "name_domain_conflict"]))
    .optional(),
  status: z.array(z.enum(["open", "merged", "dismissed"])).optional(),
});
export type DuplicatesSearch = z.infer<typeof duplicatesSearchSchema>;
export const validateDuplicatesSearch = (search: Record<string, unknown>): DuplicatesSearch => {
  const parsed = duplicatesSearchSchema.safeParse(search);
  return parsed.success ? parsed.data : {};
};
