import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  document: vi.fn(),
  toast: { error: vi.fn() },
}));

vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/lib/backend-client", () => ({ backend: { proposals: { document: mocks.document } } }));
vi.mock("@/store", () => ({
  messageFromError: (error: unknown) => (error instanceof Error ? error.message : "Failed"),
}));

import { ViewDocumentButton } from "./proposal-document";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ViewDocumentButton (C6a fix c)", () => {
  it("fetches the signed URL on click and opens it in a new tab", async () => {
    const tab = { opener: {}, location: { href: "" }, close: vi.fn() };
    const open = vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    mocks.document.mockResolvedValue({ url: "https://files.example/signed?token=x" });
    render(<ViewDocumentButton proposal={{ id: "p-1", title: "Quote", fileName: "quote.pdf" }} />);
    expect(mocks.document).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "View document of Quote" }));
    expect(open).toHaveBeenCalledWith("", "_blank");
    await waitFor(() => expect(tab.location.href).toBe("https://files.example/signed?token=x"));
    expect(mocks.document).toHaveBeenCalledWith("p-1");
    expect(tab.opener).toBeNull();
  });

  it("closes the tab and shows the error when the link fails; hidden without a file", async () => {
    const tab = { opener: {}, location: { href: "" }, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    mocks.document.mockRejectedValue(new Error("Proposal document not found."));
    const { rerender } = render(
      <ViewDocumentButton proposal={{ id: "p-1", title: "Quote", fileName: "quote.pdf" }} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "View document of Quote" }));
    await waitFor(() => expect(tab.close).toHaveBeenCalled());
    expect(mocks.toast.error).toHaveBeenCalledWith("Proposal document not found.");
    rerender(<ViewDocumentButton proposal={{ id: "p-2", title: "Draft" }} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
