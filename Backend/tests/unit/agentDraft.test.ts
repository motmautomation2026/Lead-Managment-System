import { describe, expect, it } from "vitest";
import type { AgentDecision } from "../../src/agent/decisionSchema.js";
import { EMAIL_NO_REPLY_READING } from "../../src/agent/liveMode.js";
import { buildDecisionMessages, type GroundingResult } from "../../src/agent/prompt.js";
import { checkMessage, messageFactsOf } from "../../src/agent/messageChecks.js";
import { situationOf } from "../../src/agent/situation.js";
import { threadSubject, unthreadedSubject } from "../../src/domain/emailSafety.js";
import { draftDecision, type Usage } from "../../src/services/agentRunner.service.js";
import { createFakeDecisionModel } from "../helpers/fakeDecisionModel.js";
import { sampleContext, settings } from "../helpers/agentContextFixture.js";

// Tuesday 27 Oct 2026, 16:30 IST (inside the send window).
const NOW = new Date("2026-10-27T11:00:00Z");
const userText = (ctx: ReturnType<typeof sampleContext>) => buildDecisionMessages(ctx, settings, NOW)[1]!.content;
const systemText = (ctx: ReturnType<typeof sampleContext>) => buildDecisionMessages(ctx, settings, NOW)[0]!.content;

describe("E2 rule 6: past messages in the prompt", () => {
  it("a shadow draft is labelled as never sent", () => {
    expect(userText(sampleContext())).toContain("- 2026-10-21T05:00:00.000Z email (draft — never sent to the contact)\n  Subject: Outbound for Acme");
  });

  it("a real send is shown as sent", () => {
    const ctx = sampleContext({ pastMessages: [{ at: "2026-10-22T05:00:00.000Z", channel: "whatsapp", subject: null, body: "Hi Asha.", outcome: "sent", playbookVersion: 1 }] });
    const text = userText(ctx);
    expect(text).toContain("- 2026-10-22T05:00:00.000Z whatsapp (sent)\n  Hi Asha.");
    expect(text).not.toContain("never sent");
  });
});

describe("E2 rule 4: email unavailable in the context", () => {
  it("the lead data says so when reply reading is unhealthy, and nothing changes otherwise", () => {
    const base = sampleContext();
    const blocked = sampleContext({ rules: { ...base.rules, mode: "live", emailBlockedReason: EMAIL_NO_REPLY_READING } });
    expect(userText(blocked)).toContain(EMAIL_NO_REPLY_READING);
    expect(userText(base)).not.toContain("AI email is unavailable");
    expect(systemText(base)).toBe(systemText(sampleContext()));
  });
});

describe("E2 rule 7: one question per message", () => {
  const whatsapp = (body: string): AgentDecision => ({ action: "send_whatsapp", body, assetIds: [], nextWakeInDays: 3, reasoning: "Follow up." });
  const deps = (decisions: AgentDecision[]) => ({
    model: createFakeDecisionModel({ decisions }),
    decisionModel: "m-decide",
    groundingModel: "m-ground",
    prices: { "m-decide": { inputPer1M: 1, outputPer1M: 1 }, "m-ground": { inputPer1M: 1, outputPer1M: 1 } },
    now: NOW,
  });
  const usage = (): Usage => ({ inputTokens: 0, outputTokens: 0, costUsd: 0 });
  const ctx = () => sampleContext({ rules: { ...sampleContext().rules, contactability: { email: null, whatsapp: null, phone: null } } });

  it("two questions → regenerated once with feedback → one question passes", async () => {
    const d = deps([whatsapp("Hi Asha, is Tuesday good? Or Wednesday?"), whatsapp("Hi Asha, would Tuesday work for a short call?")]);
    const result = await draftDecision(ctx(), d, usage());
    expect(result.regenerated).toBe(true);
    expect(result.decision.action).toBe("send_whatsapp");
    expect(result.attempts[0]!.problems).toEqual(["one_question: The message asks 2 questions; ask at most one."]);
    const retry = d.model.calls.filter((c) => c.kind === "decide")[1]!.input.messages.at(-1)!.content;
    expect(retry).toContain("one_question: The message asks 2 questions");
  });

  it("still two questions after regenerating → handoff with its own title", async () => {
    const twice = whatsapp("Hi Asha, is Tuesday good? Or Wednesday?");
    const result = await draftDecision(ctx(), deps([twice, twice]), usage());
    expect(result.decision).toMatchObject({ action: "handoff", title: "AI couldn't write a one-question message" });
    expect(result.failedAttempt?.decision).toEqual(twice);
  });

  it("other problems keep the general handoff title", async () => {
    const html = whatsapp("Hi Asha, is <b>Tuesday</b> good? Or Wednesday?");
    const result = await draftDecision(ctx(), deps([html, html]), usage());
    expect(result.decision).toMatchObject({ action: "handoff", title: "AI couldn't write a safe message" });
  });
});

