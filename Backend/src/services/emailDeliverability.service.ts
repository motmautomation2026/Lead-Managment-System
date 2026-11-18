import { Resolver } from "node:dns/promises";
import { pool } from "../db.js";
import { ValidationError } from "../errors.js";
import { COMMON_DKIM_SELECTORS, gradeDkim, gradeDmarc, gradeMx, gradeSpf, joinTxt, type Lookup } from "../domain/emailDeliverability.js";
import { domainOf } from "../domain/emailSafety.js";
import { withTimeout } from "../providers/email.provider.js";
import { loadEmailConnection } from "./emailConnection.service.js";

/**
 * E1b Settings → Email → Deliverability check: DNS lookups for the from-address domain
 * (5 s each, cached 10 min), graded by domain/emailDeliverability.ts. Reads DNS only;
 * never blocks sending. Tests pass a fake resolver.
 */

export interface DnsResolver {
  resolveMx(name: string): Promise<{ exchange: string }[]>;
  resolveTxt(name: string): Promise<string[][]>;
}

const LOOKUP_TIMEOUT_MS = 5_000;
const CACHE_MS = 10 * 60_000;
const NO_RECORDS = new Set(["ENOTFOUND", "ENODATA", "NXDOMAIN"]);

const systemResolver: DnsResolver = new Resolver({ timeout: LOOKUP_TIMEOUT_MS, tries: 1 });
const cache = new Map<string, { at: number; value: Lookup<unknown> }>();

async function lookup<T>(resolver: DnsResolver, key: string, run: () => Promise<T[]>): Promise<Lookup<T>> {
  const hit = resolver === systemResolver ? cache.get(key) : undefined;
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as Lookup<T>;
  let value: Lookup<T>;
  try {
    value = { records: await withTimeout(run(), LOOKUP_TIMEOUT_MS) };
  } catch (err) {
    const code = (err as { code?: string }).code ?? "error";
    value = NO_RECORDS.has(code) ? { records: [] } : { error: code === "TIMEOUT" || code === "ETIMEOUT" ? "DNS lookup timed out" : `DNS error ${code}` };
  }
  if (resolver === systemResolver) cache.set(key, { at: Date.now(), value });
  return value;
}

export async function runDeliverabilityCheck(domain: string, selector: string | null, resolver: DnsResolver = systemResolver) {
  const txt = (name: string) => lookup(resolver, `txt:${name}`, async () => joinTxt(await resolver.resolveTxt(name)));
  const selectors = selector ? [selector] : [...COMMON_DKIM_SELECTORS];
  const [mx, spf, dmarc, ...dkim] = await Promise.all([
    lookup(resolver, `mx:${domain}`, () => resolver.resolveMx(domain)),
    txt(domain),
    txt(`_dmarc.${domain}`),
    ...selectors.map((s) => txt(`${s}._domainkey.${domain}`)),
  ]);
  const foundAt = dkim.findIndex((r) => "records" in r && r.records.some((t) => /(^|;)\s*(v=DKIM1|p=)/i.test(t)));
  const found = foundAt >= 0 ? { selector: selectors[foundAt]!, record: (dkim[foundAt] as { records: string[] }).records.find((t) => /p=/i.test(t)) ?? "" } : null;
  const dkimError = dkim.every((r) => "error" in r) ? (dkim[0] as { error: string }).error : undefined;
  return {
    domain,
    checkedAt: new Date().toISOString(),
    lines: [gradeMx(domain, mx), gradeSpf(domain, spf as Lookup<string>), gradeDkim(domain, found, selectors, dkimError), gradeDmarc(domain, dmarc as Lookup<string>)],
  };
}

/** Admin only (route guard). The domain is the saved from address's. */
export async function checkDeliverability(workspaceId: string, selector: string | null) {
  const { row } = await loadEmailConnection(pool, workspaceId);
  const from = row.provider === "smtp" ? row.settings.senderAddress : undefined;
  if (!from) throw new ValidationError("Save the SMTP mailbox (from address) first.");
  return runDeliverabilityCheck(domainOf(from), selector);
}
