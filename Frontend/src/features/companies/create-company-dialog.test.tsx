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

const mocks = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/store", () => ({
  messageFromError: (error: unknown) => (error instanceof Error ? error.message : "Failed"),
  useSession: () => ({
    users: [
      { id: "me", name: "Me Admin", active: true },
      { id: "rep-1", name: "Rep One", active: true },
    ],
    currentUser: { id: "me", name: "Me Admin" },
  }),
  useCreateCompany: () => ({ mutateAsync: mocks.create, isPending: false }),
}));

import { BackendError } from "@/lib/backend-client";
import { CreateCompanyDialog } from "./create-company-dialog";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function renderDialog() {
  const root = createRootRoute({ component: () => <Outlet /> });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: "/",
        component: () => <CreateCompanyDialog open onOpenChange={() => undefined} />,
      }),
      createRoute({
        getParentRoute: () => root,
        path: "/companies/$companyId",
        component: () => <div>company page</div>,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
  await screen.findByRole("dialog", { name: "Create company" });
  return router;
}
const type = (name: string, value: string) => {
  const input = screen.getByLabelText(name);
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
};
const submit = () => fireEvent.click(screen.getByRole("button", { name: "Create company" }));

describe("CreateCompanyDialog", () => {
  it("requires a name and checks domain and LinkedIn URL", async () => {
    await renderDialog();
    type("Domain", "not a domain");
    type("LinkedIn URL", "https://example.com/acme");
    submit();
    expect(await screen.findByText("Enter the company name.")).toBeTruthy();
    expect(screen.getByText("Use a domain like example.com.")).toBeTruthy();
    expect(screen.getByText(/Use a LinkedIn URL/)).toBeTruthy();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("creates with only the filled fields (owner = API default) and opens the record", async () => {
    mocks.create.mockResolvedValue({ id: "co-9", name: "Acme" });
    const router = await renderDialog();
    expect(screen.getAllByText("Me Admin").length).toBeGreaterThan(0);
    type("Name", " Acme ");
    type("Domain", "https://www.acme.in/about");
    type("Industry", "Steel");
    type("City", "Pune");
    submit();
    await waitFor(() => expect(mocks.create).toHaveBeenCalledOnce());
    expect(mocks.create.mock.calls[0]![0]).toEqual({
      name: "Acme",
      domain: "https://www.acme.in/about",
      industry: "Steel",
      city: "Pune",
      website: undefined,
      state: undefined,
      country: undefined,
      linkedinUrl: undefined,
      employeeRange: undefined,
      revenueRange: undefined,
      description: undefined,
    });
    await waitFor(() => expect(router.state.location.pathname).toBe("/companies/co-9"));
  });

  it("a 409 says the company exists and links to it; the form stays", async () => {
    mocks.create.mockRejectedValue(
      new BackendError(409, "conflict", 'A company named "Acme" already exists.', {
        companyId: "co-1",
      }),
    );
    const router = await renderDialog();
    type("Name", "ACME pvt ltd");
    submit();
    expect(await screen.findByText("This company already exists.")).toBeTruthy();
    expect(screen.getByText('A company named "Acme" already exists.')).toBeTruthy();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("ACME pvt ltd");
    fireEvent.click(screen.getByRole("link", { name: "Open the existing company" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/companies/co-1"));
  });

  it("shows a backend field error inline (400 on the domain)", async () => {
    mocks.create.mockRejectedValue(
      new BackendError(400, "validation", "A free-mail domain can't be a company domain.", {
        field: "domain",
      }),
    );
    await renderDialog();
    type("Name", "Mailers");
    type("Domain", "gmail.com");
    submit();
    expect(await screen.findByText("A free-mail domain can't be a company domain.")).toBeTruthy();
  });
});
