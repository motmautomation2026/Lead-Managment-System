/**
 * D3: raw RFC 822 messages as real mailboxes deliver them (Gmail / Outlook / Exim shapes),
 * for the inbound email parser and the fake IMAP client. CRLF line endings like the wire.
 */

export const OWN_ADDRESS = "sales@acme.test";
export const CONTACT_ADDRESS = "ravi@client.test";

const crlf = (lines: string[]) => lines.join("\r\n");

interface Base {
  messageId?: string | null;
  from?: string;
  to?: string;
  subject?: string;
  date?: string;
}

function headers(b: Base, extra: string[] = []): string[] {
  return [
    `From: ${b.from ?? `Ravi Kumar <${CONTACT_ADDRESS}>`}`,
    `To: ${b.to ?? `Acme Sales <${OWN_ADDRESS}>`}`,
    `Subject: ${b.subject ?? "Re: Quick question about your plant"}`,
    `Date: ${b.date ?? "Tue, 27 Oct 2026 10:15:00 +0530"}`,
    ...(b.messageId === null ? [] : [`Message-ID: ${b.messageId ?? "<reply-1@mail.client.test>"}`]),
    "MIME-Version: 1.0",
    ...extra,
  ];
}

/** A plain-text reply (Gmail shape: the quote under "On … wrote:" with "> " lines). */
export function plainReply(b: Base & { inReplyTo?: string; references?: string; text?: string; extraHeaders?: string[] } = {}) {
  return crlf([
    ...headers(b, [
      ...(b.inReplyTo ? [`In-Reply-To: ${b.inReplyTo}`] : []),
      ...(b.references ? [`References: ${b.references}`] : []),
      ...(b.extraHeaders ?? []),
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: 8bit",
    ]),
    "",
    b.text ??
      [
        "Yes, please send me the pricing for 3 machines.",
        "",
        "Thanks,",
        "Ravi",
        "",
        "On Mon, 26 Oct 2026 at 18:02, Asha Rao | Acme <sales@acme.test> wrote:",
        "> Hi Ravi,",
        "> Would you like a quote for the new line?",
        ">",
        "> Reply STOP to opt out.",
      ].join("\r\n"),
    "",
  ]);
}

/** Gmail's two-line attribution ("On … <x@y>\nwrote:"). */
export const GMAIL_WRAPPED_QUOTE = [
  "Sounds good, Thursday works.",
  "",
  "On Mon, 26 Oct 2026 at 18:02, Asha Rao | Acme Industries Private Limited <",
  "sales@acme.test> wrote:",
  "",
  "> Hi Ravi, can we meet on Thursday?",
].join("\r\n");

/** Outlook desktop: a line of underscores, then a From/Sent/To/Subject block. */
export const OUTLOOK_QUOTE = [
  "Please call me tomorrow after 11.",
  "",
  "Regards",
  "Ravi",
  "",
  "________________________________",
  "From: Asha Rao | Acme <sales@acme.test>",
  "Sent: Monday, October 26, 2026 6:02 PM",
  "To: Ravi Kumar <ravi@client.test>",
  "Subject: Quick question about your plant",
  "",
  "Hi Ravi, would you like a quote?",
].join("\r\n");

export const ORIGINAL_MESSAGE_QUOTE = [
  "Not right now, maybe next quarter.",
  "",
  "-----Original Message-----",
  "From: Asha Rao <sales@acme.test>",
  "Sent: Monday, October 26, 2026 6:02 PM",
  "Subject: Quick question",
  "",
  "Hi Ravi",
].join("\r\n");

/** HTML only (no text/plain part), Gmail quote markup. */
export function htmlOnlyReply(b: Base & { inReplyTo?: string } = {}) {
  return crlf([
    ...headers(b, [...(b.inReplyTo ? [`In-Reply-To: ${b.inReplyTo}`] : []), 'Content-Type: text/html; charset="UTF-8"']),
    "",
    '<div dir="ltr">Can you share the <b>brochure</b>?<br>Thanks</div><br>',
    '<div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Mon, 26 Oct 2026 at 18:02, Asha &lt;sales@acme.test&gt; wrote:<br></div>',
    '<blockquote class="gmail_quote">Hi Ravi, would you like a quote?</blockquote></div>',
    "",
  ]);
}

/** Hindi + English, base64 UTF-8 (as Gmail sends non-ASCII). */
export function hindiReply(b: Base & { inReplyTo?: string } = {}) {
  const text = "नमस्ते, हाँ मुझे कोटेशन भेज दीजिए।\nPlease send it by Friday.\n";
  return crlf([
    ...headers({ subject: "=?UTF-8?B?" + Buffer.from("Re: कोटेशन").toString("base64") + "?=", ...b }, [
      ...(b.inReplyTo ? [`In-Reply-To: ${b.inReplyTo}`] : []),
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
    ]),
    "",
    Buffer.from(text).toString("base64"),
    "",
  ]);
}

