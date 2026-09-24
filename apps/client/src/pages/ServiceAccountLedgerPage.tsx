import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import {
  LEDGER_ENTRY_TYPE_LABELS,
  LOW_BALANCE_THRESHOLD_CENTAVOS,
  SERVICE_ACCOUNT_STATUS_LABELS,
  SERVICE_TYPE_LABELS,
  roleHasPermission,
} from "@bcis/shared";
import {
  extractApiErrorMessage,
  getServiceAccountLedger,
  postManualLedgerEntry,
  verifyLedgerIntegrity,
  type LedgerIntegrityResult,
  type ServiceAccountLedger,
} from "../lib/api-client";
import { formatCentavos, formatDateOnly, parsePesosToCentavos } from "../lib/format";
import { useAuthStore } from "../stores/auth.store";

/** Green when paid up, amber while a small balance remains, red when overdue. */
function balanceToneClass(balanceCentavos: number): string {
  if (balanceCentavos <= 0) {
    return "text-emerald-700";
  }
  if (balanceCentavos <= LOW_BALANCE_THRESHOLD_CENTAVOS) {
    return "text-amber-700";
  }
  return "text-red-700";
}

/** The date part of an ISO timestamp, for the `formatDateOnly` helper. */
function toDateOnly(isoTimestamp: string): string {
  return isoTimestamp.slice(0, 10);
}

/**
 * Service account ledger: the account header, the running balance, and every
 * financial entry in order. The balance shown is always computed from the ledger.
 */
