import { describe, expect, it } from "vitest";
import type { AgentDecision } from "../../src/agent/decisionSchema.js";
import { draftFirstMessages } from "../../src/agent/draftDecision.js";
import { checkMessage, firstClosingOf, messageFactsOf } from "../../src/agent/messageChecks.js";
import { polishDecision } from "../../src/agent/polish.js";
import { settingsUpdateSchema } from "../../src/agent/settingsSchema.js";
import { stagePlan, type StagePlanInput } from "../../src/agent/stagePlan.js";
import { firstMessageClosing } from "../../src/domain/reminders.js";
import type { Usage } from "../../src/agent/draftDecision.js";
import { createFakeDecisionModel } from "../helpers/fakeDecisionModel.js";
import { sampleContext, settings } from "../helpers/agentContextFixture.js";

/** IST wall clock → Date. 2026-11-04 is a Wednesday, 2026-11-07 a Saturday, 2026-11-08 a Sunday. */
const ist = (local: string) => new Date(`${local}:00+05:30`);
const WEDNESDAY = ist("2026-11-04T11:00");

describe("HOTFIX-3: the first message's closing sentence (firstMessageClosing)", () => {
  it("owner → I; no owner → our team; never a time or day", () => {
    expect(firstMessageClosing(true)).toBe("I will give you a call to understand your requirements.");
    expect(firstMessageClosing(false)).toBe("Our team will give you a call to understand your requirements.");
  });

  it("firstClosingOf picks by the lead's owner, welcome angle only", () => {
    const plan = stagePlan(planInput({ firstChannel: "whatsapp" }));
    const lead = sampleContext().lead;
    expect(firstClosingOf({ stagePlan: plan, lead: { ...lead, ownerName: "Ravi Kumar" } })).toBe(firstMessageClosing(true));
    expect(firstClosingOf({ stagePlan: plan, lead: { ...lead, ownerName: null } })).toBe(firstMessageClosing(false));
    expect(firstClosingOf({ stagePlan: stagePlan(planInput({ touches: [{ at: ist("2026-11-01T11:00"), channel: "email" }] })), lead })).toBeNull();
  });
});

const planInput = (overrides: Partial<StagePlanInput> = {}): StagePlanInput => ({
  now: WEDNESDAY,
  lifecycleState: "active",
  nurtureLongTerm: false,
  pipelineStage: "contact_attempted",
  openDealStage: null,
  lastCallOrNoteAt: null,
  latestMeeting: null,
  hasUpcomingMeeting: false,
  latestProposal: null,
  touches: [],
  conversationExists: false,
  emailUsable: true,
  whatsappUsable: true,
  firstChannel: "both",
  maxTouchesTotal: 8,
  repOwnedBefore: false,
  ...overrides,
});

describe("HOTFIX-2: the first-message channel setting", () => {
  it("accepts whatsapp, email and both; nothing else", () => {
    for (const firstChannel of ["whatsapp", "email", "both"]) expect(settingsUpdateSchema.safeParse({ firstChannel }).success).toBe(true);
    expect(settingsUpdateSchema.safeParse({ firstChannel: "sms" }).success).toBe(false);
  });
});

describe("HOTFIX-2: first_channel both in the stage plan", () => {
  it("first message, both usable → WhatsApp plus email", () => {
    const plan = stagePlan(planInput())!;
    expect(plan).toMatchObject({ angle: "welcome", preferredChannel: "whatsapp", alsoChannel: "email" });
  });

  it("one channel unusable → only the other, no second message", () => {
    expect(stagePlan(planInput({ emailUsable: false }))).toMatchObject({ preferredChannel: "whatsapp" });
    expect(stagePlan(planInput({ emailUsable: false }))!.alsoChannel).toBeUndefined();
    expect(stagePlan(planInput({ whatsappUsable: false }))).toMatchObject({ preferredChannel: "email" });
    expect(stagePlan(planInput({ whatsappUsable: false }))!.alsoChannel).toBeUndefined();
  });

  it("after the first touch: one channel, alternating as before", () => {
    const plan = stagePlan(planInput({ touches: [{ at: ist("2026-11-01T11:00"), channel: "whatsapp" }] }))!;
    expect(plan.preferredChannel).toBe("email");
    expect(plan.alsoChannel).toBeUndefined();
  });
});

const whatsapp = (body: string): AgentDecision => ({ action: "send_whatsapp", body, assetIds: [], nextWakeInDays: 3, reasoning: "First message." });
const email = (body: string): AgentDecision => ({ action: "send_email", subject: "Outbound for Acme Steel", body, assetIds: [], nextWakeInDays: 3, reasoning: "First message." });
const CLOSING = "I will give you a call to understand your requirements.";
const GOOD = `Hi Asha, thanks for your enquiry about growing outbound sales for Acme Steel. We start with a short review of how your team finds buyers. ${CLOSING}`;
const DAY_PAIR = "Hi Asha, thanks for your enquiry about growing outbound sales. Would Thursday or Friday suit you for a short call?";

