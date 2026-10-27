import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InboundReply, TimelineEvent } from "@/types";

const mocks = vi.hoisted(() => ({
  timeline: vi.fn(),
  reply: vi.fn(),
  setReplyLabel: vi.fn(),
}));

vi.mock("@/store/workspace-context", () => ({
  useWorkspace: () => ({ currentWorkspaceId: "ws-1" }),
}));
vi.mock("@/lib/backend-client", () => ({
  BackendError: class extends Error {},
  backend: {
    contacts: { timeline: mocks.timeline, reply: mocks.reply, setReplyLabel: mocks.setReplyLabel },
    companies: { timeline: vi.fn() },
    deals: { timeline: vi.fn() },
  },
}));

import { keys } from "@/store/query";
import { ActivityFeed, ReadReplyLink } from "./activity-feed";

const SECRET = "Yes, please send the proposal";
const replyRow = (reply: TimelineEvent["reply"], id = "t-1"): TimelineEvent => ({
  id,
  leadId: "c-1",
  at: "2026-10-27T05:00:00Z",
  kind: "whatsapp",
  title: "WhatsApp reply received - automation stopped",
  actor: "System",
  source: "system",
  ...(reply && { reply }),
});
type ReplyField = NonNullable<TimelineEvent["reply"]>;
const r = (over: Partial<ReplyField> = {}): ReplyField => ({
  messageId: "m-1",
  hasText: true,
  canRead: true,
  label: null,
  labelSource: null,
  labelBy: null,
  classifying: false,
  canCorrect: false,
  ...over,
});
const answer = (over: Partial<InboundReply> = {}): InboundReply => ({
  messageId: "m-1",
  receivedAt: "2026-10-27T05:00:00Z",
  text: SECRET,
  truncated: false,
  ...over,
});

let client: QueryClient;

