/**
 * AI-FIX-1: the writing problems found in the DEMO-1 demo journey (Sagar Khanna, Reshma Tantry). Fake models only.
 */
import { describe, expect, it } from "vitest";
import type { AgentDecision } from "../../src/agent/decisionSchema.js";
import {
  callThanks,
  checkMessage,
  experienceLabel,
  isListedExperienceClaim,
  messageFactsOf,
  playbookClientExperiences,
  usedClientExperiences,
} from "../../src/agent/messageChecks.js";
import { applyGroundingAllowList, buildDecisionMessages, buildGroundingMessages, callNoteQuestions } from "../../src/agent/prompt.js";
import { ANGLE_RULES, CALL_ANGLES, type StagePlan } from "../../src/agent/stagePlan.js";
import { greetByFirstName, writeReplyDraft } from "../../src/agent/replyDraftWriter.js";
import { draftDecision, type Usage } from "../../src/services/agentRunner.service.js";
import { createFakeDecisionModel } from "../helpers/fakeDecisionModel.js";
import { sampleContext } from "../helpers/agentContextFixture.js";

const NOW = new Date("2026-11-23T04:40:00Z"); // Monday 10:10 IST
const SETTINGS = { banned_phrases: [], email_max_words: 120, whatsapp_max_words: 60 };
const email = (body: string): AgentDecision => ({ action: "send_email", subject: "UAE buyer outreach", body, assetIds: [], nextWakeInDays: 3, reasoning: "r" });
const whatsapp = (body: string): AgentDecision => ({ action: "send_whatsapp", body, assetIds: [], nextWakeInDays: 3, reasoning: "r" });

// The CLIENT EXPERIENCES section of AI_PLAYBOOK_v7 (demo-local/ is git-ignored, so it is copied here).
const PLAYBOOK = `GOOD FIT
Engineering and manufacturing companies.

CLIENT EXPERIENCES (public testimonials; qualitative only)
Use at most one per message, the one closest to the lead's PROBLEM (industry second).
- A premium industrial automation company (Indian subsidiary of a global group): tailored account-based outreach helped them reach relevant stakeholders and get high-quality leads within several months.
- An industrial steel trader: combined calling, field visits and multi-channel engagement helped them consistently acquire new customers and repeat business.
- An environmental EPC company (ETP/STP) that relied on referrals: regular calling, email and disciplined follow-up improved their visibility and sales consistency.
- A precision machined components company (part of an international group): targeted outreach connected them with relevant Tier-1 and OEM decision-makers across India.
- An industrial belt manufacturer: research and importer targeting helped them connect with decision-makers for exports.
Do not claim proven results in a sector that is not listed here (for example IT); explain our approach instead.

MESSAGE ANGLE BY STATED PROBLEM
- Poor conversion: qualification, handoffs and follow-up.`;
const EXPERIENCES = playbookClientExperiences(PLAYBOOK);

const RESHMA_STEP3 = "We have done similar account-based work for a premium industrial automation company.";
const RESHMA_STEP4 =
  "We have worked with a premium industrial automation company where tailored account-based outreach helped them reach relevant stakeholders and get high-quality leads within several months.";
const SAGAR_STEP3 =
  "Hi Sagar,\n\nThanks for your time on the call.\n\nWe have also worked with an environmental EPC company that relied on referrals, where regular calling, emailing and disciplined follow-up improved visibility and sales consistency.\n\nWould Thursday or Friday suit you for a short call?";
const SAGAR_STEP4 =
  "Sagar, one relevant example was an environmental EPC company that relied on referrals. Regular calling, email and disciplined follow-up helped improve visibility and sales consistency. Would that help?";

/** A contact in conversation (a call was logged) with the v7-style playbook. */
const inConversation = (pastBodies: string[] = []) =>
  sampleContext({
    playbook: { version: 7, body: PLAYBOOK },
    pastMessages: pastBodies.map((body, i) => ({ at: `2026-11-1${8 + i}T04:40:00.000Z`, channel: i % 2 ? "whatsapp" : "email", subject: null, body, outcome: "sent", playbookVersion: 7 })),
  });

