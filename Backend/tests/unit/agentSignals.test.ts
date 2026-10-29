import { describe, expect, it } from "vitest";
import type { AgentDecision } from "../../src/agent/decisionSchema.js";
import { buildDecisionMessages, buildGroundingMessages, type GroundingResult } from "../../src/agent/prompt.js";
import { validateDecision } from "../../src/agent/rules.js";
import { detectSignals, signalsOf } from "../../src/agent/signals.js";
import { draftDecision, type Usage } from "../../src/services/agentRunner.service.js";
import { SCENARIOS, seedCompany } from "../../scripts/seed-ai-test-contacts.js";
import { createFakeDecisionModel } from "../helpers/fakeDecisionModel.js";
import { sampleContext, settings } from "../helpers/agentContextFixture.js";

// Tuesday 27 Oct 2026, 16:30 IST (inside the send window).
const NOW = new Date("2026-10-27T11:00:00Z");
const kinds = (enquiry: string, latest = "") => detectSignals({ enquiry, latest }).map((s) => s.kind);

describe("E2f rule 6: detectSignals", () => {
  it.each([
    ["Manoj replied to our email asking: what are your charges?", "price"],
    ["What is the cost for this?", "price"],
    ["Please share your rate card", "price"],
    ["Can you send a quote", "price"],
    ["Any discount for a year?", "price"],
    ["Fees?", "price"],
    ["She asked whether someone from our team can visit their factory.", "visit"],
    ["Can we meet in person next week?", "visit"],
    ["Please come to our office in Pune", "visit"],
    ["Sanjay is interested. Asked for a call on Monday.", "ready"],
    ["Call me after 4", "ready"],
    ["Let's schedule a call", "ready"],
    ["We are ready to start", "ready"],
    ["Please send the proposal", "ready"],
  ])("the latest call/note %j → %s", (latest, kind) => {
    expect(kinds("", latest)).toEqual([kind]);
  });

  it.each([
    ["We run a bakery and cafe in Bandra. We want more walk-in customers on weekdays.\nIndustry: Bakery / Food & Beverage"],
    ["Our café needs more footfall"],
    ["Restaurant in Indiranagar"],
    ["Ladies salon and boutique"],
    ["We have a retail shop"],
    ["I am an individual looking for a job"],
  ])("the enquiry/industry %j → consumer (stop)", (enquiry) => {
    const signals = detectSignals({ enquiry, latest: "" });
    expect(signals[0]).toMatchObject({ kind: "consumer", action: "stop", line: "Signal: this looks like a consumer business, not B2B — stop." });
  });

  it("no-signal controls: B2B enquiries, plurals and look-alike words don't fire", () => {
    expect(kinds("We get 40-50 enquiries a month for our PLC panels and SPMs but very few turn into orders. Quotes go out and then nothing happens.")).toEqual([]);
    expect(kinds("We trade HR/CR coils and structural steel. Buyers come once for a project and do not come back.")).toEqual([]);
    expect(kinds("", "Spoke to Vikram. Interested but busy with festive season dispatches. Asked to call after Diwali.")).toEqual([]);
    expect(kinds("", "Connected on LinkedIn. CA firm in Ahmedabad, mostly individual and small business clients.")).toEqual([]); // consumer: enquiry/industry only
    expect(kinds("Revisit our pricingless plan", "Costly mistakes; a callback on Monday")).toEqual([]);
  });

  it("a consumer business is stopped even if it also asked about price", () => {
    expect(kinds("Bakery in Bandra", "What are your charges?")).toEqual(["consumer", "price"]);
  });

  it("the seeded scenarios: only the bakery, price, visit and call-on-Monday contacts have a signal", () => {
    const found = SCENARIOS.map((s) => {
      const notes = (s.steps ?? []).map((step) => ("note" in step ? step.note : "call" in step ? (step.call.notes ?? "") : "")).filter(Boolean);
      const enquiry = `${s.website?.message ?? ""}\n${s.lead?.industry ?? ""}`;
      return [seedCompany(s), detectSignals({ enquiry, latest: notes.at(-1) ?? "" }).map((x) => x.kind)] as const;
    }).filter(([, k]) => k.length);
    expect(found).toEqual([
      ["Sweet Crumbs Bakery", ["consumer"]],
      ["Gupta Packaging Industries", ["ready"]],
      ["Tiwari Conveyors", ["price"]],
      ["Pawar Precision Tools", ["visit"]],
    ]);
  });

  it("signalsOf reads the website enquiry, the industry (company first) and only the LATEST call or note", () => {
    const base = sampleContext();
    expect(signalsOf(base)).toEqual([]);
    const older = sampleContext({
      timeline: [
        { at: "2026-10-18T05:00:00.000Z", kind: "note", title: "Note", detail: "Asked about pricing" },
        { at: "2026-10-20T05:00:00.000Z", kind: "call", title: "Call Connected", detail: "Budget next quarter" },
      ],
    });
    expect(signalsOf(older)).toEqual([]);
    const latest = sampleContext({ timeline: [...older.timeline, { at: "2026-10-22T05:00:00.000Z", kind: "note", title: "Note", detail: "What are your charges?" }] });
    expect(signalsOf(latest).map((s) => s.kind)).toEqual(["price"]);
    expect(signalsOf(sampleContext({ lead: { ...base.lead, industry: "Restaurant" } })).map((s) => s.kind)).toEqual(["consumer"]);
  });
});

