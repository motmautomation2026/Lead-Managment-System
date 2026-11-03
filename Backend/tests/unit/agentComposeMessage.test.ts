import { describe, expect, it } from "vitest";
import { composeOutgoing, type ComposeOptions } from "../../src/agent/composeMessage.js";

const options: ComposeOptions = {
  ownerName: "Ravi Kumar",
  companyName: "Northbeam",
  settings: { email_opt_out_text: 'If you\'d prefer not to hear from us, just reply "stop".', whatsapp_opt_out_text: "Reply STOP to opt out." },
  isFirstWhatsApp: false,
};

const email = (body: string) => ({ action: "send_email" as const, subject: "Hello", body, assetIds: [], nextWakeInDays: 3, reasoning: "r" });
const whatsapp = (body: string) => ({ action: "send_whatsapp" as const, body, assetIds: [], nextWakeInDays: 3, reasoning: "r" });

describe("composeOutgoing", () => {
  it("email: text = body + signature + opt-out; html = escaped paragraphs with <br> inside", () => {
    const result = composeOutgoing(email("Hi Asha,\n\nLine one\nline two"), options);
    expect(result).toEqual({
      channel: "email",
      subject: "Hello",
      text: 'Hi Asha,\n\nLine one\nline two\n\nBest regards,\nRavi Kumar\nNorthbeam\n\nIf you\'d prefer not to hear from us, just reply "stop".',
      html: [
        "<p>Hi Asha,</p>",
        "<p>Line one<br>line two</p>",
        "<p>Best regards,<br>Ravi Kumar<br>Northbeam</p>",
        "<p>If you&#39;d prefer not to hear from us, just reply &quot;stop&quot;.</p>",
      ].join("\n"),
      bookingLinkAdded: false,
    });
  });

  it("email: escapes <script>, & and quotes in the body", () => {
    const result = composeOutgoing(email(`<script>alert("x")</script> & 'q'`), options);
    if (result.channel !== "email") throw new Error("expected email");
    expect(result.html).toContain("<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;</p>");
    expect(result.html).not.toContain("<script>");
  });

  it("email: splits paragraphs on blank lines (incl. CRLF and whitespace-only lines)", () => {
    const result = composeOutgoing(email("A\r\n\r\nB\n  \nC"), options);
    if (result.channel !== "email") throw new Error("expected email");
    expect(result.html.split("\n").slice(0, 3)).toEqual(["<p>A</p>", "<p>B</p>", "<p>C</p>"]);
    expect(result.text.startsWith("A\n\nB\n\nC\n\nBest regards,")).toBe(true);
  });

  it("email: owner and company names containing HTML are escaped", () => {
    const result = composeOutgoing(email("Hi"), { ...options, ownerName: "<b>Ravi</b>", companyName: "A & B <Co>" });
    if (result.channel !== "email") throw new Error("expected email");
    expect(result.html).toContain("<p>Best regards,<br>&lt;b&gt;Ravi&lt;/b&gt;<br>A &amp; B &lt;Co&gt;</p>");
    expect(result.text).toContain("Best regards,\n<b>Ravi</b>\nA & B <Co>");
  });

  it("WhatsApp: opt-out only on the first message", () => {
    expect(composeOutgoing(whatsapp("Hi Asha"), { ...options, isFirstWhatsApp: true })).toEqual({
      channel: "whatsapp",
      text: "Hi Asha\n\n— Ravi Kumar, Northbeam\n\nReply STOP to opt out.",
      bookingLinkAdded: false,
    });
    expect(composeOutgoing(whatsapp("Hi Asha"), options)).toEqual({ channel: "whatsapp", text: "Hi Asha\n\n— Ravi Kumar, Northbeam", bookingLinkAdded: false });
  });
});