describe("AI-FIX-1 rule 1: an approved client experience is not unsupported and not an introduction", () => {
  it("reads the playbook's CLIENT EXPERIENCES bullets and names each one", () => {
    expect(EXPERIENCES).toHaveLength(5);
    expect(EXPERIENCES.map(experienceLabel)).toEqual([
      "premium industrial automation company",
      "industrial steel trader",
      "environmental EPC company",
      "precision machined components company",
      "industrial belt manufacturer",
    ]);
    expect(playbookClientExperiences("Tone: warm and direct.")).toEqual([]);
    expect(playbookClientExperiences(null)).toEqual([]);
  });

  it("the code check never calls Reshma's two sentences an introduction", () => {
    const facts = messageFactsOf(inConversation());
    expect(facts.conversationExists).toBe(true);
    for (const sentence of [RESHMA_STEP3, RESHMA_STEP4]) {
      expect(checkMessage(email(`Hi Reshma,\n\n${sentence}\n\nWould Thursday or Friday suit you for a short call?`), SETTINGS, facts).map((v) => v.rule)).toEqual([]);
    }
  });

  it("both sentences are faithful paraphrases of a listed experience; plurals, numbers and unlisted claims are not", () => {
    expect(isListedExperienceClaim(RESHMA_STEP3, EXPERIENCES)).toBe(true);
    expect(isListedExperienceClaim(RESHMA_STEP4, EXPERIENCES)).toBe(true);
    expect(isListedExperienceClaim("We have worked with similar industrial automation companies.", EXPERIENCES)).toBe(false);
    expect(isListedExperienceClaim("A premium industrial automation company got 3x more leads within several months.", EXPERIENCES)).toBe(false);
    expect(isListedExperienceClaim("We have worked with a premium industrial automation company in the GCC region.", EXPERIENCES)).toBe(false);
    expect(isListedExperienceClaim("We have done outreach in the GCC region before.", EXPERIENCES)).toBe(false);
  });

  it("the checker's flags on both sentences (claim + introduction) are dropped; other flags stay", () => {
    const ctx = inConversation();
    for (const sentence of [RESHMA_STEP3, RESHMA_STEP4]) {
      const checked = applyGroundingAllowList(
        { supported: false, unsupportedClaims: [sentence], styleViolations: [{ rule: "introduction_mid_conversation", quote: sentence }] },
        ctx,
        NOW,
      );
      expect(checked.supported).toBe(true);
      expect(checked.unsupportedClaims).toEqual([]);
      expect(checked.styleViolations).toEqual([]);
    }
    const kept = applyGroundingAllowList(
      { supported: false, unsupportedClaims: ["We have worked with similar industrial automation companies."], styleViolations: [{ rule: "introduction_mid_conversation", quote: "I'm Naitik from MOTM." }] },
      ctx,
      NOW,
    );
    expect(kept.supported).toBe(false);
    expect(kept.styleViolations).toHaveLength(1);
  });

  it("the checker receives the client experiences as an approved source and the introduction rule allows one", () => {
    const [system] = buildGroundingMessages(email(`Hi Reshma,\n\n${RESHMA_STEP4}`), inConversation())!;
    expect(system!.content).toContain("APPROVED CLIENT EXPERIENCES (from the playbook; an approved source");
    for (const experience of EXPERIENCES) expect(system!.content).toContain(experience);
    expect(system!.content).toContain('"We have done similar <approach> work for <one experience>."');
    expect(system!.content).toMatch(/introduction_mid_conversation:.*It is about introducing us again.*naming ONE approved client experience/);
    // Without the section nothing is added.
    expect(buildGroundingMessages(email("Hi Asha,\n\nThanks."), sampleContext())![0]!.content).not.toContain("APPROVED CLIENT EXPERIENCES");
  });
});

