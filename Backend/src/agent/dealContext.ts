/**
 * The contact's deals as the agent sees them (D1). Pure. Internal context only:
 * the model may use it to decide what to do and when, never quote it. Amounts,
 * loss reasons/notes and owners are never read here.
 */
import { DEAL_STAGE_LABELS } from "../domain/dealRouting.js";
import type { DealStage } from "../domain/enums.js";

/** One of the contact's deals as buildAgentContext reads it. */
export interface AgentDealRow {
  id: string;
  name: string;
  stage: DealStage;
  updatedAt: Date;
  /** When the deal entered its current stage (last stage-change event, else created_at). */
  stageSince: Date;
  /** YYYY-MM-DD. */
  expectedCloseDate: string | null;
  /** The latest linked meeting / proposal (statuses only). */
  latestMeeting: { status: string; scheduledAt: string } | null;
  latestProposal: { status: string } | null;
}

export interface AgentOpenDeal {
  id: string;
  name: string;
  stage: DealStage;
  stageLabel: string;
  daysInStage: number;
  /** e.g. "December 2026". */
  expectedCloseMonth: string | null;
  latestMeeting: { status: string; scheduledAt: string } | null;
  latestProposal: { status: string } | null;
}

export interface AgentDealContext {
  open: AgentOpenDeal | null;
  wonCount: number;
  lostCount: number;
}

const DAY_MS = 24 * 3600 * 1000;
const isOpen = (stage: DealStage) => stage !== "won" && stage !== "lost";

function closeMonth(date: string | null): string | null {
  if (!date) return null;
  const [year, month] = date.split("-").map(Number);
  if (!year || !month) return null;
  return new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "UTC" }).format(Date.UTC(year, month - 1, 1));
}

/** The open deal = the most recently updated one (as `openDeal` in /contacts: updated_at desc, id desc). */
export function buildDealContext(deals: AgentDealRow[], now: Date): AgentDealContext {
  const open = deals
    .filter((d) => isOpen(d.stage))
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))[0];
  return {
    open: open
      ? {
          id: open.id,
          name: open.name,
          stage: open.stage,
          stageLabel: DEAL_STAGE_LABELS[open.stage],
          daysInStage: Math.max(0, Math.floor((now.getTime() - open.stageSince.getTime()) / DAY_MS)),
          expectedCloseMonth: closeMonth(open.expectedCloseDate),
          latestMeeting: open.latestMeeting,
          latestProposal: open.latestProposal,
        }
      : null,
    wonCount: deals.filter((d) => d.stage === "won").length,
    lostCount: deals.filter((d) => d.stage === "lost").length,
  };
}

export const hasDealContext = (deal: AgentDealContext) => Boolean(deal.open) || deal.wonCount > 0 || deal.lostCount > 0;
