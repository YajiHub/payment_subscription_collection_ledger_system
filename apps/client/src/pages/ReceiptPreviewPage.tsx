import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { PAYMENT_METHOD_LABELS } from "@bcis/shared";
import { extractApiErrorMessage, getPayment, type PaymentDetail } from "../lib/api-client";
import { formatCentavos, formatDateOnly } from "../lib/format";

/** The ISP's printable letterhead. Kept here so every receipt carries the same header. */
const COMPANY = {
  name: "BCIS Internet Services",
  address: "Poblacion, Philippines",
  tagline: "Subscription Billing and Collection System",
};

/** Receipt preview and print, with the ISP header and both signature lines. */
export function ReceiptPreviewPage(): ReactNode {
  const { id } = useParams<{ id: string }>();
  const [payment, setPayment] = useState<PaymentDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

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

  function printReceipt(): void {
    if (window.electronAPI !== undefined) {
      void window.electronAPI.printCurrentWindow();
    } else {
      window.print();
    }
  }

  if (isLoading) {
    return (
      <main className="mx-auto max-w-2xl p-8">
        <p className="text-sm text-slate-500">Loading receipt…</p>
      </main>
    );
  }

  if (payment === null) {
    return (
      <main className="mx-auto max-w-2xl space-y-4 p-8">
        <p role="alert" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          {errorMessage ?? "Receipt not found."}
        </p>
        <Link to="/payments" className="text-sm font-medium text-slate-700 underline">
          Back to payments
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl space-y-6 p-8">
      <div className="flex justify-end gap-3 print:hidden">
        <button
          type="button"
          onClick={printReceipt}
          className="rounded bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
        >
          Print Receipt
        </button>
        <Link
          to={`/payments/${payment.id}`}
          className="rounded border border-slate-300 px-4 py-2 text-sm font-medium"
        >
          Payment detail
        </Link>
      </div>

      <article className="space-y-6 rounded-lg border border-slate-300 bg-white p-8 shadow-sm">
        <header className="border-b border-slate-200 pb-4 text-center">
          <h1 className="text-xl font-semibold">{COMPANY.name}</h1>
          <p className="text-sm text-slate-600">{COMPANY.address}</p>
          <p className="text-xs text-slate-500">{COMPANY.tagline}</p>
          <p className="mt-3 text-sm font-semibold uppercase tracking-wide">
            {payment.status === "reversed" ? "Voided Official Receipt" : "Official Receipt"}
          </p>
        </header>

        <section className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-slate-600">Receipt number</p>
            <p className="font-mono">{payment.receiptNumber}</p>
          </div>
          <div>
            <p className="text-slate-600">Date</p>
            <p>{formatDateOnly(payment.paymentDate)}</p>
          </div>
          <div>
            <p className="text-slate-600">Subscriber</p>
            <p>{payment.subscriberName}</p>
          </div>
          <div>
            <p className="text-slate-600">Service account</p>
            <p className="font-mono">{payment.serviceAccountNumber}</p>
          </div>
          <div>
            <p className="text-slate-600">Payment method</p>
            <p>{PAYMENT_METHOD_LABELS[payment.paymentMethod]}</p>
          </div>
          <div>
            <p className="text-slate-600">Cashier</p>
            <p>{payment.postedByName}</p>
          </div>
          {payment.gcash !== null && (
            <div className="col-span-2">
              <p className="text-slate-600">GCash reference</p>
              <p className="font-mono">{payment.gcash.referenceNumber}</p>
            </div>
          )}
        </section>

        <section className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-600">
            Application of payment
          </h2>
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="px-3 py-2 font-medium">Applied to</th>
                <th className="px-3 py-2 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {payment.allocations.map((allocation) => (
                <tr key={allocation.invoiceId} className="border-t border-slate-100">
                  <td className="px-3 py-2">Invoice {allocation.invoiceNumber}</td>
                  <td className="px-3 py-2 text-right">
                    {formatCentavos(allocation.allocatedAmountCentavos)}
                  </td>
                </tr>
              ))}
              {payment.advanceCreditCentavos > 0 && (
                <tr className="border-t border-slate-100">
                  <td className="px-3 py-2">Advance credit</td>
                  <td className="px-3 py-2 text-right">
                    {formatCentavos(payment.advanceCreditCentavos)}
                  </td>
                </tr>
              )}
            </tbody>
            <tfoot className="border-t border-slate-200 bg-slate-50">
              <tr>
                <td className="px-3 py-2 font-semibold">Total received</td>
                <td className="px-3 py-2 text-right font-semibold">
                  {formatCentavos(payment.amountCentavos)}
                </td>
              </tr>
            </tfoot>
          </table>
        </section>

        {payment.notes !== null && payment.notes !== "" && (
          <p className="text-sm text-slate-600">Notes: {payment.notes}</p>
        )}

        <footer className="grid grid-cols-2 gap-8 pt-8 text-xs text-slate-600">
          <div className="space-y-6">
            <div className="border-t border-slate-400 pt-1">Cashier</div>
          </div>
          <div className="space-y-6">
            <div className="border-t border-slate-400 pt-1">Subscriber</div>
          </div>
        </footer>
      </article>
    </main>
  );
}