describe("AI-FIX-1 rule 2: never the same client experience twice for one lead", () => {
  it("finds the experiences earlier messages used (real sends and current-playbook drafts only)", () => {
    expect(usedClientExperiences(inConversation([SAGAR_STEP3]))).toEqual(["environmental EPC company"]);
    expect(usedClientExperiences(inConversation(["Hi Sagar, thanks for the call."]))).toEqual([]);
    const oldDraft = inConversation();
    oldDraft.pastMessages = [{ at: "2026-11-18T04:40:00.000Z", channel: "email", subject: null, body: SAGAR_STEP3, outcome: "draft", playbookVersion: 6 }];
    expect(usedClientExperiences(oldDraft)).toEqual([]);
  });

  it("Sagar's step 4 repeating the EPC company fails repeated_client_experience; another experience passes", () => {
    const facts = messageFactsOf(inConversation([SAGAR_STEP3]));
    expect(facts.usedExperiences).toEqual(["environmental EPC company"]);
    const repeated = checkMessage(whatsapp(SAGAR_STEP4), SETTINGS, facts);
    expect(repeated.map((v) => v.rule)).toEqual(["repeated_client_experience"]);
    expect(repeated[0]!.message).toContain('"environmental EPC company"');
    const other = "Sagar, one relevant example is an industrial steel trader where calling, field visits and multi-channel engagement helped them win new customers. Would that help?";
    expect(checkMessage(whatsapp(other), SETTINGS, facts)).toEqual([]);
  });

  it("the writer is told which experiences were used (no line without any)", () => {
    const user = buildDecisionMessages(inConversation([SAGAR_STEP3]), inConversation().settings, NOW)[1]!.content;
    expect(user).toContain("Client experiences already used with this contact: environmental EPC company. Never use one of them again");
    expect(buildDecisionMessages(inConversation(), inConversation().settings, NOW)[1]!.content).not.toContain("Client experiences already used");
  });

  it("a repeat is fixable: the regeneration picks another experience and passes", async () => {
    const ctx = inConversation([SAGAR_STEP3]);
    ctx.settings = { ...ctx.settings, banned_phrases: [] };
    const model = createFakeDecisionModel({
      decisions: [whatsapp(SAGAR_STEP4), whatsapp("Sagar, one relevant example is an industrial steel trader where calling and field visits helped them win new customers. Would that help?")],
    });
    const usage: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    const result = await draftDecision(ctx, { model, decisionModel: "w", groundingModel: "c", prices: {}, now: NOW }, usage);
    expect(result.attempts.map((a) => a.problems.map((p) => p.split(":")[0]))).toEqual([["repeated_client_experience"], []]);
    expect(result.decision.action).toBe("send_whatsapp");
  });
});

const plan = (angle: "final_check" | "call_followup", channel: "email" | "whatsapp" = "email"): StagePlan => ({
  stageKey: "after_call",
  angle,
  allowedActions: [`send_${channel}`, "wait", "handoff", "update_stage", "stop"],
  preferredChannel: channel,
  reason: angle === "final_check" ? "continuing after the call" : "a rep logged a call or note since our last message",
  fallback: { action: "wait", days: 7 },
});
const callOn = (at: string, detail: string) => [{ at, kind: "call", title: "Call Connected - interested_later", detail }];
const FINAL_NOW = new Date("2026-12-09T04:40:00Z"); // Wed 9 Dec 2026, 10:10 IST: three weeks after the call
const SAGAR_NOTE = "Spoke for 10 minutes. Gets most work through contacts and referrals. Wants regular enquiries from plants and EPC companies. Asked for examples of similar work.";
const RESHMA_NOTE =
  "Spoke for 15 minutes. Altem wants meetings with automation buyers in the UAE and Saudi Arabia. Their own sales team is small. Looking for outsourced SDR support. Asked how we qualify leads before passing them on.";
const SAGAR_STEP6 =
  "Hi Sagar,\n\nThank you for your time on the call. You mentioned that most work still comes through contacts and referrals.\n\nWould you like me to stay in touch later?";
const GOOD_FINAL = "Hi Sagar,\n\nI wanted to check whether regular enquiries from plants and EPC companies are still a priority for your team. If the timing is not right, I am happy to reconnect later.";

