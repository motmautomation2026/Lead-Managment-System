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

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  companies: [] as { id: string; name: string }[],
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/store", () => ({
  messageFromError: (error: unknown) => (error instanceof Error ? error.message : "Failed"),
  useSession: () => ({ users: [{ id: "rep-1", name: "Rep One", active: true }] }),
  useCreateContact: () => ({ mutateAsync: mocks.create, isPending: false }),
  useCompanySearch: () => ({ data: { data: mocks.companies, nextCursor: null } }),
}));

import { BackendError } from "@/lib/backend-client";
import { CreateContactDialog } from "./create-contact-dialog";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.companies = [];
});

async function renderDialog() {
  const root = createRootRoute({ component: () => <Outlet /> });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: "/",
        component: () => <CreateContactDialog open onOpenChange={() => undefined} />,
      }),
      createRoute({
        getParentRoute: () => root,
        path: "/contacts/$contactId",
        component: () => <div>record page</div>,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
  await screen.findByRole("dialog", { name: "Create contact" });
  return router;
}
const type = (name: string, value: string) => {
  const input = screen.getByLabelText(name);
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
};
const submit = () => fireEvent.click(screen.getByRole("button", { name: "Create contact" }));

describe("CreateContactDialog", () => {
  it("requires first name, company and an email or phone (same rules as the old dialog)", async () => {
    await renderDialog();
    submit();
    expect(await screen.findByText("First name is required.")).toBeTruthy();
    expect(screen.getByText("Company is required.")).toBeTruthy();
    expect(screen.getByText("Provide at least an email or a phone number.")).toBeTruthy();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("rejects an invalid email and phone", async () => {
    await renderDialog();
    type("Email", "not-an-email");
    type("Phone", "12");
    submit();
    expect(await screen.findByText("Enter a valid email address.")).toBeTruthy();
    expect(screen.getByText(/Enter a valid phone number/)).toBeTruthy();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("creates with Auto owner (no ownerId), normalised phone, and opens the record", async () => {
    mocks.create.mockResolvedValue({ id: "lead-9" });
    const router = await renderDialog();
    expect(screen.getAllByText("Auto (by assignment rules)").length).toBeGreaterThan(0);
    type("First name", "Ada");
    type("Company", "Analytics Co");
    type("Phone", "98765 43210");
    type("Company revenue", "₹1–5 Cr");
    type("Job title", "CTO");
    submit();
    await waitFor(() => expect(mocks.create).toHaveBeenCalledOnce());
    const sent = mocks.create.mock.calls[0]![0];
    expect(sent).toMatchObject({
      firstName: "Ada",
      company: "Analytics Co",
      phone: "+919876543210",
      email: "",
      jobTitle: "CTO",
      revenueRange: "₹1–5 Cr",
      source: "website",
    });
    expect(sent.ownerId).toBeUndefined();
    await waitFor(() => expect(router.state.location.pathname).toBe("/contacts/lead-9"));
  });

  it("shows a backend field error inline and keeps the form", async () => {
    mocks.create.mockRejectedValue(
      new BackendError(409, "conflict", "A lead with this email already exists.", {
        field: "email",
      }),
    );
    await renderDialog();
    type("First name", "Ada");
    type("Company", "Analytics Co");
    type("Email", "ada@example.com");
    submit();
    expect(await screen.findByText("A lead with this email already exists.")).toBeTruthy();
    expect((screen.getByLabelText("First name") as HTMLInputElement).value).toBe("Ada");
  });

  it("hints when the company text matches an existing company (informational only)", async () => {
    mocks.companies = [{ id: "co-1", name: "Tata Motors" }];
    await renderDialog();
    type("Company", "tata motors");
    expect(await screen.findByText("Matches the existing company “Tata Motors”.")).toBeTruthy();
  });
});