describe("HOTFIX-2: message checks for the first message", () => {
  const firstCtx = () => sampleContext({ stagePlan: stagePlan(planInput({ firstChannel: "whatsapp" })) });
  const followUpCtx = () => sampleContext({ stagePlan: stagePlan(planInput({ firstChannel: "whatsapp", touches: [{ at: ist("2026-11-01T11:00"), channel: "email" }] })) });
  const rules = (decision: AgentDecision, ctx: ReturnType<typeof sampleContext>) => checkMessage(decision, settings, messageFactsOf(ctx, WEDNESDAY)).map((v) => v.rule);

  it("the closing with zero questions passes", () => {
    expect(rules(whatsapp(GOOD), firstCtx())).not.toContain("call_days");
    expect(rules(whatsapp(GOOD), firstCtx())).not.toContain("one_question");
  });

  it("a day-pair call question in the first message fails", () => {
    expect(rules(whatsapp(DAY_PAIR), firstCtx())).toContain("call_days");
  });

  it("both closing sentences are allowed only in the first message", () => {
    const noOwner = GOOD.replace(CLOSING, "Our team will give you a call to understand your requirements.");
    expect(rules(whatsapp(noOwner), firstCtx())).not.toContain("call_days");
    expect(rules(whatsapp(GOOD), followUpCtx())).toContain("call_days");
    expect(rules(whatsapp(noOwner), followUpCtx())).toContain("call_days");
    // A follow-up keeps the two-day call request.
    expect(rules(whatsapp(DAY_PAIR), followUpCtx())).not.toContain("call_days");
  });

  it("HOTFIX-3: a time or day phrase in the first message fails", () => {
    for (const phrase of ["shortly", "tomorrow morning", "on Monday", "today", "this afternoon", "soon"]) {
      const body = `Hi Asha, thanks for your enquiry about growing outbound sales. Ravi will reach out ${phrase}. ${CLOSING}`;
      expect(rules(whatsapp(body), firstCtx())).toContain("call_days");
    }
  });

  it("code appends the closing when the writer left it out (and drops its own call promise)", () => {
    const { decision, autoFixes } = polishDecision(whatsapp("Hi Asha, thanks for your enquiry. We start with a short review. Someone will call you soon."), {
      ownerName: "Ravi Kumar",
      companyName: "Northbeam",
      firstClosing: CLOSING,
    });
    expect(decision.action === "send_whatsapp" && decision.body).toBe(`Hi Asha, thanks for your enquiry. We start with a short review.\n\n${CLOSING}`);
    expect(autoFixes.map((f) => f.rule)).toContain("call_days");
    expect(polishDecision(whatsapp(GOOD), { ownerName: "Ravi Kumar", companyName: "Northbeam", firstClosing: CLOSING }).autoFixes).toEqual([]);
  });
});

describe("HOTFIX-2: drafting a both-channel first message (draftFirstMessages)", () => {
  const deps = (decisions: AgentDecision[]) => ({
    model: createFakeDecisionModel({ decisions }),
    decisionModel: "m-decide",
    groundingModel: "m-ground",
    prices: { "m-decide": { inputPer1M: 1, outputPer1M: 1 }, "m-ground": { inputPer1M: 1, outputPer1M: 1 } },
    now: WEDNESDAY,
  });
  const usage = (): Usage => ({ inputTokens: 0, outputTokens: 0, costUsd: 0 });
  const ctx = (overrides: Partial<StagePlanInput> = {}) => {
    const base = sampleContext();
    const plan = stagePlan(planInput(overrides));
    return sampleContext({ stagePlan: plan, rules: { ...base.rules, contactability: { email: null, whatsapp: null, phone: null }, stagePlan: plan } });
  };
  const decides = (d: ReturnType<typeof deps>) => d.model.calls.filter((c) => c.kind === "decide").map((c) => c.input.messages[1]!.content.match(/Channel for this message: (\w+)/)?.[1]);

  it("both ok: one WhatsApp and one email, each written for its channel", async () => {
    const d = deps([whatsapp(GOOD), email(GOOD)]);
    const u = usage();
    const { main, companion } = await draftFirstMessages(ctx(), d, u);
    expect(decides(d)).toEqual(["WhatsApp", "email"]);
    expect(main.decision.action).toBe("send_whatsapp");
    expect(companion).toMatchObject({ ok: true, draft: { decision: { action: "send_email" } } });
    // Both drafts' model costs land on the one decision's usage.
    expect(u.inputTokens).toBe(4000);
  });

  it("one channel unusable: one message only", async () => {
    const d = deps([email(GOOD)]);
    const { main, companion } = await draftFirstMessages(ctx({ whatsappUsable: false }), d, usage());
    expect(main.decision.action).toBe("send_email");
    expect(companion).toBeNull();
    expect(decides(d)).toEqual(["email"]);
  });

  it("one fails its checks: the other still goes; the failed one is kept for review, never a second message on a channel", async () => {
    // WhatsApp: a day-pair question three times (handoff fallback); email passes.
    const d = deps([whatsapp(DAY_PAIR), whatsapp(DAY_PAIR), whatsapp(DAY_PAIR), email(GOOD)]);
    const { main, companion } = await draftFirstMessages(ctx(), d, usage());
    expect(main.decision.action).toBe("send_email");
    expect(main.failedAttempt).toBeNull();
    expect(companion!.ok).toBe(false);
    expect(companion!.draft.failedAttempt!.rules.finalDecision.action).toBe("send_whatsapp");
  });

  it("the model decides not to write (wait): no second draft", async () => {
    const d = deps([{ action: "wait", nextWakeInDays: 2, reasoning: "Too early." }]);
    const { main, companion } = await draftFirstMessages(ctx(), d, usage());
    expect(main.decision.action).toBe("wait");
    expect(companion).toBeNull();
    expect(decides(d)).toHaveLength(1);
  });
});