describe("E2b: message checks, style check, one regeneration", () => {
  const whatsapp = (body: string): AgentDecision => ({ action: "send_whatsapp", body, assetIds: [], nextWakeInDays: 3, reasoning: "Follow up." });
  const deps = (decisions: AgentDecision[], grounding?: GroundingResult[]) => ({
    model: createFakeDecisionModel({ decisions, ...(grounding ? { grounding } : {}) }),
    decisionModel: "m-decide",
    groundingModel: "m-ground",
    prices: { "m-decide": { inputPer1M: 1, outputPer1M: 1 }, "m-ground": { inputPer1M: 1, outputPer1M: 1 } },
    now: NOW,
  });
  const usage = (): Usage => ({ inputTokens: 0, outputTokens: 0, costUsd: 0 });
  const ctx = () => sampleContext({ rules: { ...sampleContext().rules, contactability: { email: null, whatsapp: null, phone: null } } });
  const BAD = whatsapp("Hi Asha, thanks for connecting. Could we have a quick chat?");
  const CLEAN = whatsapp("Hi Asha, thank you for your enquiry. Would a short call on Tuesday suit you?");
  const decideCalls = (d: ReturnType<typeof deps>) => d.model.calls.filter((c) => c.kind === "decide");

  it('"thanks for connecting" → regenerated with the violation as feedback → clean draft accepted', async () => {
    const d = deps([BAD, CLEAN]);
    const result = await draftDecision(ctx(), d, usage());
    expect(result).toMatchObject({ regenerated: true, decision: CLEAN, failedAttempt: null });
    expect(result.attempts[0]!.problems).toEqual(['banned_phrase: Uses banned phrase(s): "thanks for connecting".']);
    expect(result.attempts[0]!.rules.allowed).toBe(false);
    expect(decideCalls(d)[1]!.input.messages.at(-1)!.content).toContain('banned_phrase: Uses banned phrase(s): "thanks for connecting".');
    // Message checks run before grounding: only the clean attempt was grounded.
    expect(d.model.calls.map((c) => c.kind)).toEqual(["decide", "decide", "grounding"]);
  });

  it("still violating after regenerating → playbook handoff, failed message kept", async () => {
    const result = await draftDecision(ctx(), deps([BAD, BAD]), usage());
    expect(result.decision).toMatchObject({ action: "handoff", title: "AI couldn't write a message that meets the playbook" });
    expect(result.failedAttempt?.decision).toEqual(BAD);
  });

  it("a compound question → regenerate", async () => {
    const compound = whatsapp("Hi Asha, which industries do you target, and how do you handle follow-ups?");
    const result = await draftDecision(ctx(), deps([compound, CLEAN]), usage());
    expect(result.regenerated).toBe(true);
    expect(result.attempts[0]!.problems[0]).toMatch(/^compound_question: /);
    expect(result.decision).toEqual(CLEAN);
  });

  it("a style violation from grounding → regenerated with the quote", async () => {
    const sector = whatsapp("Hi Asha, we help steel makers grow. Would a short call on Tuesday suit you?");
    const d = deps(
      [sector, CLEAN],
      [
        { supported: true, unsupportedClaims: [], styleViolations: [{ rule: "unsupported_sector_claim", quote: "we help steel makers grow" }] },
        { supported: true, unsupportedClaims: [], styleViolations: [] },
      ],
    );
    const result = await draftDecision(ctx(), d, usage());
    expect(result.attempts[0]!.problems).toEqual(['unsupported_sector_claim: "we help steel makers grow"']);
    expect(decideCalls(d)[1]!.input.messages.at(-1)!.content).toContain('unsupported_sector_claim: "we help steel makers grow"');
    expect(result).toMatchObject({ regenerated: true, decision: CLEAN });
  });

  it("both kinds of problems → still only one regeneration, then handoff", async () => {
    const d = deps(
      [BAD, whatsapp("Hi Asha, we help steel makers grow. Shall we talk?")],
      [{ supported: false, unsupportedClaims: ["we help steel makers"], styleViolations: [{ rule: "unsupported_sector_claim", quote: "we help steel makers grow" }] }],
    );
    const result = await draftDecision(ctx(), d, usage());
    expect(decideCalls(d)).toHaveLength(2);
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[1]!.problems).toEqual(["Unsupported claim: we help steel makers", 'unsupported_sector_claim: "we help steel makers grow"']);
    // An unsupported fact is a safety problem, not only a playbook one.
    expect(result.decision).toMatchObject({ action: "handoff", title: "AI couldn't write a safe message" });
  });
});

