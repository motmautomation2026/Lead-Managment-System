import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("@/store/workspace-context", () => ({
  useWorkspace: () => ({ currentWorkspaceId: "ws-1" }),
}));
vi.mock("@/lib/backend-client", () => ({
  BackendError: class BackendError extends Error {},
  backend: { contacts: { list: mocks.list } },
}));

import { ContactPicker } from "./contact-picker";

const contact = (id: string, name: string, company: string | null = null) => ({
  id,
  name,
  email: `${id}@example.com`,
  company: company ? { id: `co-${id}`, name: company } : null,
});

function renderPicker(props: Partial<Parameters<typeof ContactPicker>[0]> = {}) {
  const onChange = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ContactPicker value={null} onChange={onChange} {...props} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Contact" }));
  return { onChange, input: screen.getByLabelText("Search contacts") };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ContactPicker", () => {
  it("debounces: one request for the settled text, none under 2 characters", async () => {
    mocks.list.mockResolvedValue({ data: [contact("l1", "Asha Rao", "Acme")], nextCursor: null });
    const { input } = renderPicker();
    fireEvent.change(input, { target: { value: "a" } });
    expect(screen.getByText("Type at least 2 characters.")).toBeTruthy();
    fireEvent.change(input, { target: { value: "as" } });
    fireEvent.change(input, { target: { value: "ash" } });
    expect(await screen.findByText("Asha Rao")).toBeTruthy();
    expect(screen.getByText("Acme")).toBeTruthy();
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.list.mock.calls[0]![0]).toEqual({
      q: "ash",
      companyId: undefined,
      sort: "name:asc",
      limit: 8,
    });
  });

  it("keyboard: ↓ then Enter picks the second result", async () => {
    mocks.list.mockResolvedValue({
      data: [contact("l1", "Asha Rao"), contact("l2", "Ashok Iyer")],
      nextCursor: null,
    });
    const { input, onChange } = renderPicker();
    fireEvent.change(input, { target: { value: "ash" } });
    await screen.findByText("Ashok Iyer");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith({ id: "l2", name: "Ashok Iyer" });
  });

  it("companyId: lists that company's contacts before typing and filters within it", async () => {
    mocks.list.mockResolvedValue({ data: [contact("l1", "Asha Rao")], nextCursor: null });
    const { input } = renderPicker({ companyId: "co-1" });
    expect(await screen.findByText("Asha Rao")).toBeTruthy();
    expect(mocks.list.mock.calls[0]![0]).toEqual({
      q: undefined,
      companyId: "co-1",
      sort: "name:asc",
      limit: 20,
    });
    mocks.list.mockResolvedValue({ data: [], nextCursor: null });
    fireEvent.change(input, { target: { value: "zed" } });
    expect(await screen.findByText("No contacts match.")).toBeTruthy();
    expect(mocks.list.mock.calls.at(-1)![0]).toMatchObject({ q: "zed", companyId: "co-1" });
  });
});
