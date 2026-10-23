import { describe, expect, it } from "vitest";
import { buildKbQuery } from "../../src/agent/kbQuery.js";
import { trimToCap, type AgentContext } from "../../src/services/agentContext.service.js";

describe("buildKbQuery", () => {
  it("combines industry, stage, objection, last call outcome and the first 300 chars of the enquiry", () => {
    const query = buildKbQuery(
      { industry: "Steel", pipelineStage: "objection_nurture", objectionType: "budget_price", websiteMessage: `${"x".repeat(400)}` },
      { outcome: "interested_later" },
    );
    expect(query).toBe(
      ["Industry: Steel", "Stage: objection nurture", "Objection: budget price", "Last call: interested later", `Enquiry: ${"x".repeat(300)}`].join("\n"),
    );
  });

  it("skips what's missing", () => {
    expect(buildKbQuery({ industry: " ", pipelineStage: "new", objectionType: null, websiteMessage: null }, null)).toBe("Stage: new");
  });
});

describe("trimToCap", () => {
  const entry = (i: number) => ({ at: `2026-10-${String(i).padStart(2, "0")}T00:00:00.000Z`, kind: "note", title: "Note Added", detail: "word ".repeat(200) });
  const base = {
    workspaceId: "w",
    companyName: "Northbeam",
    playbook: { version: 1, body: "playbook ".repeat(300) },
    knowledge: { query: "q", chunks: [{ id: "c1", title: "Doc", text: "fact ".repeat(300) }] },
    timeline: Array.from({ length: 20 }, (_, i) => entry(i + 1)),
    decisionSummaries: Array.from({ length: 10 }, (_, i) => ({ at: `t${i}`, action: "wait", outcome: "draft", reasoning: "because ".repeat(20) })),
  } as unknown as AgentContext;

  it("keeps everything under the cap", () => {
    const result = trimToCap(base, 100_000);
    expect(result.meta).toMatchObject({ trimmedTimelineEvents: 0, trimmedDecisionSummaries: 0 });
    expect(result.timeline).toHaveLength(20);
  });

  it("drops the oldest timeline events first, never the playbook or knowledge", () => {
    const result = trimToCap(base, 2_500);
    expect(result.meta.trimmedTimelineEvents).toBeGreaterThan(0);
    expect(result.meta.trimmedDecisionSummaries).toBe(0);
    expect(result.meta.tokenEstimate).toBeLessThanOrEqual(2_500);
    expect(result.timeline.at(-1)).toEqual(base.timeline.at(-1));
    expect(result.timeline[0]).toEqual(base.timeline[result.meta.trimmedTimelineEvents]);
    expect(result.playbook).toBe(base.playbook);
    expect(result.knowledge).toBe(base.knowledge);
  });

  it("then drops the oldest decision summaries", () => {
    const result = trimToCap(base, 900);
    expect(result.timeline).toEqual([]);
    expect(result.meta.trimmedTimelineEvents).toBe(20);
    expect(result.meta.trimmedDecisionSummaries).toBeGreaterThan(0);
    expect(result.decisionSummaries.at(-1)).toEqual(base.decisionSummaries.at(-1));
  });
});
