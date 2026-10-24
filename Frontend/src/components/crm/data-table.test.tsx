import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DataTable, type DataTableColumn, type SortState } from "@/components/crm/data-table";

interface Row {
  id: string;
  name: string;
  city: string;
}

const rows = (n: number): Row[] =>
  Array.from({ length: n }, (_, i) => ({
    id: String(i + 1),
    name: `Contact ${i + 1}`,
    city: "Pune",
  }));

const columns: DataTableColumn<Row>[] = [
  { id: "name", header: "Name", cell: (r) => r.name, sortable: true, hideable: false },
  { id: "city", header: "City", cell: (r) => r.city },
];

type Props = Partial<Parameters<typeof DataTable<Row>>[0]>;

function renderTable(props: Props = {}) {
  return render(
    <DataTable<Row>
      label="Contacts"
      data={rows(3)}
      columns={columns}
      getRowId={(r) => r.id}
      getRowHref={(r) => `/leads/${r.id}`}
      {...props}
    />,
  );
}

function SelectableTable({ onSelect }: { onSelect: (ids: string[]) => void }) {
  const [selected, setSelected] = useState<string[]>([]);
  return (
    <DataTable<Row>
      label="Contacts"
      data={rows(3)}
      columns={columns}
      getRowId={(r) => r.id}
      selectedIds={selected}
      onSelectionChange={(ids) => {
        onSelect(ids);
        setSelected(ids);
      }}
      bulkActions={<button>Assign owner</button>}
    />
  );
}