export function ServiceAccountLedgerPage(): ReactNode {
  const { id } = useParams<{ id: string }>();
  const user = useAuthStore((state) => state.user);

  const [ledger, setLedger] = useState<ServiceAccountLedger | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [integrity, setIntegrity] = useState<LedgerIntegrityResult | null>(null);

  const [manualType, setManualType] = useState<"manual_debit" | "manual_credit">("manual_debit");
  const [manualAmount, setManualAmount] = useState("");
  const [manualReason, setManualReason] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const canVerify = user !== null && roleHasPermission(user.role, "ledger:verify");
  const canAdjust = user !== null && roleHasPermission(user.role, "ledger:adjust");

  const loadLedger = useCallback(async (): Promise<void> => {
    if (id === undefined) {
      return;
    }
    setIsLoading(true);
    setErrorMessage(null);
    try {
      setLedger(
        await getServiceAccountLedger(id, {
          fromDate: fromDate === "" ? undefined : fromDate,
          toDate: toDate === "" ? undefined : toDate,
        })
      );
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  }, [id, fromDate, toDate]);

  useEffect(() => {
    void loadLedger();
  }, [loadLedger]);

  async function runIntegrityCheck(): Promise<void> {
    if (id === undefined) {
      return;
    }
    setIntegrity(null);
    try {
      setIntegrity(await verifyLedgerIntegrity(id));
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    }
  }

  async function submitManualEntry(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (id === undefined) {
      return;
    }

    const amountCentavos = parsePesosToCentavos(manualAmount);
    if (amountCentavos === null || amountCentavos <= 0) {
      setErrorMessage("Enter an amount greater than zero, e.g. 500.00.");
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      const result = await postManualLedgerEntry({
        serviceAccountId: id,
        entryType: manualType,
        amountCentavos,
        reason: manualReason,
      });
      setStatusMessage(
        `Adjustment recorded. New balance: ${formatCentavos(result.balanceCentavos)}.`
      );
      setManualAmount("");
      setManualReason("");
      await loadLedger();
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  if (isLoading && ledger === null) {
    return (
      <main className="mx-auto max-w-5xl p-8">
        <p className="text-sm text-slate-500">Loading ledger…</p>
      </main>
    );
  }

  if (ledger === null) {
    return (
      <main className="mx-auto max-w-5xl space-y-4 p-8">
        <p
          role="alert"
          className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {errorMessage ?? "Ledger not found."}
        </p>
        <Link to="/subscribers" className="text-sm font-medium text-slate-700 underline">
          Back to subscribers
        </Link>
      </main>
    );
  }

  const { header } = ledger;
  const balance = header.balanceCentavos;

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-8">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
              {SERVICE_TYPE_LABELS[header.serviceType]}
            </span>
            <span className="font-mono text-xs text-slate-500">{header.serviceAccountNumber}</span>
          </div>
          <h1 className="text-xl font-semibold">{header.planName}</h1>
          <p className="text-sm text-slate-600">
            {header.subscriberName} · {SERVICE_ACCOUNT_STATUS_LABELS[header.status]} ·{" "}
            {header.entryCount} ledger {header.entryCount === 1 ? "entry" : "entries"}
          </p>
        </div>
        <div className="text-right">
          <p className="text-sm text-slate-600">Current balance</p>
          <p className={`text-3xl font-semibold ${balanceToneClass(balance)}`}>
            {formatCentavos(balance)}
          </p>
          <p className="text-xs text-slate-500">
            {balance > 0 ? "Amount owed" : balance < 0 ? "Advance credit" : "Paid up"}
          </p>
          <Link
            to={`/service-accounts/${header.serviceAccountId}/statement`}
            className="mt-2 inline-block rounded border border-slate-300 px-3 py-1.5 text-sm font-medium"
          >
            Export Statement
          </Link>
        </div>
      </div>

      {statusMessage !== null && (
        <p className="rounded border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {statusMessage}
        </p>
      )}
      {errorMessage !== null && (
        <p
          role="alert"
          className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {errorMessage}
        </p>
      )}

      <section className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-4">
        <label className="space-y-1 text-sm">
          <span className="block text-slate-600">From</span>
          <input
            type="date"
            value={fromDate}
            onChange={(event) => setFromDate(event.target.value)}
            className="rounded border border-slate-300 px-2 py-1"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="block text-slate-600">To</span>
          <input
            type="date"
            value={toDate}
            onChange={(event) => setToDate(event.target.value)}
            className="rounded border border-slate-300 px-2 py-1"
          />
        </label>
        <button
          type="button"
          onClick={() => void loadLedger()}
          className="rounded bg-slate-800 px-3 py-1.5 text-sm font-medium text-white"
        >
          Apply filter
        </button>
        {(fromDate !== "" || toDate !== "") && (
          <button
            type="button"
            onClick={() => {
              setFromDate("");
              setToDate("");
            }}
            className="rounded border border-slate-300 px-3 py-1.5 text-sm"
          >
            Clear
          </button>
        )}
        {canVerify && (
          <button
            type="button"
            onClick={() => void runIntegrityCheck()}
            className="ml-auto rounded border border-slate-300 px-3 py-1.5 text-sm"
          >
            Verify integrity
          </button>
        )}
      </section>

      {integrity !== null && (
        <p
          className={
            integrity.isValid
              ? "rounded border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
              : "rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700"
          }
        >
          {integrity.isValid
            ? `Ledger chain is sound (${integrity.entryCount} entries, closing ${formatCentavos(integrity.lastComputedBalanceCentavos)}).`
            : `Ledger integrity FAILED (${integrity.failure}). Computed ${formatCentavos(integrity.lastComputedBalanceCentavos)}, stored ${formatCentavos(integrity.lastStoredBalanceCentavos)}.`}
        </p>
      )}

      <table className="w-full border-collapse bg-white text-left text-sm shadow-sm">
        <thead className="bg-slate-50 text-slate-600">
          <tr>
            <th className="border-b border-slate-200 px-3 py-2 font-medium">Date</th>
            <th className="border-b border-slate-200 px-3 py-2 font-medium">Description</th>
            <th className="border-b border-slate-200 px-3 py-2 text-right font-medium">Debit</th>
            <th className="border-b border-slate-200 px-3 py-2 text-right font-medium">Credit</th>
            <th className="border-b border-slate-200 px-3 py-2 text-right font-medium">Balance</th>
            <th className="border-b border-slate-200 px-3 py-2 font-medium">Reference</th>
          </tr>
        </thead>
        <tbody>
          {ledger.items.map((entry) => (
            <tr key={entry.id} className="border-b border-slate-100">
              <td className="px-3 py-2 whitespace-nowrap">
                {formatDateOnly(toDateOnly(entry.entryDate))}
              </td>
              <td className="px-3 py-2">
                <span className="block">{entry.description}</span>
                <span className="text-xs text-slate-500">
                  {LEDGER_ENTRY_TYPE_LABELS[entry.entryType]}
                </span>
              </td>
              <td className="px-3 py-2 text-right">
                {entry.debitCentavos > 0 ? formatCentavos(entry.debitCentavos) : "—"}
              </td>
              <td className="px-3 py-2 text-right">
                {entry.creditCentavos > 0 ? formatCentavos(entry.creditCentavos) : "—"}
              </td>
              <td className="px-3 py-2 text-right font-medium">
                {formatCentavos(entry.runningBalanceCentavos)}
              </td>
              <td className="px-3 py-2 font-mono text-xs text-slate-600">
                {entry.referenceNumber === "" ? "—" : entry.referenceNumber}
              </td>
            </tr>
          ))}
          {ledger.items.length === 0 && (
            <tr>
              <td colSpan={6} className="px-3 py-6 text-center text-sm text-slate-500">
                No ledger entries for this account in the selected period.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {ledger.total > ledger.items.length && (
        <p className="text-xs text-slate-500">
          Showing {ledger.items.length} of {ledger.total} entries.
        </p>
      )}

      {canAdjust && (
        <section className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-600">
            Manual adjustment (Admin)
          </h2>
          <form
            onSubmit={(event) => void submitManualEntry(event)}
            className="flex flex-wrap items-end gap-3"
          >
            <label className="space-y-1 text-sm">
              <span className="block text-slate-600">Type</span>
              <select
                value={manualType}
                onChange={(event) =>
                  setManualType(event.target.value as "manual_debit" | "manual_credit")
                }
                className="rounded border border-slate-300 px-2 py-1"
              >
                <option value="manual_debit">Manual debit (charge)</option>
                <option value="manual_credit">Manual credit</option>
              </select>
            </label>
            <label className="space-y-1 text-sm">
              <span className="block text-slate-600">Amount</span>
              <input
                type="text"
                inputMode="decimal"
                value={manualAmount}
                onChange={(event) => setManualAmount(event.target.value)}
                placeholder="0.00"
                className="w-32 rounded border border-slate-300 px-2 py-1"
              />
            </label>
            <label className="min-w-64 flex-1 space-y-1 text-sm">
              <span className="block text-slate-600">Justification (at least 10 characters)</span>
              <input
                type="text"
                value={manualReason}
                onChange={(event) => setManualReason(event.target.value)}
                className="w-full rounded border border-slate-300 px-2 py-1"
              />
            </label>
            <button
              type="submit"
              disabled={isSubmitting}
              className="rounded bg-slate-800 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              Post adjustment
            </button>
          </form>
        </section>
      )}
    </main>
  );
}
