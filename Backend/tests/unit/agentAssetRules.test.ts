import { describe, expect, it } from "vitest";
import { applyAssetRules, assetViolations, MAX_ATTACHMENT_BYTES, type AgentAssetInfo, type AssetFacts } from "../../src/agent/assetRules.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const MB = 1024 * 1024;

const assets: AgentAssetInfo[] = [
  { id: A, active: true, channels: ["email", "whatsapp"], sizeBytes: 1 * MB },
  { id: B, active: true, channels: ["email"], sizeBytes: 2 * MB },
  { id: C, active: true, channels: ["email"], sizeBytes: 3 * MB },
];

const facts = (overrides: Partial<AssetFacts> = {}): AssetFacts => ({
  conversationExists: true,
  realMessageSent: true,
  whatsappReplied: true,
  sentAssetIds: [],
  ...overrides,
});

describe("assetViolations (rule 1)", () => {
  it("rejects unknown, inactive and channel-not-allowed assets", () => {
    const list = [...assets, { id: C, active: false, channels: ["email"], sizeBytes: 1 }];
    expect(assetViolations([B], "whatsapp", assets).map((n) => n.message)).toEqual([`Asset ${B} is not allowed on whatsapp.`]);
    expect(assetViolations(["44444444-4444-4444-8444-444444444444"], "email", assets)[0]!.message).toMatch(/does not exist/);
    expect(assetViolations([C], "email", [list[0]!, list[3]!])[0]!.message).toMatch(/not active/);
    expect(assetViolations([A, B], "email", assets)).toEqual([]);
  });
});

describe("applyAssetRules (rules 2–4, limits)", () => {
  it("rule 2: no attachment before a conversation or a real message (drafts don't count)", () => {
    expect(applyAssetRules([A], "email", assets, facts({ conversationExists: false, realMessageSent: false }))).toEqual({
      kept: [],
      removed: [{ assetId: A, reason: "first_message" }],
    });
    expect(applyAssetRules([A], "email", assets, facts({ conversationExists: false })).kept).toEqual([A]);
    expect(applyAssetRules([A], "email", assets, facts({ realMessageSent: false })).kept).toEqual([A]);
  });

  it("unknown facts are treated as a first message", () => {
    expect(applyAssetRules([A], "email", assets, null).removed).toEqual([{ assetId: A, reason: "first_message" }]);
  });

  it("rule 3: WhatsApp attachments only after a WhatsApp reply; email doesn't need one", () => {
    expect(applyAssetRules([A], "whatsapp", assets, facts({ whatsappReplied: false })).removed).toEqual([{ assetId: A, reason: "whatsapp_no_reply" }]);
    expect(applyAssetRules([A], "whatsapp", assets, facts()).kept).toEqual([A]);
    expect(applyAssetRules([A], "email", assets, facts({ whatsappReplied: false })).kept).toEqual([A]);
  });

  it("rule 4: an asset already sent to the contact is not attached again", () => {
    expect(applyAssetRules([A, B], "email", assets, facts({ sentAssetIds: [A] }))).toEqual({ kept: [B], removed: [{ assetId: A, reason: "already_sent" }] });
  });

  it("at most 2 on email (the first kept) and 1 on WhatsApp; duplicates collapse", () => {
    expect(applyAssetRules([A, B, C], "email", assets, facts())).toEqual({ kept: [A, B], removed: [{ assetId: C, reason: "count_limit" }] });
    expect(applyAssetRules([A, A], "whatsapp", assets, facts())).toEqual({ kept: [A], removed: [] });
  });

  it("over 10 MB in total: the largest is dropped until it fits", () => {
    const big: AgentAssetInfo[] = [
      { id: A, active: true, channels: ["email"], sizeBytes: 4 * MB },
      { id: B, active: true, channels: ["email"], sizeBytes: 7 * MB },
    ];
    expect(applyAssetRules([A, B], "email", big, facts())).toEqual({ kept: [A], removed: [{ assetId: B, reason: "size_limit" }] });
    const huge = [{ id: A, active: true, channels: ["email"], sizeBytes: MAX_ATTACHMENT_BYTES + 1 }];
    expect(applyAssetRules([A], "email", huge, facts())).toEqual({ kept: [], removed: [{ assetId: A, reason: "size_limit" }] });
  });

  it("nothing chosen → nothing removed", () => {
    expect(applyAssetRules([], "email", assets, null)).toEqual({ kept: [], removed: [] });
  });
});
