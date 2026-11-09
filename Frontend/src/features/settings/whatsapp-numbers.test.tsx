import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WhatsAppConnection, WhatsAppNumber } from "@/lib/backend-client";

const mocks = vi.hoisted(() => ({
  isAdmin: false,
  addNumber: vi.fn(),
  updateNumber: vi.fn(),
  pauseNumber: vi.fn(),
  removeNumber: vi.fn(),
  command: vi.fn(),
}));

vi.mock("@/store", () => ({
  keys: { connection: (ws: string | null, kind: string) => ["connection", ws, kind] },
  messageFromError: (error: unknown) => (error instanceof Error ? error.message : "Failed"),
  useIsAdmin: () => mocks.isAdmin,
  useSession: () => ({ users: [{ id: "u-1", name: "Suyash", active: true }] }),
}));
vi.mock("@/lib/backend-client", () => ({
  backend: {
    connections: {
      whatsapp: {
        addNumber: mocks.addNumber,
        updateNumber: mocks.updateNumber,
        pauseNumber: mocks.pauseNumber,
        removeNumber: mocks.removeNumber,
        command: mocks.command,
      },
    },
  },
}));

import { WhatsAppNumbers } from "./whatsapp-numbers";

const number = (over: Partial<WhatsAppNumber>): WhatsAppNumber =>
  ({
    id: "n-1",
    label: "#1",
    ownerUserId: null,
    ownerName: null,
    enabled: true,
    status: "connected",
    connectedPhone: "919800000001",
    displayName: null,
    qr: null,
    lastError: null,
    outboundRestricted: false,
    warmupDay: null,
    dailyCap: 200,
    effectiveDailyCap: 200,
    minDelaySeconds: 45,
    maxDelaySeconds: 120,
    maxNewChatsPerDay: 20,
    sentToday: 12,
    newChatsToday: 3,
    leadCount: 4,
    queuedSends: 0,
    pause: null,
    ...over,
  }) as WhatsAppNumber;

const data = {
  maxNumbers: 5,
  sessionSlots: { numbers: 2, headroom: 8, overHeadroom: false },
  numbers: [
    number({}),
    number({
      id: "n-2",
      label: "#2",
      status: "qr_ready",
      connectedPhone: null,
      warmupDay: 1,
      effectiveDailyCap: 20,
      sentToday: 0,
      leadCount: 0,
    }),
  ],
} as unknown as WhatsAppConnection;

function renderNumbers(over: Partial<WhatsAppConnection> = {}) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <WhatsAppNumbers workspaceId="ws-1" data={{ ...data, ...over }} />
    </QueryClientProvider>,
  );
}

const card = (label: string) => screen.getByRole("article", { name: `WhatsApp number ${label}` });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("WhatsAppNumbers", () => {
  it("one card per number: status, sent / cap with the warm-up day, contacts", () => {
    renderNumbers();
    expect(screen.getByText("Numbers (2 of 5)")).toBeInTheDocument();
    expect(within(card("#1")).getByText("12 / 200")).toBeInTheDocument();
    expect(within(card("#1")).getByText("+919800000001")).toBeInTheDocument();
    expect(within(card("#2")).getByText("0 / 20 (warm-up day 1)")).toBeInTheDocument();
    expect(within(card("#2")).getByText("qr ready")).toBeInTheDocument();
  });

  it("a salesperson can connect a number but not add, pause, remove or edit", async () => {
    mocks.isAdmin = false;
    renderNumbers();
    expect(screen.queryByRole("button", { name: /Add number/ })).not.toBeInTheDocument();
    expect(
      within(card("#1")).queryByRole("button", { name: "Pause sending" }),
    ).not.toBeInTheDocument();
    expect(within(card("#1")).queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
    expect(
      within(card("#1")).queryByRole("button", { name: "Save number" }),
    ).not.toBeInTheDocument();
    fireEvent.click(within(card("#2")).getByRole("button", { name: "Connect / get QR" }));
    await waitFor(() => expect(mocks.command).toHaveBeenCalledWith("n-2", "connect"));
  });

  it("an admin adds a number; Add is off at the maximum", async () => {
    mocks.isAdmin = true;
    mocks.addNumber.mockResolvedValue(data);
    renderNumbers();
    fireEvent.click(screen.getByRole("button", { name: /Add number/ }));
    await waitFor(() => expect(mocks.addNumber).toHaveBeenCalledOnce());
    cleanup();
    renderNumbers({ maxNumbers: 2 });
    expect(screen.getByRole("button", { name: /Add number/ })).toBeDisabled();
  });

  it("an admin saves a number's label and owner", async () => {
    mocks.isAdmin = true;
    mocks.updateNumber.mockResolvedValue(data);
    renderNumbers();
    const first = card("#1");
    fireEvent.change(within(first).getByLabelText("Label"), { target: { value: "Sales line" } });
    fireEvent.click(within(first).getByRole("button", { name: "Save number" }));
    await waitFor(() => expect(mocks.updateNumber).toHaveBeenCalledOnce());
    expect(mocks.updateNumber).toHaveBeenCalledWith("n-1", {
      label: "Sales line",
      ownerUserId: null,
      dailyCap: 200,
      minDelaySeconds: 45,
      maxDelaySeconds: 120,
      maxNewChatsPerDay: 20,
    });
  });

  it("a paused number shows its reason; an admin resumes after confirming", async () => {
    mocks.isAdmin = true;
    mocks.pauseNumber.mockResolvedValue(data);
    renderNumbers({
      numbers: [
        number({
          enabled: false,
          pause: { reason: "5 WhatsApp send failures in 30 minutes.", at: null, byName: null },
        }),
      ],
    });
    expect(within(card("#1")).getByRole("alert")).toHaveTextContent("Sending on #1 is paused");
    fireEvent.click(within(card("#1")).getByRole("button", { name: "Resume sending" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Resume sending" }).at(-1)!);
    await waitFor(() => expect(mocks.pauseNumber).toHaveBeenCalledWith("n-1", false));
  });

  it("remove with contacts: move them to another number (rule 10)", async () => {
    mocks.isAdmin = true;
    mocks.removeNumber.mockResolvedValue(data);
    renderNumbers();
    fireEvent.click(within(card("#1")).getByRole("button", { name: "Remove" }));
    expect(screen.getByText("4 contact(s) use this number.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove number" }));
    expect(await screen.findByText("Pick the number to move the contacts to.")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/Leave them without a number/));
    fireEvent.click(screen.getByRole("button", { name: "Remove number" }));
    await waitFor(() =>
      expect(mocks.removeNumber).toHaveBeenCalledWith("n-1", { leads: "unassign" }),
    );
  });

  it("warns when the numbers would exceed the session-pooler headroom (rule 12)", () => {
    renderNumbers({ sessionSlots: { numbers: 9, headroom: 8, overHeadroom: true } });
    expect(screen.getByRole("alert")).toHaveTextContent("only 8 are free");
  });
});
