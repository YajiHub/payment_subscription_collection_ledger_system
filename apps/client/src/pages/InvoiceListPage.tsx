import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import {
  INVOICE_STATUSES,
  INVOICE_STATUS_LABELS,
  getMonthName,
  type InvoiceStatus,
} from "@bcis/shared";
import {
  extractApiErrorMessage,
  listInvoices,
  listSubscribers,
  type InvoiceSummary,
  type Subscriber,
} from "../lib/api-client";
import { formatCentavos, formatDateOnly } from "../lib/format";
import { AppShell } from "../components/layout/AppShell";
import { DataTable, type TableColumn } from "../components/table/DataTable";
import { Badge, type BadgeVariant } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { ErrorBanner } from "../components/ui/ErrorBanner";

const MONTH_NUMBERS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;

/**
 * How many subscribers the picker loads. The subscriber filter is a convenience
 * over a paged endpoint (`/api/subscribers` caps `pageSize` at 200), so it asks
 * for one bounded page rather than dumping every subscriber into the browser.
 */
const SUBSCRIBER_PICKER_PAGE_SIZE = 50;

// A single, exhaustive mapping from invoice status to its badge tone.
// `unpaid` is the canonical name of the state the old `posted` spelling meant
// (section 3.4); `credited` means fully settled by an advance credit.
const STATUS_BADGE_VARIANTS = {
  draft: "neutral",
  unpaid: "info",
  partially_paid: "warning",
  paid: "success",
  overdue: "danger",
  void: "neutral",
  credited: "success",
} satisfies Record<InvoiceStatus, BadgeVariant>;

/** A human label for the invoice's billing period, or a dash for one-off charges. */
function periodLabel(invoice: InvoiceSummary): string {
  if (invoice.billingPeriodYear === null || invoice.billingPeriodMonth === null) {
    return "—";
  }
  return `${getMonthName(invoice.billingPeriodMonth)} ${invoice.billingPeriodYear}`;
}

interface InvoiceTableProps {
  invoices: InvoiceSummary[];
  isLoading: boolean;
}

// Columns and cells for the shared table. Sorting runs on the loaded page: the
// invoices endpoint takes no sort parameter yet, so the table never claims a
// global order it cannot guarantee.
const INVOICE_COLUMNS: TableColumn<InvoiceSummary>[] = [
  {
    id: "invoiceNumber",
    header: "Invoice #",
    sortValue: (invoice) => invoice.invoiceNumber,
    cell: (invoice) => (
      <Link
        to={`/invoices/${invoice.id}`}
        className="font-mono text-sm text-accent underline-offset-4 hover:underline"
      >
        {invoice.invoiceNumber}
      </Link>
    ),
  },
  {
    id: "subscriberName",
    header: "Subscriber",
    cellClassName: "text-content-primary",
    sortValue: (invoice) => invoice.subscriberName,
    cell: (invoice) => invoice.subscriberName,
  },
  {
    id: "serviceAccountNumber",
    header: "Service",
    cellClassName: "font-mono text-xs text-content-secondary",
    sortValue: (invoice) => invoice.serviceAccountNumber,
    cell: (invoice) => invoice.serviceAccountNumber,
  },
  {
    id: "period",
    header: "Period",
    cellClassName: "text-content-primary",
    sortValue: (invoice) => periodLabel(invoice),
    cell: (invoice) => periodLabel(invoice),
  },
  {
    id: "totalAmountCentavos",
    header: "Amount",
    align: "right",
    cellClassName: "tabular-nums",
    sortValue: (invoice) => invoice.totalAmountCentavos,
    cell: (invoice) => formatCentavos(invoice.totalAmountCentavos),
  },
  {
    id: "paidAmountCentavos",
    header: "Paid",
    align: "right",
    cellClassName: "tabular-nums",
    sortValue: (invoice) => invoice.paidAmountCentavos,
    cell: (invoice) => formatCentavos(invoice.paidAmountCentavos),
  },
  {
    id: "remainingBalanceCentavos",
    header: "Balance",
    align: "right",
    cellClassName: "font-medium tabular-nums",
    sortValue: (invoice) => invoice.remainingBalanceCentavos,
    cell: (invoice) => formatCentavos(invoice.remainingBalanceCentavos),
  },
  {
    id: "status",
    header: "Status",
    sortValue: (invoice) => invoice.status,
    cell: (invoice) => (
      <Badge variant={STATUS_BADGE_VARIANTS[invoice.status]} size="sm">
        {INVOICE_STATUS_LABELS[invoice.status]}
      </Badge>
    ),
  },
  {
    id: "dueDate",
    header: "Due Date",
    cellClassName: "text-content-secondary",
    sortValue: (invoice) => invoice.dueDate,
    cell: (invoice) => formatDateOnly(invoice.dueDate),
  },
];

