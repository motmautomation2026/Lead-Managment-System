import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
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

vi.mock("qrcode.react", () => ({ QRCodeSVG: () => <svg aria-label="QR code" /> }));
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

import { renderInRouter } from "@/test/render-in-router";
import { WhatsAppNumbers } from "./whatsapp-numbers";

const number = (over: Partial<WhatsAppNumber>): WhatsAppNumber =>
  ({
    id: "11111111-1111-4111-8111-111111111111",
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

const N1 = "11111111-1111-4111-8111-111111111111";
const N2 = "22222222-2222-4222-8222-222222222222";
const data = {
  maxNumbers: 5,
  sessionSlots: { numbers: 2, headroom: 8, overHeadroom: false },
  numbers: [
    number({}),
    number({
      id: N2,
      label: "#2",
      status: "qr_ready",
      connectedPhone: null,
      warmupDay: 1,
      effectiveDailyCap: 20,
      sentToday: 0,
      leadCount: 0,
      qr: "qr-payload",
    }),
  ],
} as unknown as WhatsAppConnection;

function renderNumbers(over: Partial<WhatsAppConnection> = {}, search = "") {
  return renderInRouter(() => <WhatsAppNumbers workspaceId="ws-1" data={{ ...data, ...over }} />, {
    search,
  });
}

const row = (label: string) => screen.getByRole("button", { name: `WhatsApp number ${label}` });
/** Opens a number's drawer from its row and returns the drawer. */
async function openNumber(label: string) {
  fireEvent.click(row(label));
  return screen.findByRole("dialog", { name: `Number ${label}` });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("WhatsAppNumbers (E4a, UX-1 list + drawer)", () => {
  it("one row per number: status, sent / cap with the warm-up day, new chats, contacts", async () => {
    await renderNumbers();
    expect(screen.getByText("Numbers (2 of 5)")).toBeInTheDocument();
    expect(row("#1")).toHaveTextContent("12 / 200");
    expect(row("#1")).toHaveTextContent("+919800000001");
    expect(row("#1")).toHaveTextContent("3 / 20");
    expect(row("#2")).toHaveTextContent("0 / 20 (warm-up day 1)");
    expect(row("#2")).toHaveTextContent("qr ready");
  });

  it("a row opens the number's drawer (in the URL, so Back closes it) with its QR code", async () => {
    const { router } = await renderNumbers();
    const drawer = await openNumber("#2");
    expect(router.state.location.search).toEqual({ number: N2 });
    expect(within(drawer).getByLabelText("QR code")).toBeInTheDocument();
    router.history.back();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("a salesperson can connect a number but not add, pause, remove or edit", async () => {
    mocks.isAdmin = false;
    mocks.command.mockResolvedValue(data);
    await renderNumbers();
    expect(screen.queryByRole("button", { name: /Add number/ })).not.toBeInTheDocument();
    const drawer = await openNumber("#2");
    expect(within(drawer).queryByRole("tab", { name: "Settings" })).toBeNull();
    expect(within(drawer).queryByRole("button", { name: "Pause sending" })).toBeNull();
    expect(within(drawer).queryByRole("button", { name: "Remove" })).toBeNull();
    expect(within(drawer).getByText(/Only admins can change these/)).toBeInTheDocument();
    fireEvent.click(within(drawer).getByRole("button", { name: "Connect / get QR" }));
    await waitFor(() => expect(mocks.command).toHaveBeenCalledWith(N2, "connect"));
  });

  it("an admin adds a number (its drawer opens); Add is off at the maximum", async () => {
    mocks.isAdmin = true;
    const added = number({ id: "33333333-3333-4333-8333-333333333333", label: "#3" });
    mocks.addNumber.mockResolvedValue({ ...data, numbers: [...data.numbers, added] });
    const { router } = await renderNumbers();
    fireEvent.click(screen.getByRole("button", { name: /Add number/ }));
    await waitFor(() => expect(mocks.addNumber).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(router.state.location.search).toEqual({
        number: "33333333-3333-4333-8333-333333333333",
      }),
    );
    cleanup();
    await renderNumbers({ maxNumbers: 2 });
    expect(screen.getByRole("button", { name: /Add number/ })).toBeDisabled();
  });

  it("an admin saves a number's label in the drawer's Settings tab (save bar)", async () => {
    mocks.isAdmin = true;
    mocks.updateNumber.mockResolvedValue(data);
    await renderNumbers();
    const drawer = await openNumber("#1");
    fireEvent.mouseDown(within(drawer).getByRole("tab", { name: "Settings" }), { button: 0 });
    expect(within(drawer).queryByRole("button", { name: "Save number" })).toBeNull();
    fireEvent.change(within(drawer).getByLabelText("Label"), { target: { value: "Sales line" } });
    fireEvent.click(await within(drawer).findByRole("button", { name: "Save number" }));
    await waitFor(() => expect(mocks.updateNumber).toHaveBeenCalledOnce());
    expect(mocks.updateNumber).toHaveBeenCalledWith(N1, {
      label: "Sales line",
      ownerUserId: null,
      dailyCap: 200,
      minDelaySeconds: 45,
      maxDelaySeconds: 120,
      maxNewChatsPerDay: 20,
    });
  });

  it("closing the drawer with unsaved settings asks first (UX-2); Keep editing keeps it open", async () => {
    mocks.isAdmin = true;
    const { router } = await renderNumbers();
    let drawer = await openNumber("#1");
    fireEvent.mouseDown(within(drawer).getByRole("tab", { name: "Settings" }), { button: 0 });
    fireEvent.change(within(drawer).getByLabelText("Label"), { target: { value: "Sales line" } });
    await within(drawer).findByRole("button", { name: "Save number" });
    fireEvent.keyDown(drawer, { key: "Escape" });
    let ask = await screen.findByRole("dialog", { name: "Discard unsaved changes?" });
    fireEvent.click(within(ask).getByRole("button", { name: "Keep editing" }));
    drawer = screen.getByRole("dialog", { name: "Number #1" });
    expect(within(drawer).getByLabelText("Label")).toHaveValue("Sales line");
    fireEvent.keyDown(drawer, { key: "Escape" });
    ask = await screen.findByRole("dialog", { name: "Discard unsaved changes?" });
    fireEvent.click(within(ask).getByRole("button", { name: "Discard changes" }));
    await waitFor(() =>
      expect((router.state.location.search as Record<string, unknown>)["number"]).toBeUndefined(),
    );
    expect(mocks.updateNumber).not.toHaveBeenCalled();
  });

  it("closing without changes needs no confirm", async () => {
    const { router } = await renderNumbers();
    const drawer = await openNumber("#1");
    fireEvent.keyDown(drawer, { key: "Escape" });
    await waitFor(() =>
      expect((router.state.location.search as Record<string, unknown>)["number"]).toBeUndefined(),
    );
    expect(screen.queryByRole("dialog", { name: "Discard unsaved changes?" })).toBeNull();
  });

  it("pausing asks first and says what happens", async () => {
    mocks.isAdmin = true;
    mocks.pauseNumber.mockResolvedValue(data);
    await renderNumbers();
    const drawer = await openNumber("#1");
    fireEvent.click(within(drawer).getByRole("button", { name: "Pause sending" }));
    const confirm = await screen.findByRole("dialog", { name: "Pause sending on #1?" });
    expect(confirm).toHaveTextContent("queued messages wait");
    expect(mocks.pauseNumber).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: "Pause sending" }));
    await waitFor(() => expect(mocks.pauseNumber).toHaveBeenCalledWith(N1, true));
  });

  it("a paused number shows its reason; an admin resumes after confirming", async () => {
    mocks.isAdmin = true;
    mocks.pauseNumber.mockResolvedValue(data);
    await renderNumbers(
      {
        numbers: [
          number({
            enabled: false,
            pause: { reason: "5 WhatsApp send failures in 30 minutes.", at: null, byName: null },
          }),
        ],
      },
      `?number=${N1}`,
    );
    const drawer = await screen.findByRole("dialog", { name: "Number #1" });
    // The list behind the open drawer is aria-hidden.
    expect(
      screen.getByRole("button", { name: "WhatsApp number #1", hidden: true }),
    ).toHaveTextContent("paused");
    expect(within(drawer).getByRole("alert")).toHaveTextContent("Sending on #1 is paused");
    fireEvent.click(within(drawer).getByRole("button", { name: "Resume sending" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Resume sending" }).at(-1)!);
    await waitFor(() => expect(mocks.pauseNumber).toHaveBeenCalledWith(N1, false));
  });

  it("remove with contacts: move them to another number (rule 10)", async () => {
    mocks.isAdmin = true;
    mocks.removeNumber.mockResolvedValue(data);
    await renderNumbers();
    const drawer = await openNumber("#1");
    fireEvent.click(within(drawer).getByRole("button", { name: "Remove" }));
    expect(screen.getByText("4 contact(s) use this number.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove number" }));
    expect(await screen.findByText("Pick the number to move the contacts to.")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/Leave them without a number/));
    fireEvent.click(screen.getByRole("button", { name: "Remove number" }));
    await waitFor(() => expect(mocks.removeNumber).toHaveBeenCalledWith(N1, { leads: "unassign" }));
  });

  it("warns when the numbers would exceed the session-pooler headroom (rule 12)", async () => {
    await renderNumbers({ sessionSlots: { numbers: 9, headroom: 8, overHeadroom: true } });
    expect(screen.getByRole("alert")).toHaveTextContent("only 8 are free");
  });

  it("no numbers yet: an empty state with the one next action", async () => {
    mocks.isAdmin = true;
    await renderNumbers({ numbers: [] });
    expect(screen.getByText("No WhatsApp number yet")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Add number/ }).length).toBe(2);
  });
});
