import { describe, expect, it } from "vitest";
import type { AgentDecision } from "../../src/agent/decisionSchema.js";
import { buildGroundingMessages } from "../../src/agent/prompt.js";
import { draftDecision, type Usage } from "../../src/services/agentRunner.service.js";
import { createFakeDecisionModel } from "../helpers/fakeDecisionModel.js";
import { sampleContext } from "../helpers/agentContextFixture.js";

const NOW = new Date("2026-11-04T05:30:00Z"); // Wednesday 11:00 IST
const whatsapp = (body: string): AgentDecision => ({ action: "send_whatsapp", body, assetIds: [], nextWakeInDays: 3, reasoning: "Follow up." });

const NEHA = "We usually start by mapping the right corporate segments and decision-makers";
const PRIYA = "Based on our discussion, the focus was on a practical plan for reaching the right buyers.";
const IMRAN = "Our published client experiences also include industrial exporters";
const RITU = "we have worked with similar industrial companies";
const RAJ = "You mentioned TRC's requirement is already under discussion with us.";

describe("E3b-1 rule 8: checker prompt", () => {
  const system = () => buildGroundingMessages(whatsapp("Hi Asha, would Thursday or Friday suit you?"), sampleContext())![0]!.content;

  it("describing our approach for any B2B sector is supported (Neha); only results/experience claims are sector claims", () => {
    const text = system();
    expect(text).toContain(`SUPPORTED: describing HOW we work (our approach or process) for ANY B2B sector`);
    expect(text).toContain(NEHA);
    expect(text).toContain("unsupported_sector_claim: claims results, clients or experience in the lead's sector");
    expect(text).toContain("ALLOWED (not a violation): describing our approach or process for their sector");
  });

  it("flags invented history (Priya), one experience made plural (Imran / Ritu) and words put in the lead's mouth (Raj)", () => {
    const text = system();
    expect(text).toContain("UNSUPPORTED: saying what a past call, meeting, discussion or proposal contained, unless the latest call/note or the meeting outcome notes in lead_data say so.");
    expect(text).toContain(PRIYA);
    expect(text).toContain("UNSUPPORTED: turning ONE listed client experience into a plural or a pattern");
    expect(text).toContain(IMRAN);
    expect(text).toContain("similar industrial companies");
    expect(text).toContain('UNSUPPORTED: saying the lead said, asked or mentioned something ("you mentioned…", "you said…", "as you told us…") that is not in the lead\'s own data');
    expect(text).toContain(RAJ);
  });

  it("the internal context stays decide-only: never in the checker's messages", () => {
    const ctx = sampleContext({ internal: { companyDescription: "TRC runs a confidential plant expansion.", deal: { open: null, wonCount: 0, lostCount: 0 } } });
    const messages = buildGroundingMessages(whatsapp("Hi Asha."), ctx)!;
    expect(messages.map((m) => m.content).join("\n")).not.toContain("confidential plant expansion");
    expect(messages.map((m) => m.content).join("\n")).not.toContain("<internal_context>");
  });
});

describe("E3b-1 rule 8: flagged claims are regenerated (fake grounding model)", () => {
  const deps = (decisions: AgentDecision[], grounding: { supported: boolean; unsupportedClaims: string[] }[]) => ({
    model: createFakeDecisionModel({ decisions, grounding }),
    decisionModel: "m",
    groundingModel: "g",
    prices: { m: { inputPer1M: 1, outputPer1M: 1 }, g: { inputPer1M: 1, outputPer1M: 1 } },
    now: NOW,
  });
  const usage = (): Usage => ({ inputTokens: 0, outputTokens: 0, costUsd: 0 });
  const ctx = () => sampleContext({ rules: { ...sampleContext().rules, contactability: { email: null, whatsapp: null, phone: null } } });

  it.each([
    ["Priya", `Hi Priya, ${PRIYA} Would Thursday suit you?`, PRIYA],
    ["Imran", `Hi Imran, ${IMRAN}. Would Thursday suit you?`, IMRAN],
    ["Ritu", `Hi Ritu, ${RITU}. Would Thursday suit you?`, RITU],
    ["Raj", `Hi Raj, ${RAJ} Would Thursday suit you?`, RAJ],
  ])("%s: the flagged claim is fed back and the rewrite without it passes", async (_name, body, claim) => {
    const d = deps(
      [whatsapp(body), whatsapp("Hi, would a short call on Thursday or Friday suit you?")],
      [{ supported: false, unsupportedClaims: [claim] }, { supported: true, unsupportedClaims: [] }],
    );
    const result = await draftDecision(ctx(), d, usage());
    expect(result.attempts[0]!.problems).toEqual([`Unsupported claim: ${claim}`]);
    expect(result.decision).toMatchObject({ action: "send_whatsapp", body: "Hi, would a short call on Thursday or Friday suit you?" });
    const retry = d.model.calls.filter((c) => c.kind === "decide")[1]!.input.messages.at(-1)!.content;
    expect(retry).toContain(`Unsupported claim: ${claim}`);
  });

  it("Neha: an approach statement the checker supports goes through first time", async () => {
    const d = deps([whatsapp(`Hi Neha, ${NEHA}, then reach out to them for you. Would Thursday suit you?`)], [{ supported: true, unsupportedClaims: [] }]);
    const result = await draftDecision(ctx(), d, usage());
    expect(result.attempts).toHaveLength(1);
    expect(result.decision.action).toBe("send_whatsapp");
  });
});
