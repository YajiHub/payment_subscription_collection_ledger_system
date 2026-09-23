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

const MONTH_NUMBERS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;

// Colours per status. `satisfies` keeps the keys exhaustive without widening the
// literal class strings into plain `string`.
const STATUS_BADGE_CLASSES = {
  draft: "bg-slate-100 text-slate-700",
  posted: "bg-sky-50 text-sky-700",
  partially_paid: "bg-amber-50 text-amber-700",
  paid: "bg-emerald-50 text-emerald-700",
  overdue: "bg-red-50 text-red-700",
  void: "bg-slate-100 text-slate-500",
} satisfies Record<InvoiceStatus, string>;

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

function InvoiceTable({ invoices, isLoading }: InvoiceTableProps): ReactNode {
  if (isLoading) {
    return (
      <tbody>
        <tr>
          <td colSpan={9} className="px-4 py-6 text-center text-slate-500">
            Loading invoices…
          </td>
        </tr>
      </tbody>
    );
  }

  if (invoices.length === 0) {
    return (
      <tbody>
        <tr>
          <td colSpan={9} className="px-4 py-6 text-center text-slate-500">
            No invoices match these filters.
          </td>
        </tr>
      </tbody>
    );
  }

  return (
    <tbody>
      {invoices.map((invoice) => (
        <tr key={invoice.id} className="border-t border-slate-100">
          <td className="px-4 py-3">
            <Link to={`/invoices/${invoice.id}`} className="font-mono text-slate-700 underline">
              {invoice.invoiceNumber}
            </Link>
          </td>
          <td className="px-4 py-3">{invoice.subscriberName}</td>
          <td className="px-4 py-3 font-mono text-xs">{invoice.serviceAccountNumber}</td>
          <td className="px-4 py-3">{periodLabel(invoice)}</td>
          <td className="px-4 py-3">{formatCentavos(invoice.totalAmountCentavos)}</td>
          <td className="px-4 py-3">{formatCentavos(invoice.paidAmountCentavos)}</td>
          <td className="px-4 py-3">{formatCentavos(invoice.remainingBalanceCentavos)}</td>
          <td className="px-4 py-3">
            <span
              className={`rounded-full px-2 py-0.5 text-xs ${STATUS_BADGE_CLASSES[invoice.status]}`}
            >
              {INVOICE_STATUS_LABELS[invoice.status]}
            </span>
          </td>
          <td className="px-4 py-3">{formatDateOnly(invoice.dueDate)}</td>
        </tr>
      ))}
    </tbody>
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
        const page = await listSubscribers({ page: 1, pageSize: 100 });
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

  return (
    <main className="mx-auto max-w-6xl space-y-6 p-8">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Invoices</h1>
          <p className="text-sm text-slate-600">
            Every invoice the office has generated, newest first.
          </p>
        </div>
        <div className="flex items-center gap-3 text-sm font-medium">
          <Link to="/billing" className="text-slate-800 underline">
            Billing Dashboard
          </Link>
          <Link to="/" className="text-slate-700 underline">
            Dashboard
          </Link>
        </div>
      </header>

      <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
        <label className="space-y-1">
          <span className="text-sm font-medium text-slate-700">Status</span>
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as InvoiceStatus | "")}
            className="rounded border border-slate-300 px-3 py-2 text-sm"
          >
            <option value="">All</option>
            {INVOICE_STATUSES.map((status) => (
              <option key={status} value={status}>
                {INVOICE_STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1">
          <span className="text-sm font-medium text-slate-700">Month</span>
          <select
            value={monthFilter}
            onChange={(event) => setMonthFilter(event.target.value)}
            className="rounded border border-slate-300 px-3 py-2 text-sm"
          >
            <option value="">All</option>
            {MONTH_NUMBERS.map((monthNumber) => (
              <option key={monthNumber} value={monthNumber}>
                {getMonthName(monthNumber)}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1">
          <span className="text-sm font-medium text-slate-700">Year</span>
          <input
            type="number"
            value={yearFilter}
            onChange={(event) => setYearFilter(event.target.value)}
            className="w-28 rounded border border-slate-300 px-3 py-2 text-sm"
          />
        </label>

        <label className="space-y-1">
          <span className="text-sm font-medium text-slate-700">Subscriber</span>
          <select
            value={subscriberFilter}
            onChange={(event) => setSubscriberFilter(event.target.value)}
            className="rounded border border-slate-300 px-3 py-2 text-sm"
          >
            <option value="">All</option>
            {subscribers.map((subscriber) => (
              <option key={subscriber.id} value={subscriber.id}>
                {subscriber.accountNumber} — {subscriber.lastName}, {subscriber.firstName}
              </option>
            ))}
          </select>
        </label>

        <button
          type="submit"
          className="rounded border border-slate-300 px-4 py-2 text-sm font-medium"
        >
          Apply filters
        </button>
      </form>

      {errorMessage !== null && (
        <p
          role="alert"
          className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {errorMessage}
        </p>
      )}

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="px-4 py-3 font-medium">Invoice #</th>
              <th className="px-4 py-3 font-medium">Subscriber</th>
              <th className="px-4 py-3 font-medium">Service</th>
              <th className="px-4 py-3 font-medium">Period</th>
              <th className="px-4 py-3 font-medium">Amount</th>
              <th className="px-4 py-3 font-medium">Paid</th>
              <th className="px-4 py-3 font-medium">Balance</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Due Date</th>
            </tr>
          </thead>
          <InvoiceTable invoices={invoices} isLoading={isLoading} />
        </table>
      </div>
    </main>
  );
}
