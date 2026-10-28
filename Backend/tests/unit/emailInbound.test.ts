import { describe, expect, it } from "vitest";
import {
  candidateMessageIds,
  classifyInboundEmail,
  extractReplyText,
  isOwnOrNoReply,
  parseDsn,
  parseInboundEmail,
  MAX_REPLY_CHARS,
} from "../../src/domain/emailInbound.js";
import {
  CONTACT_ADDRESS,
  GMAIL_WRAPPED_QUOTE,
  ORIGINAL_MESSAGE_QUOTE,
  OUTLOOK_QUOTE,
  OWN_ADDRESS,
  autoReply,
  dsn,
  eximBounce,
  hindiReply,
  htmlOnlyReply,
  plainReply,
  unsubscribeMessage,
} from "../fixtures/email/rawEmails.js";

const own = { fromAddress: OWN_ADDRESS, replyTo: OWN_ADDRESS };
const classify = async (raw: string) => classifyInboundEmail(await parseInboundEmail(raw), own);

describe("D3 bounces (rule 3a)", () => {
  it("Gmail DSN 5.1.1: permanent, recipient, original Message-ID from message/rfc822", async () => {
    const result = await classify(dsn({ status: "5.1.1", originalMessageId: "<abc-123@acme.test>" }));
    expect(result.kind).toBe("bounce");
    expect(result.dsn).toMatchObject({ status: "5.1.1", permanent: true, recipient: CONTACT_ADDRESS, originalMessageId: "<abc-123@acme.test>" });
    expect(result.dsn!.diagnostic).toContain("550 5.1.1");
  });

  it("Outlook DSN 5.1.1 (Undeliverable, text/rfc822-headers, Auto-Submitted): a bounce, not an auto-reply", async () => {
    const result = await classify(dsn({ status: "5.1.1", style: "outlook", headersOnly: true, originalMessageId: "<o-1@acme.test>" }));
    expect(result.kind).toBe("bounce");
    expect(result.dsn).toMatchObject({ status: "5.1.1", originalMessageId: "<o-1@acme.test>" });
  });

  it("5.7.1 policy rejection is permanent", async () => {
    const result = await classify(dsn({ status: "5.7.1", diagnostic: "550 5.7.1 Message rejected by policy" }));
    expect(result.kind).toBe("bounce");
    expect(result.dsn!.status).toBe("5.7.1");
  });

  it("4.4.7 delayed is temporary", async () => {
    const result = await classify(dsn({ status: "4.4.7", action: "delayed", diagnostic: "Message delayed" }));
    expect(result.kind).toBe("bounce_temporary");
    expect(result.dsn).toMatchObject({ status: "4.4.7", permanent: false });
  });

  it("X-Failed-Recipients only (Exim): status and original Message-ID from the body", async () => {
    const result = await classify(eximBounce({ originalMessageId: "<ex-9@acme.test>" }));
    expect(result.kind).toBe("bounce");
    expect(result.dsn).toMatchObject({ status: "5.1.1", recipient: CONTACT_ADDRESS, originalMessageId: "<ex-9@acme.test>" });
  });

  it("a DSN without the original message still parses", async () => {
    const parsed = await parseInboundEmail(dsn({ status: "5.1.1", originalMessageId: null }));
    expect(parseDsn(parsed).originalMessageId).toBeNull();
  });
});

describe("D3 auto-replies (rule 3b)", () => {
  it("Gmail out-of-office (Auto-Submitted: auto-replied)", async () => {
    expect((await classify(autoReply())).kind).toBe("auto_reply");
  });

  it("Outlook 'Automatic reply:' subject without headers", async () => {
    expect((await classify(autoReply({ subject: "Automatic reply: Quick question", extraHeaders: [] }))).kind).toBe("auto_reply");
  });

  it("Precedence: bulk, List-Id and X-Autoreply", async () => {
    expect((await classify(autoReply({ subject: "News", extraHeaders: ["Precedence: bulk"] }))).kind).toBe("auto_reply");
    expect((await classify(autoReply({ subject: "News", extraHeaders: ["List-Id: <news.vendor.test>"] }))).kind).toBe("auto_reply");
    expect((await classify(autoReply({ subject: "Thanks", extraHeaders: ["X-Autoreply: yes"] }))).kind).toBe("auto_reply");
  });

  it("Auto-Submitted: no is a person", async () => {
    expect((await classify(plainReply({ extraHeaders: ["Auto-Submitted: no"] }))).kind).toBe("reply");
  });
});

