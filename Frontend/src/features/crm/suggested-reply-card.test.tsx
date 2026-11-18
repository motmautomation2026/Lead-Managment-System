import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplyDraft } from "@/types";

const mocks = vi.hoisted(() => ({
  sendReplyDraft: vi.fn(),
  discardReplyDraft: vi.fn(),
  latestReplyDraft: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));
vi.mock("@/store/workspace-context", () => ({
  useWorkspace: () => ({ currentWorkspaceId: "ws-1" }),
}));
vi.mock("@/lib/backend-client", () => ({
  BackendError: class extends Error {},
  backend: {
    contacts: {
      sendReplyDraft: mocks.sendReplyDraft,
      discardReplyDraft: mocks.discardReplyDraft,
      latestReplyDraft: mocks.latestReplyDraft,
    },
  },
}));

import { LatestSuggestedReply, SuggestedReplyCard } from "./suggested-reply-card";

const draft = (over: Partial<ReplyDraft> = {}): ReplyDraft => ({
  id: "d-1",
  channel: "whatsapp",
  status: "open",
  subject: null,
  body: "Thanks, Asha. Would Thursday or Friday suit you for a short call?",
  edited: null,
  sentBody: null,
  sentByName: null,
  queuedAt: null,
  sendStatus: null,
  sendAt: null,
  sentAt: null,
  sendError: null,
  createdAt: "2026-11-03T05:00:00Z",
  canSend: true,
  ...over,
});

let client: QueryClient;
const renderCard = (ui: React.ReactNode) =>
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SuggestedReplyCard", () => {
  it("shows the editable draft; Send posts the edited text and shows Sending… while queued", async () => {
    let resolve: (value: ReplyDraft) => void = () => undefined;
    mocks.sendReplyDraft.mockReturnValue(new Promise<ReplyDraft>((r) => (resolve = r)));
    renderCard(<SuggestedReplyCard contactId="c-1" draft={draft()} />);
    const box = screen.getByLabelText("Suggested reply");
    expect(box).toHaveValue(draft().body);
    fireEvent.change(box, { target: { value: "Thanks, Asha. Would Monday suit you?" } });
    expect(screen.getByText(/6 words\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByRole("button", { name: "Sending…" })).toBeDisabled();
    expect(mocks.sendReplyDraft).toHaveBeenCalledWith(
      "c-1",
      "d-1",
      "Thanks, Asha. Would Monday suit you?",
    );
    resolve(draft({ status: "sent", sendStatus: "queued", sendAt: "2030-01-07T04:00:00Z" }));
    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        expect.stringMatching(/^Reply queued\. Will send at /),
      ),
    );
  });

  it("Discard; a server error (e.g. the word limit) is shown", async () => {
    mocks.discardReplyDraft.mockResolvedValue(draft({ status: "discarded", canSend: false }));
    mocks.sendReplyDraft.mockRejectedValue(
      new Error("WhatsApp replies can be at most 60 words; this one has 70."),
    );
    renderCard(<SuggestedReplyCard contactId="c-1" draft={draft()} />);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        "WhatsApp replies can be at most 60 words; this one has 70.",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(mocks.discardReplyDraft).toHaveBeenCalledWith("c-1", "d-1"));
  });

  it("E3b-2b: a newer reply after the daily limit shows the marker; without one there is none", () => {
    const { rerender } = renderCard(<SuggestedReplyCard contactId="c-1" draft={draft()} />);
    expect(screen.queryByText(/wrote again after this draft/)).not.toBeInTheDocument();
    rerender(
      <QueryClientProvider client={client}>
        <SuggestedReplyCard
          contactId="c-1"
          draft={draft({ newerReplyAt: "2026-11-03T06:00:00Z", contactFirstName: "Asha" })}
        />
      </QueryClientProvider>,
    );
    expect(
      screen.getByText("Asha wrote again after this draft. Read the newer reply before sending."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  });

  it("an empty text can't be sent", () => {
    renderCard(<SuggestedReplyCard contactId="c-1" draft={draft()} />);
    fireEvent.change(screen.getByLabelText("Suggested reply"), { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("the sent state: queued with its time, then sent; edited and who sent it", () => {
    const sent = draft({
      status: "sent",
      canSend: false,
      sentBody: "Thanks, Asha.",
      edited: true,
      sentByName: "Govinda",
      sendStatus: "queued",
      sendAt: "2030-01-07T04:00:00Z",
    });
    const { rerender } = renderCard(<SuggestedReplyCard contactId="c-1" draft={sent} />);
    expect(screen.getByText(/^Will send at /)).toBeInTheDocument();
    expect(screen.getByText("Suggested reply, edited, sent by Govinda")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    rerender(
      <QueryClientProvider client={client}>
        <SuggestedReplyCard
          contactId="c-1"
          draft={{
            ...sent,
            sendStatus: "failed",
            sendAt: null,
            sendError: "The contact opted out of WhatsApp.",
          }}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByText("Not sent: The contact opted out of WhatsApp.")).toBeInTheDocument();
  });

  it("email: shows the subject and says the signature and booking link are added", () => {
    renderCard(
      <SuggestedReplyCard
        contactId="c-1"
        draft={draft({ channel: "email", subject: "Re: New buyers" })}
      />,
    );
    expect(screen.getByText("Subject: Re: New buyers")).toBeInTheDocument();
    expect(screen.getByText(/booking link when it offers a call/)).toBeInTheDocument();
  });
});

describe("LatestSuggestedReply (reply task)", () => {
  it("renders the contact's open draft, nothing when there is none or the user may not see it", async () => {
    mocks.latestReplyDraft.mockResolvedValueOnce({ draft: draft() });
    renderCard(<LatestSuggestedReply contactId="c-1" />);
    expect(await screen.findByLabelText("Suggested reply")).toBeInTheDocument();
    cleanup();
    mocks.latestReplyDraft.mockRejectedValueOnce(
      new Error("Only the contact owner and admins can see suggested replies."),
    );
    const { container } = renderCard(<LatestSuggestedReply contactId="c-2" />);
    await waitFor(() => expect(mocks.latestReplyDraft).toHaveBeenCalledTimes(2));
    expect(container).toBeEmptyDOMElement();
  });
});