function InvoiceTable({ invoices, isLoading }: InvoiceTableProps): ReactNode {
  return (
    <DataTable
      columns={INVOICE_COLUMNS}
      data={invoices}
      getRowId={(invoice) => invoice.id}
      isLoading={isLoading}
      emptyState={
        <EmptyState
          title="No invoices match these filters"
          description="Try widening the status, month, or subscriber filters, or generate invoices from the billing run."
        />
      }
    />
  );
}

/**
 * Invoice list: filter by status, billing period, and subscriber, then open an
 * invoice's detail page. The subscriber filter lists the office's subscribers so a
 * clerk picks one instead of typing an opaque id.
 */
export function InvoiceListPage(): ReactNode {
  const [invoices, setInvoices] = useState<InvoiceSummary[]>([]);
  const [subscribers, setSubscribers] = useState<Subscriber[]>([]);
  const [statusFilter, setStatusFilter] = useState<InvoiceStatus | "">("");
  const [yearFilter, setYearFilter] = useState("");
  const [monthFilter, setMonthFilter] = useState("");
  const [subscriberFilter, setSubscriberFilter] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const loadInvoices = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      // Pagination dependency (spec S8-1): `/api/invoices` is being given
      // server-side `page`/`pageSize`/`total` support in the server work package.
      // Until that lands, `listInvoices` still returns the array it always did, so
      // this page shows what the contract returns and deliberately does NOT
      // paginate on the client — a client-only page would misrepresent the data.
      const items = await listInvoices({
        status: statusFilter === "" ? undefined : statusFilter,
        year: yearFilter.trim() === "" ? undefined : Number.parseInt(yearFilter, 10),
        month: monthFilter === "" ? undefined : Number.parseInt(monthFilter, 10),
        subscriberId: subscriberFilter === "" ? undefined : subscriberFilter,
      });
      setInvoices(items);
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  }, [statusFilter, yearFilter, monthFilter, subscriberFilter]);

  useEffect(() => {
    void loadInvoices();
  }, [loadInvoices]);

  useEffect(() => {
    async function loadSubscriberOptions(): Promise<void> {
      try {
        const page = await listSubscribers({ page: 1, pageSize: SUBSCRIBER_PICKER_PAGE_SIZE });
        setSubscribers(page.items);
      } catch {
        // The subscriber filter is a convenience; a failure here must not block the list.
      }
    }
    void loadSubscriberOptions();
  }, []);

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void loadInvoices();
  }

  const selectClass =
    "h-9 rounded-lg border border-line-strong bg-surface px-3 text-sm text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

  return (
    <AppShell
      pageTitle="Invoices"
      pageDescription="Every invoice the office has generated, newest first"
      headerActions={
        <Link
          to="/billing"
          className="inline-flex h-9 items-center rounded-lg border border-line-strong bg-surface px-3.5 text-sm font-medium text-content-primary transition-colors hover:bg-canvas"
        >
          Billing Dashboard
        </Link>
      }
    >
      <div className="space-y-5">
        <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
          <label className="space-y-1.5">
            <span className="block text-xs font-medium text-content-secondary">Status</span>
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as InvoiceStatus | "")}
              className={selectClass}
            >
              <option value="">All statuses</option>
              {INVOICE_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {INVOICE_STATUS_LABELS[status]}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-1.5">
            <span className="block text-xs font-medium text-content-secondary">Month</span>
            <select
              value={monthFilter}
              onChange={(event) => setMonthFilter(event.target.value)}
              className={selectClass}
            >
              <option value="">All months</option>
              {MONTH_NUMBERS.map((monthNumber) => (
                <option key={monthNumber} value={monthNumber}>
                  {getMonthName(monthNumber)}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-1.5">
            <span className="block text-xs font-medium text-content-secondary">Year</span>
            <input
              type="number"
              value={yearFilter}
              onChange={(event) => setYearFilter(event.target.value)}
              placeholder="e.g. 2026"
              className={`${selectClass} w-28`}
            />
          </label>

          <label className="space-y-1.5">
            <span className="block text-xs font-medium text-content-secondary">Subscriber</span>
            <select
              value={subscriberFilter}
              onChange={(event) => setSubscriberFilter(event.target.value)}
              className={`${selectClass} min-w-56 max-w-80`}
            >
              <option value="">All subscribers</option>
              {subscribers.map((subscriber) => (
                <option key={subscriber.id} value={subscriber.id}>
                  {subscriber.accountNumber} — {subscriber.lastName}, {subscriber.firstName}
                </option>
              ))}
            </select>
          </label>

          <Button type="submit" variant="secondary" size="md">
            Apply filters
          </Button>
        </form>

        {errorMessage !== null && <ErrorBanner message={errorMessage} onRetry={() => void loadInvoices()} />}

        <Card>
          <InvoiceTable invoices={invoices} isLoading={isLoading} />
        </Card>
      </div>
    </AppShell>
  );
}