async function renderWithRouter(ui: ReactNode) {
  const root = createRootRoute({ component: () => <Outlet /> });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: "/", component: () => <>{ui}</> }),
      createRoute({
        getParentRoute: () => root,
        path: "/contacts/$contactId",
        component: () => null,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const feed = (rows: TimelineEvent[]) => {
  mocks.timeline.mockResolvedValue({ data: rows, nextCursor: null });
  return renderWithRouter(<ActivityFeed contactId="c-1" />);
};
const cachedReply = () => client.getQueryData(keys.inboundReply("ws-1", "c-1", "m-1"));

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ActivityFeed — inbound replies (D2)", () => {
  it("requests the text only after Show message; Hide removes it from the cache", async () => {
    mocks.reply.mockResolvedValue(answer());
    await feed([replyRow(r({ hasText: true, canRead: true }))]);
    const show = await screen.findByRole("button", { name: "Show message" });
    expect(mocks.reply).not.toHaveBeenCalled();

    fireEvent.click(show);
    expect(await screen.findByText(SECRET)).toBeInTheDocument();
    expect(mocks.reply).toHaveBeenCalledTimes(1);
    expect(mocks.reply.mock.calls[0]!.slice(0, 2)).toEqual(["c-1", "m-1"]);
    expect(cachedReply()).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
    expect(cachedReply()).toBeUndefined();
    expect(screen.getByRole("button", { name: "Show message" })).toBeInTheDocument();
  });

  it("unmounting (navigating away) removes the text from the cache", async () => {
    mocks.reply.mockResolvedValue(answer());
    await feed([replyRow(r({ hasText: true, canRead: true }))]);
    fireEvent.click(await screen.findByRole("button", { name: "Show message" }));
    await screen.findByText(SECRET);
    cleanup();
    expect(cachedReply()).toBeUndefined();
  });

  it("shows the shortened note when truncated", async () => {
    mocks.reply.mockResolvedValue(answer({ truncated: true }));
    await feed([replyRow(r({ hasText: true, canRead: true }))]);
    fireEvent.click(await screen.findByRole("button", { name: "Show message" }));
    expect(await screen.findByText("(shortened — the message was longer)")).toBeInTheDocument();
  });

  it.each([
    ["not_stored", /wasn't stored/],
    ["unreadable", /can't be read/],
  ] as const)("shows %s as muted text", async (reason, text) => {
    mocks.reply.mockResolvedValue(answer({ text: null, reason }));
    await feed([replyRow(r({ hasText: reason === "unreadable", canRead: true }))]);
    fireEvent.click(await screen.findByRole("button", { name: "Show message" }));
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it("no button and an explanation when the user can't read replies", async () => {
    await feed([replyRow(r({ hasText: true, canRead: false }))]);
    expect(
      await screen.findByText("Only the contact owner and admins can read replies."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show message" })).not.toBeInTheDocument();
    expect(mocks.reply).not.toHaveBeenCalled();
  });

  it("rows without `reply` get no button", async () => {
    await feed([replyRow(undefined)]);
    await screen.findByText("WhatsApp reply received - automation stopped");
    expect(screen.queryByRole("button", { name: "Show message" })).not.toBeInTheDocument();
  });

  it("initialFilter asks the server for messages only", async () => {
    mocks.timeline.mockResolvedValue({ data: [], nextCursor: null });
    await renderWithRouter(<ActivityFeed contactId="c-1" initialFilter="messages" focusReply />);
    await waitFor(() => expect(mocks.timeline).toHaveBeenCalled());
    expect(mocks.timeline.mock.calls[0]![1]).toEqual(["messages"]);
    expect(screen.getByRole("button", { name: "Messages" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});

describe("ActivityFeed — reply labels (D4a)", () => {
  it.each([
    [{ label: "asked_to_stop", labelSource: "keyword" }, "Asked to stop", "by keyword"],
    [{ label: "not_interested", labelSource: "ai" }, "Not interested", "by AI"],
    [{ label: "annoyed", labelSource: "ai" }, "Annoyed", "by AI"],
    [{ label: "positive", labelSource: "rep", labelBy: "Priya" }, "Wants to talk", "by Priya"],
    [{ label: "question", labelSource: "ai" }, "Question", "by AI"],
    [{ label: "other", labelSource: "ai" }, "Other", "by AI"],
    [{ label: "unclassified", labelSource: "keyword" }, "Not classified", "by keyword"],
  ] as const)("shows %o as a pill with its source", async (over, pill, by) => {
    await feed([replyRow(r(over))]);
    expect(await screen.findByText(pill)).toBeInTheDocument();
    expect(screen.getByText(by)).toBeInTheDocument();
  });

  it("shows Classifying… while pending, and nothing for an unlabelled older reply", async () => {
    await feed([
      replyRow(r({ classifying: true }), "t-1"),
      replyRow(r({ messageId: "m-2" }), "t-2"),
    ]);
    expect(await screen.findAllByText("Classifying…")).toHaveLength(1);
  });

  it("no Change menu unless the user may correct", async () => {
    await feed([replyRow(r({ label: "positive", labelSource: "ai", canCorrect: false }))]);
    await screen.findByText("Wants to talk");
    expect(screen.queryByRole("button", { name: "Change reply label" })).not.toBeInTheDocument();
  });

  it("the owner/admin changes the label: one API call, then the timeline refetches", async () => {
    mocks.setReplyLabel.mockResolvedValue({
      messageId: "m-1",
      label: "not_interested",
      labelSource: "rep",
      labelBy: "Me",
    });
    await feed([replyRow(r({ label: "positive", labelSource: "ai", canCorrect: true }))]);
    const change = await screen.findByRole("button", { name: "Change reply label" });
    expect(mocks.timeline).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(change, { key: "Enter" });
    const menu = await screen.findByRole("menu");
    expect(within(menu).queryByRole("menuitem", { name: "Not classified" })).toBeNull();
    expect(within(menu).getByRole("menuitem", { name: "Wants to talk" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Not interested" }));
    await waitFor(() =>
      expect(mocks.setReplyLabel).toHaveBeenCalledWith("c-1", "m-1", "not_interested"),
    );
    await waitFor(() => expect(mocks.timeline).toHaveBeenCalledTimes(2));
  });
});

describe("ReadReplyLink", () => {
  it("links to the contact's Activity, filtered to messages, at the newest reply", async () => {
    await renderWithRouter(<ReadReplyLink contactId="c-9" />);
    const link = await screen.findByRole("link", { name: "Read reply" });
    expect(link.getAttribute("href")).toBe(
      "/contacts/c-9?tab=activity&activity=messages&reply=latest",
    );
  });
});
