import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Printer } from "lucide-react";

import {
  INVOICE_STATUS_LABELS,
  INVOICE_TYPE_LABELS,
  getMonthYearLabel,
  roleHasPermission,
  type InvoiceStatus,
} from "@bcis/shared";
import {
  extractApiErrorMessage,
  getInvoice,
  postInvoice,
  voidInvoice,
  type InvoiceDetail,
} from "../lib/api-client";
import { formatCentavos, formatDateOnly } from "../lib/format";
import { useAuthStore } from "../stores/auth.store";
import { AppShell } from "../components/layout/AppShell";
import { Badge, type BadgeVariant } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card";
import { ErrorBanner } from "../components/ui/ErrorBanner";
import { Modal } from "../components/ui/Modal";
import { Skeleton } from "../components/ui/Skeleton";

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
function periodLabel(invoice: InvoiceDetail): string {
  if (invoice.billingPeriodYear === null || invoice.billingPeriodMonth === null) {
    return "One-off charge";
  }
  return getMonthYearLabel(invoice.billingPeriodMonth, invoice.billingPeriodYear);
}

/** Whether voiding is legal from the invoice's current state. */
function canVoidStatus(status: InvoiceStatus): boolean {
  return status !== "void" && status !== "paid";
}

/**
 * Invoice detail: header, subscriber and service information, the line items that
 * make up the total, and the void/post actions.
 */
