import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { AgentDecision } from "../../src/agent/decisionSchema.js";
import { parsePrices } from "../../src/agent/pricing.js";
import { estimateCost, evaluationContext, parseCombos, renderReport, runModelTest, unpricedModels } from "../../src/services/agentModelTest.service.js";
import { createFakeDecisionModel } from "../helpers/fakeDecisionModel.js";
import { sampleContext } from "../helpers/agentContextFixture.js";

const NOW = new Date("2026-10-27T11:00:00Z");
const prices = parsePrices('{"gpt-5.1":{"inputPer1M":1,"cachedInputPer1M":0.1,"outputPer1M":1},"gpt-4.1":{"inputPer1M":2,"outputPer1M":2}}');
const combos = parseCombos("gpt-5.1>gpt-4.1,gpt-5.1@low>gpt-4.1");
const CLEAN: AgentDecision = { action: "send_whatsapp", body: "Hi Asha, good to speak. Shall we talk on Monday?", assetIds: [], nextWakeInDays: 3, reasoning: "r" };
const TWO: AgentDecision = { ...CLEAN, body: "Hi Asha, shall we talk? Is Monday good?" } as AgentDecision;

describe("agent:model-test", () => {
  it("parses combos and refuses anything else", () => {
    expect(combos).toEqual([
      { label: "gpt-5.1>gpt-4.1", decisionModel: "gpt-5.1", groundingModel: "gpt-4.1" },
      { label: "gpt-5.1@low>gpt-4.1", decisionModel: "gpt-5.1@low", groundingModel: "gpt-4.1" },
    ]);
    expect(parseCombos("gpt-5.1/gpt-4.1")[0]).toMatchObject({ decisionModel: "gpt-5.1", groundingModel: "gpt-4.1" });
    expect(() => parseCombos("gpt-5.4-mini")).toThrow("writer>checker");
    expect(() => parseCombos("a>b>c")).toThrow("writer>checker");
    expect(() => parseCombos("gpt-4.1@low>gpt-4.1")).toThrow("doesn't take a reasoning effort");
    expect(() => parseCombos(" ")).toThrow("No combos");
  });

  it("finds models without a price and estimates per combination", () => {
    expect(unpricedModels(parseCombos("gpt-5.1>gpt-4.1,gpt-5.9>gpt-4.1"), prices)).toEqual(["gpt-5.9"]);
    const estimate = estimateCost(combos, 10, prices);
    expect(estimate.perCombo).toHaveLength(2);
    expect(estimate.totalUsd).toBeCloseTo(estimate.perCombo[0]!.usd * 2);
    expect(estimate.totalUsd).toBeGreaterThan(0);
  });

  it("evaluation ignores mode, AI status and touches, and says so", () => {
    const base = sampleContext();
    const { ctx, ignored } = evaluationContext({ ...base, rules: { ...base.rules, mode: "off", lead: { ...base.rules.lead, agentStatus: "stopped", agentTouchCount: 4 } } });
    expect(ctx.rules).toMatchObject({ mode: "shadow", recentTouchTimes: [], lead: { agentStatus: "active", agentTouchCount: 0, agentLastTouchAt: null } });
    expect(ignored.join(" ")).toContain('AI status "stopped"');
  });

  it("runs every combination on every contact with a fake model and reports them side by side", async () => {
    const second = sampleContext();
    second.lead = { ...second.lead, id: "lead-2", firstName: "Raj", lastName: "Shah" };
    const model = createFakeDecisionModel({ decisions: [TWO, CLEAN, CLEAN], tokens: { input: 1000, output: 100 } });
    const result = await runModelTest({ contexts: [sampleContext(), second], combos, model, prices, now: NOW });
    expect(result.runs).toHaveLength(4);
    expect(result.stoppedAtCap).toBe(false);
    expect(result.runs[0]).toMatchObject({ combo: "gpt-5.1>gpt-4.1", outcome: "send", passedFirstTry: false, regenerations: 1 });
    expect(result.runs[1]).toMatchObject({ combo: "gpt-5.1>gpt-4.1", name: "Raj Shah", passedFirstTry: true, regenerations: 0 });
    expect(result.spentUsd).toBeGreaterThan(0);

    const report = renderReport(result, combos, { at: NOW, contacts: 2 });
    expect(report).toContain("### gpt-5.1>gpt-4.1");
    expect(report).toContain("### gpt-5.1@low>gpt-4.1");
    expect(report).toContain("- Passed first try: 50 % (1 of 2 messages)");
    expect(report).toContain("- Regenerations: 1");
    expect(report).toContain("- Cached input: 0 %");
    expect(report).toContain("  - send: 2");
    expect(report).toContain("### Raj Shah (lead-2)");
    expect(report).toContain("> Hi Asha, good to speak. Shall we talk on Monday?");
    expect(report).toContain("Failed attempt 1:");
    expect(report).toContain("one_question:");
  });

  it("a model error is recorded and the run goes on", async () => {
    const model = createFakeDecisionModel({ decisions: [new Error("model unavailable"), CLEAN] });
    const result = await runModelTest({ contexts: [sampleContext(), sampleContext()], combos: combos.slice(0, 1), model, prices, now: NOW });
    expect(result.runs[0]).toMatchObject({ outcome: "error: model unavailable", wroteMessage: false });
    expect(result.runs[1]).toMatchObject({ outcome: "send" });
  });

  it("stops once the spend passes the cap and marks the report", async () => {
    const model = createFakeDecisionModel({ decisions: [CLEAN], tokens: { input: 1_000_000, output: 0 } });
    const result = await runModelTest({ contexts: [sampleContext(), sampleContext(), sampleContext()], combos, model, prices, now: NOW, capUsd: 2.5 });
    expect(result.stoppedAtCap).toBe(true);
    expect(result.runs).toHaveLength(1);
    expect(renderReport(result, combos, { at: NOW, contacts: 3 })).toContain("STOPPED: the spend passed");
  });

  it("the script refuses a production DATABASE_URL before connecting", () => {
    const run = spawnSync(process.execPath, ["--import", "tsx", "scripts/agent-model-test.ts", "--combos", "gpt-5.1>gpt-4.1"], {
      env: { ...process.env, DATABASE_URL: "postgres://x@db.jorxltfwboabyjiydyhu.supabase.co/postgres" },
      encoding: "utf8",
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("only runs against staging");
  });
});
