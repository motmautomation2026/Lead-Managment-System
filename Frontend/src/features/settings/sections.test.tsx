import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isAdmin: true,
  usersList: vi.fn(),
  usersCreate: vi.fn(),
  usersUpdate: vi.fn(),
  calendarGet: vi.fn(),
  calendarUpdate: vi.fn(),
  calendarDisconnect: vi.fn(),
  whatsappGet: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("qrcode.react", () => ({ QRCodeSVG: () => null }));
vi.mock("@/lib/supabase-client", () => ({ backendBaseUrl: "http://api.test" }));
vi.mock("@/store", async () => {
  const { keys } = await import("@/store/query");
  return {
    keys,
    messageFromError: (error: unknown) => (error instanceof Error ? error.message : "Failed"),
    useIsAdmin: () => mocks.isAdmin,
    useSession: () => ({ users: [] }),
  };
});
vi.mock("@/lib/backend-client", () => ({
  backend: {
    admin: {
      users: { list: mocks.usersList, create: mocks.usersCreate, update: mocks.usersUpdate },
    },
    connections: {
      googleCalendar: {
        get: mocks.calendarGet,
        updateCredentials: mocks.calendarUpdate,
        disconnect: mocks.calendarDisconnect,
        oauthStart: vi.fn(),
      },
      whatsapp: { get: mocks.whatsappGet },
    },
  },
}));

import { renderInRouter } from "@/test/render-in-router";
import { UsersPanel } from "./users-panel";
import { GoogleCalendarPanel } from "./calendar-section";
import { WhatsAppPanel } from "./whatsapp-section";

const user = (id: string, name: string, active = true) => ({
  id,
  name,
  email: `${id}@motm.test`,
  initials: name[0],
  active,
  createdAt: "2026-11-01T00:00:00.000Z",
  bookingUrl: null,
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/");
});
beforeEach(() => {
  mocks.isAdmin = true;
});

