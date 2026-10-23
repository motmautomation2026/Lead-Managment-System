import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ addLead: vi.fn(), addNote: vi.fn() }));

vi.mock("@/store", () => ({
  messageFromError: (error: unknown) => (error instanceof Error ? error.message : "Failed"),
  useLeads: () => ({ addLead: mocks.addLead, addNote: mocks.addNote, isPending: false }),
  useSession: () => ({
    users: [{ id: "rep-1", name: "Rep One", active: true }],
    currentUser: { id: "rep-1", name: "Rep One", role: "Salesperson" },
  }),
}));

import { AddLeadDialog } from "./add-lead-dialog";

afterEach(cleanup);

async function renderDialog() {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const routes = [
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => <AddLeadDialog open onOpenChange={() => undefined} />,
    }),
    createRoute({ getParentRoute: () => rootRoute, path: "/leads/$leadId", component: () => null }),
  ];
  const router = createRouter({
    routeTree: rootRoute.addChildren(routes),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
}

const input = (labelText: string) =>
  screen.getByText(labelText, { selector: "label" }).parentElement!.querySelector("input")!;

describe("AddLeadDialog owner", () => {
  it("defaults to Auto (by revenue rules) and sends no ownerId, with the revenue text", async () => {
    mocks.addLead.mockResolvedValue({ id: "lead-1" });
    await renderDialog();
    expect(await screen.findByText("Auto (by revenue rules)")).toBeInTheDocument();

    fireEvent.change(input("First name"), { target: { value: "Ada" } });
    fireEvent.change(input("Company"), { target: { value: "Analytics Co" } });
    fireEvent.change(input("Email"), { target: { value: "ada@example.com" } });
    fireEvent.change(input("Company revenue"), { target: { value: "₹1–5 Cr" } });
    expect(input("Company revenue")).toHaveAttribute("placeholder", "e.g. ₹1–5 Cr");
    fireEvent.click(screen.getByRole("button", { name: "Create lead" }));

    await vi.waitFor(() => expect(mocks.addLead).toHaveBeenCalledOnce());
    const sent = mocks.addLead.mock.calls[0]![0];
    expect(sent).toMatchObject({
      firstName: "Ada",
      company: "Analytics Co",
      revenueRange: "₹1–5 Cr",
    });
    expect(sent.ownerId).toBeUndefined();
  });
});
