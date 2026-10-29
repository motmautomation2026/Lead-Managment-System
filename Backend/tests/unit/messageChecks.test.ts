import { describe, expect, it } from "vitest";
import type { AgentDecision } from "../../src/agent/decisionSchema.js";
import { checkMessage, compoundQuestion, findBannedPhrases, wordCount, type MessageCheckSettings } from "../../src/agent/messageChecks.js";

const DEFAULT_BANNED = [
  "thanks for connecting",
  "just following up",
  "just checking in",
  "any update",
  "this week",
  "today",
  "free",
  "guarantee",
  "guaranteed",
  "revolutionary",
  "skyrocket",
  "100+",
  "140+",
];
const settings: MessageCheckSettings = { banned_phrases: DEFAULT_BANNED, email_max_words: 160, whatsapp_max_words: 75 };

const whatsapp = (body: string): AgentDecision => ({ action: "send_whatsapp", body, assetIds: [], nextWakeInDays: 3, reasoning: "r" });
const email = (body: string, subject = "Next step"): AgentDecision => ({ action: "send_email", subject, body, assetIds: [], nextWakeInDays: 3, reasoning: "r" });
const rulesOf = (decision: AgentDecision) => checkMessage(decision, settings).map((v) => v.rule);

describe("findBannedPhrases", () => {
  it.each([
    ["Hi Suyash, thanks for connecting. Shall we talk?", ["thanks for connecting"]],
    ["THANKS FOR   CONNECTING!", ["thanks for connecting"]],
    ["Are you free on Monday?", ["free"]],
    ["We work with 100+ brands", ["100+"]],
    ["We have 2100+ brands", []],
    ["A freelancer helped us", []],
    ["Could we speak todayish", []],
    ["Is there any update on the proposal?", ["any update"]],
    ["See https://acme.in/free-trial?today=1 for the deck", []],
    ["See www.acme.in/guarantee and today's plan", ["today"]],
    ["नमस्ते, क्या आप free हैं?", ["free"]],
    ["आज बात करें? We guarantee nothing.", ["guarantee"]],
  ])("%s → %j", (text, expected) => {
    expect(findBannedPhrases(text, DEFAULT_BANNED)).toEqual(expected);
  });

  it("ignores blank phrases and matches custom regex-like phrases literally", () => {
    expect(findBannedPhrases("a (b) c", ["", "  ", "(b)"])).toEqual(["(b)"]);
    expect(findBannedPhrases("abc", ["a.c"])).toEqual([]);
  });
});

describe("compoundQuestion", () => {
  it.each([
    ["Which industries do you target, and how do you handle follow-ups?", true],
    ["Would a short call on Monday or Tuesday suit you?", false],
    ["What are your goals and what's blocking you?", true],
    ["Can we speak next week or would Thursday be better?", true],
    ["Do you sell to retailers and do you export?", true],
    ["Is growth or retention your focus?", false],
    ["Would you like to see our approach and pricing?", false],
    ["How do your sales and marketing teams work together?", false],
    ["Shall we set up a call, or is email easier?", true],
    ["Who handles your marketing and when can we talk?", true],
    ["What would a good next step look like for you and your team?", false],
    ["Thanks. And how is the launch going?", false],
    ["Are you in Pune and are you open to a visit?", true],
    ["Could we talk about expansion plans?", false],
    ["We help B2B firms and can share details. Would that help?", false],
    ["Would Tuesday work or does Wednesday suit?", true],
    ["No question here, and how it works is simple.", false],
  ])("%s → %s", (text, compound) => {
    expect(compoundQuestion(text) !== null).toBe(compound);
  });

  it("returns the offending sentence", () => {
    expect(compoundQuestion("Hi Raj. Which markets matter, and how do you sell?")).toBe("Which markets matter, and how do you sell?");
  });
});

describe("wordCount", () => {
  it("counts whitespace-separated words, Hindi too", () => {
    expect(wordCount("  a\n\nb   c ")).toBe(3);
    expect(wordCount("क्या हम सोमवार को बात करें")).toBe(6);
  });
});

describe("checkMessage", () => {
  it("passes a clean one-question message", () => {
    expect(checkMessage(whatsapp("Hi Raj, would a short call on Monday or Tuesday suit you?"), settings)).toEqual([]);
  });

  it("flags banned phrases in the email subject too", () => {
    expect(rulesOf(email("Hi Raj, shall we talk?", "Just checking in"))).toEqual(["banned_phrase"]);
  });

  it("word limits at the boundary, per channel, body only", () => {
    expect(rulesOf(whatsapp("word ".repeat(75)))).toEqual([]);
    expect(rulesOf(whatsapp("word ".repeat(76)))).toEqual(["length"]);
    expect(rulesOf(email("word ".repeat(160), "a long subject ".repeat(20)))).toEqual([]);
    expect(rulesOf(email("word ".repeat(161)))).toEqual(["length"]);
  });

  it("questions: more than one, compound, exclamation", () => {
    expect(rulesOf(whatsapp("Is Tuesday ok? Or Wednesday?"))).toEqual(["one_question"]);
    expect(rulesOf(whatsapp("Which industries do you target, and how do you handle follow-ups?"))).toEqual(["compound_question"]);
    expect(rulesOf(whatsapp("Great to hear from you! Shall we talk?"))).toEqual(["exclamation"]);
    expect(rulesOf(whatsapp("See https://acme.in/a?b=1#!x — shall we talk?"))).toEqual([]);
  });

  it("collects every violation and ignores non-send actions", () => {
    expect(rulesOf(whatsapp(`Thanks for connecting! ${"word ".repeat(80)} Is it ok? And what about today?`))).toEqual([
      "banned_phrase",
      "length",
      "one_question",
      "exclamation",
    ]);
    expect(checkMessage({ action: "wait", nextWakeInDays: 2, reasoning: "r" }, settings)).toEqual([]);
  });
});