describe("E2b rule 4: what the model sees", () => {
  it("lead data says how they came to us", () => {
    expect(userText(sampleContext())).toContain("How they came to us: submitted the enquiry form on our website (inbound)");
    const imported = sampleContext({ lead: { ...sampleContext().lead, source: "linkedin" } });
    expect(userText(imported)).toContain("How they came to us: added by our team (source: linkedin)");
  });

  it("a draft from an older playbook is one line without its text; current drafts keep theirs", () => {
    const old = { at: "2026-10-19T05:00:00.000Z", channel: "whatsapp" as const, subject: null, body: "Thanks for connecting, Asha!", outcome: "draft", playbookVersion: 2 };
    const unknown = { ...old, at: "2026-10-18T05:00:00.000Z", playbookVersion: null };
    const text = userText(sampleContext({ pastMessages: [unknown, old, ...sampleContext().pastMessages] }));
    expect(text).toContain("- 2026-10-19T05:00:00.000Z whatsapp (draft from an earlier playbook — not sent)\n");
    expect(text).toContain("- 2026-10-18T05:00:00.000Z whatsapp (draft from an earlier playbook — not sent)");
    expect(text).not.toContain("Thanks for connecting, Asha");
    expect(text).toContain("email (draft — never sent to the contact)\n  Subject: Outbound for Acme");
  });

  it("ends with the checklist: banned phrases, limits, inbound thanks (no conversation yet), no introduction mid-conversation", () => {
    // E2c: a current-playbook shadow draft means it is no longer the first message.
    const text = userText(sampleContext({ pastMessages: [], timeline: [] }));
    const tail = text.slice(text.indexOf("Before you answer, check:"));
    expect(text.endsWith(tail)).toBe(true);
    expect(tail).toContain("- The message rules above.");
    // E3a rule 2: the banned phrases and limits are the same for every contact, so they are in the cached part.
    const system = buildDecisionMessages(sampleContext(), settings, NOW)[0]!.content;
    expect(system).toContain('- None of these phrases: "thanks for connecting", "just following up", "today", "free".');
    expect(system).toContain("- Word limits: email body 250 words, WhatsApp 80 words.");
    expect(tail).toContain("thank them for reaching out");
    expect(userText(sampleContext())).toContain("don't introduce us again");
    const fresh = sampleContext({ lead: { ...sampleContext().lead, source: "cold_call" }, timeline: [] });
    const freshText = userText(fresh);
    const freshTail = freshText.slice(freshText.indexOf("Before you answer, check:"));
    expect(freshTail).not.toContain("thank them");
    expect(freshTail).not.toContain("introduce");
  });

  // E2d: Raj (inbound, no sends, deal in Negotiation) got both contradictory checklist lines and a forced "thank you".
  describe("E2d: inbound thanks only when no conversation exists", () => {
    const wa = (body: string): AgentDecision => ({ action: "send_whatsapp", body, assetIds: [], nextWakeInDays: 3, reasoning: "r" });
    const FOLLOW_UP = wa("Hi Asha, following up on our discussion, would Tuesday suit you to go through the next steps?");
    const THANKS = wa("Hi Asha, thank you for reaching out with your enquiry. Would Tuesday suit you to go through the next steps?");
    const rules = (ctx: ReturnType<typeof sampleContext>, d: AgentDecision) => checkMessage(d, settings, messageFactsOf(ctx)).map((v) => v.rule);
    const checklist = (ctx: ReturnType<typeof sampleContext>) => {
      const text = userText(ctx);
      return text.slice(text.indexOf("Before you answer, check:"));
    };
    // The fixture has a logged call (conversation) and a current-playbook draft (not first).
    const cases = [
      { name: "no conversation, first inbound message", ctx: () => sampleContext({ timeline: [], pastMessages: [] }), thanksRequired: true, conversation: false },
      { name: "no conversation, not the first message", ctx: () => sampleContext({ timeline: [] }), thanksRequired: false, conversation: false },
      { name: "conversation, first inbound message (Raj)", ctx: () => sampleContext({ pastMessages: [] }), thanksRequired: false, conversation: true },
      { name: "conversation, not the first message", ctx: () => sampleContext(), thanksRequired: false, conversation: true },
    ];

    it.each(cases)("$name", ({ ctx, thanksRequired, conversation }) => {
      const c = ctx();
      expect(situationOf(c).conversationExists).toBe(conversation);
      expect(messageFactsOf(c).inboundFirst).toBe(thanksRequired);
      expect(rules(c, FOLLOW_UP)).toEqual(thanksRequired ? ["not_thanking_inbound"] : []);
      // With a conversation, "thank you for reaching out" is an introduction phrase (no E2c exception any more).
      expect(rules(c, THANKS)).toEqual(conversation ? ["introduction_mid_conversation"] : []);
      const tail = checklist(c);
      expect(tail.includes("thank them for reaching out")).toBe(thanksRequired);
      expect(tail.includes("don't introduce us again")).toBe(conversation);
    });

    it("checklist snapshot for each combination", () => {
      expect(Object.fromEntries(cases.map(({ name, ctx }) => [name, checklist(ctx())]))).toMatchSnapshot();
    });
  });

  it("situation: nothing yet vs an open deal at a proposal stage (Raj's case: no introduction)", () => {
    const base = sampleContext({ timeline: [], pastMessages: [] });
    expect(situationOf(base)).toEqual({ inbound: true, firstMessage: true, hasCallOrNote: false, proposalStage: false, conversationExists: false });
    const open = { id: "d-1", name: "TRC", stage: "negotiation" as const, stageLabel: "Negotiation", daysInStage: 3, expectedCloseMonth: null, latestMeeting: null, latestProposal: null };
    const raj = sampleContext({ timeline: [], pastMessages: [], internal: { companyDescription: null, deal: { open, wonCount: 0, lostCount: 0 } } });
    expect(situationOf(raj)).toMatchObject({ proposalStage: true, conversationExists: true });
    const sent = sampleContext({ timeline: [], pastMessages: [{ ...sampleContext().pastMessages[0]!, outcome: "sent" }] });
    expect(situationOf(sent).firstMessage).toBe(false);
    // E2c: in shadow a current-playbook draft counts as the first message having been written; an older playbook's does not.
    expect(situationOf(sampleContext({ timeline: [] })).firstMessage).toBe(false);
    expect(situationOf(sampleContext({ timeline: [], pastMessages: [{ ...sampleContext().pastMessages[0]!, playbookVersion: 2 }] })).firstMessage).toBe(true);
    // E2c: a real AI send that got a reply.
    expect(situationOf(sampleContext({ timeline: [], pastMessages: [], aiSendReplied: true })).conversationExists).toBe(true);
  });

  it("the checklist stays last after regeneration feedback", () => {
    const user = buildDecisionMessages(sampleContext(), settings, NOW, { previousFailure: { problems: ["length: 90 words"] } })[1]!.content;
    expect(user.indexOf("length: 90 words")).toBeLessThan(user.indexOf("Before you answer, check:"));
  });
});