describe("Settings → User accounts (UX-1)", () => {
  it("lists accounts in pages, searches on the server, creates in a dialog", async () => {
    mocks.usersList
      .mockResolvedValueOnce({ data: [user("u-1", "Rep One")], nextCursor: "c-2" })
      .mockResolvedValueOnce({ data: [user("u-2", "Rep Two", false)], nextCursor: null })
      .mockResolvedValue({ data: [user("u-2", "Rep Two", false)], nextCursor: null });
    mocks.usersCreate.mockResolvedValue(user("u-3", "New Rep"));
    await renderInRouter(() => <UsersPanel />);
    expect(await screen.findByRole("button", { name: "Open Rep One" })).toHaveTextContent("Active");
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByRole("button", { name: "Open Rep Two" })).toHaveTextContent(
      "Deactivated",
    );
    expect(mocks.usersList).toHaveBeenLastCalledWith(
      { cursor: "c-2", q: undefined },
      expect.anything(),
    );
    fireEvent.change(screen.getByLabelText("Search accounts"), { target: { value: "two" } });
    await waitFor(() =>
      expect(mocks.usersList).toHaveBeenLastCalledWith(
        { cursor: undefined, q: "two" },
        expect.anything(),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    const dialog = await screen.findByRole("dialog", { name: "Create salesperson" });
    fireEvent.change(within(dialog).getByLabelText("Full name"), { target: { value: "New Rep" } });
    fireEvent.change(within(dialog).getByLabelText("Email"), {
      target: { value: "new@motm.test" },
    });
    fireEvent.change(within(dialog).getByLabelText("Password (12+ characters)"), {
      target: { value: "a-long-password" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create account" }));
    await waitFor(() =>
      expect(mocks.usersCreate).toHaveBeenCalledWith(
        { name: "New Rep", email: "new@motm.test", password: "a-long-password" },
        expect.anything(),
      ),
    );
  });

  it("a row opens the account in a drawer; deactivating asks first", async () => {
    mocks.usersList.mockResolvedValue({ data: [user("u-1", "Rep One")], nextCursor: null });
    mocks.usersUpdate.mockResolvedValue(user("u-1", "Rep One"));
    await renderInRouter(() => <UsersPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Rep One" }));
    const drawer = await screen.findByRole("dialog", { name: "Rep One" });
    expect(within(drawer).getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.change(within(drawer).getByLabelText("Name"), { target: { value: "Rep 1" } });
    fireEvent.click(within(drawer).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mocks.usersUpdate).toHaveBeenCalledWith("u-1", {
        name: "Rep 1",
        email: "u-1@motm.test",
        bookingUrl: null,
      }),
    );
    fireEvent.click(within(drawer).getByRole("button", { name: "Deactivate" }));
    const confirm = await screen.findByRole("dialog", { name: "Deactivate Rep One?" });
    expect(confirm).toHaveTextContent("can no longer sign in");
    fireEvent.click(within(confirm).getByRole("button", { name: "Deactivate" }));
    await waitFor(() =>
      expect(mocks.usersUpdate).toHaveBeenLastCalledWith("u-1", { active: false }),
    );
  });
});

const calendar = {
  status: "connected",
  configured: true,
  platformConfigured: false,
  usesOwnCredentials: true,
  clientId: "client-1",
  clientSecretConfigured: true,
  redirectUri: "http://api.test/cb",
  connectedEmail: "cal@motm.test",
  lastError: null,
};

describe("Settings → Google Calendar (UX-1)", () => {
  it("a status card, credentials behind a save bar, Disconnect confirmed", async () => {
    mocks.calendarGet.mockResolvedValue(calendar);
    mocks.calendarUpdate.mockResolvedValue(calendar);
    mocks.calendarDisconnect.mockResolvedValue(undefined);
    await renderInRouter(() => <GoogleCalendarPanel workspaceId="ws-1" />);
    const card = await screen.findByRole("region", { name: "Google Calendar status" });
    expect(card).toHaveTextContent("Connected");
    expect(card).toHaveTextContent("cal@motm.test");
    expect(within(card).getByRole("button", { name: "Reconnect" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save credentials" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Client ID"), { target: { value: "client-2" } });
    fireEvent.click(await screen.findByRole("button", { name: "Save credentials" }));
    await waitFor(() =>
      expect(mocks.calendarUpdate).toHaveBeenCalledWith({
        clientId: "client-2",
        redirectUri: "http://api.test/cb",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    const confirm = await screen.findByRole("dialog", { name: "Disconnect Google Calendar?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(mocks.calendarDisconnect).toHaveBeenCalled());
  });

  it("the OAuth return (?calendar=connected) shows its toast once", async () => {
    mocks.calendarGet.mockResolvedValue({ ...calendar, status: "not_connected" });
    window.history.replaceState(null, "", "/settings/calendar?calendar=connected");
    await renderInRouter(() => <GoogleCalendarPanel workspaceId="ws-1" />);
    await waitFor(() =>
      expect(mocks.toast.success).toHaveBeenCalledWith("Google Calendar connected."),
    );
    expect(window.location.search).toBe("");
    expect(await screen.findByRole("region", { name: "Google Calendar status" })).toHaveTextContent(
      "Not connected",
    );
  });
});

describe("Settings → WhatsApp status card (UX-1)", () => {
  const wa = (over: Record<string, unknown> = {}) => ({
    enabled: true,
    maxNumbers: 5,
    todayCount: 12,
    sendWindow: { days: [1], start: "09:30", end: "19:00" },
    sessionSlots: { numbers: 1, headroom: 8, overHeadroom: false },
    numbers: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        label: "#1",
        status: "connected",
        effectiveDailyCap: 40,
        dailyCap: 40,
        warmupDay: null,
        sentToday: 12,
        newChatsToday: 0,
        maxNewChatsPerDay: 20,
        leadCount: 3,
        pause: null,
      },
    ],
    newChatsToday: 0,
    failures24h: 0,
    stops24h: 0,
    safetyEvents: [],
    daily: [],
    pendingCount: 0,
    invalidPhoneCount: 0,
    inboundReview: [],
    ...over,
  });

  it("connected: the key number is sent today against today's caps", async () => {
    mocks.whatsappGet.mockResolvedValue(wa());
    await renderInRouter(() => <WhatsAppPanel workspaceId="ws-1" />);
    const card = await screen.findByRole("region", { name: "WhatsApp status" });
    expect(card).toHaveTextContent("Connected");
    expect(card).toHaveTextContent("12 / 40");
    expect(screen.getByRole("tab", { name: "Numbers" })).toHaveAttribute("aria-selected", "true");
  });

  it("paused: says which number and opens it", async () => {
    mocks.whatsappGet.mockResolvedValue(
      wa({
        numbers: [
          { ...wa().numbers[0], pause: { reason: "Too many failures", at: null, byName: null } },
        ],
      }),
    );
    const { router } = await renderInRouter(() => <WhatsAppPanel workspaceId="ws-1" />);
    const card = await screen.findByRole("region", { name: "WhatsApp status" });
    expect(card).toHaveTextContent("#1 is paused: Too many failures.");
    fireEvent.click(within(card).getByRole("button", { name: "Open #1" }));
    await waitFor(() =>
      expect(router.state.location.search).toEqual({
        number: "11111111-1111-4111-8111-111111111111",
      }),
    );
  });
});
