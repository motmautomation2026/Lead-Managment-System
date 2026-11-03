import { z } from "zod";

/** E3b-1 rule 5: a booking page link, https only, ≤ 300 characters; empty = none. Mirrors the server (profiles.service.ts). */
export const bookingUrlField = z
  .string()
  .trim()
  .max(300, "The booking link can be at most 300 characters.")
  .refine(
    (value) => value === "" || isHttpsUrl(value),
    "Use a full https:// link, e.g. https://calendly.com/your-name.",
  );

function isHttpsUrl(value: string): boolean {
  if (/\s/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.includes(".");
  } catch {
    return false;
  }
}
