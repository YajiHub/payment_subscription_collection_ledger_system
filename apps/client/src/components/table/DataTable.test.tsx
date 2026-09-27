import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { DataTable, type TableColumn } from "./DataTable";

interface Row {
  id: string;
  name: string;
  amountCentavos: number;
}

const ROWS: Row[] = [
  { id: "1", name: "Charlie", amountCentavos: 300 },
  { id: "2", name: "Alice", amountCentavos: 100 },
  { id: "3", name: "Bob", amountCentavos: 200 },
];

const COLUMNS: TableColumn<Row>[] = [
  { id: "name", header: "Name", sortValue: (row) => row.name, cell: (row) => row.name },
  {
    id: "amount",
    header: "Amount",
    align: "right",
    sortValue: (row) => row.amountCentavos,
    cell: (row) => row.amountCentavos,
  },
  { id: "actions", header: "Actions", cell: () => "—" },
];

/** The body rows, in the order they are drawn. */
function renderedNames(): string[] {
  const body = screen.getAllByRole("rowgroup")[1];
  if (body === undefined) {
    return [];
  }
  return within(body)
    .getAllByRole("row")
    .map((row) => within(row).getAllByRole("cell")[0]?.textContent ?? "");
}

describe("DataTable", () => {
  it("renders one row per record with a sticky header", () => {
    render(<DataTable columns={COLUMNS} data={ROWS} getRowId={(row) => row.id} />);

    expect(renderedNames()).toEqual(["Charlie", "Alice", "Bob"]);
    expect(screen.getByRole("columnheader", { name: /name/i })).toHaveClass("sticky");
    expect(screen.getByRole("columnheader", { name: /amount/i })).toHaveClass("sticky");
  });

  it("does not render a sort control for a column without a sort value", () => {
    render(<DataTable columns={COLUMNS} data={ROWS} getRowId={(row) => row.id} />);

    const actionsHeader = screen.getByRole("columnheader", { name: "Actions" });
    expect(within(actionsHeader).queryByRole("button")).toBeNull();
  });

  it("sorts ascending then descending when a sortable header is toggled", async () => {
    const user = userEvent.setup();
    render(<DataTable columns={COLUMNS} data={ROWS} getRowId={(row) => row.id} />);

    await user.click(screen.getByRole("button", { name: /sort by name/i }));
    expect(renderedNames()).toEqual(["Alice", "Bob", "Charlie"]);
    expect(screen.getByRole("columnheader", { name: /name/i })).toHaveAttribute(
      "aria-sort",
      "ascending"
    );

    await user.click(screen.getByRole("button", { name: /sort by name/i }));
    expect(renderedNames()).toEqual(["Charlie", "Bob", "Alice"]);
    expect(screen.getByRole("columnheader", { name: /name/i })).toHaveAttribute(
      "aria-sort",
      "descending"
    );
  });

  it("shows the loading skeleton instead of rows while a request is in flight", () => {
    render(<DataTable columns={COLUMNS} data={[]} isLoading getRowId={(row) => row.id} />);

    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("row")).toBeNull();
  });

  it("shows the empty state when the request returned no records", () => {
    render(
      <DataTable
        columns={COLUMNS}
        data={[]}
        getRowId={(row) => row.id}
        emptyTitle="No subscribers match this search"
        emptyDescription="Try a different name or account number."
      />
    );

    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText("No subscribers match this search")).toBeInTheDocument();
    expect(screen.getByText("Try a different name or account number.")).toBeInTheDocument();
  });

  it("reports the total and asks the page for the next page", async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();
    const onPageSizeChange = vi.fn();

    render(
      <DataTable
        columns={COLUMNS}
        data={ROWS}
        getRowId={(row) => row.id}
        pagination={{
          page: 1,
          pageSize: 20,
          total: 45,
          rowNoun: "subscriber",
          onPageChange,
          onPageSizeChange,
        }}
      />
    );

    expect(screen.getByText(/^45 subscribers$/)).toBeInTheDocument();
    expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(onPageChange).toHaveBeenCalledWith(2);

    await user.selectOptions(screen.getByRole("combobox"), "50");
    expect(onPageSizeChange).toHaveBeenCalledWith(50);
  });

  it("disables Next on the last page and hides the footer in print", () => {
    render(
      <DataTable
        columns={COLUMNS}
        data={ROWS}
        getRowId={(row) => row.id}
        pagination={{
          page: 3,
          pageSize: 20,
          total: 45,
          rowNoun: "invoice",
          onPageChange: vi.fn(),
          onPageSizeChange: vi.fn(),
        }}
      />
    );

    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(screen.getByText(/45 invoices/).closest(".data-table-pagination")).toHaveClass(
      "print:hidden"
    );
  });
});
