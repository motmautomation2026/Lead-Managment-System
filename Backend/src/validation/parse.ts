import type { RequestParamHandler } from "express";
import { z, type ZodSchema } from "zod";
import { ValidationError } from "../errors.js";

export function parseBody<T>(schema: ZodSchema<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ValidationError("Request body failed validation.", result.error.flatten());
  }
  return result.data;
}

export function parseQuery<T>(schema: ZodSchema<T>, query: unknown): T {
  const result = schema.safeParse(query);
  if (!result.success) {
    throw new ValidationError("Query parameters failed validation.", result.error.flatten());
  }
  return result.data;
}

export function parseParams<T>(schema: ZodSchema<T>, params: unknown): T {
  const result = schema.safeParse(params);
  if (!result.success) {
    throw new ValidationError("Route parameters failed validation.", result.error.flatten());
  }
  return result.data;
}

const uuidSchema = z.string().uuid();

export function isUuid(value: unknown): boolean {
  return uuidSchema.safeParse(value).success;
}

/**
 * For `router.param(name, uuidParam("lead"))`: a malformed id in that route
 * parameter is a 400 "Invalid lead id." before it reaches the database
 * (where it used to be a 22P02 500, audit B24).
 */
export function uuidParam(resource: string): RequestParamHandler {
  return (_req, _res, next, value) => next(isUuid(value) ? undefined : new ValidationError(`Invalid ${resource} id.`));
}
