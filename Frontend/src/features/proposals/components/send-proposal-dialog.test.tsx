import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock("@/store", () => ({
  messageFromError: (err: unknown) => String(err),
  useAutomations: () => ({ templates: [] }),
}));

import { SendProposalDialog } from "./send-proposal-dialog";

afterEach(cleanup);

describe("SendProposalDialog file row", () => {
  it("truncates a long file name and keeps the size and Remove visible", () => {
    render(<SendProposalDialog leadId="lead-1" open onOpenChange={() => {}} onSend={vi.fn()} />);
    const name = `${"very-long-proposal-document-name-".repeat(6)}final.pdf`;
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    fireEvent.change(input!, { target: { files: [new File(["x"], name)] } });

    const nameEl = screen.getByText(name);
    expect(nameEl).toHaveClass("min-w-0", "flex-1", "truncate");
    expect(nameEl).toHaveAttribute("title", name);
    expect(screen.getByText("(1 B)")).toHaveClass("shrink-0");
    const remove = screen.getByRole("button", { name: "Remove" });
    expect(remove).toBeVisible();
    expect(remove).toHaveClass("shrink-0");
    // The dialog's single column is minmax(0, 1fr), so the row can't widen the dialog.
    expect(screen.getByRole("dialog")).toHaveClass("grid-cols-1");
  });
});

describe("SendProposalDialog valid until (LL-3)", () => {
  it("an optional date; empty means 30 days after sending", () => {
    render(<SendProposalDialog leadId="lead-1" open onOpenChange={() => {}} onSend={vi.fn()} />);
    const field = screen.getByLabelText("Valid until");
    expect(field).toHaveAttribute("type", "date");
    expect(field).toHaveValue("");
    expect(screen.getByText("Empty = 30 days after sending.")).toBeTruthy();
  });
});
