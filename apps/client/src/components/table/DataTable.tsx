import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";

import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { TableSkeleton } from "../ui/Skeleton";

/**
 * One column of a {@link DataTable}.
 *
 * `sortValue` doubles as the "this column is sortable" switch and as the value
 * the sort compares: a cell that shows a formatted peso amount still sorts on the
 * underlying integer centavos.
 */
export interface TableColumn<TData> {
  id: string;
  header: string;
  /** When set, the header becomes a sort control and the column sorts on this value. */
  sortValue?: (row: TData) => string | number;
  align?: "left" | "right";
  headerClassName?: string;
  cellClassName?: string;
  cell: (row: TData) => ReactNode;
}

/** Server-side pagination state, owned by the page and driven through the API. */
export interface TablePaginationProps {
  page: number;
  pageSize: number;
  total: number;
  /** The word for one record, so the count reads "1 batch" and "12 batches". */
  rowNoun: string;
  /** Overrides the naive "+s" plural for a noun like "batch". */
  rowNounPlural?: string;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  pageSizeOptions?: readonly number[];
}

export interface DataTableProps<TData> {
  columns: TableColumn<TData>[];
  data: TData[];
  /** A stable identity per row; without one React falls back to the row index. */
  getRowId?: (row: TData) => string;
  isLoading?: boolean;
  /** Shown when the request succeeded but matched no records. */
  emptyState?: ReactNode;
  /** The default empty state's wording when no custom one is supplied. */
  emptyTitle?: string;
  emptyDescription?: string;
  /** Omit to render no footer — for endpoints that do not page yet. */
  pagination?: TablePaginationProps;
}

const DEFAULT_EMPTY_TITLE = "Nothing to show yet";

/**
 * The shared operational table (spec S7-4).
 *
 * Every list screen renders through this component so the four behaviours the
 * audit found missing are defined once: a sticky header, a sort affordance on
 * sortable columns, an honest empty state, and a pagination footer. TanStack Table
 * (spec S11-1) supplies the column model and the sorting; it does not fetch or
 * page — the page owns the request so the table never renders more than the
 * server sent.
 *
 * The scroll region has a height cap on purpose. A `position: sticky` header only
 * sticks to its nearest scroll container, and the card around a table clips its
 * overflow, so the table needs its own scrollport for the header to stay put while
 * the rows move. Print resets all of it (see `styles.css`): on paper the header is
 * a static row that repeats on every page.
 */
