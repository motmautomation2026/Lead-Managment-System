import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";

/**
 * E1b: email goes only through the workspace's SMTP mailbox, and only the worker sends
 * (services/emailOutbound.service.ts). One pooled transport (1 connection) per workspace,
 * rebuilt when the settings change. Tests inject a TransportCache with a fake factory;
 * nothing here talks to a real server in tests.
 */

export type MailSecurity = "ssl" | "starttls";

export interface SmtpConfig {
  host: string;
  port: number;
  /** `ssl` = implicit TLS (usually 465); `starttls` = upgrade (usually 587). */
  security: MailSecurity;
  username: string;
  password: string;
}

export interface OutgoingMail {
  from: { name: string; address: string };
  to: string;
  replyTo: string;
  subject: string;
  html: string;
  text: string;
  messageId: string;
  date: Date;
  headers: Record<string, string>;
  attachments: { filename: string; content: Buffer; contentType?: string }[];
}

export interface EmailTransport {
  sendMail(mail: OutgoingMail): Promise<{ messageId?: string; response?: string }>;
  verify(): Promise<unknown>;
  close(): void;
}

export type TransportFactory = (config: SmtpConfig, options: { pool: boolean }) => EmailTransport;

export const SMTP_CONNECTION_TIMEOUT_MS = 15_000;
export const SMTP_GREETING_TIMEOUT_MS = 15_000;
export const SMTP_SOCKET_TIMEOUT_MS = 60_000;
export const CONNECTION_TEST_TIMEOUT_MS = 15_000;

export const createSmtpTransport: TransportFactory = (config, { pool }) =>
  nodemailer.createTransport({
    ...(pool ? { pool: true as const, maxConnections: 1, maxMessages: 100 } : {}),
    host: config.host,
    port: config.port,
    secure: config.security === "ssl",
    requireTLS: config.security === "starttls",
    auth: { user: config.username, pass: config.password },
    tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
    connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
    greetingTimeout: SMTP_GREETING_TIMEOUT_MS,
    socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
  }) as unknown as EmailTransport;

/** One pooled transport per workspace; a new `key` (the settings changed) closes the old one. */
export class TransportCache {
  private readonly transports = new Map<string, { key: string; transport: EmailTransport }>();

  constructor(private readonly factory: TransportFactory = createSmtpTransport) {}

  get(workspaceId: string, key: string, config: SmtpConfig): EmailTransport {
    const cached = this.transports.get(workspaceId);
    if (cached?.key === key) return cached.transport;
    cached?.transport.close();
    const transport = this.factory(config, { pool: true });
    this.transports.set(workspaceId, { key, transport });
    return transport;
  }

  closeAll(): void {
    for (const { transport } of this.transports.values()) transport.close();
    this.transports.clear();
  }
}

export const defaultTransportCache = new TransportCache();

/** Rejects with a `TIMEOUT`-coded error when `promise` takes longer than `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`Timed out after ${ms / 1000}s`), { code: "TIMEOUT" })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** "Test SMTP login": connect + EHLO + TLS + AUTH, nothing sent. */
export async function verifySmtp(config: SmtpConfig, factory: TransportFactory = createSmtpTransport): Promise<void> {
  const transport = factory(config, { pool: false });
  try {
    await withTimeout(transport.verify(), CONNECTION_TEST_TIMEOUT_MS);
  } finally {
    transport.close();
  }
}

export interface ImapConfig extends SmtpConfig {
  folder: string;
}

/** What "Test IMAP login" needs from an IMAP client (tests inject a fake). */
export interface ImapClient {
  connect(): Promise<void>;
  mailboxOpen(path: string, options: { readOnly: true }): Promise<unknown>;
  logout(): Promise<void>;
  close(): void;
}

export type ImapFactory = (config: ImapConfig) => ImapClient;

/** D3: one fetched message (`source` read with BODY.PEEK, so nothing is marked read). */
export interface ImapMessage {
  uid: number;
  internalDate?: Date | string;
  source?: Buffer;
}

/**
 * D3: what the worker's mailbox poller needs: EXAMINE (read-only), SEARCH and FETCH by UID.
 * Nothing that sets flags, moves, copies, deletes or expunges is part of it.
 */
export interface ImapReader extends ImapClient {
  mailboxOpen(path: string, options: { readOnly: true }): Promise<{ uidValidity: bigint | number; uidNext?: number }>;
  search(query: { since?: Date; uid?: string }, options: { uid: true }): Promise<number[] | false>;
  fetch(
    range: string,
    query: { uid: true; internalDate?: true; source?: { start: 0; maxLength: number } },
    options: { uid: true },
  ): AsyncIterable<ImapMessage>;
}

export type ImapReaderFactory = (config: ImapConfig) => ImapReader;

export const IMAP_POLL_TIMEOUT_MS = 30_000;

export const createImapReader: ImapReaderFactory = (config) => createImapClient(config, IMAP_POLL_TIMEOUT_MS) as unknown as ImapReader;

export const createImapClient = (config: ImapConfig, timeoutMs = CONNECTION_TEST_TIMEOUT_MS): ImapClient => {
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.security === "ssl",
    doSTARTTLS: config.security === "starttls",
    auth: { user: config.username, pass: config.password },
    tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
    logger: false,
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
  });
  // An unhandled 'error' event would crash the process; the awaited calls reject anyway.
  client.on("error", () => undefined);
  return client as unknown as ImapClient;
};

/** "Test IMAP login": connect + login + open the folder read-only (EXAMINE) + logout. Nothing is read or changed. */
export async function verifyImap(config: ImapConfig, factory: ImapFactory = createImapClient): Promise<void> {
  const client = factory(config);
  try {
    await withTimeout(
      (async () => {
        await client.connect();
        await client.mailboxOpen(config.folder, { readOnly: true });
        await client.logout();
      })(),
      CONNECTION_TEST_TIMEOUT_MS,
    );
  } finally {
    client.close();
  }
}
