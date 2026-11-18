import { randomBytes } from "node:crypto";
import type { EmailSource } from "./emailSafety.js";

/**
 * E3b-2b rules 7–12: email open tracking, a soft signal only. Pure apart from the token's
 * randomness. An open never sends, wakes the agent, counts as a reply or reaches the writer.
 */

/** 128 random bits, URL-safe (base64url, 22 characters); no personal data in the link. */
export function newOpenToken(): string {
  return randomBytes(16).toString("base64url");
}

/** Checked before the database is touched: anything else gets the GIF and nothing is recorded. */
export const OPEN_TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;

/** Rule 7: only AI agent and workflow emails carry the pixel (never reply drafts, proposals, meetings or tests). */
export function isTrackedSource(source: EmailSource): boolean {
  return source === "agent" || source === "scheduled_action";
}

/** Rule 12: an open within this long after sending is a prefetch (mail filters, Apple Mail): open_count only. */
export const PREFETCH_WINDOW_MS = 60_000;

/** The 1×1 transparent GIF served for every request to the pixel route. */
export const TRANSPARENT_GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

/** Rule 9: the pixel goes at the very end of the HTML part (before </body> when there is one). */
export function withOpenPixel(html: string, baseUrl: string, token: string): string {
  const img = `<img src="${baseUrl}/t/o/${token}.gif" width="1" height="1" alt="" style="display:block;border:0">`;
  const end = html.search(/<\/body>/i);
  return end < 0 ? `${html}${img}` : `${html.slice(0, end)}${img}${html.slice(end)}`;
}

/**
 * Rule 10: PUBLIC_API_BASE_URL — missing = tracking off; malformed = a startup error; https in
 * production. Returns the URL without a trailing slash.
 */
export function parsePublicApiBaseUrl(value: string | undefined, nodeEnv: string): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("PUBLIC_API_BASE_URL must be a full URL like https://api.example.com.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("PUBLIC_API_BASE_URL must start with https:// (or http:// outside production).");
  if (nodeEnv === "production" && url.protocol !== "https:") throw new Error("PUBLIC_API_BASE_URL must use https in production.");
  if (url.search || url.hash || url.username || url.password) throw new Error("PUBLIC_API_BASE_URL must not contain a query, fragment or login.");
  return url.toString().replace(/\/+$/, "");
}

/** Per-IP request limit for the public pixel route, in memory (rule 11). Over the limit still gets the GIF, but nothing is recorded. */
export function createRateLimiter(limit: number, windowMs: number, now: () => number = Date.now) {
  let windowStart = now();
  let counts = new Map<string, number>();
  return (key: string): boolean => {
    if (now() - windowStart >= windowMs) {
      windowStart = now();
      counts = new Map();
    }
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    return n <= limit;
  };
}
