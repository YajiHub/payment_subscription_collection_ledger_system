import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import {
  PAYMENT_METHOD_LABELS,
  PAYMENT_STATUS_LABELS,
  roleHasPermission,
} from "@bcis/shared";
import {
  extractApiErrorMessage,
  getPayment,
  reversePayment,
  type PaymentDetail,
} from "../lib/api-client";
import { formatCentavos, formatDateOnly } from "../lib/format";
import { useAuthStore } from "../stores/auth.store";

/** Payment detail: receipt information, allocation breakdown, and the reversal action. */
export function PaymentDetailPage(): ReactNode {
  const { id } = useParams<{ id: string }>();
  const user = useAuthStore((state) => state.user);

  const [payment, setPayment] = useState<PaymentDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isReverseDialogOpen, setIsReverseDialogOpen] = useState(false);
  const [reason, setReason] = useState("");

  const canReverse = user !== null && roleHasPermission(user.role, "payments:reverse");

  const loadPayment = useCallback(async (): Promise<void> => {
    if (id === undefined) {
      return;
    }
    setIsLoading(true);
    setErrorMessage(null);
    try {
      setPayment(await getPayment(id));
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void loadPayment();
  }, [loadPayment]);

  async function confirmReverse(): Promise<void> {
    if (id === undefined) {
      return;
    }
    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      const result = await reversePayment(id, reason);
      setIsReverseDialogOpen(false);
      setReason("");
      setStatusMessage(
        `Payment reversed. Reversal receipt ${result.reversalReceiptNumber} was issued.`
      );
      await loadPayment();
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  if (isLoading) {
    return (
      <main className="mx-auto max-w-3xl p-8">
        <p className="text-sm text-slate-500">Loading payment…</p>
      </main>
    );
  }

  if (payment === null) {
    return (
      <main className="mx-auto max-w-3xl space-y-4 p-8">
        <p role="alert" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          {errorMessage ?? "Payment not found."}
        </p>
        <Link to="/payments" className="text-sm font-medium text-slate-700 underline">
          Back to payments
        </Link>
      </main>
    );
  }

  const alreadyReversed = payment.status === "reversed";

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-8">
      <header className="flex items-start justify-between">
        <div className="space-y-1">
          <p className="font-mono text-sm text-slate-500">{payment.receiptNumber}</p>
          <h1 className="text-2xl font-semibold">{formatCentavos(payment.amountCentavos)}</h1>
          <p className="text-sm text-slate-600">
            {payment.subscriberName} ·{" "}
            <span className="font-mono">{payment.serviceAccountNumber}</span>
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              alreadyReversed ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-700"
            }`}
          >
            {PAYMENT_STATUS_LABELS[payment.status]}
          </span>
          <Link to="/payments" className="text-sm font-medium text-slate-700 underline">
            Back to payments
          </Link>
        </div>
      </header>

      {errorMessage !== null && (
        <p role="alert" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          {errorMessage}
        </p>
      )}
      {statusMessage !== null && (
        <p className="rounded border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {statusMessage}
        </p>
      )}

      <section className="grid grid-cols-2 gap-4 rounded-lg border border-slate-200 bg-white p-5 text-sm shadow-sm sm:grid-cols-4">
        <div>
          <p className="text-slate-600">Date paid</p>
          <p>{formatDateOnly(payment.paymentDate)}</p>
        </div>
        <div>
          <p className="text-slate-600">Method</p>
          <p>{PAYMENT_METHOD_LABELS[payment.paymentMethod]}</p>
        </div>
        <div>
          <p className="text-slate-600">Allocated</p>
          <p>{formatCentavos(payment.allocatedCentavos)}</p>
        </div>
        <div>
          <p className="text-slate-600">Advance credit</p>
          <p>{formatCentavos(payment.advanceCreditCentavos)}</p>
        </div>
      </section>

      {payment.gcash !== null && (
        <section className="space-y-2 rounded-lg border border-slate-200 bg-white p-5 text-sm shadow-sm">
          <h2 className="text-base font-medium">GCash details</h2>
          <div className="flex justify-between border-t border-slate-100 pt-2">
            <span className="text-slate-600">Reference number</span>
            <span className="font-mono">{payment.gcash.referenceNumber}</span>
          </div>
          {payment.gcash.senderName !== null && (
            <div className="flex justify-between border-t border-slate-100 pt-2">
              <span className="text-slate-600">Sender</span>
              <span>{payment.gcash.senderName}</span>
            </div>
          )}
          {payment.gcash.senderGcashNumber !== null && (
            <div className="flex justify-between border-t border-slate-100 pt-2">
              <span className="text-slate-600">Sender number</span>
              <span className="font-mono">{payment.gcash.senderGcashNumber}</span>
            </div>
          )}
        </section>
      )}

      <section className="space-y-2 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-base font-medium">Allocation</h2>
        {payment.allocations.length === 0 ? (
          <p className="text-sm text-slate-500">
            No invoices were outstanding; the whole amount became advance credit.
          </p>
        ) : (
          payment.allocations.map((allocation) => (
            <div
              key={allocation.invoiceId}
              className="flex justify-between border-t border-slate-100 pt-2 text-sm"
            >
              <Link to={`/invoices/${allocation.invoiceId}`} className="underline">
                Invoice {allocation.invoiceNumber}
              </Link>
              <span>{formatCentavos(allocation.allocatedAmountCentavos)}</span>
            </div>
          ))
        )}
      </section>

      {payment.notes !== null && payment.notes !== "" && (
        <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-base font-medium">Notes</h2>
          <p className="mt-1 text-sm text-slate-700">{payment.notes}</p>
        </section>
      )}

      <div className="flex flex-wrap gap-3">
        <Link
          to={`/payments/${payment.id}/receipt`}
          className="rounded border border-slate-300 px-4 py-2 text-sm font-medium"
        >
          Print Receipt
        </Link>

        {canReverse && (
          <button
            type="button"
            onClick={() => setIsReverseDialogOpen(true)}
            disabled={alreadyReversed}
            title={alreadyReversed ? "This payment has already been reversed" : undefined}
            className="rounded border border-red-300 px-4 py-2 text-sm font-medium text-red-700 disabled:opacity-40"
          >
            Reverse Payment
          </button>
        )}
      </div>

      {isReverseDialogOpen && (
        <div className="fixed inset-0 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="w-full max-w-md space-y-4 rounded-lg bg-white p-6 shadow-lg">
            <h2 className="text-base font-medium">Reverse {payment.receiptNumber}</h2>
            <p className="text-sm text-slate-600">
              The original payment row is kept forever. A reversal receipt is issued and a debit is
              added to the ledger to cancel the credit.
            </p>
            <label className="block space-y-1">
              <span className="text-sm font-medium text-slate-700">Reason</span>
              <textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                rows={3}
                className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
              />
            </label>
            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setIsReverseDialogOpen(false)}
                className="rounded border border-slate-300 px-4 py-2 text-sm font-medium"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void confirmReverse()}
                disabled={isSubmitting || reason.trim().length < 10}
                className="rounded bg-red-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                Reverse Payment
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
