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
  "ymail.com",
  "outlook.com",
  "outlook.in",
  "hotmail.com",
  "hotmail.co.in",
  "live.com",
  "live.in",
  "msn.com",
  "rediffmail.com",
  "rediff.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "protonmail.com",
  "proton.me",
  // Zoho's free personal mail only; companies on Zoho use their own domain.
  "zoho.com",
  "zohomail.com",
  "gmx.com",
  "yandex.com",
  "mail.com",
];
const FREE_MAIL = new Set(FREE_MAIL_DOMAINS);

/** RFC 2606 / 6761 reserved names: test data, never a real company. */
const RESERVED_DOMAINS = new Set(["example.com", "example.org", "example.net"]);
const RESERVED_TLDS = ["test", "example", "invalid", "localhost"];

/** True for example.com/.org/.net and any *.test, *.example, *.invalid or *.localhost domain. */
export function isReservedDomain(domain: string): boolean {
  const tld = domain.slice(domain.lastIndexOf(".") + 1);
  return RESERVED_DOMAINS.has(domain) || RESERVED_TLDS.includes(tld);
}

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

/** The email's domain, lower-case, or null for free mail, a reserved/test domain or an invalid address. */
export function corporateDomain(email: string | null | undefined): string | null {
  const normalized = email ? normalizeEmail(email) : null;
  const domain = normalized?.split("@")[1]?.replace(/\.$/, "");
  if (!domain || FREE_MAIL.has(domain) || isReservedDomain(domain)) return null;
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