export function DataTable<TData>({
  columns,
  data,
  getRowId,
  isLoading = false,
  emptyState,
  emptyTitle = DEFAULT_EMPTY_TITLE,
  emptyDescription,
  pagination,
}: DataTableProps<TData>): ReactNode {
  const [sorting, setSorting] = useState<SortingState>([]);

  // The page describes columns once; TanStack wants a `ColumnDef` per column. The
  // alignment and cell classes travel in a lookup rather than in TanStack's `meta`,
  // so the page-facing `TableColumn` stays the single description of a column.
  const columnStyles = useMemo(
    () => new Map(columns.map((column) => [column.id, column])),
    [columns]
  );

  const columnDefs = useMemo<ColumnDef<TData>[]>(
    () =>
      columns.map((column) => ({
        id: column.id,
        header: column.header,
        enableSorting: column.sortValue !== undefined,
        accessorFn: (row: TData) => (column.sortValue === undefined ? "" : column.sortValue(row)),
        cell: ({ row }) => column.cell(row.original),
      })),
    [columns]
  );

  const table = useReactTable({
    data,
    columns: columnDefs,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    ...(getRowId === undefined ? {} : { getRowId: (row: TData) => getRowId(row) }),
  });

  if (isLoading) {
    return <TableSkeleton rows={6} columns={columns.length} />;
  }

  if (data.length === 0) {
    return (
      <div className="p-6">
        {emptyState ?? <EmptyState title={emptyTitle} description={emptyDescription} />}
      </div>
    );
  }

  return (
    <div>
      <div className="data-table-scroll max-h-[72vh] overflow-auto">
        <table className="data-table w-full text-left text-sm sm:text-base">
          <thead className="text-content-secondary">
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const column = columnStyles.get(header.column.id);
                  const isRightAligned = column?.align === "right";
                  const sorted = header.column.getIsSorted();

                  return (
                    <th
                      key={header.id}
                      scope="col"
                      aria-sort={
                        sorted === "asc"
                          ? "ascending"
                          : sorted === "desc"
                            ? "descending"
                            : "none"
                      }
                      className={`sticky top-0 z-10 border-b border-line bg-canvas/95 backdrop-blur-xs px-5 py-3.5 text-xs font-semibold uppercase tracking-wider ${
                        isRightAligned ? "text-right" : "text-left"
                      } ${column?.headerClassName ?? ""}`}
                    >
                      {header.isPlaceholder ? null : header.column.getCanSort() ? (
                        <button
                          type="button"
                          onClick={(event) => header.column.getToggleSortingHandler()?.(event)}
                          aria-label={`Sort by ${column?.header ?? ""}`}
                          title={`Sort by ${column?.header ?? ""}`}
                          className={`inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 hover:bg-black/5 hover:text-content-primary transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none ${
                            isRightAligned ? "flex-row-reverse" : ""
                          }`}
                        >
                          <span>{flexRender(header.column.columnDef.header, header.getContext())}</span>
                          <SortIcon direction={sorted} />
                        </button>
                      ) : (
                        flexRender(header.column.columnDef.header, header.getContext())
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr
                key={row.id}
                className="border-t border-line/80 transition-colors duration-150 hover:bg-accent/[0.04]"
              >
                {row.getVisibleCells().map((cell) => {
                  const column = columnStyles.get(cell.column.id);
                  return (
                    <td
                      key={cell.id}
                      className={`px-5 py-3.5 ${column?.align === "right" ? "text-right" : ""} ${
                        column?.cellClassName ?? ""
                      }`}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {pagination !== undefined && <TablePagination {...pagination} />}
    </div>
  );
}

/** The arrow that shows which way a column is sorted. Decorative, hidden in print. */
function SortIcon({ direction }: { direction: false | "asc" | "desc" }): ReactNode {
  const className = "data-table-sort-icon h-3.5 w-3.5 shrink-0";

  if (direction === "asc") {
    return <ArrowUp className={className} aria-hidden="true" />;
  }
  if (direction === "desc") {
    return <ArrowDown className={className} aria-hidden="true" />;
  }
  return <ChevronsUpDown className={`${className} text-content-secondary/60`} aria-hidden="true" />;
}

const DEFAULT_PAGE_SIZE_OPTIONS = [20, 50, 100] as const;

/**
 * The pagination footer: a result count, a page-size control and previous/next.
 * It never pages on its own — every control reports the page the operator asked
 * for and the page turns that into a request.
 */
export function TablePagination({
  page,
  pageSize,
  total,
  rowNoun,
  rowNounPlural,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = DEFAULT_PAGE_SIZE_OPTIONS,
}: TablePaginationProps): ReactNode {
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const noun = total === 1 ? rowNoun : (rowNounPlural ?? `${rowNoun}s`);

  return (
    <div className="data-table-pagination flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3 text-sm text-content-secondary print:hidden">
      <span>
        {total} {noun}
      </span>

      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2">
          <span>Rows per page</span>
          <select
            value={pageSize}
            onChange={(event) => onPageSizeChange(Number.parseInt(event.target.value, 10))}
            className="h-8 rounded-lg border border-line-strong bg-surface px-2 text-sm text-content-primary focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
          >
            {pageSizeOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        <Button
          variant="outline"
          size="sm"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          Previous
        </Button>
        <span className="tabular-nums">
          Page {page} of {lastPage}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= lastPage}
          onClick={() => onPageChange(page + 1)}
        >
          Next
        </Button>
      </div>
    </div>
  );
}
