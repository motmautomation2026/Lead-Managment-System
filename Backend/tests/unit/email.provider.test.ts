import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createTransport: vi.fn() }));
vi.mock("nodemailer", () => ({ default: { createTransport: mocks.createTransport } }));

import { TransportCache, createSmtpTransport, verifySmtp, type EmailTransport, type SmtpConfig } from "../../src/providers/email.provider.js";

const CONFIG: SmtpConfig = { host: "smtp.example.com", port: 465, security: "ssl", username: "crm@example.com", password: "app-password" };

const fakeTransport = (verify: () => Promise<unknown> = async () => true): EmailTransport => ({ sendMail: vi.fn(), verify: vi.fn(verify), close: vi.fn() });

describe("createSmtpTransport (rule 5)", () => {
  it("pools one connection with bounded timeouts and checked TLS ≥ 1.2", () => {
    mocks.createTransport.mockReturnValue(fakeTransport());
    createSmtpTransport(CONFIG, { pool: true });
    expect(mocks.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        pool: true,
        maxConnections: 1,
        host: "smtp.example.com",
        port: 465,
        secure: true,
        requireTLS: false,
        tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
        connectionTimeout: 15_000,
        greetingTimeout: 15_000,
        socketTimeout: 60_000,
      }),
    );
  });

  it("STARTTLS: not secure at connect, TLS required", () => {
    mocks.createTransport.mockReturnValue(fakeTransport());
    createSmtpTransport({ ...CONFIG, port: 587, security: "starttls" }, { pool: false });
    expect(mocks.createTransport).toHaveBeenLastCalledWith(expect.objectContaining({ secure: false, requireTLS: true }));
    expect(mocks.createTransport.mock.lastCall![0]).not.toHaveProperty("pool");
  });
});

describe("TransportCache", () => {
  it("reuses a workspace's transport until the settings key changes, then closes the old one", () => {
    const factory = vi.fn(() => fakeTransport());
    const cache = new TransportCache(factory);
    const a = cache.get("ws-1", "k1", CONFIG);
    expect(cache.get("ws-1", "k1", CONFIG)).toBe(a);
    expect(cache.get("ws-2", "k1", CONFIG)).not.toBe(a);
    const b = cache.get("ws-1", "k2", CONFIG);
    expect(b).not.toBe(a);
    expect(a.close).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledTimes(3);
  });
});

describe("verifySmtp (rule 3)", () => {
  it("verifies without pooling and closes", async () => {
    const transport = fakeTransport();
    await verifySmtp(CONFIG, () => transport);
    expect(transport.verify).toHaveBeenCalledOnce();
    expect(transport.close).toHaveBeenCalledOnce();
  });

  it("gives up after 15 s with a TIMEOUT error", async () => {
    vi.useFakeTimers();
    try {
      const transport = fakeTransport(() => new Promise(() => undefined));
      const result = verifySmtp(CONFIG, () => transport).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await result).toMatchObject({ code: "TIMEOUT" });
      expect(transport.close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
