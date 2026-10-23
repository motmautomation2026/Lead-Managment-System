import { AppError } from "../errors.js";
import { isDatabaseError } from "../domain/dbErrorMessages.js";

export class ProviderDeferredError extends Error {
  constructor(message: string, readonly retryAfterMs = 60_000) {
    super(message);
    this.name = "ProviderDeferredError";
  }
}

export class PermanentProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentProviderError";
  }
}

/** The provider did not answer in time. Retryable: it may still have accepted the request. */
export class ProviderTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderTimeoutError";
  }
}

/** The model answered, but not with valid JSON matching the schema (or refused). A failed attempt, not a provider outage. */
export class ModelOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelOutputError";
  }
}

/**
 * For routes that await a provider inline: turns a provider failure into a
 * clear HTTP error, e.g. "Email test failed: Resend rejected the request: API
 * key is invalid". Provider messages never carry our secrets. Database errors
 * are returned unchanged so the error middleware maps them as usual.
 */
export function toProviderHttpError(error: unknown, action: string): unknown {
  if (isDatabaseError(error) || error instanceof AppError) return error;
  const reason = error instanceof Error ? error.message : String(error);
  if (error instanceof PermanentProviderError) return new AppError(400, "provider_rejected", `${action}: ${reason}`);
  if (error instanceof ProviderDeferredError) return new AppError(503, "provider_unavailable", `${action}: ${reason}`);
  if (error instanceof ProviderTimeoutError) return new AppError(504, "provider_timeout", `${action}: ${reason}`);
  return new AppError(502, "provider_error", `${action}: ${reason}`);
}
