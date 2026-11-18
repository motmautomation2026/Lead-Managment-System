import { z } from "zod";
import { BackendError } from "@/lib/backend-client";

/** The existing company's id from a 409 on POST/PATCH /companies (same normalised name or domain). */
export const existingCompanyId = (error: unknown) =>
  error instanceof BackendError && error.status === 409
    ? ((error.details as { companyId?: string } | undefined)?.companyId ?? null)
    : null;

/** Owner select value for "no owner" (ownerId null). */
export const NO_OWNER = "none";

// Light client checks; the backend normalises the domain and has the final say (400/409).
const DOMAIN = /^(https?:\/\/)?(www\.)?([a-z0-9-]+\.)+[a-z]{2,}(\/\S*)?$/i;
const text = (max: number) => z.string().trim().max(max, `At most ${max} characters.`);

/** Company form fields (create dialog and the About inline editors). Empty = not set. */
export const companyFormSchema = z.object({
  name: z.string().trim().min(1, "Enter the company name.").max(300, "At most 300 characters."),
  domain: text(253).refine((v) => !v || DOMAIN.test(v), "Use a domain like example.com."),
  website: text(500),
  industry: text(200),
  city: text(200),
  state: text(200),
  country: text(200),
  linkedinUrl: text(500).refine(
    (v) => !v || /linkedin\.com\//i.test(v),
    "Use a LinkedIn URL (linkedin.com/company/…).",
  ),
  employeeRange: text(100),
  revenueRange: text(200),
  description: text(5000),
  ownerId: z.string(),
});
export type CompanyFormValues = z.infer<typeof companyFormSchema>;
export type CompanyTextField = Exclude<keyof CompanyFormValues, "ownerId">;

export const COMPANY_FIELD_LABELS: Record<CompanyTextField, string> = {
  name: "Name",
  domain: "Domain",
  website: "Website",
  industry: "Industry",
  city: "City",
  state: "State",
  country: "Country",
  linkedinUrl: "LinkedIn URL",
  employeeRange: "Employees",
  revenueRange: "Revenue",
  description: "Description",
};
