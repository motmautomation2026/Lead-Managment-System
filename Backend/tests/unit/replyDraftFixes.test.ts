/**
 * E3b-2a-2 rule 5: fixes from the 2026-11-04 email model test (Rakesh, Anil, the booking line). Fake models only.
 */
import { describe, expect, it } from "vitest";
import type { AgentDecision } from "../../src/agent/decisionSchema.js";
import { callDaysProblem, checkMessage } from "../../src/agent/messageChecks.js";
import { parsePrices } from "../../src/agent/pricing.js";
import { buildDecisionMessages, buildGroundingMessages, LISTED_EXPERIENCE_EXAMPLE } from "../../src/agent/prompt.js";
import { draftDecision, type Usage } from "../../src/services/agentRunner.service.js";
import { parseCombos, renderReport, runModelTest } from "../../src/services/agentModelTest.service.js";
import { createFakeDecisionModel } from "../helpers/fakeDecisionModel.js";
import { sampleContext } from "../helpers/agentContextFixture.js";

const NOW = new Date("2026-11-04T05:30:00Z"); // Wednesday 11:00 IST
const email = (body: string): AgentDecision => ({ action: "send_email", subject: "Buyers for hydraulics", body, assetIds: [], nextWakeInDays: 3, reasoning: "r" });
const whatsapp = (body: string): AgentDecision => ({ action: "send_whatsapp", body, assetIds: [], nextWakeInDays: 3, reasoning: "r" });
const SETTINGS = { banned_phrases: [], email_max_words: 120, whatsapp_max_words: 60 };
const STEEL_TRADER =
  "2. Industrial steel trader\n- Challenge: low margins, difficulty finding repeat buyers.\n- Approach: end-to-end cross-functional tele-calling, field visits and multi-channel engagement.\n- What the client said: they consistently acquired new customers and recurring business.";
const ANIL =
  `Hi Anil,\n\nOur role is to take on research, prospecting, outreach and follow-up, while your team keeps technical presales and closing.\n\n${LISTED_EXPERIENCE_EXAMPLE}, alongside their internal team.\n\nWould Thursday or Friday suit you for a short discussion?`;

describe("rule 5c: a call ask offers the two suggested days (both channels), never 'in the coming days'", () => {
  it("Rakesh's welcome email ('a short introductory call in the coming days') fails; two days pass", () => {
    expect(callDaysProblem("Hi Rakesh,\n\nThank you for reaching out.\n\nWould a short introductory call in the coming days suit you?")).toMatch(/without offering the two suggested days \("in the coming days"\)/);
    expect(callDaysProblem("Would Thursday or Friday suit you for a short call?")).toBeNull();
    expect(callDaysProblem("Could we speak briefly on Monday or Tuesday?")).toBeNull();
  });

  it("Rakesh's WhatsApp (days AND 'in the coming days') fails", () => {
    expect(callDaysProblem("Could we have a short call in the coming days, maybe Thursday or Friday?")).toBe('The message offers days and also says "in the coming days"; keep only the two days.');
  });

  it("one day, or no day, is not enough; a message that asks for no call is not checked", () => {
    expect(callDaysProblem("Would a short call on Thursday suit you?")).toMatch(/without offering/);
    expect(callDaysProblem("Shall we set up a call?")).toMatch(/without offering/);
    expect(callDaysProblem("Is improving repeat orders a priority for you this year?")).toBeNull();
    // A statement about a call is not an ask.
    expect(callDaysProblem("We usually start with a call to map your buyers. Is that useful?")).toBeNull();
  });

  it("is a code check on email and WhatsApp (rule call_days)", () => {
    const rules = (d: AgentDecision) => checkMessage(d, SETTINGS).map((v) => v.rule);
    expect(rules(email("Hi Rakesh,\n\nWould a short call in the coming days suit you?"))).toContain("call_days");
    expect(rules(whatsapp("Hi Rakesh, would a short call in the coming days suit you?"))).toContain("call_days");
    expect(rules(whatsapp("Hi Rakesh, would Thursday or Friday suit you for a short call?"))).not.toContain("call_days");
  });

  it("is fixable: the regeneration gets the problem and the two-day rewrite goes through", async () => {
    const model = createFakeDecisionModel({ decisions: [whatsapp("Hi Asha, would a short call in the coming days suit you?"), whatsapp("Hi Asha, would Thursday or Friday suit you for a short call?")] });
    const ctx = sampleContext({ rules: { ...sampleContext().rules, contactability: { email: null, whatsapp: null, phone: null } } });
    const prices = { m: { inputPer1M: 1, outputPer1M: 1 }, g: { inputPer1M: 1, outputPer1M: 1 } };
    const usage: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    const result = await draftDecision(ctx, { model, decisionModel: "m", groundingModel: "g", prices, now: NOW }, usage);
    expect(result.attempts[0]!.problems.some((p) => p.startsWith("call_days:"))).toBe(true);
    expect(result.decision).toMatchObject({ action: "send_whatsapp", body: "Hi Asha, would Thursday or Friday suit you for a short call?" });
  });
});

