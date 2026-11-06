import { describe, expect, it } from "vitest";
import type { AgentDecision } from "../../src/agent/decisionSchema.js";
import {
  checkMessage,
  compoundQuestion,
  findBannedPhrases,
  hasInboundThanks,
  internalLeaks,
  introductionPhrases,
  mentionsAttachment,
  messageFactsOf,
  whatsappTargetWords,
  wordCount,
  type MessageCheckSettings,
  type MessageFacts,
} from "../../src/agent/messageChecks.js";
import { sampleContext } from "../helpers/agentContextFixture.js";

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
    ["Hi Suyash, thanks for connecting. Shall we talk on Monday or Tuesday?", ["thanks for connecting"]],
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

  it.each([
    ["We cannot guarantee orders.", []],
    ["We can't guarantee specific outcomes", []],
    ["We can’t guarantee specific outcomes", []],
    ["We do not guarantee results", []],
    ["We don't promise or guarantee anything", []],
    ["We will never guarantee orders", []],
    ["There is no guarantee of orders", []],
    ["We won't guarantee orders", []],
    ["We are unable to guarantee orders", []],
    ["We offer guaranteed results", ["guaranteed"]],
    ["Not every firm says this, but we guarantee results", ["guarantee"]],
    ["We cannot guarantee orders, but we guarantee effort", ["guarantee"]],
    ["It is not free", []],
    ["We do not usually work today", []],
  ])("E2f negation: %s → %j", (text, expected) => {
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

describe("E2h rule 1: mentionsAttachment", () => {
  it.each([
    "I've attached a short case study",
    "I’ve attached a short case study",
    "Please find attached our profile.",
    "Please find our company profile.",
    "I'm sharing a case study on a similar company.",
    "I'm sharing a short case study.",
    "Sending you a case study from the steel sector.",
    "Case study attached",
    "See the attachment for details.",
    "The brochure is enclosed.",
    "Enclosed is our company profile.",
    "I am attaching the details.",
    "See the file attached to this email.",
    "Here is a short PDF on our approach.",
    "We've sent you a one-pager.",
  ])("true: %s", (text) => expect(mentionsAttachment(text)).toBe(true));

  it.each([
    "Our published client experiences describe how a steel trader built outbound.",
    "The plant has an attached garage and an attached warehouse.",
    "The sales team attached to the plant handles this.",
    "An enclosed gearbox is standard on this line.",
    "Thank you for sharing your requirements document.",
    "Thank you for sharing the document.",
    "Please find a time that works for you.",
    "Would you like me to send a case study?",
    "A semi-attached unit.",
    "Hi Asha, would a short call on Tuesday or Wednesday work?",
    "Details at https://motm.example/attached-file.pdf",
  ])("false: %s", (text) => expect(mentionsAttachment(text)).toBe(false));

  it("checkMessage flags a mention only when nothing will be attached, in the body or the subject", () => {
    expect(rulesOf(email("I've attached a short case study."))).toEqual(["attachment_mention"]);
    expect(rulesOf(email("Details below.", "Case study attached"))).toEqual(["attachment_mention"]);
    expect(rulesOf({ ...email("I've attached a short case study."), assetIds: ["a"] } as AgentDecision)).toEqual([]);
    expect(rulesOf(whatsapp("I'm sharing a case study on a similar company."))).toEqual(["attachment_mention"]);
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
    expect(rulesOf(email("Hi Raj, shall we talk on Monday or Tuesday?", "Just checking in"))).toEqual(["banned_phrase"]);
  });

  it("word limits at the boundary, per channel, body only", () => {
    expect(rulesOf(whatsapp("word ".repeat(75)))).toEqual([]);
    expect(rulesOf(whatsapp("word ".repeat(76)))).toEqual(["length"]);
    expect(rulesOf(email("word ".repeat(160), "a subject of six plain words"))).toEqual([]);
    expect(rulesOf(email("word ".repeat(161)))).toEqual(["length"]);
  });

  it("E3b-1b: the length feedback gives the count, how many words to cut and the opener to drop first", () => {
    const limits = { ...settings, whatsapp_max_words: 60 };
    const f = { inboundFirst: false, conversationExists: false, ownerFirstName: "Ravi", companyName: "MOTM Technologies", internalTexts: [], leadCompany: "Acme", threaded: false };
    expect(checkMessage(whatsapp("word ".repeat(60)), limits, f)).toEqual([]);
    const [violation] = checkMessage(whatsapp("word ".repeat(61)), limits, f);
    expect(violation!.message).toMatch(/^61 words; the limit is 60\. Cut at least 1 words: drop the "thank you for reaching out to MOTM Technologies" opener first/);
  });

  it("E3b-1b: the WhatsApp target is two thirds of the hard limit", () => {
    expect(whatsappTargetWords(60)).toBe(40);
    expect(whatsappTargetWords(50)).toBe(33);
  });

  it("questions: more than one, compound, exclamation", () => {
    expect(rulesOf(whatsapp("Is Tuesday ok? Or Wednesday?"))).toEqual(["one_question"]);
    expect(rulesOf(whatsapp("Which industries do you target, and how do you handle follow-ups?"))).toEqual(["compound_question"]);
    expect(rulesOf(whatsapp("Great to hear from you! Shall we talk on Monday or Tuesday?"))).toEqual(["exclamation"]);
    // A link's own "?" and "!" don't count (the link itself is a contact_details problem).
    expect(rulesOf(whatsapp("See https://acme.in/a?b=1#!x — shall we talk on Monday or Tuesday?"))).toEqual(["contact_details"]);
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

// --- E2c ---------------------------------------------------------------------------

const facts = (over: Partial<MessageFacts> = {}): MessageFacts => ({
  inboundFirst: false,
  conversationExists: false,
  ownerFirstName: "Govinda",
  companyName: "MOTM Technologies",
  internalTexts: [],
  leadCompany: "Acme Steel",
  threaded: false,
  ...over,
});
const e2cRules = (decision: AgentDecision, f: MessageFacts) => checkMessage(decision, settings, f).map((v) => v.rule);

describe("E2c rule 1: inbound first message thanks them", () => {
  it.each([
    ["Hello Suyash, thank you for contacting MOTM Technologies. Would a short call on Monday or Tuesday suit you?", true],
    ["Thanks for your enquiry about outbound calling.", true],
    ["Thank you for sharing your requirements with us.", true],
    ["THANK YOU FOR REACHING OUT, Asha.", true],
    ["Thanks so much for getting in touch with us.", true],
    ["Thank you for your inquiry on our website.", true],
    ["Thanks a lot for your interest in MOTM.", true],
    ["Thank you for writing to us, Raj.", true],
    ["Thank you for filling in the form on our website.", true],
    ["Thank you, Ravi, for submitting the enquiry form.", true],
    ["Thank-you for contacting us.", true],
    ["Hope you are well. Would a short call on Monday or Tuesday suit you?", false],
    ["Thanks. We help B2B firms; would a call suit you?", false],
    ["Thank you for your time on the call last week, which was very useful for sharing.", false],
    ["We are happy you are contacting us, thank you.", false],
  ])("%s → %s", (body, ok) => {
    expect(hasInboundThanks(body)).toBe(ok);
    expect(e2cRules(whatsapp(body), facts({ inboundFirst: true })).includes("not_thanking_inbound")).toBe(!ok);
  });

  it("is not checked for a message that is not the first one to an inbound lead", () => {
    expect(e2cRules(whatsapp("Hope you are well. Would a short call on Monday or Tuesday suit you?"), facts())).toEqual([]);
  });

  it("first = no real send and no current-playbook draft (shadow); inbound = website / form", () => {
    expect(messageFactsOf(sampleContext({ pastMessages: [], timeline: [] })).inboundFirst).toBe(true);
    expect(messageFactsOf(sampleContext()).inboundFirst).toBe(false); // the fixture has a v3 draft, playbook v3
    expect(messageFactsOf(sampleContext({ pastMessages: [], lead: { ...sampleContext().lead, source: "cold_call" } })).inboundFirst).toBe(false);
  });
});

describe("E2c rule 2: no introduction mid-conversation", () => {
  const f = facts({ conversationExists: true });
  it.each([
    "Hi Raj, thank you for reaching out. Shall we talk on Monday or Tuesday?",
    "Hi Raj, thank you for contacting us.",
    "Hi Raj, this is Govinda from MOTM Technologies.",
    "Hi Raj, I am Govinda from MOTM.",
    "Hi Raj, I’m Govinda from MOTM.",
    "Would an introductory call next week suit you?",
    "Shall we set up an introductory discussion?",
    "I'd like to introduce MOTM Technologies to your team.",
    "Let us introduce ourselves briefly.",
  ])("flags %s", (body) => {
    expect(e2cRules(whatsapp(body), f)).toContain("introduction_mid_conversation");
  });

  it("passes follow-ups, and is not checked without a conversation", () => {
    expect(e2cRules(whatsapp("Hi Raj, following the proposal, is the revised scope clear on your side?"), f)).toEqual([]);
    expect(e2cRules(whatsapp("Hi Raj, this is Govinda from MOTM Technologies."), facts())).toEqual([]);
    // Another person's name: not our owner introducing themselves.
    expect(introductionPhrases("This is Priya from your team's note.", f)).toEqual([]);
  });

  it("E2d: with a conversation, thank you for contacting is an introduction phrase (no inbound exception)", () => {
    expect(e2cRules(whatsapp("Hi Suyash, thank you for contacting MOTM. Is Monday or Tuesday good for the call we discussed?"), f)).toEqual(["introduction_mid_conversation"]);
  });

  it("the subject counts too", () => {
    expect(e2cRules(email("Hi Raj, shall we review the proposal?", "Introductory call"), f)).toEqual(["introduction_mid_conversation"]);
  });
});

describe("E2c rule 3: internal information leak", () => {
  const description = "TRC is a leading supplier of specialty chemicals for textile plants across Gujarat.";
  it("flags an exact run of 4+ words from the description, merged into one phrase", () => {
    expect(internalLeaks("We support TRC in specialty chemicals for textile plants.", [description])).toEqual(["specialty chemicals for textile plants"]);
  });
  it("ignores case and punctuation", () => {
    expect(internalLeaks("Specialty-Chemicals, for TEXTILE plants?", [description])).toEqual(["specialty chemicals for textile plants"]);
  });
  it("a 3-word overlap is not a leak", () => {
    expect(internalLeaks("We know specialty chemicals for many sectors.", [description])).toEqual([]);
  });
  it("a run of common words only is not a leak", () => {
    expect(internalLeaks("It is one of the best options.", ["It is one of the oldest firms in the city."])).toEqual([]);
  });
  it("checks the open deal name and the email subject, and feeds the phrase back", () => {
    const f = facts({ internalTexts: [description, "TRC Gujarat dyeing unit expansion"] });
    const v = checkMessage(email("Hi Raj, shall we talk on Monday or Tuesday?", "About the Gujarat dyeing unit expansion"), settings, f);
    expect(v).toEqual([{ rule: "internal_info_leak", message: 'Repeats internal information. Do not mention: "gujarat dyeing unit expansion".' }]);
  });
  it("messageFactsOf takes the company description and the open deal name", () => {
    const open = { id: "d-1", name: "TRC deal", stage: "negotiation" as const, stageLabel: "Negotiation", daysInStage: 3, expectedCloseMonth: null, latestMeeting: null, latestProposal: null };
    const ctx = sampleContext({ internal: { companyDescription: description, deal: { open, wonCount: 0, lostCount: 0 } } });
    expect(messageFactsOf(ctx)).toMatchObject({ internalTexts: [description, "TRC deal"], conversationExists: true, ownerFirstName: "Ravi" });
  });
});

describe("E3a: subject_style", () => {
  const facts = { inboundFirst: false, conversationExists: false, ownerFirstName: "Ravi", companyName: "MOTM Technologies", internalTexts: [], leadCompany: "SKF India", threaded: false };
  const check = (subject: string) => checkMessage(email("Hi Raj, shall we talk on Monday or Tuesday?", subject), settings, facts).filter((v) => v.rule === "subject_style");

  it("accepts a plain, specific subject, acronyms and company names", () => {
    for (const subject of ["Steel exports to Pune", "Your CRM enquiry", "B2B outbound for SKF", "MOTM and your Gujarat plant"]) expect(check(subject)).toEqual([]);
  });

  it("rejects more than 60 characters, more than 8 words, all caps words, Re: and Fwd:", () => {
    expect(check("x".repeat(61))[0]?.message).toContain("61 characters");
    expect(check("one two three four five six seven eight nine")[0]?.message).toContain("9 words");
    expect(check("URGENT steel exports")[0]?.message).toContain("URGENT");
    expect(check("Re: Steel exports")).toHaveLength(1);
    expect(check("FWD: Steel exports")).toHaveLength(1);
  });
});

describe("E3a: new banned phrases and links", () => {
  const added = ["hope you're doing well", "don't hesitate", "leverage", "feel free to", "in today's fast-paced", "game-changer", "I came across your"];

  it("finds them, also with a curly apostrophe", () => {
    expect(findBannedPhrases("Hope you\u2019re doing well, Raj. Don\u2019t hesitate to ask.", added)).toEqual(["hope you're doing well", "don't hesitate"]);
    expect(findBannedPhrases("We can leverage this. It's a game-changer.", added)).toEqual(["leverage", "game-changer"]);
  });

  it("the E2f negation rule still applies", () => {
    expect(findBannedPhrases("We will not leverage your data.", added)).toEqual([]);
  });

  it("a link, address or number polish couldn't remove needs a rewrite", () => {
    expect(rulesOf(whatsapp("Read more at https://motm.tech today, Raj"))).toContain("contact_details");
    expect(rulesOf(whatsapp("Write to ravi@motm.tech for details"))).toContain("contact_details");
    expect(rulesOf(whatsapp("Call me on +91 98765 43210 for details"))).toContain("contact_details");
    expect(rulesOf(whatsapp("We can start on 2026-11-08 with 40 calls"))).not.toContain("contact_details");
  });
});
