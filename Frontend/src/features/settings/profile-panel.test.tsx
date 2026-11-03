import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ me: vi.fn(), updateMe: vi.fn() }));

vi.mock("@/store", () => ({
  keys: { session: ["session"] },
  messageFromError: (error: unknown) => (error instanceof Error ? error.message : "Failed"),
}));
vi.mock("@/lib/backend-client", () => ({ backend: { me: mocks.me, updateMe: mocks.updateMe } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ProfilePanel } from "./profile-panel";
import { bookingUrlField } from "./booking-url";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderPanel(bookingUrl: string | null) {
  mocks.me.mockResolvedValue({
    id: "u1",
    name: "Ravi",
    email: "ravi@x.in",
    role: "salesperson",
    bookingUrl,
  });
  mocks.updateMe.mockImplementation(async (input: { bookingUrl: string | null }) => input);
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ProfilePanel />
    </QueryClientProvider>,
  );
}

describe("ProfilePanel (E3b-1 booking link)", () => {
  it("shows the saved link and saves a new one", async () => {
    renderPanel("https://calendly.com/old");
    const input = screen.getByLabelText<HTMLInputElement>("Booking link");
    await waitFor(() => expect(input.value).toBe("https://calendly.com/old"));
    fireEvent.change(input, { target: { value: "https://calendly.com/ravi" } });
    fireEvent.click(screen.getByRole("button", { name: "Save booking link" }));
    await waitFor(() =>
      expect(mocks.updateMe).toHaveBeenCalledWith(
        { bookingUrl: "https://calendly.com/ravi" },
        expect.anything(),
      ),
    );
  });

  it("an empty field removes the link; an http link is refused", async () => {
    renderPanel("https://calendly.com/old");
    const input = screen.getByLabelText<HTMLInputElement>("Booking link");
    await waitFor(() => expect(input.value).toBe("https://calendly.com/old"));
    fireEvent.change(input, { target: { value: "http://calendly.com/ravi" } });
    fireEvent.click(screen.getByRole("button", { name: "Save booking link" }));
    expect(await screen.findByText(/Use a full https:\/\/ link/)).toBeTruthy();
    expect(mocks.updateMe).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save booking link" }));
    await waitFor(() =>
      expect(mocks.updateMe).toHaveBeenCalledWith({ bookingUrl: null }, expect.anything()),
    );
  });
});

describe("bookingUrlField", () => {
  it("mirrors the server: https only, ≤ 300 characters, empty allowed", () => {
    expect(bookingUrlField.safeParse("").success).toBe(true);
    expect(bookingUrlField.safeParse("https://cal.com/ravi").success).toBe(true);
    expect(bookingUrlField.safeParse("ftp://cal.com/ravi").success).toBe(false);
    expect(bookingUrlField.safeParse(`https://cal.com/${"a".repeat(290)}`).success).toBe(false);
  });
});
