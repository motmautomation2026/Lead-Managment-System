/**
 * The contact's company as the agent sees it (D1). Pure. Company facts are lead
 * data (an approved grounding source); the description is internal context only.
 */

/** A companies row as buildAgentContext reads it (camelCase). */
export interface CompanyRecord {
  id: string;
  name: string;
  domain: string | null;
  website: string | null;
  industry: string | null;
  revenueRange: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  employeeRange: string | null;
  description: string | null;
  mergedIntoCompanyId: string | null;
}

export interface CompanyFacts {
  id: string;
  name: string;
  domain: string | null;
  website: string | null;
  industry: string | null;
  revenueRange: string | null;
  location: string | null;
  employeeRange: string | null;
}

export const COMPANY_DESCRIPTION_LIMIT = 500;

/** A merged company → its merge target, followed once; a target that is itself merged (or missing) → no company. */
export function resolveCompany(linked: CompanyRecord | null, mergeTarget: CompanyRecord | null): CompanyRecord | null {
  if (!linked) return null;
  if (!linked.mergedIntoCompanyId) return linked;
  if (!mergeTarget || mergeTarget.id !== linked.mergedIntoCompanyId || mergeTarget.mergedIntoCompanyId) return null;
  return mergeTarget;
}

const blank = (value: string | null | undefined) => !value?.trim();

/** Company first, contact fallback (industry, revenue range); null without a company. */
export function companyFacts(company: CompanyRecord | null, contact: { industry: string | null; revenueRange: string | null }): CompanyFacts | null {
  if (!company) return null;
  const location = [company.city, company.state, company.country].filter((v) => !blank(v)).join(", ");
  return {
    id: company.id,
    name: company.name,
    domain: company.domain,
    website: company.website,
    industry: blank(company.industry) ? contact.industry : company.industry,
    revenueRange: blank(company.revenueRange) ? contact.revenueRange : company.revenueRange,
    location: location || null,
    employeeRange: company.employeeRange,
  };
}

export function companyDescription(company: CompanyRecord | null): string | null {
  const text = company?.description?.trim();
  if (!text) return null;
  return text.length > COMPANY_DESCRIPTION_LIMIT ? `${text.slice(0, COMPANY_DESCRIPTION_LIMIT - 1)}…` : text;
}
