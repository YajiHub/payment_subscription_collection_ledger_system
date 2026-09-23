import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

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

const STATUS_BADGE_CLASSES = {
  draft: "bg-slate-100 text-slate-700",
  posted: "bg-sky-50 text-sky-700",
  partially_paid: "bg-amber-50 text-amber-700",
  paid: "bg-emerald-50 text-emerald-700",
  overdue: "bg-red-50 text-red-700",
  void: "bg-slate-100 text-slate-500",
} satisfies Record<InvoiceStatus, string>;

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
      <main className="mx-auto max-w-4xl p-8">
        <p className="text-sm text-slate-500">Loading invoice…</p>
      </main>
    );
  }

  if (invoice === null) {
    return (
      <main className="mx-auto max-w-4xl space-y-4 p-8">
        <p
          role="alert"
          className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {errorMessage ?? "Invoice not found."}
        </p>
        <Link to="/invoices" className="text-sm font-medium text-slate-700 underline">
          Back to invoices
        </Link>
      </main>
    );
  }

  const voidIsDisabled = !canVoidStatus(invoice.status) || !canVoid;

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-8">
      <header className="flex items-start justify-between">
        <div className="space-y-1">
          <p className="font-mono text-sm text-slate-500">{invoice.invoiceNumber}</p>
          <h1 className="text-2xl font-semibold">
            {INVOICE_TYPE_LABELS[invoice.invoiceType]}
          </h1>
          <p className="text-sm text-slate-600">
            {invoice.subscriberName} · <span className="font-mono">{invoice.serviceAccountNumber}</span>
          </p>
          <p className="text-sm text-slate-600">Billing period: {periodLabel(invoice)}</p>
        </div>
        <div className="flex items-center gap-3">
          <span
            className={`rounded-full px-3 py-1 text-xs font-medium ${STATUS_BADGE_CLASSES[invoice.status]}`}
          >
            {INVOICE_STATUS_LABELS[invoice.status]}
          </span>
          <Link to="/invoices" className="text-sm font-medium text-slate-700 underline">
            Back to invoices
          </Link>
        </div>
      </header>

      {errorMessage !== null && (
        <p
          role="alert"
          className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
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
          <p className="text-slate-600">Invoice date</p>
          <p>{formatDateOnly(invoice.invoiceDate)}</p>
        </div>
        <div>
          <p className="text-slate-600">Due date</p>
          <p>{formatDateOnly(invoice.dueDate)}</p>
        </div>
        <div>
          <p className="text-slate-600">Total</p>
          <p className="font-medium">{formatCentavos(invoice.totalAmountCentavos)}</p>
        </div>
        <div>
          <p className="text-slate-600">Balance</p>
          <p className="font-medium">{formatCentavos(invoice.remainingBalanceCentavos)}</p>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Line items</h2>
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="px-4 py-3 font-medium">Description</th>
                <th className="px-4 py-3 font-medium">Qty</th>
                <th className="px-4 py-3 font-medium">Unit</th>
                <th className="px-4 py-3 font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {invoice.lineItems.map((lineItem) => (
                <tr key={lineItem.id} className="border-t border-slate-100">
                  <td className="px-4 py-3">{lineItem.description}</td>
                  <td className="px-4 py-3">{lineItem.quantity}</td>
                  <td className="px-4 py-3">{formatCentavos(lineItem.unitAmountCentavos)}</td>
                  <td className="px-4 py-3">{formatCentavos(lineItem.totalAmountCentavos)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t border-slate-200 bg-slate-50">
              <tr>
                <td className="px-4 py-3 font-medium" colSpan={3}>
                  Subtotal
                </td>
                <td className="px-4 py-3">{formatCentavos(invoice.subtotalCentavos)}</td>
              </tr>
              <tr>
                <td className="px-4 py-3 font-medium" colSpan={3}>
                  Late fees
                </td>
                <td className="px-4 py-3">{formatCentavos(invoice.lateFeesCentavos)}</td>
              </tr>
              <tr>
                <td className="px-4 py-3 font-semibold" colSpan={3}>
                  Total
                </td>
                <td className="px-4 py-3 font-semibold">
                  {formatCentavos(invoice.totalAmountCentavos)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-base font-medium">Payment history</h2>
        <p className="mt-1 text-sm text-slate-500">
          Payments are recorded in Phase 5. Until then this section stays empty.
        </p>
      </section>

      {invoice.notes !== null && invoice.notes !== "" && (
        <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-base font-medium">Notes</h2>
          <p className="mt-1 text-sm text-slate-700">{invoice.notes}</p>
        </section>
      )}

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={printInvoice}
          className="rounded border border-slate-300 px-4 py-2 text-sm font-medium"
        >
          Print / Preview
        </button>

        {canGenerate && invoice.status === "draft" && (
          <button
            type="button"
            onClick={() => void postDraft()}
            disabled={isSubmitting}
            className="rounded bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
          >
            Post Invoice
          </button>
        )}

        <button
          type="button"
          onClick={() => setIsVoidDialogOpen(true)}
          disabled={voidIsDisabled}
          title={voidIsDisabled ? "This invoice cannot be voided" : undefined}
          className="rounded border border-red-300 px-4 py-2 text-sm font-medium text-red-700 disabled:opacity-40"
        >
          Void Invoice
        </button>
      </div>

      {isVoidDialogOpen && (
        <div className="fixed inset-0 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="w-full max-w-md space-y-4 rounded-lg bg-white p-6 shadow-lg">
            <h2 className="text-base font-medium">Void invoice {invoice.invoiceNumber}</h2>
            <p className="text-sm text-slate-600">
              The invoice row stays in the database forever. A credit entry is added to the ledger to
              cancel the debt.
            </p>
            <label className="block space-y-1">
              <span className="text-sm font-medium text-slate-700">Reason</span>
              <textarea
                value={voidReason}
                onChange={(event) => setVoidReason(event.target.value)}
                rows={3}
                className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
              />
            </label>
            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setIsVoidDialogOpen(false)}
                className="rounded border border-slate-300 px-4 py-2 text-sm font-medium"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void confirmVoid()}
                disabled={isSubmitting || voidReason.trim().length < 10}
                className="rounded bg-red-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                Void Invoice
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
