/**
 * Company revenue (in crore) and revenue-based owner assignment for new leads.
 * Pure: no I/O. The service layer loads the rules and the fallback owner.
 */

/** Parsed revenue in crore. A null bound is open-ended. */
export interface RevenueRange {
  minCr: number | null;
  maxCr: number | null;
}

export interface AssignmentRule {
  position: number;
  /** Exclusive lower bound (crore); null = no lower bound. */
  minCr: number | null;
  /** Inclusive upper bound (crore); null = no upper bound. */
  maxCr: number | null;
  ownerId: string;
  isActive: boolean;
}

const ABOVE = /\b(above|over|more than|greater than|exceeding|beyond)\b|>|\+/;
const BELOW = /\b(below|under|less than|up ?to|till|within)\b|</;
// Units we can't convert to crore safely: better unknown than wrong.
const FOREIGN_UNITS = /\b(million|billion|mn|bn|thousand|k|usd|eur|gbp)\b|\$|€|£/;
const NUMBER_WITH_UNIT = /(\d+(?:\.\d+)?)\s*(crores?|cr|lakhs?|lacs?|lac|l)?(?![a-z])/g;
const MAX_CR = 1_000_000_000; // fits numeric(12,2)

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Leniently parses revenue text such as "₹1–5 Cr", "5-10 Crore", "Above 50 Cr",
 * "Below 1 Cr", "50L-1Cr", "Rs 2.5 crore", "up to 50 lakh" or a bare "10"
 * (assumed crore). 100 lakh = 1 Cr. Returns null when it can't tell.
 */
export function parseRevenueRange(text: string | null | undefined): RevenueRange | null {
  if (!text) return null;
  const s = text
    .toLowerCase()
    .replace(/₹|\binr\b|\brs\b\.?/g, " ")
    .replace(/(\d),(?=\d)/g, "$1")
    .replace(/[–—−]/g, "-");
  if (FOREIGN_UNITS.test(s)) return null;
  const above = ABOVE.test(s);
  const below = BELOW.test(s);

  const matches = [...s.matchAll(NUMBER_WITH_UNIT)];
  if (matches.length === 0 || matches.length > 2) return null;
  // "1-5 Cr" / "50-100 lakh": a number without a unit takes the unit given elsewhere.
  const sharedUnit = matches.map((m) => m[2]).find(Boolean);
  const values = matches.map((m) => {
    const unit = m[2] ?? sharedUnit ?? "cr";
    return round2(Number(m[1]) / (unit.startsWith("l") ? 100 : 1));
  });
  if (values.some((v) => !Number.isFinite(v) || v > MAX_CR)) return null;

  if (values.length === 2) {
    const [minCr, maxCr] = values as [number, number];
    return minCr <= maxCr ? { minCr, maxCr } : null;
  }
  const value = values[0]!;
  if (above && below) return null;
  if (above) return { minCr: value, maxCr: null };
  if (below) return { minCr: null, maxCr: value };
  return { minCr: value, maxCr: value };
}

const cr = (n: number) => `₹${round2(n)} Cr`;

/** "₹5 Cr", "₹1–5 Cr", "above ₹50 Cr", "up to ₹1 Cr". */
export function describeRevenue(range: RevenueRange): string {
  const { minCr, maxCr } = range;
  if (minCr !== null && maxCr !== null) return minCr === maxCr ? cr(minCr) : `₹${round2(minCr)}–${round2(maxCr)} Cr`;
  if (minCr !== null) return `above ${cr(minCr)}`;
  if (maxCr !== null) return `up to ${cr(maxCr)}`;
  return "unknown";
}

/** "above ₹1 Cr up to ₹5 Cr", "above ₹5 Cr", "up to ₹5 Cr", "any revenue". */
export function describeRule(rule: Pick<AssignmentRule, "minCr" | "maxCr">): string {
  const parts = [rule.minCr !== null ? `above ${cr(rule.minCr)}` : "", rule.maxCr !== null ? `up to ${cr(rule.maxCr)}` : ""].filter(Boolean);
  return parts.join(" ") || "any revenue";
}

/**
 * Picks a new lead's owner. The lead's value is `maxCr ?? minCr`; active rules
 * are tried in position order and the first with value > minCr (when set) and
 * value <= maxCr (when set) wins. An open-ended "above X" lead is treated as
 * just over X, so it matches "above X" but not "up to X". Unknown revenue or
 * no match gives the fallback owner (which may be null = unassigned).
 */
export function resolveOwnerByRules(
  rules: readonly AssignmentRule[],
  revenue: RevenueRange | null,
  fallbackOwnerId: string | null,
): { ownerId: string | null; reason: string } {
  const fallback = fallbackOwnerId ? "default owner" : "unassigned";
  const value = revenue ? (revenue.maxCr ?? revenue.minCr) : null;
  if (!revenue || value === null) return { ownerId: fallbackOwnerId, reason: `Revenue unknown — ${fallback}` };
  const justAbove = revenue.maxCr === null;

  const ordered = rules.filter((rule) => rule.isActive).sort((a, b) => a.position - b.position);
  for (const rule of ordered) {
    const aboveMin = rule.minCr === null || value > rule.minCr || (justAbove && value === rule.minCr);
    const withinMax = rule.maxCr === null || (justAbove ? value < rule.maxCr : value <= rule.maxCr);
    if (aboveMin && withinMax) {
      return { ownerId: rule.ownerId, reason: `Revenue ${describeRevenue(revenue)} matched rule: ${describeRule(rule)}` };
    }
  }
  return { ownerId: fallbackOwnerId, reason: `No rule matched — ${fallback}` };
}

export const MAX_ASSIGNMENT_RULES = 50;

/** The first problem with a rule list an admin is saving, or null when it's valid. */
export function assignmentRulesProblem(rules: readonly Pick<AssignmentRule, "position" | "minCr" | "maxCr">[]): string | null {
  if (rules.length > MAX_ASSIGNMENT_RULES) return `At most ${MAX_ASSIGNMENT_RULES} rules are allowed.`;
  const positions = rules.map((rule) => rule.position).sort((a, b) => a - b);
  if (positions.some((position, index) => position !== index)) return "Rule positions must run 0, 1, 2… with no gaps or repeats.";
  for (const rule of [...rules].sort((a, b) => a.position - b.position)) {
    const label = `Rule ${rule.position + 1}`;
    for (const bound of [rule.minCr, rule.maxCr]) {
      if (bound !== null && !(Number.isFinite(bound) && bound >= 0 && bound <= MAX_CR)) return `${label}: revenue must be a positive number of crore.`;
    }
    if (rule.minCr !== null && rule.maxCr !== null && rule.minCr >= rule.maxCr) return `${label}: "From" must be less than "Up to".`;
  }
  return null;
}
