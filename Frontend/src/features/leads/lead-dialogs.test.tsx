import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/store", () => ({ useSession: () => ({ users: [] }) }));

import { DiscardDialog, LostReasonDialog } from "./lead-dialogs";
import type { LeadLossReason } from "@/types";

afterEach(cleanup);

async function pick(combobox: string, option: string) {
  fireEvent.keyDown(screen.getByRole("combobox", { name: combobox }), { key: "Enter" });
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

describe("DiscardDialog (LL-3 rule 7)", () => {
  it("needs a reason; Other also needs the text", async () => {
    const onConfirm = vi.fn();
    render(<DiscardDialog open onOpenChange={vi.fn()} onConfirm={onConfirm} />);
    const discard = screen.getByRole("button", { name: "Discard" });
    expect(discard).toBeDisabled();
    await pick("Discard reason", "Other");
    expect(discard).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Why (required)"), { target: { value: "Test entry" } });
    fireEvent.click(discard);
    expect(onConfirm).toHaveBeenCalledWith("other", "Test entry");
  });

  it("a listed reason is enough", async () => {
    const onConfirm = vi.fn();
    render(<DiscardDialog open onOpenChange={vi.fn()} onConfirm={onConfirm} />);
    await pick("Discard reason", "Not A Sales Lead");
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(onConfirm).toHaveBeenCalledWith("not_a_sales_lead", "");
  });
});

describe("LostReasonDialog (LL-3 rule 4/6)", () => {
  function Harness({ onConfirm }: { onConfirm: () => void }) {
    const [reason, setReason] = useState<LeadLossReason | "">("");
    const [details, setDetails] = useState({ competitorName: "", projectDate: "" });
    return (
      <LostReasonDialog
        open
        lossReason={reason}
        onLossReason={setReason}
        notes=""
        onNotes={vi.fn()}
        details={details}
        onDetails={setDetails}
        onOpenChange={vi.fn()}
        onConfirm={onConfirm}
      />
    );
  }
  it("offers the LL-3 reasons; Postponed needs the project date; Competitor asks for the name", async () => {
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    const options = (await screen.findAllByRole("option")).map((o) => o.textContent);
    expect(options).toEqual([
      "Price / Budget",
      "No Requirement",
      "Existing Supplier",
      "Competitor Selected",
      "No Response",
      "Project Postponed",
      "Other",
    ]);
    fireEvent.click(screen.getByRole("option", { name: "Project Postponed" }));
    const confirm = screen.getByRole("button", { name: "Confirm" });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Project date (required)"), {
      target: { value: "2027-03-01" },
    });
    expect(confirm).toBeEnabled();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "Competitor Selected" }));
    expect(screen.getByLabelText("Competitor name (optional)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onConfirm).toHaveBeenCalled();
  });
});
