import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Printer } from "lucide-react";

import { PAYMENT_METHOD_LABELS } from "@bcis/shared";
import { extractApiErrorMessage, getPayment, type PaymentDetail } from "../lib/api-client";
import { formatCentavos, formatDateOnly } from "../lib/format";
import { AppShell } from "../components/layout/AppShell";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { ErrorBanner } from "../components/ui/ErrorBanner";
import { Skeleton } from "../components/ui/Skeleton";

/** The ISP's printable letterhead. Kept here so every receipt carries the same header. */
const COMPANY = {
  name: "BCIS Internet Services",
  address: "Poblacion, Philippines",
  tagline: "Subscription Billing and Collection System",
};

/** Receipt preview and print, with the ISP header and both signature lines. */
export function ReceiptPreviewPage(): ReactNode {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
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
      <AppShell pageTitle="Receipt" pageDescription="Loading the official receipt">
        <Card>
          <div className="space-y-4 p-8">
            <Skeleton className="mx-auto h-6 w-56" />
            <Skeleton className="mx-auto h-4 w-40" />
            <Skeleton className="mt-6 h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="mt-6 h-24 w-full" />
          </div>
        </Card>
      </AppShell>
    );
  }

  if (payment === null) {
    return (
      <AppShell pageTitle="Receipt" pageDescription="The requested receipt could not be shown">
        <div className="mx-auto max-w-2xl space-y-4">
          {errorMessage !== null ? (
            <ErrorBanner message={errorMessage} onRetry={() => void loadPayment()} />
          ) : null}
          <Card>
            <EmptyState
              title="Receipt not found"
              description="This receipt does not exist or is no longer available. Open the payment ledger to find the receipt you need."
              actionLabel="Back to payments"
              onAction={() => navigate("/payments")}
            />
          </Card>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell pageTitle="Official Receipt" pageDescription={`Receipt ${payment.receiptNumber}`}>
      <div className="mx-auto max-w-2xl space-y-6">
        <div className="flex justify-end gap-3 print:hidden">
          <Button type="button" variant="secondary" leftIcon={<Printer className="h-4 w-4" />} onClick={printReceipt}>
            Print Receipt
          </Button>
          <Link
            to={`/payments/${payment.id}`}
            className="inline-flex h-9 items-center rounded-lg border border-line-strong bg-surface px-3.5 text-sm font-medium text-content-primary transition-colors hover:bg-canvas"
          >
            Payment detail
          </Link>
        </div>

        <Card>
          <article className="space-y-6 p-8">
            <header className="border-b border-line pb-4 text-center">
              <h1 className="text-xl font-semibold">{COMPANY.name}</h1>
              <p className="text-sm text-content-secondary">{COMPANY.address}</p>
              <p className="text-xs text-content-secondary">{COMPANY.tagline}</p>
              <p className="mt-3 text-sm font-semibold uppercase tracking-wide">
                {payment.status === "reversed" ? "Voided Official Receipt" : "Official Receipt"}
              </p>
            </header>

            <section className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-content-secondary">Receipt number</p>
                <p className="font-mono">{payment.receiptNumber}</p>
              </div>
              <div>
                <p className="text-content-secondary">Date</p>
                <p>{formatDateOnly(payment.paymentDate)}</p>
              </div>
              <div>
                <p className="text-content-secondary">Subscriber</p>
                <p>{payment.subscriberName}</p>
              </div>
              <div>
                <p className="text-content-secondary">Service account</p>
                <p className="font-mono">{payment.serviceAccountNumber}</p>
              </div>
              <div>
                <p className="text-content-secondary">Payment method</p>
                <p>{PAYMENT_METHOD_LABELS[payment.paymentMethod]}</p>
              </div>
              <div>
                <p className="text-content-secondary">Cashier</p>
                <p>{payment.postedByName}</p>
              </div>
              {payment.gcash !== null && (
                <div className="col-span-2">
                  <p className="text-content-secondary">GCash reference</p>
                  <p className="font-mono">{payment.gcash.referenceNumber}</p>
                </div>
              )}
            </section>

            <section className="space-y-2">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-content-secondary">
                Application of payment
              </h2>
              <table className="w-full text-left text-sm">
                <thead className="bg-canvas text-content-secondary">
                  <tr>
                    <th className="px-3 py-2 font-medium">Applied to</th>
                    <th className="px-3 py-2 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {payment.allocations.map((allocation) => (
                    <tr key={allocation.invoiceId} className="border-t border-line">
                      <td className="px-3 py-2">Invoice {allocation.invoiceNumber}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatCentavos(allocation.allocatedAmountCentavos)}
                      </td>
                    </tr>
                  ))}
                  {payment.advanceCreditCentavos > 0 && (
                    <tr className="border-t border-line">
                      <td className="px-3 py-2">Advance credit</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatCentavos(payment.advanceCreditCentavos)}
                      </td>
                    </tr>
                  )}
                </tbody>
                <tfoot className="border-t border-line bg-canvas">
                  <tr>
                    <td className="px-3 py-2 font-semibold">Total received</td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums">
                      {formatCentavos(payment.amountCentavos)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </section>

            {payment.notes !== null && payment.notes !== "" && (
              <p className="text-sm text-content-secondary">Notes: {payment.notes}</p>
            )}

            <footer className="grid grid-cols-2 gap-8 pt-8 text-xs text-content-secondary">
              <div className="space-y-6">
                <div className="border-t border-line-strong pt-1">Cashier</div>
              </div>
              <div className="space-y-6">
                <div className="border-t border-line-strong pt-1">Subscriber</div>
              </div>
            </footer>
          </article>
        </Card>
      </div>
    </AppShell>
  );
}
