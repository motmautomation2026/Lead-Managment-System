import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { AppError } from "./errors.js";
import { env } from "./env.js";
import { mapDatabaseError } from "./domain/dbErrorMessages.js";

/** Reuses a well-formed incoming X-Request-Id (e.g. from a proxy), otherwise makes one, and echoes it back. */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction) {
  const incoming = req.header("x-request-id");
  req.requestId = incoming && /^[\w.:-]{1,128}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader("X-Request-Id", req.requestId);
  next();
}

export function notFoundMiddleware(req: Request, res: Response) {
  res.status(404).json({ error: { code: "not_found", message: `No route: ${req.method} ${req.path}` } });
}

export function errorMiddleware(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }

  const mapped = mapDatabaseError(err);
  if (mapped) {
    res.status(mapped.status).json({ error: { code: mapped.code, message: mapped.message, details: mapped.details } });
    return;
  }

  const requestId = req.requestId ?? randomUUID();
  const message = err instanceof Error ? err.message : "Internal server error.";
  if (env.NODE_ENV !== "test") {
    console.error(`[request ${requestId}] Unhandled error on ${req.method} ${req.originalUrl}:`, err);
  }
  res.status(500).json({
    error: {
      code: "internal_error",
      message: env.NODE_ENV === "production" ? `Something went wrong. Reference: ${requestId}` : message,
      details: { requestId },
    },
  });
}
