import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplyDraft, TaskListItem, TimelineEvent } from "@/types";
import { renderInRouter } from "@/test/render-in-router";

const mocks = vi.hoisted(() => ({
  rows: [] as TaskListItem[],
  listParams: [] as unknown[],
  countParams: [] as unknown[],
  canRead: true,
  complete: vi.fn(),
  send: vi.fn(),
  discard: vi.fn(),
  replyReads: [] as string[],
  toast: { success: vi.fn(), error: vi.fn() },
}));

const replyTask = (id: string, name: string): TaskListItem => ({
  id,
  leadId: `l-${id}`,
  ownerId: "u-1",
  ownerName: "Asha Owner",
  type: "follow_up",
  title: "Asked a question — respond today",
  dueAt: "2026-11-12T13:30:00.000Z",
  status: "open",
  done: false,
  origin: "agent",
  createdAt: "2026-11-12T08:00:00.000Z",
  updatedAt: "2026-11-12T08:00:00.000Z",
  contact: { id: `l-${id}`, name },
  company: null,
  isOverdue: false,
});

const draft = (contactId: string): ReplyDraft => ({
  id: `d-${contactId}`,
  channel: "whatsapp",
  status: "open",
  subject: null,
  body: "Happy to help — would Thursday or Friday suit you for a short call?",
  edited: null,
  sentBody: null,
  sentByName: null,
  queuedAt: null,
  sendStatus: null,
  sendAt: null,
  sentAt: null,
  sendError: null,
  createdAt: "2026-11-12T08:05:00.000Z",
  canSend: true,
});

const replyEvent = (contactId: string): TimelineEvent => ({
  id: `ev-${contactId}`,
  leadId: contactId,
  at: "2026-11-12T08:00:00.000Z",
  kind: "whatsapp_inbound",
  title: "Replied on WhatsApp",
  actor: "Contact",
  source: "system",
  reply: {
    channel: "whatsapp",
    messageId: `msg-${contactId}`,
    hasText: true,
    canRead: mocks.canRead,
    label: "question",
    labelSource: "ai",
    labelBy: null,
    classifying: false,
    canCorrect: false,
    draft: mocks.canRead ? draft(contactId) : null,
  },
});

vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/store", () => ({
  messageFromError: (error: unknown) => (error instanceof Error ? error.message : "Failed"),
  useTaskList: (params: unknown) => {
    mocks.listParams.push(params);
    return {
      data: { pages: [{ data: mocks.rows, nextCursor: null }] },
      isLoading: false,
      error: null,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
    };
  },
  useTaskCount: (params: unknown) => {
    mocks.countParams.push(params);
    return { data: { count: mocks.rows.length } };
  },
  useCompleteTask: () => ({ mutate: mocks.complete, isPending: false }),
  useContactTimeline: (contactId: string) => ({
    data: { pages: [{ data: contactId ? [replyEvent(contactId)] : [], nextCursor: null }] },
    isLoading: false,
  }),
  useCompanyTimeline: () => ({ data: undefined }),
  useDealTimeline: () => ({ data: undefined }),
  useCorrectReplyLabel: () => ({ mutate: vi.fn(), isPending: false }),
  // D2: the text is fetched only when "Show message" is clicked (enabled), and each read is audited.
  useInboundReply: (contactId: string, messageId: string, enabled: boolean) => {
    if (enabled) mocks.replyReads.push(`${contactId}/${messageId}`);
    return { data: enabled ? { text: `Text of ${messageId}` } : undefined, isLoading: false };
  },
  useReplyDraftActions: () => ({
    send: { mutate: mocks.send, isPending: false },
    discard: { mutate: mocks.discard, isPending: false },
  }),
}));

import { ReplyQueuePage } from "./reply-queue";

const renderQueue = () => renderInRouter(() => <ReplyQueuePage />);
const current = () => screen.getByRole("heading", { level: 2 }).textContent;

beforeEach(() => {
  mocks.rows = [replyTask("t1", "Ravi Kumar"), replyTask("t2", "Mira Rao")];
  mocks.canRead = true;
  mocks.replyReads = [];
  mocks.listParams = [];
  mocks.countParams = [];
  // Mutations succeed: run their onSuccess.
  const succeed = (_arg: unknown, options?: { onSuccess?: (v: unknown) => void }) =>
    options?.onSuccess?.({ sendAt: null });
  mocks.send.mockImplementation(succeed);
  mocks.discard.mockImplementation(succeed);
  mocks.complete.mockImplementation(succeed);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ReplyQueuePage", () => {
  it("asks for my open reply tasks oldest first, and counts them for the badge", async () => {
    await renderQueue();
    expect(mocks.listParams[0]).toEqual({
      ownerId: ["me"],
      replyTasks: "only",
      sort: "createdAt:asc",
      limit: 25,
    });
    expect(mocks.countParams[0]).toEqual({ ownerId: ["me"], replyTasks: "only" });
    expect(current()).toBe("Ravi Kumar");
    expect(screen.getByText("1 of 2")).toBeInTheDocument();
  });

  it("shows the reply text only after an audited click, then Send moves to the next reply", async () => {
    await renderQueue();
    expect(mocks.replyReads).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Show message" }));
    expect(await screen.findByText("Text of msg-l-t1")).toBeInTheDocument();
    expect(mocks.replyReads).toContain("l-t1/msg-l-t1");
    const card = screen.getByLabelText("Suggested reply").closest("div.rounded-md") as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: "Send" }));
    expect(mocks.send).toHaveBeenCalledWith(
      { draftId: "d-l-t1", body: draft("l-t1").body },
      expect.anything(),
    );
    await waitFor(() => expect(current()).toBe("Mira Rao"));
    expect(screen.getByText("2 of 2")).toBeInTheDocument();
  });

  it("Discard and Mark done move on too; Mark done completes the task", async () => {
    await renderQueue();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(current()).toBe("Mira Rao"));
    fireEvent.click(screen.getByRole("button", { name: /Mark done/ }));
    expect(mocks.complete).toHaveBeenCalledWith("t2", expect.anything());
    expect(await screen.findByText("No replies waiting")).toBeInTheDocument();
  });

  it("someone other than the owner or an admin never gets the text or a draft", async () => {
    mocks.canRead = false;
    await renderQueue();
    expect(
      screen.getByText("Only the contact owner and admins can read replies."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show message" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(mocks.replyReads).toEqual([]);
  });
});
