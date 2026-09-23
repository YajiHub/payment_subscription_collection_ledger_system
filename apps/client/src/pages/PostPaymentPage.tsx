import type { ReactNode } from "react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { PAYMENT_METHOD_LABELS, type PostablePaymentMethod } from "@bcis/shared";
import {
  extractApiErrorMessage,
  getServiceAccountPaymentSummary,
  postPayment,
  searchSubscribers,
  uploadGcashScreenshot,
  type OutstandingInvoiceSummary,
  type PostPaymentResult,
  type ServiceAccountPaymentSummary,
} from "../lib/api-client";
import { formatCentavos, formatDateOnly, parsePesosToCentavos } from "../lib/format";

interface ServiceAccountChoice {
  serviceAccountId: string;
  serviceAccountNumber: string;
  subscriberName: string;
  planName: string;
}

interface AllocationPreviewLine {
  label: string;
  amountCentavos: number;
}

interface ScreenshotUpload {
  fileName: string;
  contentType: string;
  dataBase64: string;
}

/**
 * A display-only preview of how the amount would be spread, oldest invoice first.
 *
 * This mirrors the server's allocation rule for the cashier's benefit; the server
 * re-runs it authoritatively when the payment is posted, so the preview can never
 * change what actually happens.
 */
function previewAllocation(
  amountCentavos: number,
  outstandingInvoices: readonly OutstandingInvoiceSummary[]
): AllocationPreviewLine[] {
  let remaining = amountCentavos;
  const lines: AllocationPreviewLine[] = [];

  for (const invoice of outstandingInvoices) {
    if (remaining <= 0) {
      break;
    }
    const applied = Math.min(remaining, invoice.remainingBalanceCentavos);
    if (applied <= 0) {
      continue;
    }
    lines.push({ label: `Invoice ${invoice.invoiceNumber}`, amountCentavos: applied });
    remaining -= applied;
  }

  if (remaining > 0) {
    lines.push({ label: "Advance Credit", amountCentavos: remaining });
  }

  return lines;
}

/** Reads a chosen image file into base64 so it can be uploaded through the API. */
function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("The screenshot could not be read"));
        return;
      }
      // FileReader returns a data URL; the API wants the bytes after the comma.
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(new Error("The screenshot could not be read"));
    reader.readAsDataURL(file);
  });
}

