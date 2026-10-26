import { z } from "zod";

/** /search URL state: the term and the open tab (absent = contacts). */
export const SEARCH_TABS = ["contacts", "companies", "deals"] as const;
export type SearchTab = (typeof SEARCH_TABS)[number];

export const searchPageSchema = z.object({
  q: z.string().optional(),
  tab: z.enum(SEARCH_TABS).optional(),
});
export const validateSearchPage = (search: Record<string, unknown>) => {
  const parsed = searchPageSchema.safeParse(search);
  return parsed.success ? parsed.data : {};
};
