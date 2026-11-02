import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const mocks = vi.hoisted(() => ({
  isAdmin: false,
  userId: "rep-1",
  rate: vi.fn(),
  report: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock("@/store", () => {
  const mutation = (fn: ReturnType<typeof vi.fn>) => ({ mutate: fn, isPending: false });
  return {
    messageFromError: (error: unknown) => (error instanceof Error ? error.message : "Failed"),
    useIsAdmin: () => mocks.isAdmin,
    useSession: () => ({ currentUser: { id: mocks.userId } }),
    useAgentDecision: () => ({ data: undefined, isLoading: false, error: null }),
    useRateDecision: () => mutation(mocks.rate),
    useReportDecision: () => mutation(mocks.report),
    useResolveReport: () => mutation(mocks.resolve),
  };
});

vi.mock("@/features/crm/record-link", () => ({
  RecordLink: ({ type, id, children }: { type: string; id: string; children: ReactNode }) => (
    <a href={`/${type}/${id}`}>{children}</a>
  ),
}));

import { AttachmentsUsed, ContextUsed, RatingControls, ReportsSection } from "./decision-drawer";

describe("AttachmentsUsed (E2g)", () => {
  it("lists attachments by title, the removed ones with the reason and the ones left out at send time", () => {
    render(
      <AttachmentsUsed
        attachments={{
          assets: [{ id: "a1", title: "Steel trading case study", sent: true }],
          removed: [{ assetId: "a2", title: "EPC case study", reason: "first_message" }],
          issues: [
            {
              assetId: "a3",
              title: null,
              reason: "The asset was deleted or turned off before sending.",
            },
          ],
        }}
      />,
    );
    expect(screen.getByText("Steel trading case study (sent)")).toBeTruthy();
    expect(
      screen.getByText("Removed EPC case study: No attachments before a conversation exists"),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Not sent A deleted asset: The asset was deleted or turned off before sending.",
      ),
    ).toBeTruthy();
  });

  it("renders nothing without attachments unless asked to say none", () => {
    const empty = { assets: [], removed: [], issues: [] };
    const { container, unmount } = render(<AttachmentsUsed attachments={empty} />);
    expect(container.textContent).toBe("");
    unmount();
    render(<AttachmentsUsed attachments={empty} showNone />);
    expect(screen.getByText("none")).toBeTruthy();
  });
});

describe("ContextUsed", () => {
  it("links the company and the deal, with the deal's stage at the time", () => {
    render(
      <ContextUsed
        context={{
          company: { id: "co-1", name: "Acme Steel" },
          deal: { id: "d-1", name: "Acme – pilot", stage: "proposal_sent" },
        }}
      />,
    );
    expect(screen.getByRole("link", { name: "Acme Steel" }).getAttribute("href")).toBe(
      "/company/co-1",
    );
    expect(screen.getByRole("link", { name: "Acme – pilot" }).getAttribute("href")).toBe(
      "/deal/d-1",
    );
    expect(screen.getByText("Proposal sent")).toBeTruthy();
    expect(screen.queryByText("No company")).toBeNull();
  });

  it("says so when the decision saw no company and no open deal (or predates D1)", () => {
    const { unmount } = render(<ContextUsed context={{ company: null, deal: null }} />);
    expect(screen.getByText("No company")).toBeTruthy();
    expect(screen.getByText("no open deal")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
    unmount();
    render(<ContextUsed context={undefined} />);
    expect(screen.getByText("No company")).toBeTruthy();
  });
});

const decision = {
  id: "d-1",
  outcome: "draft" as const,
  rating: null,
  ratingReason: null,
  ratingNote: null,
  leadOwnerId: "owner-1",
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.isAdmin = false;
  mocks.userId = "rep-1";
});

describe("RatingControls", () => {
  it("is hidden for a salesperson who isn't the lead's owner", () => {
    render(<RatingControls decision={decision} />);
    expect(screen.queryByRole("button", { name: "Good" })).toBeNull();
  });

  it("is shown for the lead's owner and for admins, never on a failed decision", () => {
    mocks.userId = "owner-1";
    const { unmount } = render(<RatingControls decision={decision} />);
    expect(screen.getByRole("button", { name: "Good" })).toBeTruthy();
    unmount();

    mocks.userId = "someone-else";
    mocks.isAdmin = true;
    const admin = render(<RatingControls decision={decision} />);
    expect(screen.getByRole("button", { name: "Bad" })).toBeTruthy();
    admin.unmount();

    render(<RatingControls decision={{ ...decision, outcome: "failed" }} />);
    expect(screen.queryByRole("button", { name: "Good" })).toBeNull();
  });

  it("Bad needs one of the six reasons before it can be saved", () => {
    mocks.isAdmin = true;
    render(<RatingControls decision={decision} />);
    const save = screen.getByRole("button", { name: "Save rating" });
    expect(save).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByRole("button", { name: "Bad" }));
    for (const reason of [
      "Made-up fact",
      "Leaked internal info",
      "Wrong tone",
      "Wrong timing",
      "Wrong action",
      "Other",
    ]) {
      expect(screen.getByRole("button", { name: reason })).toBeTruthy();
    }
    expect(save).toHaveProperty("disabled", true);
    fireEvent.click(save);
    expect(mocks.rate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Made-up fact" }));
    fireEvent.change(screen.getByPlaceholderText("Note (optional)"), {
      target: { value: " Invented a client " },
    });
    fireEvent.click(save);
    expect(mocks.rate).toHaveBeenCalledWith(
      { id: "d-1", input: { rating: "bad", reason: "made_up_fact", note: "Invented a client" } },
      expect.anything(),
    );
  });

  it("Good saves without a reason", () => {
    mocks.userId = "owner-1";
    render(<RatingControls decision={decision} />);
    fireEvent.click(screen.getByRole("button", { name: "Good" }));
    fireEvent.click(screen.getByRole("button", { name: "Save rating" }));
    expect(mocks.rate).toHaveBeenCalledWith(
      { id: "d-1", input: { rating: "good", reason: undefined, note: undefined } },
      expect.anything(),
    );
  });
});

describe("ReportsSection", () => {
  const report = {
    id: "r-1",
    decisionId: "d-1",
    reportedBy: "rep-1",
    reportedByName: "Naitik",
    note: "It promised a discount.",
    createdAt: "2026-10-23T05:30:00.000Z",
    resolvedAt: null,
    resolvedBy: null,
    resolutionNote: null,
  };

  it("anyone can report; only admins see Resolve", () => {
    const { unmount } = render(<ReportsSection decisionId="d-1" reports={[report]} />);
    expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("What's wrong with this AI message?"), {
      target: { value: "Wrong price" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Report" }));
    expect(mocks.report).toHaveBeenCalledWith(
      { id: "d-1", note: "Wrong price" },
      expect.anything(),
    );
    unmount();

    mocks.isAdmin = true;
    render(<ReportsSection decisionId="d-1" reports={[report]} />);
    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
    expect(mocks.resolve).toHaveBeenCalledWith(
      { reportId: "r-1", note: undefined },
      expect.anything(),
    );
  });
});
