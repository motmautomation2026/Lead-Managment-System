import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FilterBar } from "@/components/crm/filter-bar";
import { filterSummary, type FilterDef, type FilterValues } from "@/components/crm/filter-model";

const owner: FilterDef = {
  id: "ownerId",
  label: "Owner",
  type: "multi",
  options: [
    { value: "me", label: "Me" },
    { value: "none", label: "No owner" },
  ],
};
const openDeal: FilterDef = { id: "hasOpenDeal", label: "Open deal", type: "boolean" };
const amount: FilterDef = { id: "amount", label: "Amount", type: "numberRange" };
const created: FilterDef = { id: "created", label: "Created", type: "dateRange" };

function Harness({ onChange }: { onChange: (v: FilterValues) => void }) {
  const [values, setValues] = useState<FilterValues>({});
  return (
    <FilterBar
      filters={[owner, openDeal]}
      moreFilters={[amount]}
      values={values}
      onChange={(v) => {
        onChange(v);
        setValues(v);
      }}
    />
  );
}

afterEach(cleanup);

describe("FilterBar", () => {
  it("applies a multi-select chip and clears it", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /Owner/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Me" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "No owner" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onChange).toHaveBeenLastCalledWith({ ownerId: ["me", "none"] });
    expect(screen.getByRole("button", { name: /Owner: Me \+1/ })).toBeTruthy();
    expect(screen.getByText("1 active")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Owner: Me/ }));
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onChange).toHaveBeenLastCalledWith({ ownerId: undefined });
    expect(screen.queryByText(/active$/)).toBeNull();
  });

  it("applies a boolean chip; Clear all resets everything", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /Open deal/ }));
    fireEvent.click(screen.getByRole("radio", { name: "No" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onChange).toHaveBeenLastCalledWith({ hasOpenDeal: false });
    expect(screen.getByRole("button", { name: /Open deal: No/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(onChange).toHaveBeenLastCalledWith({});
  });

  it("cancelling a chip keeps the applied value", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /Owner/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Me" }));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("More filters opens a sheet and applies its draft", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "More filters" }));
    const sheet = screen.getByRole("dialog", { name: "More filters" });
    fireEvent.change(within(sheet).getByLabelText("Min"), { target: { value: "50000" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Apply filters" }));
    expect(onChange).toHaveBeenLastCalledWith({ amount: { min: 50000 } });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("filterSummary", () => {
  it("summarises each type", () => {
    expect(filterSummary(owner, ["none"])).toBe("No owner");
    expect(filterSummary(openDeal, true)).toBe("Yes");
    expect(filterSummary(amount, { min: 1, max: 9 })).toBe("1 – 9");
    expect(filterSummary(amount, { max: 9 })).toBe("≤ 9");
    expect(filterSummary(created, { from: "2026-10-01" })).toBe("from 2026-10-01");
    expect(filterSummary(owner, [])).toBeNull();
  });
});