export function InvoiceDetailPage(): ReactNode {
  const { id } = useParams<{ id: string }>();
  const user = useAuthStore((state) => state.user);

  const [invoice, setInvoice] = useState<InvoiceDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isVoidDialogOpen, setIsVoidDialogOpen] = useState(false);
  const [voidReason, setVoidReason] = useState("");

  const canGenerate = user !== null && roleHasPermission(user.role, "invoices:generate");
  const canVoid = user !== null && roleHasPermission(user.role, "invoices:void");

  const loadInvoice = useCallback(async (): Promise<void> => {
    if (id === undefined) {
      return;
    }
    setIsLoading(true);
    setErrorMessage(null);
    try {
      setInvoice(await getInvoice(id));
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void loadInvoice();
  }, [loadInvoice]);

  async function postDraft(): Promise<void> {
    if (id === undefined) {
      return;
    }
    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      await postInvoice(id);
      setStatusMessage("Invoice posted. A debit was added to the subscriber's ledger.");
      await loadInvoice();
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function confirmVoid(): Promise<void> {
    if (id === undefined) {
      return;
    }
    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      await voidInvoice(id, voidReason);
      setIsVoidDialogOpen(false);
      setVoidReason("");
      setStatusMessage("Invoice voided. A credit was added to the subscriber's ledger.");
      await loadInvoice();
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  function printInvoice(): void {
    // Printing is an OS feature exposed by the Electron preload bridge. In a plain
    // browser during development the bridge is absent, so fall back to the browser.
    if (window.electronAPI !== undefined) {
      void window.electronAPI.printCurrentWindow();
    } else {
      window.print();
    }
  }

  if (isLoading) {
    return (
      <AppShell pageTitle="Invoice" pageDescription="Loading invoice…">
        <div className="mx-auto max-w-4xl space-y-6">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </AppShell>
    );
  }

  if (invoice === null) {
    return (
      <AppShell pageTitle="Invoice" pageDescription="The requested invoice could not be loaded">
        <div className="mx-auto max-w-4xl space-y-4">
          <ErrorBanner
            message={errorMessage ?? "Invoice not found."}
            onRetry={() => void loadInvoice()}
          />
          <Link to="/invoices" className="text-sm font-medium text-content-primary underline">
            Back to invoices
          </Link>
        </div>
      </AppShell>
    );
  }

  const voidIsDisabled = !canVoidStatus(invoice.status) || !canVoid;

  return (
    <AppShell
      pageTitle={`Invoice ${invoice.invoiceNumber}`}
      pageDescription={`${INVOICE_TYPE_LABELS[invoice.invoiceType]} · ${invoice.subscriberName}`}
      headerActions={
        <Button
          variant="outline"
          size="md"
          leftIcon={<Printer className="h-4 w-4" />}
          onClick={printInvoice}
        >
          Print / Preview
        </Button>
      }
    >
      <div className="mx-auto max-w-4xl space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <Badge variant={STATUS_BADGE_VARIANTS[invoice.status]} size="md" dot>
              {INVOICE_STATUS_LABELS[invoice.status]}
            </Badge>
            <p className="text-sm text-content-secondary">
              {invoice.subscriberName} ·{" "}
              <span className="font-mono">{invoice.serviceAccountNumber}</span>
            </p>
            <p className="text-sm text-content-secondary">Billing period: {periodLabel(invoice)}</p>
          </div>
          <Link to="/invoices" className="text-sm font-medium text-content-primary underline">
            Back to invoices
          </Link>
        </div>

        {errorMessage !== null && (
          <ErrorBanner message={errorMessage} onRetry={() => void loadInvoice()} />
        )}
        {statusMessage !== null && (
          <p className="rounded-xl border border-success-line bg-success-soft px-4 py-3 text-sm text-success-strong">
            {statusMessage}
          </p>
        )}

        <Card>
          <CardContent className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
            <div>
              <p className="text-content-secondary">Invoice date</p>
              <p>{formatDateOnly(invoice.invoiceDate)}</p>
            </div>
            <div>
              <p className="text-content-secondary">Due date</p>
              <p>{formatDateOnly(invoice.dueDate)}</p>
            </div>
            <div>
              <p className="text-content-secondary">Total</p>
              <p className="font-medium tabular-nums">
                {formatCentavos(invoice.totalAmountCentavos)}
              </p>
            </div>
            <div>
              <p className="text-content-secondary">Balance</p>
              <p className="font-medium tabular-nums">
                {formatCentavos(invoice.remainingBalanceCentavos)}
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Line items</CardTitle>
          </CardHeader>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-canvas text-content-secondary">
                <tr>
                  <th className="px-4 py-3 font-medium">Description</th>
                  <th className="px-4 py-3 font-medium">Qty</th>
                  <th className="px-4 py-3 font-medium text-right">Unit</th>
                  <th className="px-4 py-3 font-medium text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {invoice.lineItems.map((lineItem) => (
                  <tr
                    key={lineItem.id}
                    className="border-t border-line transition-colors hover:bg-canvas/60"
                  >
                    <td className="px-4 py-3">{lineItem.description}</td>
                    <td className="px-4 py-3">{lineItem.quantity}</td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {formatCentavos(lineItem.unitAmountCentavos)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {formatCentavos(lineItem.totalAmountCentavos)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t border-line bg-canvas">
                <tr>
                  <td className="px-4 py-3 font-medium" colSpan={3}>
                    Subtotal
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {formatCentavos(invoice.subtotalCentavos)}
                  </td>
                </tr>
                <tr>
                  <td className="px-4 py-3 font-medium" colSpan={3}>
                    Late fees
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {formatCentavos(invoice.lateFeesCentavos)}
                  </td>
                </tr>
                <tr>
                  <td className="px-4 py-3 font-semibold" colSpan={3}>
                    Total
                  </td>
                  <td className="px-4 py-3 text-right font-semibold tabular-nums">
                    {formatCentavos(invoice.totalAmountCentavos)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </Card>

        <Card>
          <CardContent>
            <h2 className="text-base font-medium">Payment history</h2>
            <p className="mt-1 text-sm text-content-secondary">
              Payments that settle this invoice appear in the{" "}
              <Link to="/payments" className="underline">
                payment history
              </Link>
              .
            </p>
          </CardContent>
        </Card>

        {invoice.notes !== null && invoice.notes !== "" && (
          <Card>
            <CardContent>
              <h2 className="text-base font-medium">Notes</h2>
              <p className="mt-1 text-sm text-content-primary">{invoice.notes}</p>
            </CardContent>
          </Card>
        )}

        <div className="flex flex-wrap gap-3">
          {canGenerate && invoice.status === "draft" && (
            <Button
              variant="secondary"
              size="md"
              isLoading={isSubmitting}
              onClick={() => void postDraft()}
            >
              Post Invoice
            </Button>
          )}

          <Button
            variant="danger"
            size="md"
            disabled={voidIsDisabled}
            title={voidIsDisabled ? "This invoice cannot be voided" : undefined}
            onClick={() => setIsVoidDialogOpen(true)}
          >
            Void Invoice
          </Button>
        </div>
      </div>

      <Modal
        isOpen={isVoidDialogOpen}
        onClose={() => setIsVoidDialogOpen(false)}
        title={`Void invoice ${invoice.invoiceNumber}`}
        description="The invoice row stays in the database forever. A credit entry is added to the ledger to cancel the debt."
        footer={
          <>
            <Button variant="outline" size="md" onClick={() => setIsVoidDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size="md"
              isLoading={isSubmitting}
              disabled={voidReason.trim().length < 10}
              onClick={() => void confirmVoid()}
            >
              Void Invoice
            </Button>
          </>
        }
      >
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-content-secondary">Reason</span>
          <textarea
            value={voidReason}
            onChange={(event) => setVoidReason(event.target.value)}
            rows={3}
            className="w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          />
        </label>
      </Modal>
    </AppShell>
  );
}
