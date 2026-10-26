import { BackendError } from "@/lib/backend-client";

/** The existing company's id from a 409 on POST/PATCH /companies (same normalised name or domain). */
export const existingCompanyId = (error: unknown) =>
  error instanceof BackendError && error.status === 409
    ? ((error.details as { companyId?: string } | undefined)?.companyId ?? null)
    : null;