describe("D3 unsubscribe (rule 3c) and ignored senders (3d)", () => {
  it("subject 'unsubscribe' (trimmed, any case) to our address", async () => {
    expect((await classify(unsubscribeMessage())).kind).toBe("unsubscribe");
    expect((await classify(unsubscribeMessage({ subject: "UNSUBSCRIBE" }))).kind).toBe("unsubscribe");
  });

  it("'unsubscribe me please' is a reply (left to keywords / AI)", async () => {
    expect((await classify(unsubscribeMessage({ subject: "unsubscribe me please" }))).kind).toBe("reply");
  });

  it("our own sent copy and no-reply senders are ignored", async () => {
    expect((await classify(plainReply({ from: `Asha <${OWN_ADDRESS}>` }))).kind).toBe("ignored");
    expect((await classify(plainReply({ from: "Portal <no-reply@service.test>" }))).kind).toBe("ignored");
    expect((await classify(plainReply({ from: "Portal <noreply+abc@service.test>" }))).kind).toBe("ignored");
    expect((await classify(plainReply({ from: "Portal <donotreply@service.test>" }))).kind).toBe("ignored");
  });

  it("isOwnOrNoReply is case-insensitive", () => {
    expect(isOwnOrNoReply("SALES@ACME.TEST", [OWN_ADDRESS])).toBe(true);
    expect(isOwnOrNoReply("ravi@client.test", [OWN_ADDRESS])).toBe(false);
    expect(isOwnOrNoReply(null, [OWN_ADDRESS])).toBe(true);
  });
});

describe("D3 replies: matching ids (rule 4)", () => {
  it("In-Reply-To first, then References newest first", async () => {
    const parsed = await parseInboundEmail(plainReply({ inReplyTo: "<b@acme.test>", references: "<a@acme.test> <b@acme.test>" }));
    expect((await classify(plainReply({ inReplyTo: "<b@acme.test>" }))).kind).toBe("reply");
    expect(candidateMessageIds(parsed)).toEqual([
      { id: "<b@acme.test>", method: "in_reply_to" },
      { id: "<a@acme.test>", method: "references" },
    ]);
  });

  it("only References", async () => {
    const parsed = await parseInboundEmail(plainReply({ references: "<x1@acme.test>\r\n <x2@acme.test>" }));
    expect(candidateMessageIds(parsed).map((c) => c.id)).toEqual(["<x2@acme.test>", "<x1@acme.test>"]);
  });

  it("a reply from a different address keeps its In-Reply-To", async () => {
    const raw = plainReply({ from: "Ravi <ravi.personal@gmail.test>", inReplyTo: "<orig@acme.test>" });
    expect((await classify(raw)).kind).toBe("reply");
    expect(candidateMessageIds(await parseInboundEmail(raw))[0]).toEqual({ id: "<orig@acme.test>", method: "in_reply_to" });
  });
});

describe("D3 reply text (rule 5)", () => {
  const text = async (raw: string) => extractReplyText(await parseInboundEmail(raw));

  it("Gmail 'On … wrote:' and '>' lines are stripped", async () => {
    const r = await text(plainReply());
    expect(r.text).toBe("Yes, please send me the pricing for 3 machines.\n\nThanks,\nRavi");
    expect(r.subject).toBe("Re: Quick question about your plant");
  });

  it("Gmail's wrapped two-line attribution", async () => {
    expect((await text(plainReply({ text: GMAIL_WRAPPED_QUOTE }))).text).toBe("Sounds good, Thursday works.");
  });

  it("Outlook underscores + From/Sent block", async () => {
    expect((await text(plainReply({ text: OUTLOOK_QUOTE }))).text).toBe("Please call me tomorrow after 11.\n\nRegards\nRavi");
  });

  it("Outlook From/Sent block without the separator", async () => {
    const body = OUTLOOK_QUOTE.replace("________________________________\r\n", "");
    expect((await text(plainReply({ text: body }))).text).toBe("Please call me tomorrow after 11.\n\nRegards\nRavi");
  });

  it("-----Original Message-----", async () => {
    expect((await text(plainReply({ text: ORIGINAL_MESSAGE_QUOTE }))).text).toBe("Not right now, maybe next quarter.");
  });

  it("HTML-only: converted to text, Gmail quote dropped", async () => {
    expect((await text(htmlOnlyReply())).text).toBe("Can you share the brochure?\nThanks");
  });

  it("Hindi + English (base64 UTF-8, encoded subject)", async () => {
    const r = await text(hindiReply());
    expect(r.text).toBe("नमस्ते, हाँ मुझे कोटेशन भेज दीजिए।\nPlease send it by Friday.");
    expect(r.subject).toBe("Re: कोटेशन");
  });

  it("very long text is cut to 4,000 code points", async () => {
    const r = await text(plainReply({ text: "नमस्ते ".repeat(1500) }));
    expect(r.truncated).toBe(true);
    expect(Array.from(r.text)).toHaveLength(MAX_REPLY_CHARS);
    const short = await text(plainReply({ text: "ok" }));
    expect(short).toMatchObject({ text: "ok", truncated: false });
  });
});
