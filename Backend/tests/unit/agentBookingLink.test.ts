import { describe, expect, it } from "vitest";
import { applyAssetRules, type AgentAssetInfo, type AssetFacts } from "../../src/agent/assetRules.js";
import { composeOutgoing, type ComposeOptions } from "../../src/agent/composeMessage.js";
import { CALL_ANGLES, ANGLES } from "../../src/agent/stagePlan.js";
import { bookingUrlSchema } from "../../src/services/profiles.service.js";

const URL = "https://calendly.com/ravi-northbeam";
const options: ComposeOptions = {
  ownerName: "Ravi Kumar",
  companyName: "Northbeam",
  settings: { email_opt_out_text: 'Reply "stop" to opt out.', whatsapp_opt_out_text: "Reply STOP to opt out." },
  isFirstWhatsApp: false,
  bookingUrl: URL,
  angle: "check_in",
};
const email = { action: "send_email" as const, subject: "Next step", body: "Hi Asha,\n\nWould Thursday or Friday suit you?", assetIds: [], nextWakeInDays: 3, reasoning: "r" };
const whatsapp = { action: "send_whatsapp" as const, body: "Hi Asha, would Thursday or Friday suit you?", assetIds: [], nextWakeInDays: 3, reasoning: "r" };

describe("E3b-1 rule 5: the booking line", () => {
  it("email: after the body, before the signature", () => {
    const result = composeOutgoing(email, options);
    if (result.channel !== "email") throw new Error("expected email");
    expect(result.bookingLinkAdded).toBe(true);
    expect(result.text).toContain(`Would Thursday or Friday suit you?\n\nIf it's easier, you can pick a time here: ${URL}\n\nBest regards,`);
    expect(result.html).toContain(`<p>If it&#39;s easier, you can pick a time here: ${URL}</p>`);
  });

  it("WhatsApp (not the first): after the body, before the signature", () => {
    const result = composeOutgoing(whatsapp, options);
    expect(result.bookingLinkAdded).toBe(true);
    expect(result.text).toContain(`suit you?\n\nYou can also pick a time here: ${URL}\n\n`);
    expect(result.text.indexOf(URL)).toBeLessThan(result.text.indexOf("Ravi"));
  });

  it("never on a first WhatsApp (E1: no link in a first message)", () => {
    const result = composeOutgoing(whatsapp, { ...options, isFirstWhatsApp: true, angle: "welcome" });
    expect(result.bookingLinkAdded).toBe(false);
    expect(result.text).not.toContain("https://");
  });

  it("only for angles that ask for a call", () => {
    for (const angle of ANGLES) {
      expect(composeOutgoing(email, { ...options, angle }).bookingLinkAdded).toBe(CALL_ANGLES.includes(angle));
    }
    expect(CALL_ANGLES).toEqual(["welcome", "check_in", "reschedule", "meeting_recap", "proposal_timing", "call_followup"]);
    expect(composeOutgoing(email, { ...options, angle: null }).bookingLinkAdded).toBe(false);
  });

  it("not without a booking link", () => {
    for (const bookingUrl of [null, undefined, ""]) {
      const result = composeOutgoing(email, { ...options, bookingUrl });
      expect(result.bookingLinkAdded).toBe(false);
      expect(result.text).not.toContain("pick a time");
    }
  });
});

describe("E3b-1 rule 5: booking link validation", () => {
  it("accepts https links up to 300 characters; blank → null", () => {
    expect(bookingUrlSchema.parse(URL)).toBe(URL);
    expect(bookingUrlSchema.parse("  ")).toBeNull();
    expect(bookingUrlSchema.parse(null)).toBeNull();
    expect(bookingUrlSchema.parse(`https://cal.com/${"a".repeat(284)}`)).toHaveLength(300);
  });

  it("refuses http, other schemes, spaces, bare words and > 300 characters", () => {
    for (const bad of ["http://calendly.com/x", "javascript:alert(1)", "https://calendly.com/a b", "calendly", "https://localhost/x", `https://cal.com/${"a".repeat(285)}`]) {
      expect(bookingUrlSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe("E3b-1 rule 7: a WhatsApp attachment after a logged call or a held meeting", () => {
  const A = "11111111-1111-4111-8111-111111111111";
  const assets: AgentAssetInfo[] = [{ id: A, active: true, channels: ["email", "whatsapp"], sizeBytes: 1000 }];
  const facts = (overrides: Partial<AssetFacts> = {}): AssetFacts => ({
    conversationExists: true,
    realMessageSent: true,
    whatsappReplied: false,
    sentAssetIds: [],
    ...overrides,
  });

  it("allowed after a call or a held meeting without a WhatsApp reply", () => {
    expect(applyAssetRules([A], "whatsapp", assets, facts({ callOrMeetingHeld: true }))).toEqual({ kept: [A], removed: [] });
    expect(applyAssetRules([A], "whatsapp", assets, facts()).removed).toEqual([{ assetId: A, reason: "whatsapp_no_reply" }]);
  });

  it("still dropped on a first message, when already sent, and over one on WhatsApp", () => {
    const first = facts({ conversationExists: false, realMessageSent: false, callOrMeetingHeld: true });
    expect(applyAssetRules([A], "whatsapp", assets, first).removed).toEqual([{ assetId: A, reason: "first_message" }]);
    expect(applyAssetRules([A], "whatsapp", assets, facts({ callOrMeetingHeld: true, sentAssetIds: [A] })).removed).toEqual([{ assetId: A, reason: "already_sent" }]);
  });
});
