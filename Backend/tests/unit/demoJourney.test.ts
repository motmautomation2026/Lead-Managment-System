import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentDecision } from "../../src/agent/decisionSchema.js";
import type { DecisionModel, ReplyClassifierModel } from "../../src/providers/openai.provider.js";
import { demoInputSchema, renderMarkdown, runDemoJourney, type DemoInput, type DemoResult, type KnowledgeFile } from "../../src/demo/demoJourney.js";
import { fakeVector } from "../helpers/fakeEmbedder.js";

// DEMO-1: the offline demo journey with fake models (never OpenAI, never a database).
const PRICES = {
  "gpt-5.4-mini": { inputPer1M: 0.75, cachedInputPer1M: 0.075, outputPer1M: 4.5 },
  "gpt-4.1": { inputPer1M: 2, cachedInputPer1M: 0.5, outputPer1M: 8 },
};
const INPUT: DemoInput = demoInputSchema.parse({
  workspace: { companyDisplayName: "MOTM Technologies", ownerName: "Naitik", bookingLink: "https://calendly.com/motm-demo/15min", writer: "gpt-5.4-mini@low", checker: "gpt-4.1", startAtIst: "2026-11-16T10:05:00+05:30" },
  leads: [
    {
      key: "sagar", firstName: "Sagar", lastName: "Khanna", company: null, email: "demo.sagar@rediffmail.com", phone: "+91 90000 00101", source: "website_form",
      industry: "B2B Professional Services", revenueRange: "Rs.2–10Cr", enquiry: "Need new leads. I am an industrial contractor for insulation and scaffolding.",
      scenario: { repCallNote: "SIMULATED: Spoke for 10 minutes. Wants regular enquiries from plants.", leadReply: { channel: "whatsapp", text: "SIMULATED: Ok. What will be the charges for this?" } },
    },
    {
      key: "reshma", firstName: "Reshma", lastName: "Tantry", company: "Altem Technologies Pvt Ltd", email: "demo.reshma@altem.example", emailDomainIsCorporate: true, phone: "+91 90000 00102",
      source: "website_form", industry: "industrial-automation", revenueRange: null, enquiry: "We are looking for B2B lead generation and SDR support",
      scenario: { repCallNote: "SIMULATED: Wants meetings with automation buyers in the UAE.", leadReply: { channel: "email", text: "SIMULATED: Have you done outreach in the GCC region before?" } },
    },
  ],
});
const KNOWLEDGE: KnowledgeFile[] = [
  { name: "AI_PLAYBOOK_v7.txt", text: "Tone: warm, plain and specific. One question per message." },
  { name: "STYLE_EXAMPLES_v2.txt", text: "Hi Ravi, thank you for your enquiry." },
  { name: "KB_MOTM_Approach.md", text: "# Approach\n\nWe qualify every lead by phone before passing it on. ".repeat(20) },
  { name: "KB_MOTM_Services.md", text: "# Services\n\nOutsourced SDR support, calling and follow-up for B2B companies. ".repeat(20) },
];

