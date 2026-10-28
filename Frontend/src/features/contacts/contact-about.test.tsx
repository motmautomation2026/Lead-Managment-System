import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContactDetail } from "@/types";

const mocks = vi.hoisted(() => ({ isAdmin: false }));

vi.mock("@/store", () => ({
  messageFromError: (error: unknown) => (error instanceof Error ? error.message : "Failed"),
  useIsAdmin: () => mocks.isAdmin,
  useSession: () => ({ users: [] }),
  useLeadMutations: () => ({
    updateLead: vi.fn(),
    clearWhatsAppOptOut: vi.fn(),
    clearEmailStatus: vi.fn(),
  }),
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

describe("ContactAbout email status (D3 rule 6)", () => {
  const email = (status: string, reason: string) =>
    [{ channel: "email", status, reason, updatedAt: "2026-10-27T00:00:00.000Z" }] as never;

  it.each([
    ["permanent_bounce", "Bounced"],
    ["invalid", "Invalid"],
    ["unsubscribed", "Unsubscribed"],
  ])("%s shows as %s with its reason; an admin can open the clear dialog", (status, text) => {
    mocks.isAdmin = true;
    render(
      <ContactAbout contact={contact} contactability={email(status, "Email bounced: 5.1.1")} />,
    );
    expect(screen.getByText(text + " — Email bounced: 5.1.1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByRole("dialog", { name: "Clear email status?" })).toBeInTheDocument();
  });

  it("a salesperson sees the status but no Clear button", () => {
    mocks.isAdmin = false;
    render(
      <ContactAbout
        contact={contact}
        contactability={email("unsubscribed", "Unsubscribe request")}
      />,
    );
    expect(screen.getByText("Unsubscribed — Unsubscribe request")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear" })).not.toBeInTheDocument();
  });

  it("a valid email has no Clear button, even for admins", () => {
    mocks.isAdmin = true;
    render(<ContactAbout contact={contact} contactability={email("valid", "")} />);
    expect(screen.queryByRole("button", { name: "Clear" })).not.toBeInTheDocument();
  });
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
