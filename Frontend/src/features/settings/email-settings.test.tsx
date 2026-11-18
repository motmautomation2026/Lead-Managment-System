import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailSettings } from "@/lib/backend-client";

const mocks = vi.hoisted(() => ({
  isAdmin: false,
  data: null as unknown,
  update: vi.fn(),
  resume: vi.fn(),
  testSmtp: vi.fn(),
  testImap: vi.fn(),
  sendTest: vi.fn(),
  testStatus: vi.fn(),
  deliverability: vi.fn(),
  checkNow: vi.fn(),
  setTrackOpens: vi.fn(),
  safetyEvents: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/store", () => ({
  keys: {
    connection: (ws: string | null, kind: string) => ["connection", ws, kind],
    safetyEvents: (ws: string, kind: string) => ["safety-events", ws, kind],
  },
  messageFromError: (error: unknown) => (error instanceof Error ? error.message : "Failed"),
  useIsAdmin: () => mocks.isAdmin,
}));
vi.mock("@/store/server-hooks", () => ({
  useCursorList: (
    queryKey: readonly unknown[],
    fetchPage: (cursor: string | undefined, signal: AbortSignal) => Promise<unknown>,
  ) =>
    useInfiniteQuery({
      queryKey,
      queryFn: ({ pageParam, signal }) => fetchPage(pageParam, signal) as never,
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (last: { nextCursor: string | null }) => last.nextCursor ?? undefined,
    }),
}));
vi.mock("@/lib/backend-client", () => ({
  backend: {
    connections: {
      email: {
        get: async () => mocks.data,
        update: mocks.update,
        resume: mocks.resume,
        testSmtp: mocks.testSmtp,
        testImap: mocks.testImap,
        sendTest: mocks.sendTest,
        testStatus: mocks.testStatus,
        deliverability: mocks.deliverability,
        checkNow: mocks.checkNow,
        setTrackOpens: mocks.setTrackOpens,
        safetyEvents: mocks.safetyEvents,
      },
    },
  },
}));

import { renderInRouter } from "@/test/render-in-router";
import { EmailPanel } from "./email-settings";

const SAVED: EmailSettings = {
  configured: true,
  legacyProvider: null,
  enabled: true,
  smtpHost: "smtp.motm.test",
  smtpPort: 465,
  smtpSecurity: "ssl",
  smtpUsernameConfigured: true,
  smtpPasswordConfigured: true,
  fromAddress: "sales@motm.test",
  fromName: "MOTM Sales",
  replyTo: "",
  imapHost: "imap.motm.test",
  imapPort: 993,
  imapSecurity: "ssl",
  imapSameLogin: true,
  imapUsernameConfigured: false,
  imapPasswordConfigured: false,
  imapFolder: "INBOX",
  dailyCap: 100,
  hourlyCap: 20,
  minDelaySeconds: 30,
  maxDelaySeconds: 90,
  sendWindow: { days: [1, 2, 3, 4, 5, 6], start: "09:30", end: "19:00" },
  alreadyWarmed: false,
  configuredAt: "2026-10-27T05:00:00.000Z",
  warmupDay: 2,
  effectiveDailyCap: 20,
  sentToday: 7,
  sentThisHour: 3,
  pause: null,
  failures24h: 1,
  rejections24h: 2,
  queuedCount: 0,
  safetyEvents: [
    {
      kind: "recipient_rejected",
      detail: "550 5.1.1 User unknown",
      at: "2026-10-28T04:00:00.000Z",
    },
  ],
  daily: [{ date: "2026-10-28", sent: 7, failed: 1, rejected: 2 }],
  imapStatus: {
    lastCheckAt: "2026-10-28T05:00:00.000Z",
    lastSuccessAt: "2026-10-28T05:00:00.000Z",
    lastError: null,
    nextCheckAt: "2026-10-28T05:02:00.000Z",
    today: { replies: 4, bounces: 2, autoReplies: 1, unsubscribes: 1, unmatched: 3 },
    bounces24h: 2,
  },
  trackOpens: false,
  openTrackingAvailable: true,
  updatedAt: "2026-10-28T04:00:00.000Z",
};

/** UX-1: the panel at `/page?tab=…` (Connection by default). */
function renderPanel(over: Partial<EmailSettings> = {}, tab?: string) {
  mocks.data = { ...SAVED, ...over };
  return renderInRouter(() => <EmailPanel workspaceId="ws-1" />, {
    search: tab ? `?tab=${tab}` : "",
  });
}
const openTab = async (name: string) =>
  fireEvent.mouseDown(await screen.findByRole("tab", { name: new RegExp(name) }), { button: 0 });

