import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import {
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  PAYMENT_STATUSES,
  PAYMENT_STATUS_LABELS,
  type PaymentMethod,
  type PaymentStatus,
} from "@bcis/shared";
import {
  extractApiErrorMessage,
  listPayments,
  type ListPaymentFilters,
  type PaymentSummary,
} from "../lib/api-client";
import { formatCentavos, formatDateOnly } from "../lib/format";
import { AppShell } from "../components/layout/AppShell";
import { DataTable, type TableColumn } from "../components/table/DataTable";
import { Badge, type BadgeVariant } from "../components/ui/Badge";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { ErrorBanner } from "../components/ui/ErrorBanner";

const STATUS_BADGE_VARIANTS = {
  pending_verification: "info",
  posted: "success",
  reversed: "danger",
  rejected: "neutral",
} satisfies Record<PaymentStatus, BadgeVariant>;

/** The page sizes the list offers. The server caps one request at 200 rows. */
const PAYMENT_PAGE_SIZE_OPTIONS = [20, 50, 100] as const;

/** The page size the list opens with. Matches the server's own default. */
const DEFAULT_PAYMENT_PAGE_SIZE = 50;

// Sorting runs on the loaded page: the payments endpoint takes no sort parameter,
// so the table never claims a global order it cannot guarantee.
const PAYMENT_COLUMNS: TableColumn<PaymentSummary>[] = [
  {
    id: "receiptNumber",
    header: "Receipt #",
    sortValue: (payment) => payment.receiptNumber,
    cell: (payment) => (
      <Link
        to={`/payments/${payment.id}`}
        className="font-mono text-sm text-accent underline-offset-4 hover:underline"
      >
        {payment.receiptNumber}
      </Link>
    ),
  },
  {
    id: "paymentDate",
    header: "Date",
    cellClassName: "text-content-secondary",
    sortValue: (payment) => payment.paymentDate,
    cell: (payment) => formatDateOnly(payment.paymentDate),
  },
  {
    id: "subscriberName",
    header: "Subscriber",
    cellClassName: "text-content-primary",
    sortValue: (payment) => payment.subscriberName,
    cell: (payment) => payment.subscriberName,
  },
  {
    id: "serviceAccountNumber",
    header: "Service",
    cellClassName: "font-mono text-xs text-content-secondary",
    sortValue: (payment) => payment.serviceAccountNumber,
    cell: (payment) => payment.serviceAccountNumber,
  },
  {
    id: "paymentMethod",
    header: "Method",
    cellClassName: "text-content-primary",
    sortValue: (payment) => payment.paymentMethod,
    cell: (payment) => PAYMENT_METHOD_LABELS[payment.paymentMethod],
  },
  {
    id: "amountCentavos",
    header: "Amount",
    align: "right",
    cellClassName: "font-medium tabular-nums",
    sortValue: (payment) => payment.amountCentavos,
    cell: (payment) => formatCentavos(payment.amountCentavos),
  },
  {
    id: "status",
    header: "Status",
    sortValue: (payment) => payment.status,
    cell: (payment) => (
      <Badge variant={STATUS_BADGE_VARIANTS[payment.status]} size="sm">
        {PAYMENT_STATUS_LABELS[payment.status]}
      </Badge>
    ),
  },
  {
    id: "postedByName",
    header: "Posted By",
    cellClassName: "text-content-secondary",
    sortValue: (payment) => payment.postedByName,
    cell: (payment) => payment.postedByName,
  },
];

/** Payment history with the filters the spec calls for: date range, method, status. */
export function PaymentHistoryPage(): ReactNode {
  const navigate = useNavigate();
  const [filters, setFilters] = useState<ListPaymentFilters>({});
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAYMENT_PAGE_SIZE);
  const [total, setTotal] = useState(0);
  const [payments, setPayments] = useState<PaymentSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const loadPayments = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      // The server pages the endpoint (S8-1): it returns one page plus `total`, so
      // the screen shows exactly the rows the server sent and asks for the next
      // page instead of fetching everything and slicing it here.
      const response = await listPayments({ ...filters, page, pageSize });
      setPayments(response.items);
      setTotal(response.total);
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  }, [filters, page, pageSize]);

  useEffect(() => {
    void loadPayments();
  }, [loadPayments]);

  /** Applies one filter change and returns to the first page, since the set changed. */
  function applyFilter(patch: Partial<ListPaymentFilters>): void {
    setFilters((current) => ({ ...current, ...patch }));
    setPage(1);
  }

  const fieldClass =
    "h-9 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

  return (
    <AppShell
      pageTitle="Payment History"
      pageDescription="Every posted payment stays here, including reversed ones"
      headerActions={
        <Link
          to="/payments/new"
          className="inline-flex h-9 items-center rounded-lg border border-line-strong bg-surface px-3.5 text-sm font-medium text-content-primary transition-colors hover:bg-canvas"
        >
          Post payment
        </Link>
      }
    >
      <div className="space-y-5">
        <Card className="p-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-content-secondary">From</span>
              <input
                type="date"
                value={filters.dateFrom ?? ""}
                onChange={(event) => applyFilter({ dateFrom: event.target.value || undefined })}
                className={fieldClass}
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-content-secondary">To</span>
              <input
                type="date"
                value={filters.dateTo ?? ""}
                onChange={(event) => applyFilter({ dateTo: event.target.value || undefined })}
                className={fieldClass}
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-content-secondary">Method</span>
              <select
                value={filters.method ?? ""}
                onChange={(event) =>
                  applyFilter({
                    method: (event.target.value || undefined) as PaymentMethod | undefined,
                  })
                }
                className={fieldClass}
              >
                <option value="">All methods</option>
                {PAYMENT_METHODS.map((method) => (
                  <option key={method} value={method}>
                    {PAYMENT_METHOD_LABELS[method]}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-content-secondary">Status</span>
              <select
                value={filters.status ?? ""}
                onChange={(event) =>
                  applyFilter({
                    status: (event.target.value || undefined) as PaymentStatus | undefined,
                  })
                }
                className={fieldClass}
              >
                <option value="">All statuses</option>
                {PAYMENT_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {PAYMENT_STATUS_LABELS[status]}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </Card>

        {errorMessage !== null && <ErrorBanner message={errorMessage} onRetry={() => void loadPayments()} />}

        <Card>
          <DataTable
            columns={PAYMENT_COLUMNS}
            data={payments}
            getRowId={(payment) => payment.id}
            isLoading={isLoading}
            pagination={{
              page,
              pageSize,
              total,
              rowNoun: "payment",
              onPageChange: setPage,
              onPageSizeChange: (size) => {
                setPageSize(size);
                setPage(1);
              },
              pageSizeOptions: PAYMENT_PAGE_SIZE_OPTIONS,
            }}
            emptyState={
              <EmptyState
                title="No payments match these filters"
                description="Widen the date range or clear the method and status filters, or post a payment to see it here."
                actionLabel="Post a payment"
                onAction={() => navigate("/payments/new")}
              />
            }
          />
        </Card>
      </div>
    </AppShell>
  );
}