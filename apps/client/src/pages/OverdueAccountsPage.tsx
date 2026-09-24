import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { roleHasPermission } from "@bcis/shared";
import {
  extractApiErrorMessage,
  getOverdueAccounts,
  suspendOverdueAccounts,
  type OverdueAccount,
} from "../lib/api-client";
import { formatCentavos, formatDateOnly } from "../lib/format";
import { useAuthStore } from "../stores/auth.store";

/** Overdue service accounts, with bulk suspension of the selected ones. */
export function OverdueAccountsPage(): ReactNode {
  const user = useAuthStore((state) => state.user);

  const [accounts, setAccounts] = useState<OverdueAccount[]>([]);
  const [noPaymentInDays, setNoPaymentInDays] = useState("");
  const [minMonths, setMinMonths] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const loadAccounts = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const result = await getOverdueAccounts({
        noPaymentInDays: noPaymentInDays === "" ? undefined : Number.parseInt(noPaymentInDays, 10),
        minConsecutiveOverdueMonths:
          minMonths === "" ? undefined : Number.parseInt(minMonths, 10),
      });
      setAccounts(result.items);
      setSelectedIds([]);
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  }, [noPaymentInDays, minMonths]);

  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);

  const canSuspend = user !== null && roleHasPermission(user.role, "subscribers:suspend");

  function toggle(serviceAccountId: string): void {
    setSelectedIds((current) =>
      current.includes(serviceAccountId)
        ? current.filter((id) => id !== serviceAccountId)
        : [...current, serviceAccountId]
    );
  }

  async function handleSuspendSelected(): Promise<void> {
    if (selectedIds.length === 0) {
      return;
    }
    const reason = window.prompt("Reason for suspending the selected accounts?");
    if (reason === null || reason.trim().length < 5) {
      setErrorMessage("A suspension reason of at least 5 characters is required.");
      return;
    }

    setErrorMessage(null);
    setStatusMessage(null);
    try {
      const result = await suspendOverdueAccounts(selectedIds, reason.trim());
      setStatusMessage(
        `Suspended ${result.suspended.length} account(s).` +
          (result.failed.length > 0 ? ` ${result.failed.length} could not be suspended.` : "")
      );
      await loadAccounts();
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    }
  }

  return (
    <main className="mx-auto max-w-6xl space-y-6 p-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Overdue Accounts</h1>
        <Link to="/receivables/aging" className="text-sm text-slate-800 underline">
          AR aging report
        </Link>
      </header>

      <section className="flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="block text-slate-600">No payment in (days)</span>
          <input
            type="number"
            min={0}
            value={noPaymentInDays}
            onChange={(event) => setNoPaymentInDays(event.target.value)}
            placeholder="e.g. 60"
            className="w-32 rounded border border-slate-300 px-2 py-1"
          />
        </label>
        <label className="text-sm">
          <span className="block text-slate-600">Consecutive overdue months ≥</span>
          <input
            type="number"
            min={0}
            value={minMonths}
            onChange={(event) => setMinMonths(event.target.value)}
            placeholder="e.g. 3"
            className="w-32 rounded border border-slate-300 px-2 py-1"
          />
        </label>
        {canSuspend && (
          <button
            type="button"
            onClick={() => void handleSuspendSelected()}
            disabled={selectedIds.length === 0}
            className="rounded bg-red-700 px-3 py-1.5 text-sm text-white disabled:opacity-50"
          >
            Suspend Selected ({selectedIds.length})
          </button>
        )}
      </section>

      {errorMessage !== null && <p className="text-sm text-red-700">{errorMessage}</p>}
      {statusMessage !== null && <p className="text-sm text-emerald-700">{statusMessage}</p>}

      <section className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-left text-slate-600">
            <tr>
              {canSuspend && <th className="px-4 py-3"> </th>}
              <th className="px-4 py-3">Account #</th>
              <th className="px-4 py-3">Subscriber</th>
              <th className="px-4 py-3">Plan</th>
              <th className="px-4 py-3">Consecutive Overdue Months</th>
              <th className="px-4 py-3">Total Overdue</th>
              <th className="px-4 py-3">Collector</th>
              <th className="px-4 py-3">Last Payment</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-slate-500">
                  Loading overdue accounts…
                </td>
              </tr>
            ) : accounts.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-slate-500">
                  No overdue accounts match these filters.
                </td>
              </tr>
            ) : (
              accounts.map((account) => (
                <tr key={account.serviceAccountId} className="border-t border-slate-100">
                  {canSuspend && (
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={selectedIds.includes(account.serviceAccountId)}
                        onChange={() => toggle(account.serviceAccountId)}
                      />
                    </td>
                  )}
                  <td className="px-4 py-3 font-mono text-xs">{account.serviceAccountNumber}</td>
                  <td className="px-4 py-3">{account.subscriberName}</td>
                  <td className="px-4 py-3">{account.planName}</td>
                  <td className="px-4 py-3">{account.consecutiveOverdueMonths}</td>
                  <td className="px-4 py-3 text-red-700">
                    {formatCentavos(account.totalOverdueCentavos)}
                  </td>
                  <td className="px-4 py-3">{account.collectorName ?? "Office"}</td>
                  <td className="px-4 py-3">{formatDateOnly(account.lastPaymentDate)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </main>
  );
}