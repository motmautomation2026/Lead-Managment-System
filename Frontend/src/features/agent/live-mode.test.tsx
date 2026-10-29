import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/store", () => ({ useAgentLivePreview: () => ({ data: undefined, error: null }) }));

import { LiveBanner, SendStatusPill } from "./live-mode";
import { ChecksSummary } from "./decision-drawer";
import { istDateTime, withIstTimes } from "./agent-labels";

afterEach(cleanup);

const state = {
  sendStatus: null,
  sentAt: null,
  sendError: null,
  cancelReason: null,
  channel: "whatsapp" as const,
};

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
      screen.getByText('banned_phrase: Uses banned phrase(s): "thanks for connecting".'),
    ).toBeTruthy();
  });
});