/** The Post Payment screen for the cashier. */
export function PostPaymentPage(): ReactNode {
  const navigate = useNavigate();

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<ServiceAccountChoice[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  const [selectedAccount, setSelectedAccount] = useState<ServiceAccountChoice | null>(null);
  const [summary, setSummary] = useState<ServiceAccountPaymentSummary | null>(null);

  const [amountText, setAmountText] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<PostablePaymentMethod>("cash");
  const [notes, setNotes] = useState("");
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().slice(0, 10));

  const [gcashReference, setGcashReference] = useState("");
  const [gcashSenderName, setGcashSenderName] = useState("");
  const [gcashSenderNumber, setGcashSenderNumber] = useState("");
  const [screenshot, setScreenshot] = useState<ScreenshotUpload | null>(null);
  const [screenshotPath, setScreenshotPath] = useState<string | null>(null);

  const [isPosting, setIsPosting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [result, setResult] = useState<PostPaymentResult | null>(null);

  const amountCentavos = parsePesosToCentavos(amountText);
  const preview =
    amountCentavos !== null && summary !== null
      ? previewAllocation(amountCentavos, summary.outstandingInvoices)
      : [];

  async function handleSearch(): Promise<void> {
    if (searchQuery.trim() === "") {
      return;
    }
    setIsSearching(true);
    setErrorMessage(null);
    try {
      const page = await searchSubscribers(searchQuery.trim());
      const choices = page.items.flatMap((subscriber) =>
        subscriber.serviceAccounts.map((account) => ({
          serviceAccountId: account.id,
          serviceAccountNumber: account.serviceAccountNumber,
          subscriberName: `${subscriber.lastName}, ${subscriber.firstName}`,
          planName: account.planName,
        }))
      );
      setSearchResults(choices);
      if (choices.length === 0) {
        setErrorMessage("No service accounts matched that search.");
      }
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsSearching(false);
    }
  }

  async function selectAccount(choice: ServiceAccountChoice): Promise<void> {
    setSelectedAccount(choice);
    setSearchResults([]);
    setSummary(null);
    setResult(null);
    setErrorMessage(null);
    try {
      setSummary(await getServiceAccountPaymentSummary(choice.serviceAccountId));
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    }
  }

  async function handleScreenshotChosen(file: File | undefined): Promise<void> {
    if (file === undefined) {
      return;
    }
    setErrorMessage(null);
    try {
      const dataBase64 = await readFileAsBase64(file);
      const contentType = file.type;
      const uploaded = await uploadGcashScreenshot({
        fileName: file.name,
        contentType,
        dataBase64,
      });
      setScreenshot({ fileName: file.name, contentType, dataBase64 });
      setScreenshotPath(uploaded.filePath);
    } catch (error) {
      setScreenshot(null);
      setScreenshotPath(null);
      setErrorMessage(extractApiErrorMessage(error));
    }
  }

  async function submitPayment(): Promise<void> {
    if (selectedAccount === null || amountCentavos === null || amountCentavos <= 0) {
      setErrorMessage("Select a service account and enter an amount greater than zero.");
      return;
    }
    if (paymentMethod === "gcash" && gcashReference.trim() === "") {
      setErrorMessage("Enter the GCash reference number.");
      return;
    }

    setIsPosting(true);
    setErrorMessage(null);
    try {
      const posted = await postPayment({
        serviceAccountId: selectedAccount.serviceAccountId,
        paymentMethod,
        amountCentavos,
        paymentDate,
        notes: notes.trim() === "" ? undefined : notes.trim(),
        gcash:
          paymentMethod === "gcash"
            ? {
                referenceNumber: gcashReference.trim(),
                senderName: gcashSenderName.trim() === "" ? undefined : gcashSenderName.trim(),
                senderGcashNumber:
                  gcashSenderNumber.trim() === "" ? undefined : gcashSenderNumber.trim(),
                screenshotFilePath: screenshotPath ?? undefined,
              }
            : undefined,
      });
      setResult(posted);
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsPosting(false);
    }
  }

  if (result !== null) {
    return (
      <main className="mx-auto max-w-3xl space-y-6 p-8">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold">Payment posted</h1>
          <p className="text-sm text-slate-600">
            Receipt <span className="font-mono">{result.payment.receiptNumber}</span> was issued for{" "}
            {formatCentavos(result.payment.amountCentavos)}.
          </p>
        </header>

        <section className="space-y-2 rounded-lg border border-slate-200 bg-white p-5 text-sm shadow-sm">
          <h2 className="text-base font-medium">Allocation</h2>
          {result.allocations.length === 0 && result.advanceCreditCentavos === 0 && (
            <p className="text-slate-500">No invoices were outstanding.</p>
          )}
          {result.allocations.map((allocation) => (
            <div key={allocation.invoiceId} className="flex justify-between border-t border-slate-100 pt-2">
              <span>Invoice {allocation.invoiceNumber}</span>
              <span>{formatCentavos(allocation.allocatedAmountCentavos)}</span>
            </div>
          ))}
          {result.advanceCreditCentavos > 0 && (
            <div className="flex justify-between border-t border-slate-100 pt-2 font-medium">
              <span>Advance credit</span>
              <span>{formatCentavos(result.advanceCreditCentavos)}</span>
            </div>
          )}
        </section>

        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => navigate(`/payments/${result.payment.id}/receipt`)}
            className="rounded bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
          >
            Print Receipt
          </button>
          <button
            type="button"
            onClick={() => {
              setResult(null);
              setSummary(null);
              setSelectedAccount(null);
              setAmountText("");
              setGcashReference("");
              setScreenshot(null);
              setScreenshotPath(null);
            }}
            className="rounded border border-slate-300 px-4 py-2 text-sm font-medium"
          >
            Post another payment
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Post Payment</h1>
        <p className="text-sm text-slate-600">
          Find the service account, confirm the amount, then post. Cash or GCash.
        </p>
      </header>

      {errorMessage !== null && (
        <p role="alert" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          {errorMessage}
        </p>
      )}

      <section className="space-y-3 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-base font-medium">1. Service account</h2>
        <div className="flex gap-2">
          <input
            type="text"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Account number, subscriber name, or phone"
            className="flex-1 rounded border border-slate-300 px-3 py-2 text-sm"
          />
          <button
            type="button"
            onClick={() => void handleSearch()}
            disabled={isSearching}
            className="rounded bg-slate-800 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            Search
          </button>
        </div>

        {searchResults.length > 0 && (
          <ul className="divide-y divide-slate-100 rounded border border-slate-200">
            {searchResults.map((choice) => (
              <li key={choice.serviceAccountId}>
                <button
                  type="button"
                  onClick={() => void selectAccount(choice)}
                  className="w-full px-3 py-2 text-left text-sm hover:bg-slate-50"
                >
                  <span className="font-mono">{choice.serviceAccountNumber}</span> ·{" "}
                  {choice.subscriberName} · {choice.planName}
                </button>
              </li>
            ))}
          </ul>
        )}

        {selectedAccount !== null && (
          <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
            Selected: <span className="font-mono">{selectedAccount.serviceAccountNumber}</span> ·{" "}
            {selectedAccount.subscriberName}
          </div>
        )}
      </section>

      {summary !== null && (
        <section className="space-y-3 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-base font-medium">2. Outstanding invoices</h2>
          {summary.outstandingInvoices.length === 0 ? (
            <p className="text-sm text-slate-500">Nothing is outstanding on this account.</p>
          ) : (
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="px-3 py-2 font-medium">Invoice</th>
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 font-medium">Due</th>
                  <th className="px-3 py-2 font-medium">Balance</th>
                </tr>
              </thead>
              <tbody>
                {summary.outstandingInvoices.map((invoice) => (
                  <tr key={invoice.id} className="border-t border-slate-100">
                    <td className="px-3 py-2 font-mono">{invoice.invoiceNumber}</td>
                    <td className="px-3 py-2">{formatDateOnly(invoice.invoiceDate)}</td>
                    <td className="px-3 py-2">{formatDateOnly(invoice.dueDate)}</td>
                    <td className="px-3 py-2">{formatCentavos(invoice.remainingBalanceCentavos)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="flex justify-between border-t border-slate-200 pt-2 text-sm">
            <span className="text-slate-600">Total outstanding</span>
            <span className="font-medium">{formatCentavos(summary.outstandingTotalCentavos)}</span>
          </div>
          {summary.creditBalanceCentavos > 0 && (
            <div className="flex justify-between text-sm">
              <span className="text-slate-600">Advance credit</span>
              <span className="font-medium text-emerald-700">
                {formatCentavos(summary.creditBalanceCentavos)}
              </span>
            </div>
          )}
        </section>
      )}

      {summary !== null && (
        <section className="space-y-4 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-base font-medium">3. Payment</h2>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block space-y-1">
              <span className="text-sm font-medium text-slate-700">Amount (₱)</span>
              <input
                type="text"
                inputMode="decimal"
                value={amountText}
                onChange={(event) => setAmountText(event.target.value)}
                placeholder="999.00"
                className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
              />
              {amountCentavos !== null && (
                <span className="text-xs text-slate-500">{formatCentavos(amountCentavos)}</span>
              )}
            </label>

            <label className="block space-y-1">
              <span className="text-sm font-medium text-slate-700">Payment date</span>
              <input
                type="date"
                value={paymentDate}
                onChange={(event) => setPaymentDate(event.target.value)}
                className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
              />
            </label>
          </div>

          <div className="flex gap-2">
            {(["cash", "gcash"] as const).map((method) => (
              <button
                key={method}
                type="button"
                onClick={() => setPaymentMethod(method)}
                className={`rounded border px-4 py-2 text-sm font-medium ${
                  paymentMethod === method
                    ? "border-slate-800 bg-slate-800 text-white"
                    : "border-slate-300 text-slate-700"
                }`}
              >
                {PAYMENT_METHOD_LABELS[method]}
              </button>
            ))}
          </div>

          {paymentMethod === "gcash" && (
            <div className="space-y-3 rounded border border-slate-200 bg-slate-50 p-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block space-y-1">
                  <span className="text-sm font-medium text-slate-700">Reference number</span>
                  <input
                    type="text"
                    value={gcashReference}
                    onChange={(event) => setGcashReference(event.target.value)}
                    className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-sm font-medium text-slate-700">Sender name</span>
                  <input
                    type="text"
                    value={gcashSenderName}
                    onChange={(event) => setGcashSenderName(event.target.value)}
                    className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-sm font-medium text-slate-700">Sender GCash number</span>
                  <input
                    type="text"
                    value={gcashSenderNumber}
                    onChange={(event) => setGcashSenderNumber(event.target.value)}
                    className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-sm font-medium text-slate-700">Screenshot proof</span>
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    onChange={(event) => void handleScreenshotChosen(event.target.files?.[0])}
                    className="w-full text-sm"
                  />
                  {screenshot !== null && (
                    <span className="text-xs text-emerald-700">Uploaded {screenshot.fileName}</span>
                  )}
                </label>
              </div>
            </div>
          )}

          <label className="block space-y-1">
            <span className="text-sm font-medium text-slate-700">Notes (optional)</span>
            <textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              rows={2}
              className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
            />
          </label>

          {preview.length > 0 && (
            <div className="rounded border border-slate-200 bg-white p-3 text-sm">
              <p className="font-medium">This payment will be applied as follows:</p>
              {preview.map((line) => (
                <div key={line.label} className="flex justify-between border-t border-slate-100 pt-1">
                  <span>{line.label}</span>
                  <span>{formatCentavos(line.amountCentavos)}</span>
                </div>
              ))}
            </div>
          )}

          <button
            type="button"
            onClick={() => void submitPayment()}
            disabled={isPosting || amountCentavos === null || amountCentavos <= 0}
            className="rounded bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
          >
            {isPosting ? "Posting…" : "Post Payment"}
          </button>
        </section>
      )}
    </main>
  );
}