describe("AI-FIX-1 rule 3: the final polite check is short and different", () => {
  it("the writer's final_check rule: goal still a priority, reconnect later; no old-call thanks, recap or call request", () => {
    const system = buildDecisionMessages(sampleContext(), sampleContext().settings, FINAL_NOW)[0]!.content;
    expect(system).toContain("final_check: the last message, short and different from every earlier one: one simple question whether the goal they told us is still a priority");
    expect(ANGLE_RULES.final_check).toMatch(/No thanks for a call older than a week, no recap of earlier messages, no call request, no days/);
    expect(CALL_ANGLES).not.toContain("final_check");
  });

  it("finds thanks for a call; other thanks are fine", () => {
    expect(callThanks("Thank you for your time on the call.")).toBe("Thank you for your time on the call");
    expect(callThanks("Thanks for the call yesterday, Reshma.")).toBe("Thanks for the call");
    expect(callThanks("Thank you so much for speaking with me.")).toBe("Thank you so much for speaking with me");
    expect(callThanks("Thank you for reaching out to MOTM.")).toBeNull();
    expect(callThanks("Thanks for sharing the details.")).toBeNull();
  });

  it("thanks for a call more than 7 days old fails stale_call_thanks; a recent call doesn't", () => {
    const old = sampleContext({ timeline: callOn("2026-11-17T04:35:00.000Z", SAGAR_NOTE), stagePlan: plan("final_check") });
    const facts = messageFactsOf(old, FINAL_NOW);
    expect(facts).toMatchObject({ staleCall: true, finalCheck: true });
    expect(checkMessage(email(SAGAR_STEP6), SETTINGS, facts).map((v) => v.rule)).toEqual(["stale_call_thanks"]);
    expect(messageFactsOf(old).staleCall).toBe(false); // no clock, no check
    const recent = messageFactsOf(old, new Date("2026-11-18T04:40:00Z"));
    expect(recent.staleCall).toBe(false);
    expect(checkMessage(email(SAGAR_STEP6), SETTINGS, recent)).toEqual([]);
  });

  it("a final check asking for a call without days fails call_days with 'no call' advice (not 'offer the days'); a goal check passes", () => {
    const facts = messageFactsOf(sampleContext({ timeline: callOn("2026-11-17T04:35:00.000Z", SAGAR_NOTE), stagePlan: plan("final_check") }), FINAL_NOW);
    expect(checkMessage(email("Hi Sagar,\n\nShall we set up a short call?"), SETTINGS, facts)).toEqual([
      { rule: "call_days", message: "The final check doesn't ask for a call. Ask one simple question whether their goal is still a priority, and offer to reconnect later." },
    ]);
    expect(checkMessage(email(GOOD_FINAL), SETTINGS, facts)).toEqual([]);
  });

  it("stale thanks is fixable: the regeneration passes", async () => {
    const ctx = sampleContext({ timeline: callOn("2026-11-17T04:35:00.000Z", SAGAR_NOTE), stagePlan: plan("final_check"), pastMessages: [] });
    ctx.settings = { ...ctx.settings, banned_phrases: [] };
    const model = createFakeDecisionModel({ decisions: [email(SAGAR_STEP6), email(GOOD_FINAL)] });
    const usage: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    const result = await draftDecision(ctx, { model, decisionModel: "w", groundingModel: "c", prices: {}, now: FINAL_NOW }, usage);
    expect(result.attempts.map((a) => a.problems.map((p) => p.split(":")[0]))).toEqual([["stale_call_thanks"], []]);
  });
});

describe("AI-FIX-1 rule 5: the call follow-up answers what the lead asked on the call", () => {
  it("finds the question sentences in a call note", () => {
    expect(callNoteQuestions(RESHMA_NOTE)).toEqual(["Asked how we qualify leads before passing them on."]);
    expect(callNoteQuestions(SAGAR_NOTE)).toEqual(["Asked for examples of similar work."]);
    expect(callNoteQuestions("Budget next quarter")).toEqual([]);
    expect(callNoteQuestions(null)).toEqual([]);
  });

  it("the writer's prompt carries Reshma's question and the instruction to answer it from the knowledge", async () => {
    const ctx = sampleContext({ timeline: callOn("2026-11-17T04:35:00.000Z", RESHMA_NOTE), stagePlan: plan("call_followup") });
    const model = createFakeDecisionModel({ decisions: [{ action: "wait", nextWakeInDays: 2, reasoning: "r" } as AgentDecision] });
    const usage: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    await draftDecision(ctx, { model, decisionModel: "w", groundingModel: "c", prices: {}, now: new Date("2026-11-18T04:40:00Z") }, usage);
    const [system, user] = model.calls[0]!.input.messages;
    expect(user!.content).toContain(
      'The lead asked on the call: "Asked how we qualify leads before passing them on." Answer it in one sentence using only the knowledge or playbook (say what we actually do), without inventing details; never only say it is covered or built in.',
    );
    expect(system!.content).toContain("If the note records a question from the lead, answer it in one sentence from the knowledge or playbook");
    // Only for the call follow-up, and never in the checker's lead data.
    const later = sampleContext({ timeline: callOn("2026-11-17T04:35:00.000Z", RESHMA_NOTE), stagePlan: plan("final_check") });
    expect(buildDecisionMessages(later, later.settings, FINAL_NOW)[1]!.content).not.toContain("The lead asked on the call");
    expect(buildGroundingMessages(email("Hi Reshma,\n\nWe check need, timing and the buyer's role before passing a lead on."), ctx)![1]!.content).not.toContain("The lead asked on the call");
  });
});

