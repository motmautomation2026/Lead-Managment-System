import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/db.js", () => ({ pool: {} }));
vi.mock("../../src/supabaseAdmin.js", () => ({ supabaseAdmin: {} }));

import { requireAdmin, requireCrmUser, requireSuperAdmin, type Actor } from "../../src/authMiddleware.js";
import { ForbiddenError } from "../../src/errors.js";

function run(guard: (req: Request, res: Response, next: NextFunction) => void, role?: string, isSuperAdmin = false) {
  const next = vi.fn();
  const actor = role ? ({ id: "u", fullName: "U", email: "u@example.com", isActive: true, role, isSuperAdmin } as unknown as Actor) : undefined;
  guard({ actor } as Request, {} as Response, next);
  expect(next).toHaveBeenCalledTimes(1);
  return next.mock.calls[0]?.[0] as unknown;
}

describe("requireCrmUser", () => {
  it.each(["salesperson", "admin"])("lets a %s through", (role) => {
    expect(run(requireCrmUser, role)).toBeUndefined();
  });
  it.each([undefined, "viewer"])("rejects role %s with 403", (role) => {
    expect(run(requireCrmUser, role)).toBeInstanceOf(ForbiddenError);
  });
});

describe("requireAdmin", () => {
  it("lets an admin through", () => {
    expect(run(requireAdmin, "admin")).toBeUndefined();
  });
  it.each(["salesperson", undefined])("rejects %s with 403", (role) => {
    expect(run(requireAdmin, role)).toBeInstanceOf(ForbiddenError);
  });
});

describe("E4b super-admin", () => {
  it("requireAdmin lets a super-admin through whatever the role", () => {
    expect(run(requireAdmin, "salesperson", true)).toBeUndefined();
  });
  it("requireSuperAdmin accepts only a super-admin", () => {
    expect(run(requireSuperAdmin, "salesperson", true)).toBeUndefined();
    expect(run(requireSuperAdmin, "admin")).toBeInstanceOf(ForbiddenError);
    expect(run(requireSuperAdmin)).toBeInstanceOf(ForbiddenError);
  });
});
