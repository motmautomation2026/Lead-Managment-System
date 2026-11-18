/**
 * LL-2 rule 3: the staff emails' text (pure). Urgent alerts batched per person per tick, and the 09:00 IST
 * morning digest. Plain text + simple HTML, links to CRM records; no unsubscribe footer, no tracking pixel.
 */
import { textToHtml } from "./reminders.js";

export const APP_NAME = "MOTM Flow";

export interface AlertItem {
  title: string;
  detail: string | null;
  href: string | null;
}

const link = (baseUrl: string, href: string | null) => (baseUrl && href ? `${baseUrl}${href.startsWith("/") ? href : `/${href}`}` : null);
const firstName = (name: string | null) => name?.trim().split(/\s+/)[0] || "there";

/** One email for every urgent alert a person got this tick. */
export function alertEmail(name: string | null, items: AlertItem[], baseUrl: string): { subject: string; text: string; html: string } {
  const subject = items.length === 1 ? `${APP_NAME}: ${items[0]!.title}` : `${APP_NAME}: ${items.length} urgent alerts`;
  const lines = [`Hi ${firstName(name)},`, ""];
  for (const item of items) {
    lines.push(`• ${item.title}`);
    if (item.detail) lines.push(`  ${item.detail.replace(/\n/g, "\n  ")}`);
    const url = link(baseUrl, item.href);
    if (url) lines.push(`  ${url}`);
    lines.push("");
  }
  lines.push(`You get these because "Email me urgent alerts" is on (${APP_NAME} → Settings → My profile).`);
  const text = lines.join("\n").slice(0, 20_000);
  return { subject: subject.slice(0, 200), text, html: textToHtml(text) };
}

export interface DigestCounts {
  calls: number;
  replies: number;
  meetings: number;
  nextSteps: number;
  overdue: number;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The morning digest, or null when there is nothing open (empty digests are skipped). */
export function digestEmail(name: string | null, workspaceName: string, c: DigestCounts, baseUrl: string): { subject: string; text: string; html: string } | null {
  if (c.calls + c.replies + c.meetings + c.nextSteps + c.overdue === 0) return null;
  const rows: [number, string, string | null][] = [
    [c.calls, plural(c.calls, "call due today or overdue", "calls due today or overdue"), "/tasks/calls"],
    [c.replies, plural(c.replies, "reply waiting", "replies waiting"), "/tasks/replies"],
    [c.meetings, plural(c.meetings, "meeting today", "meetings today"), "/meetings"],
    [c.nextSteps, plural(c.nextSteps, '"Decide the next step" task', '"Decide the next step" tasks'), "/tasks?status=open&q=Decide%20the%20next%20step"],
    [c.overdue, plural(c.overdue, "overdue task", "overdue tasks"), "/tasks?status=open"],
  ];
  const shown = rows.filter(([n]) => n > 0);
  const lines = [`Hi ${firstName(name)},`, "", `Your day in ${workspaceName}:`, ""];
  for (const [, label, href] of shown) {
    lines.push(`• ${label}`);
    const url = link(baseUrl, href);
    if (url) lines.push(`  ${url}`);
  }
  lines.push("", `You get this because "Morning digest" is on (${APP_NAME} → Settings → My profile).`);
  const text = lines.join("\n");
  const summary = shown.slice(0, 3).map(([, label]) => label.replace(/ due today or overdue| waiting| today/g, "")).join(", ");
  return { subject: `${APP_NAME}: your day — ${summary}`.slice(0, 200), text, html: textToHtml(text) };
}

/** 09:00–12:00 IST, Monday–Saturday: when the digest goes (once per member per IST day). */
export function digestWindowOpen(now: Date): boolean {
  const ist = new Date(now.getTime() + 330 * 60_000);
  const day = ist.getUTCDay();
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return day !== 0 && minutes >= 9 * 60 && minutes < 12 * 60;
}