const REPLY_NOW = new Date("2026-11-23T06:43:00Z"); // Mon 23 Nov 2026, 12:13 IST → Tuesday or Wednesday
const withLead = (firstName: string) => {
  const ctx = sampleContext({ playbook: { version: 7, body: PLAYBOOK } });
  ctx.lead = { ...ctx.lead, firstName, ownerName: "Naitik Shah" };
  ctx.settings = { ...ctx.settings, banned_phrases: [], email_max_words: 120, whatsapp_max_words: 60 };
  return ctx;
};
const replyDeps = (model: ReturnType<typeof createFakeDecisionModel>) => ({ model, decisionModel: "w", groundingModel: "c", prices: {}, now: REPLY_NOW });
const GCC_QUESTION = "Thanks for the details. Have you done outreach in the GCC region before?";
const PRICE_QUESTION = "Ok. What will be the charges for this?";

describe("AI-FIX-1 rule 4: an honest question still gets a suggested reply", () => {
  it("Reshma's GCC question (email): the writer neither claims nor denies, the checker is told not to flag the walk-through, the draft passes", async () => {
    const ctx = withLead("Reshma");
    const answer = "Good question, Reshma. Naitik can walk you through how we would approach the GCC on a short call. Would Tuesday or Wednesday suit you for a short call?";
    const model = createFakeDecisionModel({ decisions: [email(answer)] });
    const usage: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    const result = await writeReplyDraft(ctx, GCC_QUESTION, "email", replyDeps(model), usage);
    expect(result).toEqual({ decision: expect.objectContaining({ action: "send_email", body: answer }), problems: [] });
    const writer = model.calls.find((c) => c.kind === "decide")!.input.messages[0]!.content;
    expect(writer).toContain("never claim it and never deny it: say briefly that the salesperson can walk them through how we would approach it on a short call");
    expect(writer).not.toContain('Start with "Hi <first name>,"'); // email has its own greeting rule
    const checker = model.calls.find((c) => c.kind === "grounding")!.input.messages;
    expect(checker[0]!.content).toContain("NEVER flag saying the salesperson can walk them through, on a call, how we would approach something");
    expect(checker[1]!.content).toContain(GCC_QUESTION);
  });

  it("Sagar's price question (WhatsApp): starts with his first name, still no price", async () => {
    const ctx = withLead("Sagar");
    const answer = "The charges depend on the scope and support needed, so Naitik can cover that on a short call. Would Tuesday or Wednesday suit you for a short call?";
    const model = createFakeDecisionModel({ decisions: [whatsapp(answer)] });
    const usage: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    const result = await writeReplyDraft(ctx, PRICE_QUESTION, "whatsapp", replyDeps(model), usage);
    expect(result.problems).toEqual([]);
    expect(result.decision!.body).toBe(`Hi Sagar,\n${answer}`);
    expect(result.decision!.body).not.toMatch(/\d|₹|rs\.?\s|inr/i);
    const writer = model.calls[0]!.input.messages[0]!.content;
    expect(writer).toContain('- Start with "Hi <first name>," like our other messages.');
    expect(writer).toContain("No prices, quotes, discounts or delivery dates");
  });

  it("the greeting is added only when the first name isn't already at the start", () => {
    expect(greetByFirstName("Hi Sagar, the charges depend on scope.", "Sagar")).toBe("Hi Sagar, the charges depend on scope.");
    expect(greetByFirstName("Sagar, the charges depend on scope.", "Sagar")).toBe("Sagar, the charges depend on scope.");
    expect(greetByFirstName("Good question.", "Sagar")).toBe("Hi Sagar,\nGood question.");
    expect(greetByFirstName("Good question.", " ")).toBe("Good question.");
  });
});