/** Writes a clean message on whichever channel the prompt asks for, with the prompt's own closing question when it has one. */
function journeyModel() {
  const calls = { decide: 0, grounding: 0, reply: 0, embed: 0 };
  const model: DecisionModel & ReplyClassifierModel = {
    async decide(input) {
      calls.decide++;
      const system = input.messages[0]!.content;
      const all = input.messages.map((m) => m.content).join("\n");
      const replyDraft = system.includes("You draft a reply for a salesperson");
      const email = replyDraft ? system.includes("action send_email") : all.includes("Channel for this message: email");
      const closing = /Closing question(?: when you offer a call)?(?: \(word for word, no time phrase added\))?: (Would [^\n?]+\?)/.exec(all)?.[1] ?? "";
      const body = replyDraft
        ? `Good question. The details depend on the buyers and regions you want, so Naitik will cover them on a short call. ${closing}`.trim()
        : `Thank you for your enquiry. We help industrial firms reach plant and project buyers with steady outreach and follow-up. ${closing}`.trim();
      const json: AgentDecision = email
        ? { action: "send_email", subject: "Steady enquiries for your team", body, assetIds: [], nextWakeInDays: 3, reasoning: "Test reasoning." }
        : { action: "send_whatsapp", body, assetIds: [], nextWakeInDays: 3, reasoning: "Test reasoning." };
      return { json, inputTokens: 6000, outputTokens: 300, model: input.model };
    },
    async checkGrounding(input) {
      calls.grounding++;
      return { json: { supported: true, unsupportedClaims: [] }, inputTokens: 6000, outputTokens: 100, model: input.model };
    },
    async classifyReply(input) {
      calls.reply++;
      return { json: { label: "question", confidence: 0.9 }, inputTokens: 300, outputTokens: 10, model: input.model };
    },
  };
  const embedder = {
    model: "fake-embedding",
    async embed(texts: string[]) {
      calls.embed++;
      return texts.map(fakeVector);
    },
  };
  return { calls, model, embedder };
}

const run = (overrides: Partial<Parameters<typeof runDemoJourney>[0]> = {}) => {
  const fake = journeyModel();
  return { fake, result: runDemoJourney({ input: INPUT, knowledge: KNOWLEDGE, prices: PRICES, confirm: true, maxCostUsd: 3, model: fake.model, embedder: fake.embedder, ...overrides }) };
};

