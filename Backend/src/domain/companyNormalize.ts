/**
 * Company names and email domains for CRM v2 company matching (B2-design §1.1, §2.1).
 * Pure: no I/O. `normalizeCompanyName` is the only normaliser; there is no SQL copy
 * (normalized_name is always computed here and stored).
 */
import { normalizeEmail } from "./email.js";

/** Free-mail providers: their domain says nothing about the contact's company. */
export const FREE_MAIL_DOMAINS: readonly string[] = [
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.co.in",
  "yahoo.in",
  "outlook.com",
  "hotmail.com",
  "rediffmail.com",
  "rediff.com",
  "live.com",
  "icloud.com",
  "protonmail.com",
  "aol.com",
  "ymail.com",
  "msn.com",
];
const FREE_MAIL = new Set(FREE_MAIL_DOMAINS);

// Legal-form words, stripped only from the END of a name ("ABC Co Pvt Ltd" -> "abc").
const LEGAL_SUFFIXES = new Set([
  "pvt",
  "private",
  "ltd",
  "limited",
  "llp",
  "inc",
  "incorporated",
  "llc",
  "corp",
  "corporation",
  "co",
  "company",
  "opc",
  "and", // left over from "& Co."
]);
// Compared after normalising, so "N.A." and "n/a" both become "n a".
const PLACEHOLDERS = new Set(["", "not provided", "na", "n a", "none", "unknown"]);

/** lower-case, "&" -> "and", punctuation removed, whitespace collapsed, trailing legal suffixes removed. */
export function normalizeCompanyName(name: string): string {
  const tokens = name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  while (tokens.length && LEGAL_SUFFIXES.has(tokens[tokens.length - 1]!)) tokens.pop();
  return tokens.join(" ");
}

/** True when the text names no real company: blank, "Not provided", NA, -, none, unknown, or only a legal suffix. */
export function isPlaceholderCompany(name: string | null | undefined): boolean {
  if (!name) return true;
  const raw = name.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return PLACEHOLDERS.has(raw) || PLACEHOLDERS.has(normalizeCompanyName(name));
}

/** The email's domain, lower-case, or null for free mail or an invalid address. */
export function corporateDomain(email: string | null | undefined): string | null {
  const normalized = email ? normalizeEmail(email) : null;
  const domain = normalized?.split("@")[1]?.replace(/\.$/, "");
  if (!domain || FREE_MAIL.has(domain)) return null;
  return domain;
}

/**
 * A domain typed by a user ("https://www.Acme.in/about" → "acme.in"), or null when it
 * isn't a domain. Free-mail domains pass through; callers reject them.
 */
export function normalizeDomain(input: string): string | null {
  const domain = input
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[/?#].*$/, "")
    .replace(/\.$/, "");
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain) ? domain : null;
}
