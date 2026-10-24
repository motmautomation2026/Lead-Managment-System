/** GET /search (B4-api.md §6): at most 5 of each, best match first. */
export interface SearchResults {
  contacts: Array<{
    id: string;
    name: string;
    email: string | null;
    company: string | null;
    lifecycle: string;
  }>;
  companies: Array<{ id: string; name: string; domain: string | null }>;
  deals: Array<{
    id: string;
    name: string;
    stage: string;
    amount: number | null;
    currency: string;
    company: { id: string; name: string } | null;
  }>;
}