describe("rule 5b: the checker sees the writer's client experiences and accepts a claim that matches one", () => {
  const ctx = () =>
    sampleContext({
      knowledge: { query: "q", chunks: [{ id: "k1", title: "KB_MOTM_Client_Experiences", text: STEEL_TRADER }] },
      rules: { ...sampleContext().rules, contactability: { email: null, whatsapp: null, phone: null } },
    });
  const knowledgeOf = (content: string) => /<knowledge>\n([\s\S]*?)\n<\/knowledge>/.exec(content)?.[1];

  it("the writer and the checker get the same knowledge block", () => {
    const c = ctx();
    const writer = buildDecisionMessages(c, c.settings, NOW).map((m) => m.content).join("\n");
    const checker = buildGroundingMessages(email(ANIL), c)!.map((m) => m.content).join("\n");
    expect(knowledgeOf(writer)).toContain("Industrial steel trader");
    expect(knowledgeOf(checker)).toBe(knowledgeOf(writer));
  });

  it("the checker prompt says one listed client experience is supported in any sector, with Anil's message as the example", () => {
    const system = buildGroundingMessages(email(ANIL), ctx())![0]!.content;
    expect(system).toContain("SUPPORTED: naming ONE client experience the knowledge lists");
    expect(system).toContain("this is never an unsupported_sector_claim");
    expect(system).toContain(LISTED_EXPERIENCE_EXAMPLE);
    expect(system).toContain('naming ONE client experience the knowledge lists, as described there (e.g. "an industrial steel trader"), whatever the lead\'s sector');
  });

  it("a supported Anil message goes through first time (fake checker)", async () => {
    const model = createFakeDecisionModel({ decisions: [email(ANIL)], grounding: [{ supported: true, unsupportedClaims: [] }] });
    const prices = { m: { inputPer1M: 1, outputPer1M: 1 }, g: { inputPer1M: 1, outputPer1M: 1 } };
    const result = await draftDecision(ctx(), { model, decisionModel: "m", groundingModel: "g", prices, now: NOW }, { inputTokens: 0, outputTokens: 0, costUsd: 0 });
    expect(result.attempts).toHaveLength(1);
    expect(result.decision.action).toBe("send_email");
    expect(model.calls.find((c) => c.kind === "grounding")!.input.messages[1]!.content).toContain("tele-calling, field visits");
  });
});

describe("rule 5a: the model test says why there is no booking line", () => {
  const prices = parsePrices('{"gpt-5.1":{"inputPer1M":1,"outputPer1M":1},"gpt-4.1":{"inputPer1M":2,"outputPer1M":2}}');
  const combos = parseCombos("gpt-5.1>gpt-4.1");
  const CALL = whatsapp("Hi Asha, good to speak. Shall we talk on Monday or Tuesday?");

  it("owner without a booking link → 'no (owner has no booking link)' in the run and the report", async () => {
    const none = await runModelTest({ contexts: [sampleContext()], combos, model: createFakeDecisionModel({ decisions: [CALL] }), prices, now: NOW });
    expect(none.runs[0]).toMatchObject({ bookingLink: false, bookingLinkNote: "owner has no booking link" });
    expect(renderReport(none, combos, { at: NOW, contacts: 1 })).toContain("Booking link added: no (owner has no booking link)");
  });
});
