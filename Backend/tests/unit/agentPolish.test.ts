import { describe, expect, it } from "vitest";
import type { AgentDecision } from "../../src/agent/decisionSchema.js";
import { polishDecision } from "../../src/agent/polish.js";

const names = { ownerName: "Ravi Kumar", companyName: "MOTM Technologies" };
const whatsapp = (body: string): AgentDecision => ({ action: "send_whatsapp", body, assetIds: [], nextWakeInDays: 3, reasoning: "r" });
const email = (subject: string, body: string): AgentDecision => ({ action: "send_email", subject, body, assetIds: [], nextWakeInDays: 3, reasoning: "r" });
const polish = (body: string) => {
  const { decision, autoFixes } = polishDecision(whatsapp(body), names);
  return { body: (decision as { body: string }).body, rules: autoFixes.map((f) => f.rule), autoFixes };
};

describe("polishDecision: dashes", () => {
  it("a long dash in a sentence becomes a comma", () => {
    expect(polish("We work with traders — mostly in steel.").body).toBe("We work with traders, mostly in steel.");
    expect(polish("We work with traders–mostly in steel.").body).toBe("We work with traders, mostly in steel.");
  });

  it("a dash before a new thought becomes a full stop", () => {
    expect(polish("We spoke to your team last week — The numbers looked good.").body).toBe("We spoke to your team last week. The numbers looked good.");
  });

  it('" - " between words is a dash', () => {
    expect(polish("A short call - maybe on Monday.").body).toBe("A short call, maybe on Monday.");
  });

  it("never touches a range or a hyphenated word", () => {
    for (const text of ["We work 9–5 on weekdays.", "It takes 2 – 3 weeks.", "A follow-up on the long-term plan.", "We run 10-20 calls a day."]) {
      expect(polish(text)).toMatchObject({ body: text, rules: [] });
    }
  });

  it("leaves no dash next to other punctuation or at the end of a line", () => {
    expect(polish("Thanks, — that helps a lot.").body).toBe("Thanks, that helps a lot.");
    expect(polish("That helps a lot —\nShall we talk?").body).toBe("That helps a lot.\nShall we talk?");
  });
});

describe("polishDecision: exclamation marks and ellipses", () => {
  it('"!" becomes "."', () => {
    expect(polish("Great to hear from you! Shall we talk?")).toMatchObject({ body: "Great to hear from you. Shall we talk?", rules: ["exclamation"] });
    expect(polish("Great news!!").body).toBe("Great news.");
    expect(polish("Really?!").body).toBe("Really?");
  });

  it('"…" and "..." become "."', () => {
    expect(polish("We can help… Shall we talk?")).toMatchObject({ body: "We can help. Shall we talk?", rules: ["ellipsis"] });
    expect(polish("We can help... and soon.").body).toBe("We can help. And soon.");
    expect(polish("Shall we talk...?").body).toBe("Shall we talk?");
  });
});

describe("polishDecision: sign-offs", () => {
  it.each([
    ["Best regards,\nRavi Kumar\nMOTM Technologies"],
    ["Regards,\nRavi"],
    ["Thanks and regards,\nRavi Kumar"],
    ["Warm regards"],
    ["Cheers"],
    ["Ravi Kumar"],
    ["MOTM Technologies"],
    ["— Ravi Kumar, MOTM Technologies"],
  ])("removes %j", (signature) => {
    expect(polish(`Hi Asha, shall we talk on Monday?\n\n${signature}`)).toMatchObject({ body: "Hi Asha, shall we talk on Monday?", rules: ["sign_off"] });
  });

  it("keeps a closing sentence that isn't a sign-off", () => {
    const text = "Hi Asha, thanks for the call.\n\nThank you for your time on Monday.";
    expect(polish(text)).toMatchObject({ body: text, rules: [] });
  });

  it("leaves it when only a greeting would remain", () => {
    expect(polish("Hi Asha,\n\nRegards,\nRavi").body).toBe("Hi Asha,\n\nRegards,\nRavi");
  });
});

describe("polishDecision: links, addresses and numbers", () => {
  it("removes one alone on a line, in brackets, or after the sentence", () => {
    expect(polish("Hi Asha.\n\nhttps://motm.tech/case\n\nShall we talk?")).toMatchObject({ body: "Hi Asha.\n\nShall we talk?", rules: ["contact_details", "spacing"] });
    expect(polish("Our site (www.motm.tech) has more.").body).toBe("Our site has more.");
    expect(polish("We work with steel traders ravi@motm.tech").body).toBe("We work with steel traders");
    expect(polish("We work with steel traders +91 98765 43210.").body).toBe("We work with steel traders.");
  });

  it("leaves it when removing would break the sentence (the normal check fails)", () => {
    for (const text of ["You can read more at https://motm.tech.", "Call me on +91 98765 43210 today.", "Write to ravi@motm.tech for details."]) {
      expect(polish(text)).toMatchObject({ body: text, rules: [] });
    }
  });

  it("leaves dates and short numbers alone", () => {
    const text = "We can start on 2026-11-08 with 40 calls.";
    expect(polish(text)).toMatchObject({ body: text, rules: [] });
  });

  it("keeps a \"!\" inside a link it couldn't remove", () => {
    expect(polish("Read more at https://motm.tech/a!b").body).toBe("Read more at https://motm.tech/a!b");
  });
});

