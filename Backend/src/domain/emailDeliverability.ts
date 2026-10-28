/**
 * E1b deliverability check: grades the from-address domain's MX, SPF, DKIM and DMARC
 * records. Pure: the service does the DNS lookups (resolver injected) and passes the
 * results in. The check only reads DNS; it never blocks sending.
 */

export type CheckStatus = "green" | "amber" | "red";

export interface DeliverabilityLine {
  check: "mx" | "spf" | "dkim" | "dmarc";
  status: CheckStatus;
  summary: string;
  /** One plain-English sentence on how to fix it; null when green. */
  fix: string | null;
}

/** A DNS answer: records, "none" (NXDOMAIN / no data) or "error" (timeout, server failure). */
export type Lookup<T> = { records: T[] } | { error: string };

export const COMMON_DKIM_SELECTORS = ["google", "default", "selector1", "selector2", "zoho", "zmail", "s1", "s2", "k1", "mail", "dkim"] as const;

const ask = (domain: string) => `Ask whoever manages ${domain}'s DNS to`;
const couldNotCheck = (check: DeliverabilityLine["check"], label: string, error: string): DeliverabilityLine => ({
  check,
  status: "amber",
  summary: `Couldn't check ${label} (${error}).`,
  fix: "Try Re-check in a minute.",
});

/** TXT records arrive as chunks; join each record's chunks. */
export const joinTxt = (records: string[][]) => records.map((chunks) => chunks.join(""));

export function gradeMx(domain: string, lookup: Lookup<{ exchange: string }>): DeliverabilityLine {
  if ("error" in lookup) return couldNotCheck("mx", "MX", lookup.error);
  const hosts = lookup.records.map((r) => r.exchange).filter(Boolean);
  if (!hosts.length) {
    return { check: "mx", status: "red", summary: "No MX record: replies to this address can't be delivered.", fix: `${ask(domain)} add the MX records their mail provider gives them.` };
  }
  return { check: "mx", status: "green", summary: `MX found (${hosts.slice(0, 2).join(", ")}).`, fix: null };
}

export function gradeSpf(domain: string, lookup: Lookup<string>): DeliverabilityLine {
  if ("error" in lookup) return couldNotCheck("spf", "SPF", lookup.error);
  const spf = lookup.records.filter((r) => /^v=spf1(\s|$)/i.test(r.trim()));
  if (!spf.length) {
    return {
      check: "spf",
      status: "red",
      summary: "No SPF record: receivers can't tell that this mail server may send for the domain.",
      fix: `${ask(domain)} add one TXT record like "v=spf1 include:<your mail provider> ~all".`,
    };
  }
  if (spf.length > 1) {
    return {
      check: "spf",
      status: "red",
      summary: `${spf.length} SPF records: receivers treat that as no valid SPF at all.`,
      fix: `${ask(domain)} merge them into a single "v=spf1 … ~all" TXT record.`,
    };
  }
  const record = spf[0]!.trim();
  if (/\s[+?]all\b/i.test(` ${record}`)) {
    return {
      check: "spf",
      status: "amber",
      summary: `SPF ends with "${/[+?]all/i.exec(record)![0]}", which lets anyone send as ${domain}.`,
      fix: `${ask(domain)} change the end of the SPF record to "~all" (or "-all").`,
    };
  }
  if (!/\s[~-]all\b/i.test(` ${record}`)) {
    return { check: "spf", status: "amber", summary: "SPF has no closing \"~all\" or \"-all\".", fix: `${ask(domain)} end the SPF record with "~all".` };
  }
  return { check: "spf", status: "green", summary: "One SPF record found.", fix: null };
}

/** `found` = the selector whose `<selector>._domainkey` TXT has a key; `tried` = the selectors looked up. */
export function gradeDkim(domain: string, found: { selector: string; record: string } | null, tried: string[], error?: string): DeliverabilityLine {
  if (found) {
    if (/(^|;)\s*p=\s*(;|$)/i.test(found.record)) {
      return {
        check: "dkim",
        status: "red",
        summary: `The DKIM key at selector "${found.selector}" is empty (revoked).`,
        fix: `${ask(domain)} publish the current DKIM key from the mail provider's admin.`,
      };
    }
    return { check: "dkim", status: "green", summary: `DKIM key found at selector "${found.selector}".`, fix: null };
  }
  if (error) return couldNotCheck("dkim", "DKIM", error);
  return {
    check: "dkim",
    status: "red",
    summary: `No DKIM key found (tried ${tried.join(", ")}).`,
    fix: `Turn on DKIM signing in the mail provider's admin and ${ask(domain).replace(/^Ask/, "ask")} publish its key; or enter the provider's selector and Re-check.`,
  };
}

export function gradeDmarc(domain: string, lookup: Lookup<string>): DeliverabilityLine {
  if ("error" in lookup) return couldNotCheck("dmarc", "DMARC", lookup.error);
  const record = lookup.records.find((r) => /^v=DMARC1(\s|;|$)/i.test(r.trim()));
  if (!record) {
    return {
      check: "dmarc",
      status: "red",
      summary: "No DMARC record.",
      fix: `${ask(domain)} add a TXT record at _dmarc.${domain}: "v=DMARC1; p=none; rua=mailto:<an address you read>", then move to p=quarantine once reports look clean.`,
    };
  }
  const policy = /(?:^|;)\s*p\s*=\s*([a-z]+)/i.exec(record)?.[1]?.toLowerCase() ?? "none";
  if (policy === "none") {
    return {
      check: "dmarc",
      status: "amber",
      summary: "DMARC policy is p=none (monitoring only).",
      fix: `Once SPF and DKIM pass, ${ask(domain).replace(/^Ask/, "ask")} change the DMARC policy to p=quarantine.`,
    };
  }
  return { check: "dmarc", status: "green", summary: `DMARC policy is p=${policy}.`, fix: null };
}