/** A delivery status notification (RFC 3464), Gmail- or Outlook-shaped. */
export function dsn(o: {
  status: string;
  action?: "failed" | "delayed";
  recipient?: string;
  originalMessageId?: string | null;
  diagnostic?: string;
  style?: "gmail" | "outlook";
  messageId?: string;
  /** Original headers as text/rfc822-headers (Outlook) instead of message/rfc822 (Gmail). */
  headersOnly?: boolean;
}) {
  const recipient = o.recipient ?? CONTACT_ADDRESS;
  const outlook = o.style === "outlook";
  const boundary = "dsn-boundary-1";
  const original = crlf([
    `From: Asha Rao <${OWN_ADDRESS}>`,
    `To: ${recipient}`,
    "Subject: Quick question about your plant",
    ...(o.originalMessageId === null ? [] : [`Message-ID: ${o.originalMessageId ?? "<orig-1@acme.test>"}`]),
    "Content-Type: text/plain",
  ]);
  return crlf([
    `From: ${outlook ? "Microsoft Outlook <postmaster@outlook.com>" : "Mail Delivery Subsystem <mailer-daemon@googlemail.com>"}`,
    `To: ${OWN_ADDRESS}`,
    `Subject: ${outlook ? "Undeliverable: Quick question about your plant" : o.action === "delayed" ? "Delivery Status Notification (Delay)" : "Delivery Status Notification (Failure)"}`,
    "Date: Tue, 27 Oct 2026 10:20:00 +0530",
    `Message-ID: ${o.messageId ?? "<dsn-1@mx.google.test>"}`,
    "MIME-Version: 1.0",
    ...(outlook ? ["Auto-Submitted: auto-replied"] : []),
    `Content-Type: multipart/report; report-type=delivery-status; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    `Address not found. Your message wasn't delivered to ${recipient}.`,
    "",
    `--${boundary}`,
    "Content-Type: message/delivery-status",
    "",
    "Reporting-MTA: dns; mx.google.test",
    "",
    `Final-Recipient: rfc822; ${recipient}`,
    `Action: ${o.action ?? "failed"}`,
    `Status: ${o.status}`,
    `Diagnostic-Code: smtp; ${o.diagnostic ?? `550 ${o.status} The email account that you tried to reach does not exist.`}`,
    "",
    `--${boundary}`,
    `Content-Type: ${o.headersOnly ? "text/rfc822-headers" : "message/rfc822"}`,
    "",
    original,
    ...(o.headersOnly ? [] : ["", "Hi Ravi, would you like a quote?"]),
    "",
    `--${boundary}--`,
    "",
  ]);
}

/** Exim-style bounce: X-Failed-Recipients, plain text, original headers copied into the body. */
export function eximBounce(o: { recipient?: string; originalMessageId?: string } = {}) {
  const recipient = o.recipient ?? CONTACT_ADDRESS;
  return crlf([
    "From: Mail Delivery System <Mailer-Daemon@mx.host.test>",
    `To: ${OWN_ADDRESS}`,
    "Subject: Mail delivery failed: returning message to sender",
    "Date: Tue, 27 Oct 2026 10:20:00 +0530",
    "Message-ID: <exim-1@mx.host.test>",
    `X-Failed-Recipients: ${recipient}`,
    "Content-Type: text/plain; charset=us-ascii",
    "",
    "This message was created automatically by mail delivery software.",
    "",
    "A message that you sent could not be delivered to one or more of its recipients.",
    "",
    `  ${recipient}`,
    "    host mx.client.test [10.0.0.1]",
    "    SMTP error from remote mail server after RCPT TO:<x>:",
    "    550 5.1.1 User unknown",
    "",
    "------ This is a copy of the message, including all the headers. ------",
    "",
    `From: Asha Rao <${OWN_ADDRESS}>`,
    `Message-ID: ${o.originalMessageId ?? "<orig-1@acme.test>"}`,
    "Subject: Quick question",
    "",
    "Hi Ravi",
    "",
  ]);
}

export function autoReply(o: Base & { extraHeaders?: string[]; inReplyTo?: string } = {}) {
  return crlf([
    ...headers({ subject: "Out of Office: Quick question about your plant", ...o }, [
      ...(o.inReplyTo ? [`In-Reply-To: ${o.inReplyTo}`] : []),
      ...(o.extraHeaders ?? ["Auto-Submitted: auto-replied"]),
      "Content-Type: text/plain; charset=UTF-8",
    ]),
    "",
    "I am out of the office until 2 November with limited access to email.",
    "",
  ]);
}

export function unsubscribeMessage(o: Base = {}) {
  return crlf([...headers({ subject: " Unsubscribe ", ...o }, ["Content-Type: text/plain; charset=UTF-8"]), "", "This is an unsubscribe request.", ""]);
}