const bodyRows = () => screen.getAllByRole("row").filter((r) => r.hasAttribute("data-row-index"));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("DataTable", () => {
  it("calls onSortChange with one field, toggling direction", () => {
    const onSortChange = vi.fn<(s: SortState) => void>();
    const { rerender } = renderTable({ onSortChange });
    fireEvent.click(screen.getByRole("button", { name: /Name/ }));
    expect(onSortChange).toHaveBeenLastCalledWith({ field: "name", dir: "asc" });

    rerender(
      <DataTable<Row>
        label="Contacts"
        data={rows(3)}
        columns={columns}
        getRowId={(r) => r.id}
        sort={{ field: "name", dir: "asc" }}
        onSortChange={onSortChange}
      />,
    );
    expect(screen.getByRole("columnheader", { name: /Name/ })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    fireEvent.click(screen.getByRole("button", { name: /Name/ }));
    expect(onSortChange).toHaveBeenLastCalledWith({ field: "name", dir: "desc" });
    // City is not sortable: no button.
    expect(screen.queryByRole("button", { name: /City/ })).toBeNull();
  });

  it("selects rows and shows the bulk bar with a clear action", () => {
    const onSelect = vi.fn();
    render(<SelectableTable onSelect={onSelect} />);
    fireEvent.click(screen.getAllByRole("checkbox", { name: "Select row" })[1]!);
    expect(onSelect).toHaveBeenLastCalledWith(["2"]);
    const bar = screen.getByRole("toolbar", { name: "Bulk actions" });
    expect(within(bar).getByText("1 selected")).toBeTruthy();
    expect(within(bar).getByText("Assign owner")).toBeTruthy();

    fireEvent.click(screen.getByRole("checkbox", { name: "Select all loaded rows" }));
    expect(onSelect).toHaveBeenLastCalledWith(["1", "2", "3"]);
    fireEvent.click(within(bar).getByRole("button", { name: "Clear selection" }));
    expect(onSelect).toHaveBeenLastCalledWith([]);
    expect(screen.queryByRole("toolbar", { name: "Bulk actions" })).toBeNull();
  });

  it("loads more by button and by infinite scroll", () => {
    let fire: ((entries: Array<{ isIntersecting: boolean }>) => void) | undefined;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(cb: typeof fire) {
          fire = cb;
        }
        observe() {}
        disconnect() {}
      },
    );
    const onLoadMore = vi.fn();
    renderTable({ hasNextPage: true, onLoadMore });
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    act(() => fire?.([{ isIntersecting: true }]));
    expect(onLoadMore).toHaveBeenCalledTimes(2);
  });

  it("hides Load more without a next page and disables it while fetching", () => {
    const { rerender } = renderTable({ hasNextPage: false, onLoadMore: vi.fn() });
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    rerender(
      <DataTable<Row>
        label="Contacts"
        data={rows(3)}
        columns={columns}
        getRowId={(r) => r.id}
        hasNextPage
        isFetchingNextPage
        onLoadMore={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Loading…" })).toBeDisabled();
  });

  it("shows skeleton, empty and error states", () => {
    const { rerender } = renderTable({ data: [], isLoading: true });
    expect(screen.getAllByTestId("skeleton-row")).toHaveLength(8);

    rerender(
      <DataTable<Row>
        label="Contacts"
        data={[]}
        columns={columns}
        getRowId={(r) => r.id}
        emptyState={<p>No contacts match</p>}
      />,
    );
    expect(screen.getByText("No contacts match")).toBeTruthy();

    const onRetry = vi.fn();
    rerender(
      <DataTable<Row>
        label="Contacts"
        data={[]}
        columns={columns}
        getRowId={(r) => r.id}
        error={new Error("Network down")}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText("Network down")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalled();
  });

  it("opens rows on click, and in a new tab on ctrl-click / middle-click", () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    const onRowClick = vi.fn();
    renderTable({ onRowClick });
    expect(screen.getByRole("link", { name: "Contact 1" })).toHaveAttribute("href", "/leads/1");

    fireEvent.click(screen.getAllByRole("cell", { name: "Pune" })[0]!);
    expect(onRowClick).toHaveBeenCalledWith(expect.objectContaining({ id: "1" }));

    fireEvent.click(screen.getAllByRole("cell", { name: "Pune" })[1]!, { ctrlKey: true });
    expect(open).toHaveBeenCalledWith("/leads/2", "_blank", "noopener");
    fireEvent(
      screen.getAllByRole("cell", { name: "Pune" })[2]!,
      new MouseEvent("auxclick", { bubbles: true, button: 1 }),
    );
    expect(open).toHaveBeenCalledWith("/leads/3", "_blank", "noopener");
    expect(onRowClick).toHaveBeenCalledTimes(1);
  });

  it("moves focus with arrows, opens with Enter and selects with Space", async () => {
    const onRowClick = vi.fn();
    const onSelectionChange = vi.fn();
    renderTable({ onRowClick, onSelectionChange, selectedIds: [] });
    const [first] = bodyRows();
    first!.focus();
    fireEvent.keyDown(first!, { key: "ArrowDown" });
    await waitFor(() => expect(bodyRows()[1]).toHaveFocus());
    fireEvent.keyDown(bodyRows()[1]!, { key: "Enter" });
    expect(onRowClick).toHaveBeenCalledWith(expect.objectContaining({ id: "2" }));
    fireEvent.keyDown(bodyRows()[1]!, { key: " " });
    expect(onSelectionChange).toHaveBeenCalledWith(["2"]);
    fireEvent.keyDown(bodyRows()[1]!, { key: "ArrowUp" });
    await waitFor(() => expect(bodyRows()[0]).toHaveFocus());
  });

  it("virtualises more than 200 rows", () => {
    renderTable({ data: rows(250) });
    expect(bodyRows().length).toBeLessThan(250);
    expect(screen.getByRole("table")).toHaveAttribute("aria-rowcount", "250");
  });

  it("keeps all rows in the DOM up to 200", () => {
    renderTable({ data: rows(200) });
    expect(bodyRows()).toHaveLength(200);
  });

  it("column picker reports the visible column ids", () => {
    const onColumnsChange = vi.fn();
    renderTable({ visibleColumns: ["name", "city"], onColumnsChange });
    fireEvent.keyDown(screen.getByRole("button", { name: "Columns" }), { key: "Enter" });
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "City" }));
    expect(onColumnsChange).toHaveBeenCalledWith(["name"]);
  });
});
