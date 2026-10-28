import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContactDetail } from "@/types";

const mocks = vi.hoisted(() => ({ isAdmin: false }));

vi.mock("@/store", () => ({
  messageFromError: (error: unknown) => (error instanceof Error ? error.message : "Failed"),
  useIsAdmin: () => mocks.isAdmin,
  useSession: () => ({ users: [] }),
  useLeadMutations: () => ({ updateLead: vi.fn(), clearWhatsAppOptOut: vi.fn() }),
}));

import { ContactAbout } from "./contact-about";

const contact = {
  id: "lead-1",
  firstName: "Opal",
  companyText: "Opal Pvt Ltd",
  source: "referral",
  pipelineStage: "new",
  lifecycleState: "active",
  serviceInterest: "",
  createdAt: "2026-10-01T00:00:00.000Z",
} as unknown as ContactDetail;
const optedOut = [
  {
    channel: "whatsapp",
    status: "opted_out",
    reason: "Asked to stop on WhatsApp",
    updatedAt: "2026-10-27T00:00:00.000Z",
  },
] as never;

afterEach(() => {
  cleanup();
});

describe("ContactAbout WhatsApp opt-out (E1 rule 8)", () => {
  it("an admin can open the clear dialog", () => {
    mocks.isAdmin = true;
    render(<ContactAbout contact={contact} contactability={optedOut} />);
    expect(screen.getByText(/Asked to stop on WhatsApp/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear opt-out" }));
    expect(screen.getByRole("dialog", { name: "Clear WhatsApp opt-out?" })).toBeInTheDocument();
  });

  it("a salesperson sees the status but no clear button", () => {
    mocks.isAdmin = false;
    render(<ContactAbout contact={contact} contactability={optedOut} />);
    expect(screen.getByText(/Asked to stop on WhatsApp/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear opt-out" })).not.toBeInTheDocument();
  });
});