describe("polishDecision: spacing and the result", () => {
  it("normalises repeated spaces and blank lines", () => {
    expect(polish("Hi  Asha ,\n\n\n\nShall we talk?  ")).toMatchObject({ body: "Hi Asha,\n\nShall we talk?", rules: ["spacing"] });
  });

  it("records each fix with before and after", () => {
    const { autoFixes } = polish("Great news! We can help — soon.");
    expect(autoFixes).toEqual([
      { rule: "dash", before: "at news! We can help — soon.", after: "at news! We can help, soon." },
      { rule: "exclamation", before: "Great news! We can help, soon.", after: "Great news. We can help, soon." },
    ]);
  });

  it("fixes the subject too, without a sign-off pass", () => {
    const { decision, autoFixes } = polishDecision(email("Steel exports — next steps!", "Hi Asha, shall we talk?"), names);
    expect(decision).toMatchObject({ subject: "Steel exports, next steps." });
    expect(autoFixes.map((f) => f.rule)).toEqual(["dash", "exclamation"]);
  });

  it("clean text and other actions pass through unchanged", () => {
    expect(polish("Hi Asha, shall we talk on Monday?")).toMatchObject({ body: "Hi Asha, shall we talk on Monday?", rules: [] });
    const wait: AgentDecision = { action: "wait", nextWakeInDays: 3, reasoning: "r" };
    expect(polishDecision(wait, names)).toEqual({ decision: wait, autoFixes: [] });
  });

  it("a text that would become empty stays", () => {
    expect(polish("https://motm.tech").body).toBe("https://motm.tech");
  });
});

describe("E3b-2b rule 4: call-days auto-fix", () => {
  const days = { ...names, suggestedDays: "Saturday or Monday" };
  const fix = (body: string) => {
    const { decision, autoFixes } = polishDecision(whatsapp(body), days);
    return { body: (decision as { body: string }).body, rules: autoFixes.map((f) => f.rule) };
  };

  it("removes the time phrase cleanly when both suggested days are offered", () => {
    expect(fix("Hi Rakesh, thanks. Would Saturday or Monday suit you for a short call in the coming days?")).toEqual({
      body: "Hi Rakesh, thanks. Would Saturday or Monday suit you for a short call?",
      rules: ["call_days"],
    });
    expect(fix("Would Saturday or Monday work, in the next few days, for a call?").body).toBe("Would Saturday or Monday work, for a call?");
    expect(fix("Thanks. In the coming week, would Saturday or Monday suit you?").body).toBe("Thanks. Would Saturday or Monday suit you?");
    expect(fix("Hi Rakesh,\nSometime soon would Saturday or Monday suit you?").body).toBe("Hi Rakesh,\nWould Saturday or Monday suit you?");
  });

  it("leaves the text alone without both days (the check then regenerates) or without a time phrase", () => {
    expect(fix("Would Saturday suit you for a short call in the coming days?").rules).toEqual([]);
    expect(fix("Would a short call in the coming days suit you?").rules).toEqual([]);
    expect(fix("Would Saturday or Monday suit you for a short call?").rules).toEqual([]);
    expect(polishDecision(whatsapp("Would Saturday or Monday suit you in the coming days?"), names).autoFixes).toEqual([]);
  });
});

describe("E3b-2b rule 5: generic client-experience auto-fix", () => {
  const NEHA = "Our published client experiences describe how we helped similar B2B firms find new buyers.";

  it("removes Neha's sentence when at least 2 other sentences stay", () => {
    const body = `Hi Neha,\n\nThanks for your enquiry about export buyers. ${NEHA}\n\nWe start by mapping the right buyer segments. Would Saturday or Monday suit you for a short call?`;
    expect(polish(body)).toMatchObject({
      body: "Hi Neha,\n\nThanks for your enquiry about export buyers.\n\nWe start by mapping the right buyer segments. Would Saturday or Monday suit you for a short call?",
      rules: ["generic_client_claim"],
    });
    expect(polish(`Hi Neha,\n\n${NEHA}\n\nThanks for your enquiry. Would Saturday or Monday suit you?`).body).toBe("Hi Neha,\n\nThanks for your enquiry. Would Saturday or Monday suit you?");
  });

  it("keeps it when fewer than 2 other sentences would stay (the check then regenerates)", () => {
    expect(polish(`Hi Neha,\n\n${NEHA} Would Saturday or Monday suit you?`).rules).toEqual([]);
  });
});
