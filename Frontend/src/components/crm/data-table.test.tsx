import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DataTable, type DataTableColumn, type SortState } from "@/components/crm/data-table";
import { ThemeProvider } from "@/app/theme-provider";

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

type Props = Partial<Parameters<typeof DataTable<Row>>[0]> & { wrap?: boolean };

function renderTable({ wrap, ...props }: Props = {}) {
  const table = (
    <DataTable<Row>
      label="Contacts"
      data={rows(3)}
      columns={columns}
      getRowId={(r) => r.id}
      getRowHref={(r) => `/leads/${r.id}`}
      {...props}
    />
  );
  return render(wrap ? <ThemeProvider>{table}</ThemeProvider> : table);
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

  it("j / k move between rows (also from outside the list), x selects, Enter opens", async () => {
    const onRowClick = vi.fn();
    const onSelect = vi.fn();
    render(
      <div>
        <input aria-label="Search" />
        <SelectableTableWithOpen onSelect={onSelect} onRowClick={onRowClick} />
      </div>,
    );
    // j from the page body steps into the list; typing in a field never moves it.
    screen.getByLabelText("Search").focus();
    fireEvent.keyDown(screen.getByLabelText("Search"), { key: "j" });
    expect(document.activeElement).toBe(screen.getByLabelText("Search"));
    fireEvent.keyDown(document.body, { key: "j" });
    await waitFor(() => expect(document.activeElement).toBe(bodyRows()[0]));
    fireEvent.keyDown(bodyRows()[0]!, { key: "j" });
    await waitFor(() => expect(document.activeElement).toBe(bodyRows()[1]));
    fireEvent.keyDown(bodyRows()[1]!, { key: "k" });
    await waitFor(() => expect(document.activeElement).toBe(bodyRows()[0]));
    fireEvent.keyDown(bodyRows()[0]!, { key: "x" });
    expect(onSelect).toHaveBeenLastCalledWith(["1"]);
    fireEvent.keyDown(bodyRows()[0]!, { key: "Enter" });
    expect(onRowClick).toHaveBeenCalledWith(expect.objectContaining({ id: "1" }));
  });

  it("offers rows per page and density, and keeps row actions out of the row click", () => {
    const onPageSizeChange = vi.fn();
    const onRowClick = vi.fn();
    const action = vi.fn();
    renderTable({
      wrap: true,
      pageSize: 50,
      onPageSizeChange,
      onColumnsChange: vi.fn(),
      onRowClick,
      rowActions: (r) => (
        <button type="button" onClick={() => action(r.id)}>
          Actions for {r.name}
        </button>
      ),
    });
    fireEvent.keyDown(screen.getByLabelText("Rows per page"), { key: "Enter" });
    fireEvent.click(screen.getByRole("option", { name: "25 per page" }));
    expect(onPageSizeChange).toHaveBeenCalledWith(25);

    fireEvent.keyDown(screen.getByRole("button", { name: "Columns" }), { key: "Enter" });
    expect(screen.getByRole("menuitemradio", { name: "Comfortable" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Compact" }));
    expect(document.documentElement.dataset["density"]).toBe("compact");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });

    fireEvent.click(screen.getByRole("button", { name: "Actions for Contact 2" }));
    expect(action).toHaveBeenCalledWith("2");
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("shows cards instead of a table on phones, with a sort picker", () => {
    vi.stubGlobal(
      "matchMedia",
      (query: string) =>
        ({
          matches: query.includes("max-width"),
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        }) as unknown as MediaQueryList,
    );
    const onRowClick = vi.fn();
    renderTable({
      onRowClick,
      onSortChange: vi.fn(),
      sort: { field: "name", dir: "asc" },
      onColumnsChange: vi.fn(),
    });
    expect(screen.queryByRole("table")).toBeNull();
    const list = screen.getByRole("list", { name: "Contacts" });
    const cards = within(list).getAllByRole("listitem");
    expect(cards).toHaveLength(3);
    expect(cards[0]).toHaveTextContent("Contact 1");
    expect(cards[0]).toHaveTextContent("CityPune");
    expect(screen.getByLabelText("Sort by")).toBeInTheDocument();
    fireEvent.click(cards[1]!);
    expect(onRowClick).toHaveBeenCalledWith(expect.objectContaining({ id: "2" }));
  });
});

function SelectableTableWithOpen({
  onSelect,
  onRowClick,
}: {
  onSelect: (ids: string[]) => void;
  onRowClick: (row: Row) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  return (
    <DataTable<Row>
      label="Contacts"
      data={rows(3)}
      columns={columns}
      getRowId={(r) => r.id}
      onRowClick={onRowClick}
      selectedIds={selected}
      onSelectionChange={(ids) => {
        onSelect(ids);
        setSelected(ids);
      }}
    />
  );
}
