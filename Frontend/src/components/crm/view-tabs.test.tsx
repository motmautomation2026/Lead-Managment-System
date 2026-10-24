import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ViewTabs } from "@/components/crm/view-tabs";

const views = Array.from({ length: 7 }, (_, i) => ({ id: `v${i}`, label: `View ${i}` }));

afterEach(cleanup);

describe("ViewTabs", () => {
  it("shows the first tabs, overflows the rest and keeps the active one visible", () => {
    const onChange = vi.fn();
    render(<ViewTabs views={views} activeId="v6" onChange={onChange} maxVisible={3} />);
    const tabs = screen.getAllByRole("tab").map((t) => t.textContent);
    expect(tabs).toEqual(["View 0", "View 1", "View 6"]);
    expect(screen.getByRole("tab", { name: "View 6" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: /More \(4\)/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "View 1" }));
    expect(onChange).toHaveBeenCalledWith("v1");
  });

  it("offers + to save the view only when wired", () => {
    const onSaveView = vi.fn();
    const { rerender } = render(<ViewTabs views={views} activeId="v0" onChange={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Save current view" })).toBeNull();
    rerender(<ViewTabs views={views} activeId="v0" onChange={vi.fn()} onSaveView={onSaveView} />);
    fireEvent.click(screen.getByRole("button", { name: "Save current view" }));
    expect(onSaveView).toHaveBeenCalled();
  });
});
