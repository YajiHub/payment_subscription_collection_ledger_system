import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

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

const STATUS_BADGE_CLASSES = {
  posted: "bg-emerald-50 text-emerald-700",
  reversed: "bg-red-50 text-red-700",
} satisfies Record<PaymentStatus, string>;

/** Payment history with the filters the spec calls for: date range, method, status. */
export function PaymentHistoryPage(): ReactNode {
  const [filters, setFilters] = useState<ListPaymentFilters>({});
  const [payments, setPayments] = useState<PaymentSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const loadPayments = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      setPayments(await listPayments(filters));
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    void loadPayments();
  }, [loadPayments]);

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-8">
      <header className="flex items-start justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">Payment History</h1>
          <p className="text-sm text-slate-600">
            Every posted payment stays here, including reversed ones.
          </p>
        </div>
        <Link to="/payments/new" className="text-sm font-medium text-slate-700 underline">
          Post payment
        </Link>
      </header>

      <section className="grid gap-3 rounded-lg border border-slate-200 bg-white p-4 text-sm shadow-sm sm:grid-cols-3">
        <label className="block space-y-1">
          <span className="font-medium text-slate-700">From</span>
          <input
            type="date"
            value={filters.dateFrom ?? ""}
            onChange={(event) =>
              setFilters((current) => ({ ...current, dateFrom: event.target.value || undefined }))
            }
            className="w-full rounded border border-slate-300 px-3 py-2"
          />
        </label>
        <label className="block space-y-1">
          <span className="font-medium text-slate-700">To</span>
          <input
            type="date"
            value={filters.dateTo ?? ""}
            onChange={(event) =>
              setFilters((current) => ({ ...current, dateTo: event.target.value || undefined }))
            }
            className="w-full rounded border border-slate-300 px-3 py-2"
          />
        </label>
        <label className="block space-y-1">
          <span className="font-medium text-slate-700">Method</span>
          <select
            value={filters.method ?? ""}
            onChange={(event) =>
              setFilters((current) => ({
                ...current,
                method: (event.target.value || undefined) as PaymentMethod | undefined,
              }))
            }
            className="w-full rounded border border-slate-300 px-3 py-2"
          >
            <option value="">All methods</option>
            {PAYMENT_METHODS.map((method) => (
              <option key={method} value={method}>
                {PAYMENT_METHOD_LABELS[method]}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1">
          <span className="font-medium text-slate-700">Status</span>
          <select
            value={filters.status ?? ""}
            onChange={(event) =>
              setFilters((current) => ({
                ...current,
                status: (event.target.value || undefined) as PaymentStatus | undefined,
              }))
            }
            className="w-full rounded border border-slate-300 px-3 py-2"
          >
            <option value="">All statuses</option>
            {PAYMENT_STATUSES.map((status) => (
              <option key={status} value={status}>
                {PAYMENT_STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </label>
      </section>

      {errorMessage !== null && (
        <p role="alert" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          {errorMessage}
        </p>
      )}

      {isLoading ? (
        <p className="text-sm text-slate-500">Loading payments…</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="px-4 py-3 font-medium">Receipt #</th>
                <th className="px-4 py-3 font-medium">Date</th>
                <th className="px-4 py-3 font-medium">Subscriber</th>
                <th className="px-4 py-3 font-medium">Service</th>
                <th className="px-4 py-3 font-medium">Method</th>
                <th className="px-4 py-3 font-medium">Amount</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Posted By</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((payment) => (
                <tr key={payment.id} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <Link
                      to={`/payments/${payment.id}`}
                      className="font-mono text-slate-800 underline"
                    >
                      {payment.receiptNumber}
                    </Link>
                  </td>
                  <td className="px-4 py-3">{formatDateOnly(payment.paymentDate)}</td>
                  <td className="px-4 py-3">{payment.subscriberName}</td>
                  <td className="px-4 py-3 font-mono text-xs">{payment.serviceAccountNumber}</td>
                  <td className="px-4 py-3">{PAYMENT_METHOD_LABELS[payment.paymentMethod]}</td>
                  <td className="px-4 py-3">{formatCentavos(payment.amountCentavos)}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2 py-1 text-xs font-medium ${STATUS_BADGE_CLASSES[payment.status]}`}
                    >
                      {PAYMENT_STATUS_LABELS[payment.status]}
                    </span>
                  </td>
                  <td className="px-4 py-3">{payment.postedByName}</td>
                </tr>
              ))}
              {payments.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-6 text-center text-slate-500">
                    No payments match these filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
