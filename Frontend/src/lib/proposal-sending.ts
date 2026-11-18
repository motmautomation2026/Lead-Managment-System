import type { WhatsappSendStatus } from "@/types";

/** How long the list keeps polling a WhatsApp send still in flight on the worker (audit B19). */
export const SENDING_POLL_LIMIT_MS = 2 * 60_000;
export const SENDING_POLL_INTERVAL_MS = 8000;

const IN_FLIGHT: WhatsappSendStatus[] = ["queued", "sending"];

type SendRow = {
  whatsappSendStatus: WhatsappSendStatus;
  emailSendStatus?: string;
  updatedAt: string;
};

/** E1b: the email is queued ("pending") until the worker sends it, like WhatsApp. */
const inFlight = (row: SendRow) =>
  IN_FLIGHT.includes(row.whatsappSendStatus) || row.emailSendStatus === "pending";

/** Queued/sending for longer than the poll limit: shown as "Still sending — check later". */
export function isStillSending(row: SendRow, now = Date.now()) {
  return inFlight(row) && now - Date.parse(row.updatedAt) >= SENDING_POLL_LIMIT_MS;
}

/** Poll while some row's send is in flight and younger than the limit; never for stuck rows. */
export function sendingPollInterval(rows: SendRow[], now = Date.now()) {
  return rows.some((r) => inFlight(r) && !isStillSending(r, now))
    ? SENDING_POLL_INTERVAL_MS
    : false;
}