describe("E2g: attachments", () => {
  const ASSET = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
  const email = (body: string): AgentDecision => ({ action: "send_email", subject: "Steel exports", body, assetIds: [ASSET], nextWakeInDays: 3, reasoning: "Share proof." });
  const deps = (decisions: AgentDecision[], grounding?: GroundingResult[]) => ({
    model: createFakeDecisionModel({ decisions, ...(grounding ? { grounding } : {}) }),
    decisionModel: "m-decide",
    groundingModel: "m-ground",
    prices: { "m-decide": { inputPer1M: 1, outputPer1M: 1 }, "m-ground": { inputPer1M: 1, outputPer1M: 1 } },
    now: NOW,
  });
  const usage = (): Usage => ({ inputTokens: 0, outputTokens: 0, costUsd: 0 });
  const assetInfo = { id: ASSET, active: true, channels: ["email"], sizeBytes: 900_000 };
  const ctx = (assetFacts: NonNullable<ReturnType<typeof sampleContext>["rules"]["assetFacts"]>) =>
    sampleContext({
      assets: [{ id: ASSET, title: "Steel trading case study", useWhen: "After a call with a trader", channels: ["email"], sizeBytes: 900_000 }],
      rules: { ...sampleContext().rules, assets: [assetInfo], assetFacts },
    });
  const firstMessage = { conversationExists: false, realMessageSent: false, whatsappReplied: false, sentAssetIds: [] };
  const talking = { conversationExists: true, realMessageSent: true, whatsappReplied: false, sentAssetIds: [] };
  const body = "Hi Asha,\n\nI've attached a short case study on a steel trader we worked with. Would a short call next week suit you?";

  const plain = "Hi Asha,\n\nWe helped a steel trader build outbound. Would a short call next week suit you?";

  it("an attachment on a first message is dropped; a text that doesn't mention it is kept and nothing is regenerated", async () => {
    const d = deps([email(plain)]);
    const result = await draftDecision(ctx(firstMessage), d, usage());
    expect(result.regenerated).toBe(false);
    expect(result.decision).toMatchObject({ action: "send_email", body: plain, assetIds: [] });
    expect(result.rules.attachmentsRemoved).toEqual([{ assetId: ASSET, reason: "first_message" }]);
    expect(result.attempts[0]!.problems).toEqual([]);
    expect(d.model.calls.filter((c) => c.kind === "decide")).toHaveLength(1);
  });

  it("E2h: dropped attachment + a text that mentions it → regenerated, the clean draft goes with no attachment", async () => {
    const d = deps([email(body), email(plain)]);
    const result = await draftDecision(ctx(firstMessage), d, usage());
    expect(result.regenerated).toBe(true);
    expect(result.attempts[0]!.problems).toEqual(["attachment_mention: No file will be attached to this message. Do not mention an attachment, a case study being shared, or a PDF."]);
    expect(result.outcome).toBe("draft");
    expect(result.decision).toMatchObject({ action: "send_email", body: plain, assetIds: [] });
    // The first attempt's drop stays recorded; the feedback reaches the model.
    expect(result.attempts[0]!.rules.attachmentsRemoved).toEqual([{ assetId: ASSET, reason: "first_message" }]);
    expect(d.model.calls.filter((c) => c.kind === "decide")[1]!.input.messages[1]!.content).toContain("No file will be attached");
  });

  it("E2h: still mentioning it after two regenerations → handoff, as a playbook problem", async () => {
    const d = deps([email(body), email(body), email(body)]);
    const result = await draftDecision(ctx(firstMessage), d, usage());
    expect(result.attempts).toHaveLength(3);
    expect(result.decision).toMatchObject({ action: "handoff", title: "AI couldn't write a message that meets the playbook" });
  });

  it("E2h: a chosen attachment that stays may be mentioned", async () => {
    const result = await draftDecision(ctx(talking), deps([email(body)]), usage());
    expect(result.regenerated).toBe(false);
    expect(result.decision).toMatchObject({ action: "send_email", body, assetIds: [ASSET] });
  });

  it("after a conversation the attachment is kept; the prompt says attachments are possible and how to mention them", async () => {
    const d = deps([email(body)]);
    const result = await draftDecision(ctx(talking), d, usage());
    expect(result.decision).toMatchObject({ assetIds: [ASSET] });
    expect(result.rules.attachmentsRemoved).toBeUndefined();
    const [system, user] = d.model.calls[0]!.input.messages;
    expect(system!.content).toContain("never quote numbers or results from it");
    expect(user!.content).toContain("Attachments now: email yes (at most 2); WhatsApp no");
  });

  it("an asset already sent is marked in the prompt and dropped if chosen again", async () => {
    const c = ctx({ ...talking, sentAssetIds: [ASSET] });
    expect(buildDecisionMessages(c, settings, NOW)[1]!.content).toContain("already sent to this contact");
    const result = await draftDecision(c, deps([email(plain)]), usage());
    expect(result.rules.attachmentsRemoved).toEqual([{ assetId: ASSET, reason: "already_sent" }]);
  });

  it("quoting a number from the attachment fails grounding and is regenerated", async () => {
    const quoting = email("Hi Asha,\n\nThe attached case study shows how a steel trader got 10x ROI. Would a short call next week suit you?");
    const d = deps([quoting, email(body)], [{ supported: false, unsupportedClaims: ["10x ROI"], styleViolations: [] }, { supported: true, unsupportedClaims: [], styleViolations: [] }]);
    const result = await draftDecision(ctx(talking), d, usage());
    expect(result.regenerated).toBe(true);
    expect(result.attempts[0]!.problems).toEqual(["Unsupported claim: 10x ROI"]);
    expect(result.decision).toMatchObject({ action: "send_email", body, assetIds: [ASSET] });
    const grounding = d.model.calls.find((c) => c.kind === "grounding")!.input.messages;
    expect(grounding[0]!.content).toContain("any number or result attributed to an attachment");
    // Only the title and "use when" are known; the asset's content is never a grounding source.
    expect(grounding[1]!.content).not.toContain("Steel trading case study");
  });
});

