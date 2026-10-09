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
import { AppShell } from "../components/layout/AppShell";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardContent } from "../components/ui/Card";
import { ErrorBanner } from "../components/ui/ErrorBanner";
import { Modal } from "../components/ui/Modal";
import { Skeleton } from "../components/ui/Skeleton";

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
      <AppShell pageTitle="Payment" pageDescription="Loading payment…">
        <div className="w-full max-w-5xl space-y-6">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      </AppShell>
    );
  }

  if (payment === null) {
    return (
      <AppShell pageTitle="Payment" pageDescription="The requested payment could not be loaded">
        <div className="w-full max-w-5xl space-y-4">
          <ErrorBanner
            message={errorMessage ?? "Payment not found."}
            onRetry={() => void loadPayment()}
          />
          <Link to="/payments" className="text-sm font-medium text-content-primary underline">
            Back to payments
          </Link>
        </div>
      </AppShell>
    );
  }

  const alreadyReversed = payment.status === "reversed";

  return (
    <AppShell
      pageTitle={`Receipt ${payment.receiptNumber}`}
      pageDescription={`${formatCentavos(payment.amountCentavos)} · ${payment.subscriberName}`}
      headerActions={
        <Link
          to={`/payments/${payment.id}/receipt`}
          className="inline-flex h-9 items-center rounded-lg border border-line-strong bg-surface px-3.5 text-sm font-medium text-content-primary transition-colors hover:bg-canvas"
        >
          Print Receipt
        </Link>
      }
    >
      <div className="w-full max-w-5xl space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <Badge variant={alreadyReversed ? "danger" : "success"} size="md" dot>
              {PAYMENT_STATUS_LABELS[payment.status]}
            </Badge>
            <p className="text-sm text-content-secondary">
              {payment.subscriberName} ·{" "}
              <span className="font-mono">{payment.serviceAccountNumber}</span>
            </p>
          </div>
          <Link to="/payments" className="text-sm font-medium text-content-primary underline">
            Back to payments
          </Link>
        </div>

        {errorMessage !== null && (
          <ErrorBanner message={errorMessage} onRetry={() => void loadPayment()} />
        )}
        {statusMessage !== null && (
          <p className="rounded-xl border border-success-line bg-success-soft px-4 py-3 text-sm text-success-strong">
            {statusMessage}
          </p>
        )}

        <Card>
          <CardContent className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
            <div>
              <p className="text-content-secondary">Date paid</p>
              <p>{formatDateOnly(payment.paymentDate)}</p>
            </div>
            <div>
              <p className="text-content-secondary">Method</p>
              <p>{PAYMENT_METHOD_LABELS[payment.paymentMethod]}</p>
            </div>
            <div>
              <p className="text-content-secondary">Allocated</p>
              <p className="tabular-nums">{formatCentavos(payment.allocatedCentavos)}</p>
            </div>
            <div>
              <p className="text-content-secondary">Advance credit</p>
              <p className="tabular-nums">{formatCentavos(payment.advanceCreditCentavos)}</p>
            </div>
          </CardContent>
        </Card>

        {payment.gcash !== null && (
          <Card>
            <CardContent className="space-y-2 text-sm">
              <h2 className="text-base font-medium">GCash details</h2>
              <div className="flex justify-between border-t border-line pt-2">
                <span className="text-content-secondary">Reference number</span>
                <span className="font-mono">{payment.gcash.referenceNumber}</span>
              </div>
              {payment.gcash.senderName !== null && (
                <div className="flex justify-between border-t border-line pt-2">
                  <span className="text-content-secondary">Sender</span>
                  <span>{payment.gcash.senderName}</span>
                </div>
              )}
              {payment.gcash.senderGcashNumber !== null && (
                <div className="flex justify-between border-t border-line pt-2">
                  <span className="text-content-secondary">Sender number</span>
                  <span className="font-mono">{payment.gcash.senderGcashNumber}</span>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardContent className="space-y-2">
            <h2 className="text-base font-medium">Allocation</h2>
            {payment.allocations.length === 0 ? (
              <p className="text-sm text-content-secondary">
                No invoices were outstanding; the whole amount became advance credit.
              </p>
            ) : (
              payment.allocations.map((allocation) => (
                <div
                  key={allocation.invoiceId}
                  className="flex justify-between border-t border-line pt-2 text-sm"
                >
                  <Link to={`/invoices/${allocation.invoiceId}`} className="underline">
                    Invoice {allocation.invoiceNumber}
                  </Link>
                  <span className="tabular-nums">
                    {formatCentavos(allocation.allocatedAmountCentavos)}
                  </span>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        {payment.notes !== null && payment.notes !== "" && (
          <Card>
            <CardContent>
              <h2 className="text-base font-medium">Notes</h2>
              <p className="mt-1 text-sm text-content-primary">{payment.notes}</p>
            </CardContent>
          </Card>
        )}

        {canReverse && (
          <div className="flex flex-wrap gap-3">
            <Button
              variant="danger"
              size="md"
              disabled={alreadyReversed}
              title={alreadyReversed ? "This payment has already been reversed" : undefined}
              onClick={() => setIsReverseDialogOpen(true)}
            >
              Reverse Payment
            </Button>
          </div>
        )}
      </div>

      <Modal
        isOpen={isReverseDialogOpen}
        onClose={() => setIsReverseDialogOpen(false)}
        title={`Reverse ${payment.receiptNumber}`}
        description="The original payment row is kept forever. A reversal receipt is issued and a debit is added to the ledger to cancel the credit."
        footer={
          <>
            <Button variant="outline" size="md" onClick={() => setIsReverseDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size="md"
              isLoading={isSubmitting}
              disabled={reason.trim().length < 10}
              onClick={() => void confirmReverse()}
            >
              Reverse Payment
            </Button>
          </>
        }
      >
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-content-secondary">Reason</span>
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={3}
            className="w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          />
        </label>
      </Modal>
    </AppShell>
  );
}
