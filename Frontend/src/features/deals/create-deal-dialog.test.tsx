import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreateDealOptions } from "@/app/add-lead-context";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  searchArgs: [] as unknown[],
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/store", () => ({
  messageFromError: (error: unknown) => (error instanceof Error ? error.message : "Failed"),
  useCreateDeal: () => ({ mutateAsync: mocks.create }),
  useSession: () => ({
    users: [
      { id: "u-1", name: "Asha Owner", active: true },
      { id: "u-2", name: "Old Rep", active: false },
    ],
  }),
  useContact: (id: string) => ({
    data: id
      ? {
          id,
          companyText: "Tata Motors",
          company: { id: "co-1", name: "Tata Motors" },
          serviceInterest: "Cold Calling",
        }
      : undefined,
  }),
  useContactSearch: (input: string, companyId?: string) => {
    mocks.searchArgs.push({ input, companyId });
    return {
      data: { data: [{ id: "l-1", name: "Ravi Kumar", email: null, company: null }] },
      isFetching: false,
      isError: false,
    };
  },
}));

import { CreateDealDialog } from "./create-deal-dialog";

async function renderDialog(options: CreateDealOptions = {}) {
  const onOpenChange = vi.fn();
  const root = createRootRoute({
    component: () => (
      <>
        <CreateDealDialog open onOpenChange={onOpenChange} options={options} />
        <Outlet />
      </>
    ),
  });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: "/", component: () => null }),
      createRoute({
        getParentRoute: () => root,
        path: "/deals/$dealId",
        component: () => <div>deal page</div>,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
  await screen.findByRole("dialog", { name: "Create deal" });
  return { router, onOpenChange };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.searchArgs = [];
});

describe("CreateDealDialog", () => {
  it("needs a contact and a valid amount; an empty name means the backend's default", async () => {
    mocks.create.mockResolvedValue({ id: "d-9" });
    const { router, onOpenChange } = await renderDialog();
    fireEvent.change(screen.getByLabelText("Amount (INR)"), { target: { value: "-5" } });
    fireEvent.click(screen.getByRole("button", { name: "Create deal" }));
    expect(await screen.findByText("Choose the contact this deal is with.")).toBeTruthy();
    expect(screen.getByText("Enter an amount of 0 or more.")).toBeTruthy();
    expect(mocks.create).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Contact" }));
    fireEvent.change(screen.getByLabelText("Search contacts"), { target: { value: "ravi" } });
    fireEvent.click(await screen.findByText("Ravi Kumar"));
    // The placeholder previews the default name from the chosen contact.
    expect(screen.getByLabelText("Deal name")).toHaveAttribute(
      "placeholder",
      "Tata Motors – Cold Calling",
    );
    fireEvent.change(screen.getByLabelText("Amount (INR)"), { target: { value: "250000" } });
    fireEvent.change(screen.getByLabelText("Expected close date"), {
      target: { value: "2026-12-31" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create deal" }));
    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith({
        leadId: "l-1",
        name: undefined,
        stage: "qualified",
        amount: 250000,
        currency: "INR",
        expectedCloseDate: "2026-12-31",
      }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
    // Opened from + Create: goes to the new deal.
    await waitFor(() => expect(router.state.location.pathname).toBe("/deals/d-9"));
  });

  it("from a company: the picker lists only that company's contacts", async () => {
    await renderDialog({ companyId: "co-1", stay: true });
    fireEvent.click(screen.getByRole("button", { name: "Contact" }));
    expect(await screen.findByText("Ravi Kumar")).toBeTruthy();
    expect(mocks.searchArgs.at(-1)).toEqual({ input: "", companyId: "co-1" });
  });

  it("from a contact: fixed contact, another owner goes in the one POST, stays with a toast", async () => {
    mocks.create.mockResolvedValue({ id: "d-7" });
    const { router } = await renderDialog({ contact: { id: "c-1", name: "Asha Rao" }, stay: true });
    expect(screen.queryByRole("button", { name: "Contact" })).toBeNull();
    expect(screen.getByText("Asha Rao")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Deal name"), { target: { value: "Fleet renewal" } });
    fireEvent.keyDown(screen.getByLabelText("Owner"), { key: "Enter" });
    expect(screen.queryByRole("option", { name: "Old Rep" })).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: "Asha Owner" }));
    fireEvent.click(screen.getByRole("button", { name: "Create deal" }));
    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({ leadId: "c-1", name: "Fleet renewal", ownerId: "u-1" }),
      ),
    );
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.toast.success).toHaveBeenCalledWith("Deal created", expect.anything());
    expect(router.state.location.pathname).toBe("/");
  });

  it("shows a backend error inline", async () => {
    mocks.create.mockRejectedValue(new Error("Contact not found."));
    await renderDialog({ contact: { id: "c-1", name: "Asha Rao" } });
    fireEvent.click(screen.getByRole("button", { name: "Create deal" }));
    expect(await screen.findByText("Contact not found.")).toBeTruthy();
  });
});
