import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/store", () => ({ useAgentLivePreview: () => ({ data: undefined, error: null }) }));

import { GatePanel, LiveBanner, SendStatusPill } from "./live-mode";
import { ChecksSummary } from "./decision-drawer";
import { checkProblem, istDateTime, withIstTimes } from "./agent-labels";

afterEach(cleanup);

describe("E2h: attachment problems in plain words", () => {
  it("names the cancel reason and the check", () => {
    render(
      <SendStatusPill
        state={{ ...state, sendStatus: "cancelled", cancelReason: "attachment_missing" }}
        showReason
      />,
    );
    expect(
      screen.getByText(
        "Not sent: the attachment was missing and the message mentioned it; the AI will write a new message",
      ),
    ).toBeTruthy();
    expect(checkProblem("attachment_mention: No file will be attached.").text).toBe(
      "Mentioned an attachment that couldn't be attached: No file will be attached.",
    );
  });
});

const state = {
  sendStatus: null,
  sentAt: null,
  sendError: null,
  cancelReason: null,
  channel: "whatsapp" as const,
};

describe("E2f: Reset go-live count", () => {
  const readiness = {
    ready: false,
    rated: 3,
    goodPct: 100,
    seriousBad: 0,
    reasons: ["Rate at least 50 decisions (3 rated so far)."],
  };

  it("shows where the count starts; the reset asks for confirmation first", () => {
    const onConfirm = vi.fn();
    render(
      <GatePanel
        readiness={readiness}
        readinessSince="2026-10-29T10:00:00.000Z"
        reset={{ onConfirm, pending: false }}
      />,
    );
    expect(
      screen.getByText(`Counting since ${istDateTime("2026-10-29T10:00:00.000Z")}`),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reset go-live count" }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "Ratings before now stay saved but no longer count toward the go-live gate.",
      ),
    ).toBeTruthy();
    const dialog = screen.getByRole("dialog");
    fireEvent.click(
      Array.from(dialog.querySelectorAll("button")).find(
        (b) => b.textContent === "Reset go-live count",
      )!,
    );
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("never reset → counting all ratings; no button without `reset` (e.g. the live confirm dialog)", () => {
    render(<GatePanel readiness={readiness} readinessSince={null} />);
    expect(screen.getByText("Counting all ratings")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reset go-live count" })).toBeNull();
  });
});

describe("E2 live UI pieces", () => {
  it.each([
    ["queued", "Queued"],
    ["sent", "Sent"],
    ["failed", "Send failed"],
    ["cancelled", "Cancelled"],
    ["dry_run", "Dry run"],
  ] as const)("send status %s → %s", (sendStatus, text) => {
    render(<SendStatusPill state={{ ...state, sendStatus }} />);
    expect(screen.getByText(text)).toBeTruthy();
  });

  it("shows the reason as a tooltip, or as text when asked; nothing for a draft", () => {
    const { container, unmount } = render(<SendStatusPill state={state} />);
    expect(container).toBeEmptyDOMElement();
    unmount();
    render(
      <SendStatusPill
        state={{
          ...state,
          sendStatus: "failed",
          sendError: "First WhatsApp message can't contain a link",
        }}
        showReason
      />,
    );
    expect(screen.getByText("Send failed").getAttribute("title")).toBe(
      "First WhatsApp message can't contain a link",
    );
    expect(screen.getAllByText("First WhatsApp message can't contain a link")).toHaveLength(1);
  });

  it("the Live banner says who is live and what was sent", () => {
    render(
      <LiveBanner
        live={{
          scope: "new_leads",
          liveSince: null,
          liveContacts: 4,
          sentToday: 2,
          sentThisMonth: 11,
        }}
      />,
    );
    expect(screen.getByRole("status").textContent).toBe(
      "Live: the AI sends real messages to 4 contacts (New leads (pilot)). 2 sent today, 11 this month. Other AI contacts get drafts only.",
    );
  });

  it("rule notes show times in IST, not raw UTC", () => {
    expect(withIstTimes("Deferred until 2026-10-29T04:00:00.000Z.", istDateTime)).toBe(
      "Deferred until 29 Oct 2026, 9:30 am IST.",
    );
    render(
      <ChecksSummary
        rules={{
          allowed: true,
          violations: [],
          adjustments: [{ rule: "timing", message: "Deferred until 2026-10-29T04:00:00.000Z." }],
        }}
        grounding={null}
      />,
    );
    expect(screen.getByText("Adjusted: Deferred until 29 Oct 2026, 9:30 am IST.")).toBeTruthy();
    expect(screen.queryByText(/2026-10-29T04/)).toBeNull();
  });

  it("E3a: what code fixed on the final attempt is shown; spacing only by name", () => {
    render(
      <ChecksSummary
        rules={{ allowed: true, violations: [], adjustments: [] }}
        grounding={null}
        attempts={[
          {
            problems: [],
            autoFixes: [
              { rule: "dash", before: "traders — mostly", after: "traders, mostly" },
              { rule: "sign_off", before: "Best regards, Ravi", after: "" },
              { rule: "spacing", before: "repeated spaces or blank lines", after: "normalised" },
            ],
          },
        ]}
      />,
    );
    expect(screen.getByText("Fixed automatically:")).toBeTruthy();
    expect(screen.getByText(/Long dash, Sign-off removed, Spacing/)).toBeTruthy();
    expect(screen.getByText("“traders — mostly” → “traders, mostly”")).toBeTruthy();
    expect(screen.getByText("“Best regards, Ravi” → removed")).toBeTruthy();
    expect(screen.queryByText(/normalised/)).toBeNull();
  });

  it("E2b: style problems and the first attempt's failures are shown", () => {
    render(
      <ChecksSummary
        rules={{ allowed: true, violations: [], adjustments: [] }}
        grounding={{
          supported: true,
          unsupportedClaims: [],
          styleViolations: [{ rule: "unsupported_sector_claim", quote: "we help chemical makers" }],
        }}
        attempts={[
          { problems: ['banned_phrase: Uses banned phrase(s): "thanks for connecting".'] },
          { problems: [] },
        ]}
      />,
    );
    expect(screen.getByText("Unsupported sector claim: “we help chemical makers”")).toBeTruthy();
    expect(
      screen.getByText('Banned phrase: Uses banned phrase(s): "thanks for connecting".'),
    ).toBeTruthy();
  });

  it("E2f: with two regenerations both failed attempts are listed", () => {
    render(
      <ChecksSummary
        rules={{ allowed: true, violations: [], adjustments: [] }}
        grounding={null}
        attempts={[
          { problems: ["one_question: The message asks 2 questions; ask at most one."] },
          { problems: ['banned_phrase: Uses banned phrase(s): "today".'] },
          { problems: [] },
        ]}
      />,
    );
    expect(screen.getByText(/First attempt failed/)).toBeTruthy();
    expect(screen.getByText(/Second attempt failed/)).toBeTruthy();
    expect(screen.getByText('Banned phrase: Uses banned phrase(s): "today".')).toBeTruthy();
  });

  it("E2c: an internal information leak is shown in red by name, other checks in plain words", () => {
    const leak =
      'Repeats internal information. Do not mention: "specialty chemicals for textile plants".';
    render(
      <ChecksSummary
        rules={{
          allowed: false,
          violations: [
            { rule: "internal_info_leak", message: leak },
            { rule: "not_thanking_inbound", message: "Thank them." },
          ],
          adjustments: [],
        }}
        grounding={null}
        attempts={[
          {
            problems: [
              `internal_info_leak: ${leak}`,
              "introduction_mid_conversation: No intro.",
              "Unsupported claim: 200 clients",
            ],
          },
          { problems: [`internal_info_leak: ${leak}`] },
        ]}
      />,
    );
    const [now, before] = screen.getAllByText(`Internal information leak: ${leak}`);
    expect(now!.className).toContain("text-destructive");
    expect(before!.className).toContain("text-destructive");
    expect(screen.getByText("Doesn't thank an inbound lead: Thank them.")).toBeTruthy();
    expect(screen.getByText("Introduces us mid-conversation: No intro.").className).not.toContain(
      "text-destructive",
    );
    expect(screen.getByText("Unsupported claim: 200 clients")).toBeTruthy();
  });
});