beforeEach(() => {
  mocks.isAdmin = false;
  mocks.safetyEvents.mockResolvedValue({
    data: [
      {
        id: "e-1",
        kind: "recipient_rejected",
        detail: "550 5.1.1 User unknown",
        at: "2026-10-28T04:00:00.000Z",
      },
    ],
    nextCursor: "c-2",
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("EmailPanel (E1b)", () => {
  it("E3b-2b: Track email opens is off by default; an admin turns it on; without a public API address it says so", async () => {
    mocks.isAdmin = true;
    mocks.setTrackOpens.mockResolvedValue({ ...SAVED, trackOpens: true });
    await renderPanel({}, "deliverability");
    const toggle = await screen.findByRole("switch", { name: "Track email opens" });
    expect(toggle).not.toBeChecked();
    expect(screen.queryByText(/needs a public API address/)).not.toBeInTheDocument();
    fireEvent.click(toggle);
    await waitFor(() => expect(mocks.setTrackOpens).toHaveBeenCalledWith(true, expect.anything()));
    cleanup();
    await renderPanel({ openTrackingAvailable: false }, "deliverability");
    expect(await screen.findByText(/Open tracking needs a public API address/)).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Track email opens" })).toBeDisabled();
  });

  it("E3b-2b: a salesperson can't change Track email opens", async () => {
    await renderPanel({ trackOpens: true }, "deliverability");
    expect(await screen.findByRole("switch", { name: "Track email opens" })).toBeDisabled();
  });

  it("a salesperson sees the settings read-only, the monitoring, and no secret, test or form", async () => {
    await renderPanel();
    expect(await screen.findByText("MOTM Sales <sales@motm.test>")).toBeInTheDocument();
    expect(screen.getByText("smtp.motm.test:465 (SSL/TLS)")).toBeInTheDocument();
    // The status card: state + the one key number.
    const card = screen.getByRole("region", { name: "Email status" });
    expect(card).toHaveTextContent("Connected");
    expect(card).toHaveTextContent("7 / 20 (warm-up day 2)");
    expect(screen.getAllByText("Only admins can change these.").length).toBeGreaterThan(0);
    await openTab("Monitoring");
    expect(await screen.findByText("3 / 20")).toBeInTheDocument();
    expect(await screen.findByText("Recipient rejected")).toBeInTheDocument();
    expect(screen.getByRole("table")).toHaveTextContent("2026-10-28");
    expect(screen.queryByRole("button", { name: "Save email settings" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Test SMTP login" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Check DNS" })).toBeNull();
    expect(document.querySelector('input[type="password"]')).toBeNull();
  });

  it("not set up (was on Resend): says so; there is no Resend option", async () => {
    mocks.isAdmin = true;
    renderPanel({ configured: false, legacyProvider: "resend", smtpHost: "", fromAddress: "" });
    const card = await screen.findByRole("region", { name: "Email status" });
    expect(card).toHaveTextContent("Not set up");
    expect(card).toHaveTextContent(/used Resend, which is no longer supported/);
    fireEvent.click(within(card).getByRole("button", { name: "Set up mailbox" }));
    await waitFor(() => expect(screen.getByLabelText("SMTP host")).toHaveFocus());
    expect(screen.queryByText(/^Resend$/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Test SMTP login" })).toBeNull();
  });

  it("an admin saves; saved secrets stay blank and are not sent", async () => {
    mocks.isAdmin = true;
    mocks.update.mockResolvedValue(SAVED);
    await renderPanel();
    const password = await screen.findByLabelText("Password or app password");
    expect(password).toHaveValue("");
    expect(password).toHaveAttribute("type", "password");
    expect(screen.queryByRole("button", { name: "Save email settings" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Default from name"), { target: { value: "MOTM" } });
    fireEvent.click(await screen.findByRole("button", { name: "Save email settings" }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledOnce());
    const input = mocks.update.mock.calls[0]![0] as Record<string, unknown>;
    expect(input).toMatchObject({ fromName: "MOTM", smtpHost: "smtp.motm.test", smtpPort: 465 });
    for (const secret of ["smtpUsername", "smtpPassword", "imapUsername", "imapPassword"]) {
      expect(input).not.toHaveProperty(secret);
    }
  });

  it("validates ports, spacing, caps and the window before saving", async () => {
    mocks.isAdmin = true;
    await renderPanel({}, "safety");
    fireEvent.change(await screen.findByLabelText("Min spacing (seconds)"), {
      target: { value: "120" },
    });
    fireEvent.change(screen.getAllByLabelText("Port")[0]!, { target: { value: "70000" } });
    fireEvent.change(screen.getByLabelText("Hourly cap"), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText("Closes"), { target: { value: "08:00" } });
    fireEvent.click(await screen.findByRole("button", { name: "Save email settings" }));
    expect(
      await screen.findByText("The minimum can't be more than the maximum."),
    ).toBeInTheDocument();
    expect(screen.getByText("The window must start before it ends.")).toBeInTheDocument();
    expect(mocks.update).not.toHaveBeenCalled();
    // The bad port is on Connection: that tab opens and both tabs count their problems.
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /Connection/ })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
    expect(screen.getByRole("tab", { name: /Connection/ })).toHaveTextContent("Connection1");
    expect(screen.getByRole("tab", { name: /Safety & limits/ })).toHaveTextContent("3");
    expect(screen.getByRole("region", { name: "Unsaved changes" })).toHaveTextContent(
      "Fix the highlighted fields first.",
    );
  });

  it("login tests show the server's result; the test email shows its live status", async () => {
    mocks.isAdmin = true;
    mocks.testSmtp.mockResolvedValue({
      ok: false,
      message:
        "The server rejected the username or password. If the mailbox uses 2-step verification (Gmail, Microsoft 365, Zoho), create an app password and use it here.",
    });
    mocks.testImap.mockResolvedValue({
      ok: true,
      message: 'Logged in to imap.motm.test:993 and opened "INBOX". Nothing was read or changed.',
    });
    mocks.sendTest.mockResolvedValue({ id: "t-1", status: "queued" });
    mocks.testStatus.mockResolvedValue({
      id: "t-1",
      status: "sent",
      to: "admin@motm.test",
      lastError: null,
    });
    await renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Test SMTP login" }));
    expect(await screen.findByText(/create an app password/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Test IMAP login" }));
    expect(await screen.findByText(/opened "INBOX"/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Send test email to me" }));
    expect(await screen.findByText(/Sent to admin@motm.test/)).toBeInTheDocument();
    expect(mocks.testStatus).toHaveBeenCalledWith("t-1", expect.anything());
  });

  it("paused: the status card says why for everyone; Resume (with confirm) for admins", async () => {
    mocks.isAdmin = true;
    mocks.resume.mockResolvedValue({ ...SAVED, pause: null });
    await renderPanel({
      enabled: false,
      pause: {
        reason: "SMTP login rejected — check the password.",
        at: "2026-10-28T04:00:00.000Z",
        byName: null,
      },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "SMTP login rejected — check the password.",
    );
    expect(screen.getByRole("alert")).toHaveTextContent("automatically");
    fireEvent.click(screen.getByRole("button", { name: "Resume sending" }));
    const confirm = await screen.findAllByRole("button", { name: "Resume sending" });
    fireEvent.click(confirm[confirm.length - 1]!);
    await waitFor(() => expect(mocks.resume).toHaveBeenCalledOnce());

    cleanup();
    mocks.isAdmin = false;
    await renderPanel({
      enabled: false,
      pause: { reason: "Paused by Govind.", at: null, byName: "Govind" },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("Paused by Govind.");
    expect(screen.queryByRole("button", { name: "Resume sending" })).toBeNull();
  });

  it("the deliverability check shows green / amber / red lines with the fix", async () => {
    mocks.isAdmin = true;
    mocks.deliverability.mockResolvedValue({
      domain: "motm.test",
      checkedAt: "2026-10-28T04:00:00.000Z",
      lines: [
        { check: "mx", status: "green", summary: "MX found (aspmx.l.google.com).", fix: null },
        {
          check: "spf",
          status: "amber",
          summary: 'SPF ends with "+all".',
          fix: "Ask whoever manages motm.test's DNS to change it.",
        },
        {
          check: "dkim",
          status: "red",
          summary: "No DKIM key found (tried s1).",
          fix: "Turn on DKIM signing.",
        },
        { check: "dmarc", status: "green", summary: "DMARC policy is p=quarantine.", fix: null },
      ],
    });
    await renderPanel({}, "deliverability");
    fireEvent.change(await screen.findByLabelText("DKIM selector (optional)"), {
      target: { value: "s1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Check DNS" }));
    const list = await screen.findByRole("list", { name: "DNS checks for motm.test" });
    expect(list).toHaveTextContent("No DKIM key found (tried s1).");
    expect(list).toHaveTextContent("Ask whoever manages motm.test's DNS");
    expect(screen.getAllByText("OK")).toHaveLength(2);
    expect(screen.getByText("Check")).toBeInTheDocument();
    expect(screen.getByText("Missing")).toBeInTheDocument();
    expect(mocks.deliverability).toHaveBeenCalledWith("s1", expect.anything());
    expect(screen.getByRole("button", { name: "Re-check" })).toBeInTheDocument();
  });

  describe("Replies & bounces (D3)", () => {
    const stat = (label: string) => screen.getByText(label).parentElement!;

    it("shows the last checks and today's counts; a salesperson has no Check now", async () => {
      mocks.isAdmin = false;
      await renderPanel({}, "replies");
      expect(await screen.findByRole("heading", { name: "Replies & bounces" })).toBeInTheDocument();
      expect(stat("Replies today")).toHaveTextContent("4");
      expect(stat("Bounces today")).toHaveTextContent("2");
      expect(stat("Auto-replies today")).toHaveTextContent("1");
      expect(stat("Unsubscribes today")).toHaveTextContent("1");
      expect(stat("Unmatched today")).toHaveTextContent("3");
      expect(stat("Bounces (24 h)")).toHaveTextContent("2");
      expect(screen.queryByRole("button", { name: "Check now" })).not.toBeInTheDocument();
    });

    it("shows the last error in plain text and Never before the first check", async () => {
      mocks.isAdmin = false;
      await renderPanel(
        {
          imapStatus: {
            ...SAVED.imapStatus!,
            lastCheckAt: null,
            lastSuccessAt: null,
            lastError:
              "IMAP login rejected — check the IMAP username and password in Settings → Email.",
          },
        },
        "replies",
      );
      // The status card points at it too.
      expect(await screen.findByRole("region", { name: "Email status" })).toHaveTextContent(
        "Needs attention",
      );
      expect((await screen.findAllByText(/IMAP login rejected/)).length).toBeGreaterThan(0);
      expect(screen.getAllByText("Never")).toHaveLength(2);
    });

    it("an admin's Check now asks the server once", async () => {
      mocks.isAdmin = true;
      mocks.checkNow.mockResolvedValue({ ...SAVED });
      await renderPanel({}, "replies");
      fireEvent.click(await screen.findByRole("button", { name: "Check now" }));
      await waitFor(() => expect(mocks.checkNow).toHaveBeenCalledTimes(1));
    });

    it("no IMAP login saved: no Replies & bounces tab", async () => {
      mocks.isAdmin = false;
      await renderPanel({ imapStatus: null });
      await screen.findByText("Sent today");
      expect(screen.queryByRole("tab", { name: "Replies & bounces" })).toBeNull();
    });
  });

  describe("UX-1 layout", () => {
    it("tabs live in the URL; the shared form keeps edits across tabs; Discard restores", async () => {
      mocks.isAdmin = true;
      const { router } = await renderPanel();
      fireEvent.change(await screen.findByLabelText("Default from name"), {
        target: { value: "Edited" },
      });
      await openTab("Safety & limits");
      await waitFor(() => expect(router.state.location.search).toEqual({ tab: "safety" }));
      expect(screen.getByRole("region", { name: "Unsaved changes" })).toBeInTheDocument();
      await openTab("Connection");
      expect(screen.getByLabelText("Default from name")).toHaveValue("Edited");
      fireEvent.click(screen.getByRole("button", { name: "Discard" }));
      await waitFor(() =>
        expect(screen.getByLabelText("Default from name")).toHaveValue("MOTM Sales"),
      );
      expect(screen.queryByRole("region", { name: "Unsaved changes" })).toBeNull();
    });

    it("leaving with unsaved changes asks first", async () => {
      mocks.isAdmin = true;
      const { router } = await renderPanel();
      fireEvent.change(await screen.findByLabelText("Default from name"), {
        target: { value: "Edited" },
      });
      void router.navigate({ to: "/elsewhere" as never });
      expect(
        await screen.findByRole("dialog", { name: "Leave without saving?" }),
      ).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
      expect(router.state.location.pathname).toBe("/page");
    });

    it("monitoring pages the whole safety-event history with Load more", async () => {
      mocks.safetyEvents
        .mockResolvedValueOnce({
          data: [
            { id: "e-1", kind: "send_failed", detail: "timeout", at: "2026-10-28T04:00:00.000Z" },
          ],
          nextCursor: "c-2",
        })
        .mockResolvedValueOnce({
          data: [{ id: "e-2", kind: "paused", detail: "too many", at: "2026-10-27T04:00:00.000Z" }],
          nextCursor: null,
        });
      await renderPanel({}, "monitoring");
      const list = await screen.findByRole("list", { name: "Safety events" });
      expect(list).toHaveTextContent("Send failed");
      fireEvent.click(screen.getByRole("button", { name: "Load more" }));
      await waitFor(() => expect(list).toHaveTextContent("Paused"));
      expect(mocks.safetyEvents).toHaveBeenLastCalledWith({ cursor: "c-2" }, expect.anything());
      expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    });
  });
});
