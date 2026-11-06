import { describe, expect, it } from "vitest";
import { bandOf, leadScore, type LeadScoreInput } from "../../src/domain/leadScore.js";

const NOW = new Date("2026-11-06T06:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const MOTM = ["engineering", "manufacturing", "steel", "epc", "water treatment"];
const base = (over: Partial<LeadScoreInput> = {}): LeadScoreInput => ({
  lifecycleState: "active",
  enquiry: null,
  email: "asha@gmail.com",
  company: "Not provided",
  industry: null,
  revenueRange: null,
  targetKeywords: MOTM,
  opens: [],
  replies: [],
  meetings: [],
  proposals: [],
  now: NOW,
  ...over,
});

describe("E3b-2b rule 15: hot-lead score", () => {
  it("nothing known → 0, cold", () => {
    expect(leadScore(base())).toEqual({ score: 0, band: "cold", reasons: [] });
  });

  it("enquiry: present 5, ≥ 15 words 5, a concrete need 5, a price / visit / ready signal 10 (max 25)", () => {
    expect(leadScore(base({ enquiry: "Hello there" })).score).toBe(5);
    expect(leadScore(base({ enquiry: "We want to reach new buyers" }))).toMatchObject({ score: 10, reasons: ["enquiry", "enquiry_need"] });
    const long = "We are a steel trader in Pune and we want to reach new buyers in Gujarat and Maharashtra this year please";
    expect(leadScore(base({ enquiry: long })).reasons).toEqual(["enquiry", "enquiry_detailed", "enquiry_need"]);
    expect(leadScore(base({ enquiry: `${long}. What is the price?` }))).toMatchObject({ score: 25, reasons: ["enquiry", "enquiry_detailed", "enquiry_need", "enquiry_signal"] });
    expect(leadScore(base({ enquiry: "Can you visit our factory?" })).reasons).toContain("enquiry_signal");
  });

  it("fit: corporate email 5, company 5, target industry 10, revenue 5 (free mail / placeholder / no keywords give nothing)", () => {
    const fit = base({ email: "asha@acmesteel.in", company: "Acme Steel", industry: "Steel trading", revenueRange: "50-100 Cr" });
    expect(leadScore(fit)).toMatchObject({ score: 25, reasons: ["corporate_email", "company", "target_industry", "revenue"] });
    expect(leadScore({ ...fit, targetKeywords: [] }).score).toBe(15);
    expect(leadScore({ ...fit, email: "asha@example.com" }).score).toBe(20);
    expect(leadScore(base({ industry: "EPC contractor" })).reasons).toEqual(["target_industry"]);
    expect(leadScore(base({ industry: "Depcon services" })).reasons).toEqual([]);
    expect(leadScore(base({ industry: "Water treatment plants" })).reasons).toEqual(["target_industry"]);
  });

  it("a consumer business has no fit", () => {
    const r = leadScore(base({ email: "owner@sweetbakery.in", company: "Sweet Bakery", industry: "Bakery", revenueRange: "1 Cr", enquiry: "We run a bakery" }));
    expect(r.reasons).toEqual(["enquiry", "consumer"]);
    expect(r.score).toBe(5);
  });

  it("engagement: opens in 14 days 1 → 5, 2+ → 10 (older ones don't count); question/other 15; positive 25; meeting 20; proposal 10", () => {
    expect(leadScore(base({ opens: [daysAgo(1)] })).score).toBe(5);
    expect(leadScore(base({ opens: [daysAgo(1), daysAgo(2), daysAgo(3)] })).score).toBe(10);
    expect(leadScore(base({ opens: [daysAgo(20)] })).score).toBe(0);
    expect(leadScore(base({ replies: [{ label: "question", at: daysAgo(1) }] })).score).toBe(15);
    expect(leadScore(base({ replies: [{ label: "other", at: daysAgo(1) }] })).score).toBe(15);
    expect(leadScore(base({ replies: [{ label: "question", at: daysAgo(1) }, { label: "positive", at: daysAgo(1) }] }))).toMatchObject({ score: 25, reasons: ["replied_positive"] });
    expect(leadScore(base({ replies: [{ label: "unclassified", at: daysAgo(1) }] })).score).toBe(0);
    expect(leadScore(base({ meetings: [daysAgo(1)] })).score).toBe(20);
    expect(leadScore(base({ proposals: [daysAgo(1)] })).score).toBe(10);
  });

  it("engagement is capped at 50 and the total at 100", () => {
    const all = base({
      enquiry: "We are a steel trader in Pune and we want to reach new buyers in Gujarat and Maharashtra, what is the price?",
      email: "asha@acmesteel.in",
      company: "Acme Steel",
      industry: "Steel",
      revenueRange: "50-100 Cr",
      opens: [daysAgo(1), daysAgo(2)],
      replies: [{ label: "positive", at: daysAgo(1) }],
      meetings: [daysAgo(1)],
      proposals: [daysAgo(1)],
    });
    expect(leadScore({ ...all, enquiry: null, email: null, company: null, industry: null, revenueRange: null }).score).toBe(50);
    expect(leadScore(all)).toMatchObject({ score: 100, band: "hot" });
  });

  it("engagement older than 30 days counts half (the newest one counts)", () => {
    expect(leadScore(base({ replies: [{ label: "positive", at: daysAgo(40) }] })).score).toBe(13);
    expect(leadScore(base({ meetings: [daysAgo(45)] })).score).toBe(10);
    expect(leadScore(base({ meetings: [daysAgo(45), daysAgo(2)] })).score).toBe(20);
    expect(leadScore(base({ proposals: [daysAgo(31)] })).score).toBe(5);
  });

  it("0 / cold for DNC, lost, won, merged, discarded and an asked-to-stop, not-interested or annoyed reply", () => {
    const hot = base({ replies: [{ label: "positive", at: daysAgo(1) }], meetings: [daysAgo(1)], proposals: [daysAgo(1)] });
    for (const lifecycleState of ["do_not_contact", "lost", "won", "merged", "discarded"]) {
      expect(leadScore({ ...hot, lifecycleState })).toEqual({ score: 0, band: "cold", reasons: ["closed"] });
    }
    for (const label of ["asked_to_stop", "not_interested", "annoyed"]) {
      expect(leadScore({ ...hot, replies: [...hot.replies, { label, at: daysAgo(2) }] })).toEqual({ score: 0, band: "cold", reasons: ["stopped"] });
    }
  });

  it("bands: hot ≥ 60, warm 30–59, cold < 30", () => {
    expect([bandOf(100), bandOf(60), bandOf(59), bandOf(30), bandOf(29), bandOf(0)]).toEqual(["hot", "hot", "warm", "warm", "cold", "cold"]);
  });
});
