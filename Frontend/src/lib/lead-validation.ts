import { parsePhoneNumberFromString } from "libphonenumber-js";
import { z } from "zod";
import { LEAD_SOURCES } from "@/types";

export const SERVICE_INTERESTS = [
  "B2B Lead Generation",
  "Market Research",
  "Target Account Identification",
  "Account-Based Marketing (ABM)",
  "Cold Calling",
  "Email Outreach",
  "LinkedIn Outreach",
  "WhatsApp Outreach",
  "Lead Nurturing & Follow-Up",
  "Sales Conversion Support",
  "Industrial Marketing",
  "Digital Marketing",
  "SEO",
  "Website Optimization",
  "Market Expansion",
  "Business Development",
  "Field Marketing / Direct Visits",
  "End-to-End Sales & Marketing",
  "Other",
];

/**
 * Mirrors Backend/src/domain/phone.ts exactly (same library, same region
 * default) so the UI's verdict never drifts from what the server accepts.
 */
export function normalizePhone(raw: string): { value: string | null; error: string | null } {
  const value = raw.trim();
  if (!value) return { value: null, error: null };

  const parsed = parsePhoneNumberFromString(value, value.startsWith("+") ? undefined : "IN");
  if (!parsed?.isValid()) {
    return {
      value: null,
      error:
        "Enter a valid phone number. Indian local numbers default to +91; international numbers must include their country code.",
    };
  }
  return { value: parsed.number, error: null };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Non-authoritative client-side check — same philosophy as the CSV import
 * preview validator. The backend (Backend/src/domain/email.ts) is the real
 * authority and re-validates every value it receives.
 */
export function normalizeEmail(raw: string): { value: string | null; error: string | null } {
  const value = raw.trim().toLowerCase();
  if (!value) return { value: null, error: null };
  if (!EMAIL_RE.test(value)) return { value: null, error: "Enter a valid email address." };
  return { value, error: null };
}

export interface LeadFormLike {
  firstName: string;
  company: string;
  email: string;
  phone: string;
  source: string;
}

export type LeadFormErrors = Partial<
  Record<"firstName" | "company" | "email" | "phone" | "source", string>
>;

/**
 * Single source of truth for lead field validation on the client, shared by
 * AddLeadDialog, EditLeadDialog, and the CSV import preview so the three
 * lead-entry paths can't silently diverge from each other.
 */
export function validateLeadForm(form: LeadFormLike): LeadFormErrors {
  const errors: LeadFormErrors = {};

  if (!form.firstName.trim()) errors.firstName = "First name is required.";
  if (!form.company.trim()) errors.company = "Company is required.";

  const email = form.email.trim();
  const phone = form.phone.trim();
  if (!email && !phone) {
    errors.email = "Provide at least an email or a phone number.";
  } else {
    if (email) {
      const { error } = normalizeEmail(email);
      if (error) errors.email = error;
    }
    if (phone) {
      const { error } = normalizePhone(phone);
      if (error) errors.phone = error;
    }
  }

  if (!form.source.trim() || !(LEAD_SOURCES as readonly string[]).includes(form.source)) {
    errors.source = "Select a lead source.";
  }

  return errors;
}

/**
 * The same rules as `validateLeadForm` as a Zod schema, for react-hook-form
 * (`zodResolver(leadFormSchema)`): every message comes from validateLeadForm.
 */
export const leadFormSchema = z
  .object({
    firstName: z.string(),
    lastName: z.string(),
    company: z.string(),
    jobTitle: z.string(),
    industry: z.string(),
    email: z.string(),
    phone: z.string(),
    source: z.string(),
    serviceInterest: z.string(),
    revenueRange: z.string(),
    /** "" = no explicit owner (assignment rules decide on create). */
    ownerId: z.string(),
  })
  .superRefine((form, ctx) => {
    for (const [path, message] of Object.entries(validateLeadForm(form))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    }
  });
export type LeadFormValues = z.infer<typeof leadFormSchema>;