describe("E2f rule 6: the rules turn a send into the signalled action", () => {
  const send: AgentDecision = { action: "send_whatsapp", body: "Hi Asha, our charges depend on scope.", assetIds: [], nextWakeInDays: 3, reasoning: "Answer the price question." };
  const rulesWith = (signal?: { action: "handoff" | "stop"; title: string }) => {
    const ctx = sampleContext();
    return { ...ctx.rules, contactability: { email: null, whatsapp: null, phone: null }, ...(signal ? { signal } : {}) };
  };

  it("a handoff signal → handoff with the signal's title, recorded as an adjustment", () => {
    const result = validateDecision(send, rulesWith({ action: "handoff", title: "Lead asked about price" }), settings, NOW);
    expect(result.finalDecision).toEqual({ action: "handoff", title: "Lead asked about price", urgency: "normal", reasoning: "Answer the price question." });
    expect(result.adjustments).toContainEqual({ rule: "signal", message: "Lead asked about price: handing off instead of sending." });
    expect(result.violations).toEqual([]);
    expect(result.allowed).toBe(true);
  });

  it("a stop signal → stop (not a fit) with the reason", () => {
    const result = validateDecision(send, rulesWith({ action: "stop", title: "Not a B2B business" }), settings, NOW);
    expect(result.finalDecision).toMatchObject({ action: "stop", reason: "not_a_fit", moveToLongTermNurture: false, reasoning: "Not a B2B business. Answer the price question." });
  });

  it("non-send decisions and contacts without a signal are untouched", () => {
    const wait: AgentDecision = { action: "wait", nextWakeInDays: 3, reasoning: "Later." };
    expect(validateDecision(wait, rulesWith({ action: "handoff", title: "Lead asked about price" }), settings, NOW).finalDecision).toEqual(wait);
    expect(validateDecision(send, rulesWith(), settings, NOW).finalDecision).toEqual(send);
  });

  it("draftDecision: a signalled send is converted without a regeneration or grounding call", async () => {
    const ctx = sampleContext({ rules: rulesWith({ action: "handoff", title: "Lead asked about price" }) });
    const model = createFakeDecisionModel({ decisions: [send] });
    const usage: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    const result = await draftDecision(ctx, { model, decisionModel: "m", groundingModel: "g", prices: {}, now: NOW }, usage);
    expect(result).toMatchObject({ regenerated: false, decision: { action: "handoff", title: "Lead asked about price" } });
    expect(model.calls.map((c) => c.kind)).toEqual(["decide"]);
  });
});

