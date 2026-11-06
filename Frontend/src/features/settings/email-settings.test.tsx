import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/store", () => ({
  keys: { connection: (ws: string | null, kind: string) => ["connection", ws, kind] },
  messageFromError: (error: unknown) => (error instanceof Error ? error.message : "Failed"),
  useIsAdmin: () => mocks.isAdmin,
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
      },
    },
  },
}));

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

function renderPanel(over: Partial<EmailSettings> = {}) {
  mocks.data = { ...SAVED, ...over };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <EmailPanel workspaceId="ws-1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.isAdmin = false;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("EmailPanel (E1b)", () => {
  it("E3b-2b: Track email opens is off by default; an admin turns it on; without a public API address it says so", async () => {
    mocks.isAdmin = true;
    mocks.setTrackOpens.mockResolvedValue({ ...SAVED, trackOpens: true });
    renderPanel();
    const toggle = await screen.findByRole("switch", { name: "Track email opens" });
    expect(toggle).not.toBeChecked();
    expect(screen.queryByText(/needs a public API address/)).not.toBeInTheDocument();
    fireEvent.click(toggle);
    await waitFor(() => expect(mocks.setTrackOpens).toHaveBeenCalledWith(true, expect.anything()));
    cleanup();
    renderPanel({ openTrackingAvailable: false });
    expect(await screen.findByText(/Open tracking needs a public API address/)).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Track email opens" })).toBeDisabled();
  });

  it("E3b-2b: a salesperson can't change Track email opens", async () => {
    renderPanel({ trackOpens: true });
    expect(await screen.findByRole("switch", { name: "Track email opens" })).toBeDisabled();
  });

  it("a salesperson sees the settings read-only, the monitoring, and no secret, test or form", async () => {
    renderPanel();
    expect(await screen.findByText("MOTM Sales <sales@motm.test>")).toBeInTheDocument();
    expect(screen.getByText("smtp.motm.test:465 (SSL/TLS)")).toBeInTheDocument();
    expect(screen.getByText("7 / 20 (warm-up day 2)")).toBeInTheDocument();
    expect(screen.getByText("3 / 20")).toBeInTheDocument();
    expect(screen.getByText("Recipient rejected")).toBeInTheDocument();
    expect(screen.getByRole("table")).toHaveTextContent("2026-10-28");
    expect(screen.getByText("Only admins can change these.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save email settings" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Test SMTP login" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Check DNS" })).toBeNull();
    expect(document.querySelector('input[type="password"]')).toBeNull();
  });

  it("not set up (was on Resend): says so; there is no Resend option", async () => {
    mocks.isAdmin = true;
    renderPanel({ configured: false, legacyProvider: "resend", smtpHost: "", fromAddress: "" });
    expect(await screen.findByText("Email is not set up")).toBeInTheDocument();
    expect(screen.getByText(/used Resend, which is no longer supported/)).toBeInTheDocument();
    expect(screen.queryByText(/^Resend$/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Test SMTP login" })).toBeNull();
  });

  it("an admin saves; saved secrets stay blank and are not sent", async () => {
    mocks.isAdmin = true;
    mocks.update.mockResolvedValue(SAVED);
    renderPanel();
    const password = await screen.findByLabelText("Password or app password");
    expect(password).toHaveValue("");
    expect(password).toHaveAttribute("type", "password");
    fireEvent.change(screen.getByLabelText("Default from name"), { target: { value: "MOTM" } });
    fireEvent.click(screen.getByRole("button", { name: "Save email settings" }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledOnce());
    const input = mocks.update.mock.calls[0]![0] as Record<string, unknown>;
    expect(input).toMatchObject({ fromName: "MOTM", smtpHost: "smtp.motm.test", smtpPort: 465 });
    for (const secret of ["smtpUsername", "smtpPassword", "imapUsername", "imapPassword"]) {
      expect(input).not.toHaveProperty(secret);
    }
  });

  it("validates ports, spacing, caps and the window before saving", async () => {
    mocks.isAdmin = true;
    renderPanel();
    fireEvent.change(await screen.findByLabelText("Min spacing (seconds)"), {
      target: { value: "120" },
    });
    fireEvent.change(screen.getAllByLabelText("Port")[0]!, { target: { value: "70000" } });
    fireEvent.change(screen.getByLabelText("Hourly cap"), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText("Closes"), { target: { value: "08:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Save email settings" }));
    expect(
      await screen.findByText("The minimum can't be more than the maximum."),
    ).toBeInTheDocument();
    expect(screen.getByText("The window must start before it ends.")).toBeInTheDocument();
    expect(mocks.update).not.toHaveBeenCalled();
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
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Test SMTP login" }));
    expect(await screen.findByText(/create an app password/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Test IMAP login" }));
    expect(await screen.findByText(/opened "INBOX"/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Send test email to me" }));
    expect(await screen.findByText(/Sent to admin@motm.test/)).toBeInTheDocument();
    expect(mocks.testStatus).toHaveBeenCalledWith("t-1", expect.anything());
  });

  it("paused: a red banner for everyone, Resume (with confirm) for admins", async () => {
    mocks.isAdmin = true;
    mocks.resume.mockResolvedValue({ ...SAVED, pause: null });
    renderPanel({
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
    renderPanel({
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
    renderPanel();
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
      renderPanel();
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
      renderPanel({
        imapStatus: {
          ...SAVED.imapStatus!,
          lastCheckAt: null,
          lastSuccessAt: null,
          lastError:
            "IMAP login rejected — check the IMAP username and password in Settings → Email.",
        },
      });
      expect(await screen.findByText(/IMAP login rejected/)).toBeInTheDocument();
      expect(screen.getAllByText("Never")).toHaveLength(2);
    });

    it("an admin's Check now asks the server once", async () => {
      mocks.isAdmin = true;
      mocks.checkNow.mockResolvedValue({ ...SAVED });
      renderPanel();
      fireEvent.click(await screen.findByRole("button", { name: "Check now" }));
      await waitFor(() => expect(mocks.checkNow).toHaveBeenCalledTimes(1));
    });

    it("no IMAP login saved: no card", async () => {
      mocks.isAdmin = false;
      renderPanel({ imapStatus: null });
      await screen.findByText("Sent today");
      expect(screen.queryByRole("heading", { name: "Replies & bounces" })).not.toBeInTheDocument();
    });
  });
});
