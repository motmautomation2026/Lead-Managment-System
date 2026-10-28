import { describe, expect, it } from "vitest";
import { PermanentProviderError, ProviderDeferredError, ProviderTimeoutError, toProviderHttpError } from "../../src/providers/provider-errors.js";
import { AppError } from "../../src/errors.js";

describe("toProviderHttpError", () => {
  it.each([
    [new PermanentProviderError("The provider rejected the request: key is invalid"), 400, "provider_rejected", "Email test failed: The provider rejected the request: key is invalid"],
    [new ProviderDeferredError("Email connection is not configured."), 503, "provider_unavailable", "Email test failed: Email connection is not configured."],
    [new ProviderTimeoutError("The provider did not respond in time"), 504, "provider_timeout", "Email test failed: The provider did not respond in time"],
    [Object.assign(new Error("connect ECONNREFUSED 10.0.0.9:587"), { code: "ECONNREFUSED" }), 502, "provider_error", "Email test failed: connect ECONNREFUSED 10.0.0.9:587"],
  ])("maps %o to %i", (error, status, code, message) => {
    expect(toProviderHttpError(error, "Email test failed")).toMatchObject({ status, code, message });
  });

  it("leaves database errors and AppErrors for the error middleware", () => {
    const dbError = Object.assign(new Error("db"), { code: "23505" });
    expect(toProviderHttpError(dbError, "x")).toBe(dbError);
    const appError = new AppError(404, "not_found", "Nope.");
    expect(toProviderHttpError(appError, "x")).toBe(appError);
  });
});
