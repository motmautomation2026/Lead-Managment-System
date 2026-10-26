import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEAL_STAGES, type DealBoardColumn, type DealListItem, type DealStage } from "@/types";

const mocks = vi.hoisted(() => ({
  board: vi.fn(),
  list: vi.fn(),
  moveStage: vi.fn(),
  update: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/store/workspace-context", () => ({
  useWorkspace: () => ({ currentWorkspaceId: "ws-1" }),
}));
vi.mock("@/lib/backend-client", () => ({
  BackendError: class BackendError extends Error {},
  backend: {
    deals: {
      board: mocks.board,
      list: mocks.list,
      moveStage: mocks.moveStage,
      update: mocks.update,
    },
  },
}));

import { DealBoard } from "./deal-board";

const card = (id: string, stage: DealStage, amount: number | null = 100000): DealListItem => ({
  id,
  name: `Deal ${id}`,
  stage,
  amount,
  currency: "INR",
  expectedCloseDate: null,
  owner: { id: "u-1", name: "Asha Owner" },
  company: { id: "co-1", name: "Acme" },
  contact: { id: "l-1", name: "Ravi Kumar" },
  source: "manual",
  closedAt: null,
  createdAt: "2026-10-01T10:00:00.000Z",
  updatedAt: "2026-10-20T10:00:00.000Z",
});

function boardOf(
  cards: Partial<Record<DealStage, DealListItem[]>>,
  cursors: Partial<Record<DealStage, string>> = {},
) {
  return {
    data: DEAL_STAGES.map((stage): DealBoardColumn => ({
      stage,
      count: (cards[stage] ?? []).length + (cursors[stage] ? 5 : 0),
      amountTotal: (cards[stage] ?? []).reduce((s, d) => s + (d.amount ?? 0), 0),
      items: cards[stage] ?? [],
      nextCursor: cursors[stage] ?? null,
    })),
  };
}

const STAGE_LEFT = Object.fromEntries(DEAL_STAGES.map((s, i) => [s, i * 300]));
/** Lay the columns out side by side (jsdom has no layout) so keyboard dragging can find them. */
function fakeLayout() {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const column = this.closest("[data-stage]");
    const left = column ? STAGE_LEFT[column.getAttribute("data-stage")!]! : 0;
    const isColumn = column === this;
    const rect = isColumn
      ? { left, top: 0, width: 288, height: 600 }
      : { left: left + 8, top: 60, width: 270, height: 80 };
    return {
      ...rect,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      x: rect.left,
      y: rect.top,
      toJSON: () => rect,
    } as DOMRect;
  });
}

function setDesktop(matches: boolean) {
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
}

async function renderBoard(props: { showClosed?: boolean } = {}) {
  const onShowClosedChange = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRootRoute({
    component: () => (
      <QueryClientProvider client={client}>
        <DealBoard
          params={{ ownerId: ["me"], status: props.showClosed ? "all" : "open" }}
          showClosed={Boolean(props.showClosed)}
          onShowClosedChange={onShowClosedChange}
        />
        <Outlet />
      </QueryClientProvider>
    ),
  });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: "/", component: () => null }),
      createRoute({ getParentRoute: () => root, path: "/deals/$dealId", component: () => null }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
  await screen.findByRole("list", { name: "Pipeline" });
  return { onShowClosedChange };
}

const column = (name: string) => screen.getByRole("listitem", { name });

/** Keyboard drag: Space picks the card up, → per column, Space drops it. */
async function keyboardMove(cardName: string, steps: number) {
  const handle = screen.getByRole("button", { name: new RegExp(`^${cardName},`) });
  handle.focus();
  fireEvent.keyDown(handle, { code: "Space", key: " " });
  // The sensor starts listening for arrow keys on the next tick.
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  for (let i = 0; i < steps; i++) {
    await act(async () => {
      fireEvent.keyDown(document, { code: "ArrowRight", key: "ArrowRight" });
    });
  }
  await act(async () => {
    fireEvent.keyDown(document, { code: "Space", key: " " });
  });
}

