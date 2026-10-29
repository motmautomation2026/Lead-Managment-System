import { describe, expect, it } from "vitest";
import type { AgentDecision } from "../../src/agent/decisionSchema.js";
import { EMAIL_NO_REPLY_READING } from "../../src/agent/liveMode.js";
import { buildDecisionMessages, type GroundingResult } from "../../src/agent/prompt.js";
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

  it("ends with the checklist: banned phrases, limits, inbound thanks, no introduction mid-conversation", () => {
    const text = userText(sampleContext());
    const tail = text.slice(text.indexOf("Before you answer, check:"));
    expect(text.endsWith(tail)).toBe(true);
    expect(tail).toContain('- None of these phrases: "thanks for connecting", "just following up", "today", "free".');
    expect(tail).toContain("- Word limits: email body 250 words, WhatsApp 80 words.");
    expect(tail).toContain("thank them for reaching out");
    expect(tail).toContain("don't introduce us again");
    const fresh = sampleContext({ lead: { ...sampleContext().lead, source: "cold_call" }, timeline: [] });
    const freshText = userText(fresh);
    const freshTail = freshText.slice(freshText.indexOf("Before you answer, check:"));
    expect(freshTail).not.toContain("thank them");
    expect(freshTail).not.toContain("introduce");
  });

  it("the checklist stays last after regeneration feedback", () => {
    const user = buildDecisionMessages(sampleContext(), settings, NOW, { previousFailure: { problems: ["length: 90 words"] } })[1]!.content;
    expect(user.indexOf("length: 90 words")).toBeLessThan(user.indexOf("Before you answer, check:"));
  });
});
