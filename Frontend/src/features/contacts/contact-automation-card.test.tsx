import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  user: { id: "rep-1", role: "Salesperson" } as { id: string; role: string } | null,
}));

vi.mock("@/store", () => ({
  messageFromError: (error: unknown) => (error instanceof Error ? error.message : "Failed"),
  useContactAutomation: () => ({ mutateAsync: mocks.mutateAsync, isPending: false }),
  useSession: () => ({ currentUser: mocks.user }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { automationText, ContactAutomationCard } from "./contact-automation-card";

const OLD = {
  automated: false,
  enabled: null,
  setAt: null,
  setByName: null,
  since: "2026-11-18T06:30:00Z",
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.user = { id: "rep-1", role: "Salesperson" };
});

describe("ContactAutomationCard (REL-1 rule 2)", () => {
  it("says why a contact is on or off", () => {
    expect(automationText(OLD)).toBe("Off — contact from before go-live");
    expect(automationText({ ...OLD, automated: true })).toMatch(
      /^On — new contact \(since go-live/,
    );
    expect(
      automationText({
        ...OLD,
        automated: true,
        enabled: true,
        setAt: "2026-11-19T06:30:00Z",
        setByName: "Govinda",
      }),
    ).toMatch(/^On since .+ by Govinda$/);
  });

  it("the owner switches an old contact on after a confirm", async () => {
    mocks.mutateAsync.mockResolvedValue({ changed: 1, unchanged: 0 });
    render(<ContactAutomationCard contactId="lead-1" ownerId="rep-1" automation={OLD} />);
    const toggle = screen.getByRole("switch", { name: "Automation" });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    expect(mocks.mutateAsync).not.toHaveBeenCalled();
    expect(screen.getByText(/Nothing from the past is replayed/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Switch on" }));
    await waitFor(() =>
      expect(mocks.mutateAsync).toHaveBeenCalledWith({ ids: ["lead-1"], enabled: true }),
    );
  });

  it("another salesperson sees the state but can't change it; an admin can", () => {
    render(<ContactAutomationCard contactId="lead-1" ownerId="someone-else" automation={OLD} />);
    expect(screen.getByRole("switch", { name: "Automation" })).toBeDisabled();
    expect(screen.getByText(/Only an admin or the contact's owner/)).toBeInTheDocument();
    cleanup();
    mocks.user = { id: "admin-1", role: "Admin" };
    render(<ContactAutomationCard contactId="lead-1" ownerId="someone-else" automation={OLD} />);
    expect(screen.getByRole("switch", { name: "Automation" })).toBeEnabled();
  });
});
