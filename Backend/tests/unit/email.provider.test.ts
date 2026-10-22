import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadEmailConnection: vi.fn(),
  sendMail: vi.fn(),
  createTransport: vi.fn(),
}));

vi.mock("../../src/services/connections.service.js", () => ({ loadEmailConnection: mocks.loadEmailConnection }));
vi.mock("nodemailer", () => ({ default: { createTransport: mocks.createTransport } }));

import { RESEND_TIMEOUT_MS, sendEmail } from "../../src/providers/email.provider.js";
import { PermanentProviderError, ProviderDeferredError, ProviderTimeoutError } from "../../src/providers/provider-errors.js";

const INPUT = { to: "lead@example.com", subject: "Hi", html: "<p>Hi</p>" };
const SENDER = { senderName: "Northbeam", senderAddress: "crm@example.com" };

function useResend() {
  mocks.loadEmailConnection.mockResolvedValue({
    row: { provider: "resend", enabled: true, settings: SENDER },
    secrets: { resendApiKey: "re_test" },
  });
}

function stubFetchStatus(status: number, body: object) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("sendEmail via Resend", () => {
  it("rejects a hung request with a retryable timeout error", async () => {
    useResend();
    vi.useFakeTimers();
    // Node's AbortSignal.timeout uses an internal timer fake timers can't
    // reach, so back it with a faked setTimeout.
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), ms);
      return controller.signal;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason))),
      ),
    );

    const result = sendEmail("ws-1", INPUT).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(RESEND_TIMEOUT_MS);
    const error = await result;

    expect(timeoutSpy).toHaveBeenCalledWith(15_000);
    expect(error).toBeInstanceOf(ProviderTimeoutError);
    expect((error as Error).message).toBe("Resend request timed out after 15s");
    expect(error).not.toBeInstanceOf(PermanentProviderError);
    expect(error).not.toBeInstanceOf(ProviderDeferredError);
  });

  it("returns the provider message id on success", async () => {
    useResend();
    stubFetchStatus(200, { id: "msg_1" });
    await expect(sendEmail("ws-1", INPUT)).resolves.toEqual({ providerMessageId: "msg_1" });
  });

  it.each([400, 401, 403, 422])("treats %i as permanent", async (status) => {
    useResend();
    stubFetchStatus(status, { message: "bad request" });
    await expect(sendEmail("ws-1", INPUT)).rejects.toBeInstanceOf(PermanentProviderError);
  });

  it.each([429, 500, 503])("treats %i as retryable", async (status) => {
    useResend();
    stubFetchStatus(status, { message: "try later" });
    const error = await sendEmail("ws-1", INPUT).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PermanentProviderError);
    expect(error).not.toBeInstanceOf(ProviderDeferredError);
  });
});

describe("sendEmail via SMTP", () => {
  it("creates the transport with connection, greeting and socket timeouts", async () => {
    mocks.loadEmailConnection.mockResolvedValue({
      row: {
        provider: "smtp",
        enabled: true,
        settings: { ...SENDER, smtpHost: "smtp.example.com", smtpPort: 587, smtpSecurity: "starttls" },
      },
      secrets: { smtpUsername: "user", smtpPassword: "pass" },
    });
    mocks.sendMail.mockResolvedValue({ messageId: "<smtp-1>" });
    mocks.createTransport.mockReturnValue({ sendMail: mocks.sendMail });

    await expect(sendEmail("ws-1", INPUT)).resolves.toEqual({ providerMessageId: "<smtp-1>" });
    expect(mocks.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 30_000 }),
    );
  });

  function useSmtp() {
    mocks.loadEmailConnection.mockResolvedValue({
      row: { provider: "smtp", enabled: true, settings: { ...SENDER, smtpHost: "smtp.example.com", smtpPort: 587, smtpSecurity: "starttls" } },
      secrets: { smtpUsername: "user", smtpPassword: "pass" },
    });
    mocks.createTransport.mockReturnValue({ sendMail: mocks.sendMail });
  }

  it("turns an SMTP timeout into a ProviderTimeoutError", async () => {
    useSmtp();
    mocks.sendMail.mockRejectedValueOnce(Object.assign(new Error("Connection timeout"), { code: "ETIMEDOUT" }));
    const error = await sendEmail("ws-1", INPUT).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderTimeoutError);
    expect((error as Error).message).toBe("The SMTP server did not respond in time: Connection timeout");
  });

  it("says the SMTP server rejected a 5xx, without the password", async () => {
    useSmtp();
    mocks.sendMail.mockRejectedValueOnce(Object.assign(new Error("Invalid login: 535 Authentication failed"), { responseCode: 535 }));
    const error = await sendEmail("ws-1", INPUT).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PermanentProviderError);
    expect((error as Error).message).toBe("The SMTP server rejected the request: Invalid login: 535 Authentication failed");
    expect((error as Error).message).not.toContain("pass");
  });
});
