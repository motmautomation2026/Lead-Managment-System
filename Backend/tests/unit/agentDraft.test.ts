import { describe, expect, it } from "vitest";
import type { AgentDecision } from "../../src/agent/decisionSchema.js";
import { EMAIL_NO_REPLY_READING } from "../../src/agent/liveMode.js";
import { buildDecisionMessages } from "../../src/agent/prompt.js";
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
    const ctx = sampleContext({ pastMessages: [{ at: "2026-10-22T05:00:00.000Z", channel: "whatsapp", subject: null, body: "Hi Asha.", outcome: "sent" }] });
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
    const long = whatsapp(`Hi Asha, ${"really ".repeat(100)}is Tuesday good? Or Wednesday?`);
    const result = await draftDecision(ctx(), deps([long, long]), usage());
    expect(result.decision).toMatchObject({ action: "handoff", title: "AI couldn't write a safe message" });
  });
});
