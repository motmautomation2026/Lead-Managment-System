import { describe, expect, it } from "vitest";
import { canTransition, type TransitionContext } from "../../src/agent/status.js";
import type { AgentStatus } from "../../src/agent/rules.js";

const ctx = (extra: Partial<TransitionContext> = {}): TransitionContext => ({
  lifecycleState: "active",
  nurtureLongTerm: false,
  statusReason: null,
  hasContact: true,
  ...extra,
});
const ALL: AgentStatus[] = ["none", "active", "paused", "handed_off", "stopped"];
const refusal = (result: ReturnType<typeof canTransition>) => (result.ok ? null : result.reason);

describe("agent status machine", () => {
  it("enroll: none and stopped (non-permanent) → active", () => {
    expect(canTransition("none", "enroll", ctx())).toEqual({ ok: true, to: "active" });
    expect(canTransition("stopped", "enroll", ctx({ statusReason: "admin_stop" }))).toEqual({ ok: true, to: "active" });
    expect(canTransition("stopped", "enroll", ctx({ statusReason: null }))).toEqual({ ok: true, to: "active" });
  });

  it("enroll refusals", () => {
    expect(refusal(canTransition("active", "enroll", ctx()))).toBe("already_active");
    expect(refusal(canTransition("paused", "enroll", ctx()))).toBe("invalid_status");
    expect(refusal(canTransition("handed_off", "enroll", ctx()))).toBe("invalid_status");
    expect(refusal(canTransition("stopped", "enroll", ctx({ statusReason: "asked_to_stop" })))).toBe("permanently_stopped");
    expect(refusal(canTransition("stopped", "enroll", ctx({ statusReason: "not_interested" })))).toBe("permanently_stopped");
    expect(refusal(canTransition("none", "enroll", ctx({ hasContact: false })))).toBe("no_contact");
    for (const lifecycle of ["won", "lost", "discarded", "do_not_contact", "merged"] as const) {
      expect(refusal(canTransition("none", "enroll", ctx({ lifecycleState: lifecycle })))).toBe("not_eligible");
    }
  });

  it("long-term nurture is eligible only when the workspace nurtures long-term", () => {
    expect(refusal(canTransition("none", "enroll", ctx({ lifecycleState: "long_term_nurture" })))).toBe("not_eligible");
    expect(canTransition("none", "enroll", ctx({ lifecycleState: "long_term_nurture", nurtureLongTerm: true }))).toEqual({ ok: true, to: "active" });
    expect(refusal(canTransition("paused", "resume", ctx({ lifecycleState: "long_term_nurture" })))).toBe("not_eligible");
    expect(canTransition("paused", "resume", ctx({ lifecycleState: "long_term_nurture", nurtureLongTerm: true }))).toEqual({ ok: true, to: "active" });
  });

  it("pause: only active → paused", () => {
    for (const from of ALL) {
      expect(canTransition(from, "pause", ctx())).toEqual(from === "active" ? { ok: true, to: "paused" } : expect.objectContaining({ reason: "invalid_status" }));
    }
  });

  it("resume: paused and handed_off → active, with the lifecycle rule; contact isn't required", () => {
    for (const from of ALL) {
      const ok = from === "paused" || from === "handed_off";
      expect(canTransition(from, "resume", ctx({ hasContact: false }))).toEqual(ok ? { ok: true, to: "active" } : expect.objectContaining({ reason: "invalid_status" }));
    }
    expect(refusal(canTransition("handed_off", "resume", ctx({ lifecycleState: "do_not_contact" })))).toBe("not_eligible");
  });

  it("stop: active, paused, handed_off → stopped, whatever the lifecycle", () => {
    for (const from of ALL) {
      const ok = from === "active" || from === "paused" || from === "handed_off";
      expect(canTransition(from, "stop", ctx({ lifecycleState: "won" }))).toEqual(ok ? { ok: true, to: "stopped" } : expect.objectContaining({ reason: "invalid_status" }));
    }
  });
});
