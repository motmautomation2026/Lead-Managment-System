import type { RequestParamHandler } from "express";
import { z, type ZodType, type ZodTypeDef } from "zod";
import { ValidationError } from "../errors.js";

export function parseBody<T>(schema: ZodType<T, ZodTypeDef, unknown>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ValidationError("Some fields are missing or invalid.", result.error.flatten());
  }
  return result.data;
}

export function parseQuery<T>(schema: ZodType<T, ZodTypeDef, unknown>, query: unknown): T {
  const result = schema.safeParse(query);
  if (!result.success) {
    throw new ValidationError("Some query parameters are invalid.", result.error.flatten());
  }
  return result.data;
}

export function parseParams<T>(schema: ZodType<T, ZodTypeDef, unknown>, params: unknown): T {
  const result = schema.safeParse(params);
  if (!result.success) {
    throw new ValidationError("The address contains an invalid value.", result.error.flatten());
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

/**
 * A query-string boolean: "true"/"1" or "false"/"0", anything else a 400.
 * z.coerce.boolean() turns the string "false" into true (audit B14).
 */
export const queryBoolean = z
  .enum(["true", "1", "false", "0"], { errorMap: () => ({ message: 'Use "true" or "false".' }) })
  .transform((value) => value === "true" || value === "1");