beforeEach(() => setDesktop(true));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("DealBoard", () => {
  it("shows the 8 stages in order with counts and INR totals; Won/Lost are drop targets when closed are hidden", async () => {
    mocks.board.mockResolvedValue(
      boardOf({ qualified: [card("q1", "qualified", 250000), card("q2", "qualified", 250000)] }),
    );
    await renderBoard();
    await screen.findByText("Deal q1");
    const names = within(screen.getByRole("list", { name: "Pipeline" }))
      .getAllByRole("listitem")
      .map((el) => el.getAttribute("aria-label"));
    expect(names).toEqual([
      "Qualified",
      "Meeting scheduled",
      "Meeting done / follow-up",
      "Preparing proposal",
      "Proposal sent",
      "Negotiation",
      "Won",
      "Lost",
    ]);
    expect(within(column("Qualified")).getByText("(2)")).toBeTruthy();
    expect(within(column("Qualified")).getByText("₹5.0 L")).toBeTruthy();
    expect(within(column("Won")).getByText("Drop here to close")).toBeTruthy();
    expect(within(column("Lost")).getByText("Drop here to close")).toBeTruthy();
    expect(mocks.board).toHaveBeenCalledWith(
      { ownerId: ["me"], status: "open" },
      expect.anything(),
    );
  });

  it("Show closed fills Won/Lost; the toggle reports back", async () => {
    mocks.board.mockResolvedValue(boardOf({ won: [card("w1", "won")] }));
    const { onShowClosedChange } = await renderBoard({ showClosed: true });
    expect(await within(column("Won")).findByText("Deal w1")).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "Show closed" }));
    expect(onShowClosedChange).toHaveBeenCalledWith(false);
  });

  it("loads more cards per column with the board's filters", async () => {
    mocks.board.mockResolvedValue(
      boardOf({ qualified: [card("q1", "qualified")] }, { qualified: "cur-1" }),
    );
    mocks.list.mockResolvedValue({ data: [card("q9", "qualified")], nextCursor: null });
    await renderBoard();
    fireEvent.click(await within(column("Qualified")).findByRole("button", { name: "Load more" }));
    expect(await within(column("Qualified")).findByText("Deal q9")).toBeTruthy();
    expect(mocks.list).toHaveBeenCalledWith(
      { ownerId: ["me"], status: "open", stage: ["qualified"], sort: "updatedAt:desc" },
      "cur-1",
    );
    expect(within(column("Qualified")).queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("keyboard move to an open stage is optimistic and rolls back with a toast on failure", async () => {
    fakeLayout();
    mocks.board.mockResolvedValue(boardOf({ qualified: [card("q1", "qualified")] }));
    let reject: (e: Error) => void = () => undefined;
    mocks.moveStage.mockReturnValue(new Promise((_, r) => (reject = r)));
    await renderBoard();
    await screen.findByText("Deal q1");
    await keyboardMove("Deal q1", 1);
    await waitFor(() =>
      expect(within(column("Meeting scheduled")).getByText("Deal q1")).toBeTruthy(),
    );
    expect(within(column("Qualified")).queryByText("Deal q1")).toBeNull();
    expect(within(column("Meeting scheduled")).getByText("(1)")).toBeTruthy();
    expect(mocks.moveStage).toHaveBeenCalledWith("q1", { stage: "meeting_scheduled" });

    await act(async () => reject(new Error("Not allowed")));
    await waitFor(() => expect(within(column("Qualified")).getByText("Deal q1")).toBeTruthy());
    expect(within(column("Meeting scheduled")).queryByText("Deal q1")).toBeNull();
    expect(mocks.toast.error).toHaveBeenCalledWith("Couldn't move “Deal q1”: Not allowed");
  });

  it("dropping on Won opens the Close dialog and moves nothing until it's confirmed", async () => {
    fakeLayout();
    mocks.board.mockResolvedValue(boardOf({ negotiation: [card("n1", "negotiation")] }));
    await renderBoard();
    await screen.findByText("Deal n1");
    await keyboardMove("Deal n1", 1);
    expect(await screen.findByRole("dialog", { name: "Mark deal won" })).toBeTruthy();
    expect(mocks.moveStage).not.toHaveBeenCalled();
    // The modal hides the board from the accessibility tree.
    const negotiation = screen.getByRole("listitem", { name: "Negotiation", hidden: true });
    expect(within(negotiation).getByText("Deal n1")).toBeTruthy();
  });

  it("phone width: one stage at a time with a stage selector and a Move to… menu (no drag)", async () => {
    setDesktop(false);
    mocks.board.mockResolvedValue(
      boardOf({ qualified: [card("q1", "qualified")], negotiation: [card("n1", "negotiation")] }),
    );
    mocks.moveStage.mockResolvedValue({});
    await renderBoard();
    await screen.findByText("Deal q1");
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.queryByText("Deal n1")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Deal q1,/ })).toBeNull();

    fireEvent.pointerDown(screen.getByRole("button", { name: "Move Deal q1 to…" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Negotiation" }));
    await waitFor(() =>
      expect(mocks.moveStage).toHaveBeenCalledWith("q1", { stage: "negotiation" }),
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Move Deal q1 to…" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Lost" }));
    expect(await screen.findByRole("dialog", { name: "Mark deal lost" })).toBeTruthy();
  });
});
