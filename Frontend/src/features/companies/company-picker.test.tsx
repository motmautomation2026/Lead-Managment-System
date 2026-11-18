import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  get: vi.fn(),
  toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/store/workspace-context", () => ({
  useWorkspace: () => ({ currentWorkspaceId: "ws-1" }),
}));
vi.mock("@/lib/backend-client", () => ({
  BackendError: class BackendError extends Error {
    constructor(
      public status: number,
      public code: string,
      message: string,
      public details?: unknown,
    ) {
      super(message);
    }
  },
  backend: { companies: { list: mocks.list, create: mocks.create, get: mocks.get } },
}));

import { BackendError } from "@/lib/backend-client";
import { CompanyPicker } from "./company-picker";

const company = (id: string, name: string, domain: string | null = null) => ({ id, name, domain });

function renderPicker(props: Partial<Parameters<typeof CompanyPicker>[0]> = {}) {
  const onChange = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <CompanyPicker value={null} onChange={onChange} {...props} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: props.label ?? "Company" }));
  const input = screen.getByLabelText("Search companies");
  return { onChange, input };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CompanyPicker", () => {
  it("debounces: one request for the settled text, none under 2 characters", async () => {
    mocks.list.mockResolvedValue({ data: [company("c1", "Acme", "acme.in")], nextCursor: null });
    const { input } = renderPicker();
    fireEvent.change(input, { target: { value: "a" } });
    expect(screen.getByText("Type at least 2 characters.")).toBeTruthy();
    fireEvent.change(input, { target: { value: "ac" } });
    fireEvent.change(input, { target: { value: "acm" } });
    expect(await screen.findByText("Acme")).toBeTruthy();
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.list.mock.calls[0]![0]).toEqual({ q: "acm", limit: 5 });
  });

  it("keyboard: ↓ then Enter picks the second result", async () => {
    mocks.list.mockResolvedValue({
      data: [company("c1", "Acme"), company("c2", "Acme Steel")],
      nextCursor: null,
    });
    const { input, onChange } = renderPicker();
    fireEvent.change(input, { target: { value: "acme" } });
    await screen.findByText("Acme Steel");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith({ id: "c2", name: "Acme Steel" });
  });

  it("excludes ids and offers no create option without allowCreate", async () => {
    mocks.list.mockResolvedValue({ data: [company("c1", "Acme")], nextCursor: null });
    const { input } = renderPicker({ excludeIds: ["c1"] });
    fireEvent.change(input, { target: { value: "acme" } });
    expect(await screen.findByText("No companies match.")).toBeTruthy();
    expect(screen.queryByText(/Create company/)).toBeNull();
  });

  it("creates a company from the typed text", async () => {
    mocks.list.mockResolvedValue({ data: [company("c1", "Acme")], nextCursor: null });
    mocks.create.mockResolvedValue({ id: "c9", name: "Acme Labs" });
    const { input, onChange } = renderPicker({ allowCreate: true });
    fireEvent.change(input, { target: { value: "Acme Labs" } });
    fireEvent.click(await screen.findByText("Create company “Acme Labs”"));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ id: "c9", name: "Acme Labs" }));
    expect(mocks.create).toHaveBeenCalledWith({ name: "Acme Labs" });
  });

  it("an exact match hides the create option; a 409 picks the existing company", async () => {
    mocks.list.mockResolvedValueOnce({ data: [company("c1", "Acme")], nextCursor: null });
    const { input, onChange } = renderPicker({ allowCreate: true });
    fireEvent.change(input, { target: { value: "acme" } });
    await screen.findByText("Acme");
    expect(screen.queryByText(/Create company/)).toBeNull();

    mocks.list.mockResolvedValue({ data: [], nextCursor: null });
    mocks.create.mockRejectedValue(
      new BackendError(409, "conflict", "exists", { companyId: "c1" }),
    );
    mocks.get.mockResolvedValue({ id: "c1", name: "Acme" });
    fireEvent.change(input, { target: { value: "ACME Pvt Ltd" } });
    fireEvent.click(await screen.findByText("Create company “ACME Pvt Ltd”"));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ id: "c1", name: "Acme" }));
    expect(mocks.toast.info).toHaveBeenCalledWith('"Acme" already exists; picked it.');
  });
});