describe("E2f rule 6: what the model sees", () => {
  const user = (ctx: ReturnType<typeof sampleContext>) => buildDecisionMessages(ctx, settings, NOW)[1]!.content;
  const visit = () =>
    sampleContext({ timeline: [{ at: "2026-10-22T05:00:00.000Z", kind: "note", title: "Note", detail: "She asked whether someone can visit their factory." }] });

  it("one neutral lead_data line and a matching checklist line per signal", () => {
    const text = user(visit());
    const leadData = text.slice(text.indexOf("<lead_data>"), text.indexOf("</lead_data>"));
    expect(leadData).toContain("Signal: the contact asked for a visit or in-person meeting — hand off; never offer or promise a visit.");
    expect(text.slice(text.indexOf("Before you answer, check:"))).toContain("- lead_data has a visit signal: pick handoff; never offer or promise a visit.");
    const [, ground] = buildGroundingMessages({ action: "send_whatsapp", body: "Hi", assetIds: [], nextWakeInDays: 3, reasoning: "r" }, visit())!;
    expect(ground!.content).toContain("Signal: the contact asked for a visit");
  });

  it("no signal → no signal lines", () => {
    expect(user(sampleContext())).not.toContain("Signal:");
    expect(user(sampleContext())).not.toContain("signal:");
  });
});

describe("E2f rule 7: regenerations", () => {
  const whatsapp = (body: string): AgentDecision => ({ action: "send_whatsapp", body, assetIds: [], nextWakeInDays: 3, reasoning: "Follow up." });
  const TWO = whatsapp("Hi Asha, is Tuesday good? Or Wednesday?");
  const CLEAN = whatsapp("Hi Asha, would a short call on Tuesday suit you?");
  const ctx = () => sampleContext({ rules: { ...sampleContext().rules, contactability: { email: null, whatsapp: null, phone: null } } });
  const run = async (decisions: AgentDecision[], grounding?: GroundingResult[]) => {
    const model = createFakeDecisionModel({ decisions, ...(grounding ? { grounding } : {}) });
    const result = await draftDecision(ctx(), { model, decisionModel: "m", groundingModel: "g", prices: {}, now: NOW }, { inputTokens: 0, outputTokens: 0, costUsd: 0 });
    return { result, decides: model.calls.filter((c) => c.kind === "decide").length };
  };

  it("deterministic problems twice → a second regeneration that passes", async () => {
    const { result, decides } = await run([TWO, TWO, CLEAN]);
    expect(decides).toBe(3);
    expect(result).toMatchObject({ regenerated: true, decision: CLEAN, failedAttempt: null });
    expect(result.attempts.map((a) => a.problems.length)).toEqual([1, 1, 0]);
  });

  it("deterministic problems three times → handoff after three attempts (all recorded)", async () => {
    const { result, decides } = await run([TWO, TWO, TWO]);
    expect(decides).toBe(3);
    expect(result.attempts).toHaveLength(3);
    expect(result.decision).toMatchObject({ action: "handoff", title: "AI couldn't write a one-question message" });
    expect((result.decision as { reasoning: string }).reasoning).toMatch(/^Three attempts failed the checks: one_question/);
  });

  it("an unsupported claim on the second attempt → no second regeneration", async () => {
    const { result, decides } = await run([TWO, CLEAN], [{ supported: false, unsupportedClaims: ["40% growth"] }]);
    expect(decides).toBe(2);
    expect(result.decision).toMatchObject({ action: "handoff", title: "AI couldn't write a safe message" });
  });

  it("an internal information leak → one regeneration only", async () => {
    const leak = sampleContext({
      rules: { ...sampleContext().rules, contactability: { email: null, whatsapp: null, phone: null } },
      internal: { companyDescription: "Family owned forge supplying axle beams to tractor makers", deal: { open: null, wonCount: 0, lostCount: 0 } },
    });
    const body = whatsapp("Hi Asha, we know you supply axle beams to tractor makers. Would Tuesday suit you?");
    const model = createFakeDecisionModel({ decisions: [body] });
    const result = await draftDecision(leak, { model, decisionModel: "m", groundingModel: "g", prices: {}, now: NOW }, { inputTokens: 0, outputTokens: 0, costUsd: 0 });
    expect(model.calls.filter((c) => c.kind === "decide")).toHaveLength(2);
    expect(result.decision).toMatchObject({ action: "handoff", title: "AI couldn't write a safe message" });
  });

  it("a grounding failure first, then only deterministic problems → the remaining problems earn the second regeneration", async () => {
    const SECTOR = whatsapp("Hi Asha, we grew a steel maker 40%. Would Tuesday suit you?");
    const { result, decides } = await run([SECTOR, TWO, CLEAN], [{ supported: false, unsupportedClaims: ["grew a steel maker 40%"] }, { supported: true, unsupportedClaims: [] }]);
    expect(decides).toBe(3);
    expect(result.decision).toEqual(CLEAN);
  });
});