const IST_MS = 330 * 60_000;
const istParts = (iso: string) => {
  const d = new Date(new Date(iso).getTime() + IST_MS);
  return { weekday: d.getUTCDay(), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
};
const step = (result: DemoResult, lead: string, key: string) => result.leads.find((l) => l.key === lead)!.steps.find((s) => s.step === key)!;

describe("DEMO-1 demo journey", () => {
  it("a dry run makes zero model and embedding calls and still plans every step with an estimate", async () => {
    const { fake, result } = run({ confirm: false });
    const r = await result;
    expect(fake.calls).toEqual({ decide: 0, grounding: 0, reply: 0, embed: 0 });
    expect(r.spentUsd).toBe(0);
    expect(r.estimateUsd).toBeGreaterThan(0);
    for (const lead of r.leads) {
      expect(lead.steps.map((s) => s.step)).toEqual(["1", "2", "2b", "3", "4", "5", "6"]);
      expect(lead.steps.slice(1).every((s) => s.status === "planned" && s.message === null)).toBe(true);
    }
  });

  it("a paid run (fake models) writes every step; the first WhatsApp has no link and ends with the opt-out line", async () => {
    const { fake, result } = run();
    const r = await result;
    expect(fake.calls.decide).toBeGreaterThan(0);
    for (const lead of r.leads) {
      expect(lead.steps.map((s) => s.step)).toEqual(["1", "2", "2b", "3", "4", "5", "6"]);
      expect(lead.steps.every((s) => s.status === "done")).toBe(true);
      const first = step(r, lead.key, "2");
      expect(first.attempts).toBe(1);
      expect(first.message).toMatchObject({ channel: "whatsapp", firstWhatsApp: true, hasLink: false, optOutLine: true, bookingLink: false, sent: true });
      expect(first.message!.text.endsWith("Reply STOP to opt out.")).toBe(true);
      expect(first.message!.text).not.toMatch(/https?:\/\//);
      expect(step(r, lead.key, "2b").message).toMatchObject({ channel: "email", sent: false });
      // The call follow-up is a call angle on email: the owner's booking link is added; later WhatsApps have no opt-out line.
      expect(step(r, lead.key, "3").message).toMatchObject({ channel: "email", bookingLink: true });
      expect(step(r, lead.key, "4").message).toMatchObject({ channel: "whatsapp", firstWhatsApp: false, optOutLine: false });
      expect(step(r, lead.key, "6").stage).toBe("After a call · final check");
    }
    // The reply's channel decides the suggested reply's: WhatsApp for Sagar, email (threaded) for Reshma.
    expect(step(r, "sagar", "5").message).toMatchObject({ channel: "whatsapp", sent: false, firstWhatsApp: false });
    expect(step(r, "reshma", "5").message?.subject).toMatch(/^Re: /);
    expect(step(r, "sagar", "5").happened.join(" ")).toContain('"Asked a question — respond today"');
  });

  it("journey order and simulated times respect the window, the 48 h gap, 2 per 7 days and the rep-quiet hours", async () => {
    const r = await run().result;
    for (const lead of r.leads) {
      const at = (key: string) => new Date(step(r, lead.key, key).at).getTime();
      const start = new Date(r.startAt).getTime();
      expect(at("2") - start).toBeLessThanOrEqual(15 * 60_000);
      const sends = ["2", "3", "4"].map(at);
      expect([...sends].sort((a, b) => a - b)).toEqual(sends);
      for (let i = 1; i < sends.length; i++) expect(sends[i]! - sends[i - 1]!).toBeGreaterThanOrEqual(48 * 3_600_000);
      // At most 2 in any 7 days: the 3rd message is at least 7 days after the 1st.
      expect(sends[2]! - sends[0]!).toBeGreaterThanOrEqual(7 * 24 * 3_600_000);
      // Rep quiet: the call is logged one day after arrival; the AI waits 24 h after it.
      expect(at("3") - (start + 24 * 3_600_000)).toBeGreaterThanOrEqual(24 * 3_600_000);
      expect(at("5")).toBeGreaterThan(at("4"));
      expect(at("6")).toBeGreaterThan(at("4"));
      for (const key of ["3", "4", "6"]) {
        const { weekday, minutes } = istParts(step(r, lead.key, key).at);
        expect(weekday).not.toBe(0);
        expect(minutes).toBeGreaterThanOrEqual(9 * 60 + 30);
        expect(minutes).toBeLessThan(19 * 60);
      }
    }
  });

  it("--max-cost stops before a step that would pass it", async () => {
    const full = run();
    await full.result;
    const capped = run({ maxCostUsd: 0.02 });
    const r = await capped.result;
    expect(r.stoppedAtCap).toBe(true);
    expect(r.spentUsd).toBeLessThanOrEqual(0.02);
    expect(capped.fake.calls.decide).toBeLessThan(full.fake.calls.decide);
    const steps = r.leads.flatMap((l) => l.steps);
    expect(steps.find((s) => s.step === "2")!.status).toBe("done");
    expect(steps.filter((s) => s.status === "skipped (cost cap)").length).toBeGreaterThan(0);
  });

  it("the Markdown output contains every step of every lead, the summary table and the exact composed messages", async () => {
    const r = await run().result;
    const md = renderMarkdown(r, new Date("2026-11-13T09:00:00Z"));
    expect(md).toContain("| Lead | Messages written | Passed first try | Regenerations | Auto-fixes | Cost |");
    for (const lead of r.leads) {
      expect(md).toContain(`## ${lead.name}`);
      for (const s of lead.steps) {
        expect(md).toContain(`### Step ${s.step} — ${s.title}`);
        if (s.message) expect(md).toContain(s.message.text.split("\n")[0]);
      }
    }
    expect(md).toContain("(simulated)");
    expect(() => JSON.stringify(r)).not.toThrow();
  });

  it("imports no database, Storage or send code (static import graph)", () => {
    const seen = new Set<string>();
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/^import\s+(?!type\b)[^;]*?from\s+"(\.[^"]+)"|^import\s+"(\.[^"]+)"/gm)) {
        const spec = (m[1] ?? m[2])!.replace(/\.js$/, ".ts");
        walk(resolve(dirname(file), spec));
      }
    };
    walk(resolve("src/demo/demoJourney.ts"));
    const files = [...seen].map((f) => f.replace(/\\/g, "/"));
    expect(files.length).toBeGreaterThan(20);
    expect(files.filter((f) => /\/src\/(db|dbGuard|supabaseAdmin)\.ts$|\/providers\/(?!openai\.provider|provider-errors)|\/services\//.test(f))).toEqual([]);
  });
});
