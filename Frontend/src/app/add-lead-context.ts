import { createContext, useContext } from "react";

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
