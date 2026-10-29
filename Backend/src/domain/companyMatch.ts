/**
 * Which company a contact belongs to (B2-design §2.1, steps 1-5). Pure: the
 * service looks up the existing companies and applies the decision.
 * Step 6 (similar names after a create) needs pg_trgm and lives in the service.
 */
import { corporateDomain, isPlaceholderCompany, normalizeCompanyName } from "./companyNormalize.js";

export interface CompanyRef {
  id: string;
  domain: string | null;
}

/** Trigram similarity at or above which two normalized names are "the same company" (pg_trgm similarity()). */
export const SIMILAR_NAME_THRESHOLD = 0.6;

export interface CompanyMatchInput {
  companyText: string | null;
  email: string | null;
  /** The non-merged company with the contact's normalized name, if any. */
  byName: CompanyRef | null;
  /** The non-merged company with the contact's corporate domain, if any, and the trigram similarity of its normalized name to the contact's. */
  byDomain: (CompanyRef & { similarity: number }) | null;
}

export type CandidateReason = "similar_name" | "same_domain_different_name" | "name_domain_conflict";

/**
 * A duplicate-review row next to the linked company: a pair with `otherCompanyId`,
 * or, with `otherCompanyId` null, a contact-level row (this contact's company
 * text or domain disagrees with the company it was linked to).
 */
export interface MatchCandidate {
  otherCompanyId: string | null;
  reason: CandidateReason;
}

export type CompanyMatch =
  | { action: "none"; candidates: [] }
  | { action: "link"; companyId: string; normalizedName: string; domain: string | null; candidates: MatchCandidate[] }
  | { action: "create"; normalizedName: string; domain: string | null; candidates: MatchCandidate[] };

export function companyMatch(input: CompanyMatchInput): CompanyMatch {
  // 1. Placeholder or only a legal suffix -> no company.
  if (isPlaceholderCompany(input.companyText)) return { action: "none", candidates: [] };
  // 2.
  const normalizedName = normalizeCompanyName(input.companyText!);
  const domain = corporateDomain(input.email);

  // 3. Same name: link; a different domain is flagged, never acted on.
  if (input.byName) {
    const candidates: MatchCandidate[] = [];
    if (input.byDomain && input.byDomain.id !== input.byName.id) {
      candidates.push({ otherCompanyId: input.byDomain.id, reason: "name_domain_conflict" });
    } else if (domain && input.byName.domain && input.byName.domain !== domain) {
      candidates.push({ otherCompanyId: null, reason: "name_domain_conflict" });
    }
    return { action: "link", companyId: input.byName.id, normalizedName, domain, candidates };
  }

  // 4. Same corporate domain, different name. E2f: the name wins. A similar name ("Tata Motor" vs
  // "Tata Motors") links by domain; a different one ("TML" vs "Tata Motors") gets its own company
  // (without the domain, which belongs to the other one) and a pair for admin review.
  if (input.byDomain && input.byDomain.similarity < SIMILAR_NAME_THRESHOLD) {
    return {
      action: "create",
      normalizedName,
      domain: null,
      candidates: [{ otherCompanyId: input.byDomain.id, reason: "same_domain_different_name" }],
    };
  }
  if (input.byDomain) {
    return {
      action: "link",
      companyId: input.byDomain.id,
      normalizedName,
      domain,
      candidates: [{ otherCompanyId: null, reason: "same_domain_different_name" }],
    };
  }

  // 5.
  return { action: "create", normalizedName, domain, candidates: [] };
}
