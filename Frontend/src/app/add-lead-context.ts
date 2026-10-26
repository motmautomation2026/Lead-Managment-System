import { createContext, useContext } from "react";
import type { IdName } from "@/types";

export interface AddLeadControls {
  /** `company` prefills the Company field (e.g. "Add contact" on a company record). */
  open: (prefill?: { company?: string }) => void;
}

export const AddLeadContext = createContext<AddLeadControls>({ open: () => undefined });

export function useAddLead() {
  return useContext(AddLeadContext);
}

/** Opens the app-wide Create company dialog (hosted by the app shell). */
export const CreateCompanyContext = createContext<{ open: () => void }>({ open: () => undefined });

export function useCreateCompanyDialog() {
  return useContext(CreateCompanyContext);
}

export interface CreateDealOptions {
  /** Fixed contact (from a contact record). */
  contact?: IdName;
  /** Limit the contact picker to this company's contacts (from a company record). */
  companyId?: string;
  /** Stay on the current page after creating (toast with a link) instead of opening the deal. */
  stay?: boolean;
}

/** Opens the app-wide Create deal dialog (hosted by the app shell). */
export const CreateDealContext = createContext<{ open: (options?: CreateDealOptions) => void }>({
  open: () => undefined,
});

export function useCreateDealDialog() {
  return useContext(CreateDealContext);
}
