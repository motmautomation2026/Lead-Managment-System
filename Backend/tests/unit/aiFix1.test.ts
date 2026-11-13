/**
 * AI-FIX-1: the writing problems found in the DEMO-1 demo journey (Sagar Khanna, Reshma Tantry). Fake models only.
 */
import { describe, expect, it } from "vitest";
import type { AgentDecision } from "../../src/agent/decisionSchema.js";
import {
  checkMessage,
  experienceLabel,
  isListedExperienceClaim,
  messageFactsOf,
  playbookClientExperiences,
  usedClientExperiences,
} from "../../src/agent/messageChecks.js";
import { applyGroundingAllowList, buildDecisionMessages, buildGroundingMessages } from "../../src/agent/prompt.js";
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