describe("E3a: auto-fix instead of rejecting", () => {
  const draft = (body: string): AgentDecision => ({ action: "send_whatsapp", body, assetIds: [], nextWakeInDays: 3, reasoning: "r" });
  const run = async (answers: AgentDecision[]) => {
    const model = createFakeDecisionModel({ decisions: answers });
    const result = await draftDecision(sampleContext(), { model, decisionModel: "m-decide", groundingModel: "m-ground", prices: {}, now: NOW }, { inputTokens: 0, outputTokens: 0, costUsd: 0 });
    return { result, model };
  };

  it('a draft with "—" and "!" passes after the auto-fix, with no regeneration', async () => {
    const { result, model } = await run([draft("Hi Asha, great to speak — we can help with your steel buyers! Shall we talk on Monday?")]);
    expect(result.regenerated).toBe(false);
    expect(result.attempts).toHaveLength(1);
    expect(result.decision).toMatchObject({ body: "Hi Asha, great to speak, we can help with your steel buyers. Shall we talk on Monday?" });
    expect(result.attempts[0]!.autoFixes.map((f) => f.rule)).toEqual(["dash", "exclamation"]);
    expect(model.calls.filter((c) => c.kind === "decide")).toHaveLength(1);
    expect(model.calls.find((c) => c.kind === "grounding")!.input.messages[1]!.content).toContain("great to speak, we can help");
  });

  it('a draft with "I hope this email finds you well" regenerates', async () => {
    const ctx = sampleContext({ settings: { ...settings, banned_phrases: ["hope this email finds you well"] } });
    const model = createFakeDecisionModel({ decisions: [draft("Hi Asha, I hope this email finds you well. Shall we talk?"), draft("Hi Asha, shall we talk on Monday?")] });
    const result = await draftDecision(ctx, { model, decisionModel: "m-decide", groundingModel: "m-ground", prices: {}, now: NOW }, { inputTokens: 0, outputTokens: 0, costUsd: 0 });
    expect(result.regenerated).toBe(true);
    expect(result.attempts[0]!.problems[0]).toContain("banned_phrase");
    expect(result.decision).toMatchObject({ body: "Hi Asha, shall we talk on Monday?" });
  });

  it("subject_style is fixable: a second regeneration, then a playbook handoff", async () => {
    const bad: AgentDecision = { action: "send_email", subject: "Re: your enquiry", body: "Hi Asha, shall we talk on Monday?", assetIds: [], nextWakeInDays: 3, reasoning: "r" };
    const { result, model } = await run([bad]);
    expect(model.calls.filter((c) => c.kind === "decide")).toHaveLength(3);
    expect(result.decision).toMatchObject({ action: "handoff", title: "AI couldn't write a message that meets the playbook" });
  });
});

describe("E3a: follow-up emails keep their thread", () => {
  const thread = { messageId: "<first@motm.tech>", subject: "Steel buyers in Pune" };
  const followUp = (subject: string): AgentDecision => ({ action: "send_email", subject, body: "Hi Asha, one more thought. Shall we talk on Monday?", assetIds: [], nextWakeInDays: 3, reasoning: "r" });

  it("the model's subject is ignored (even a bad one) and the prompt says none is needed", async () => {
    const ctx = sampleContext({ emailThread: thread });
    const model = createFakeDecisionModel({ decisions: [followUp("RE: QUICK QUESTION today")] });
    const result = await draftDecision(ctx, { model, decisionModel: "m-decide", groundingModel: "m-ground", prices: {}, now: NOW }, { inputTokens: 0, outputTokens: 0, costUsd: 0 });
    expect(result.regenerated).toBe(false);
    expect(result.decision).toMatchObject({ subject: "Re: Steel buyers in Pune" });
    expect(buildDecisionMessages(ctx, settings, NOW)[1]!.content).toContain('needs no subject: put "-" as the subject');
    expect(buildDecisionMessages(sampleContext(), settings, NOW)[1]!.content).not.toContain("needs no subject");
  });

  it("threadSubject never stacks Re:", () => {
    expect(threadSubject("Steel buyers")).toBe("Re: Steel buyers");
    expect(threadSubject("Re: Steel buyers")).toBe("Re: Steel buyers");
    expect(unthreadedSubject("Re: Steel buyers")).toBe("Steel buyers");
  });
});
