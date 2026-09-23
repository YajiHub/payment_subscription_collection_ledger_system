import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { getMonthName, roleHasPermission } from "@bcis/shared";
import {
  applyLateFees,
  extractApiErrorMessage,
  listBillingRuns,
  postAllDraftInvoices,
  previewMonthlyBilling,
  runMonthlyBilling,
  type BillingPreview,
  type BillingRunRecord,
} from "../lib/api-client";
import { formatCentavos } from "../lib/format";
import { useAuthStore } from "../stores/auth.store";

const MONTH_NUMBERS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;

interface BillingPeriod {
  year: number;
  month: number;
}

/** The month the office is most likely to bill: the current one. */
function currentPeriod(): BillingPeriod {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

/** The billing run history table. Presentational only. */
function BillingRunTable({
  runs,
  isLoading,
}: {
  runs: BillingRunRecord[];
  isLoading: boolean;
}): ReactNode {
  if (isLoading) {
    return (
      <tbody>
        <tr>
          <td colSpan={7} className="px-4 py-6 text-center text-slate-500">
            Loading billing runs…
          </td>
        </tr>
      </tbody>
    );
  }

  if (runs.length === 0) {
    return (
      <tbody>
        <tr>
          <td colSpan={7} className="px-4 py-6 text-center text-slate-500">
            The billing job has not been run yet.
          </td>
        </tr>
      </tbody>
    );
  }

  return (
    <tbody>
      {runs.map((run) => (
        <tr key={run.id} className="border-t border-slate-100">
          <td className="px-4 py-3">
            {getMonthName(run.billingPeriodMonth)} {run.billingPeriodYear}
          </td>
          <td className="px-4 py-3">{run.totalServiceAccountsProcessed}</td>
          <td className="px-4 py-3">{run.totalInvoicesGenerated}</td>
          <td className="px-4 py-3">{formatCentavos(run.totalAmountBilledCentavos)}</td>
          <td className="px-4 py-3">{run.status}</td>
          <td className="px-4 py-3">{run.ranBy}</td>
          <td className="px-4 py-3">{new Date(run.ranAt).toLocaleString()}</td>
        </tr>
      ))}
    </tbody>
  );
}

/**
 * Billing Dashboard: run the monthly billing job (after a preview and
 * confirmation), bulk-post the drafts, apply late fees, and read the run history.
 */
export function BillingDashboardPage(): ReactNode {
  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);

  const [period, setPeriod] = useState<BillingPeriod>(currentPeriod);
  const [preview, setPreview] = useState<BillingPreview | null>(null);
  const [runs, setRuns] = useState<BillingRunRecord[]>([]);
  const [isLoadingRuns, setIsLoadingRuns] = useState(true);
  const [isBusy, setIsBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const canGenerate = user !== null && roleHasPermission(user.role, "invoices:generate");

  const loadRuns = useCallback(async (): Promise<void> => {
    setIsLoadingRuns(true);
    try {
      setRuns(await listBillingRuns());
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsLoadingRuns(false);
    }
  }, []);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  async function openPreview(): Promise<void> {
    setIsBusy(true);
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      setPreview(await previewMonthlyBilling(period.year, period.month));
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsBusy(false);
    }
  }

  async function confirmRun(): Promise<void> {
    setIsBusy(true);
    setErrorMessage(null);
    try {
      const result = await runMonthlyBilling(period.year, period.month);
      setPreview(null);
      setStatusMessage(
        `Generated ${result.totalInvoicesGenerated} invoice(s) totalling ` +
          `${formatCentavos(result.totalAmountBilledCentavos)}. ` +
          `${result.totalInvoicesSkipped} account(s) were already billed.`
      );
      await loadRuns();
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsBusy(false);
    }
  }

  async function postAllDrafts(): Promise<void> {
    setIsBusy(true);
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      const result = await postAllDraftInvoices(period.year, period.month);
      setStatusMessage(`Posted ${result.posted} draft invoice(s).`);
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsBusy(false);
    }
  }

  async function chargeLateFees(): Promise<void> {
    setIsBusy(true);
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      const result = await applyLateFees();
      setStatusMessage(
        `Charged ${formatCentavos(result.lateFeeCentavos)} to ${result.invoicesCharged} overdue ` +
          `invoice(s).`
      );
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-6xl space-y-6 p-8">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Billing Dashboard</h1>
          <p className="text-sm text-slate-600">
            Generate, review, and post the monthly invoices.
          </p>
        </div>
        <nav className="flex items-center gap-3 text-sm font-medium">
          <Link to="/invoices" className="text-slate-800 underline">
            Invoices
          </Link>
          <Link to="/" className="text-slate-700 underline">
            Dashboard
          </Link>
        </nav>
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

      <section className="space-y-4 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-medium">Billing period</h2>
        <div className="flex flex-wrap items-end gap-3">
          <label className="space-y-1">
            <span className="text-sm font-medium text-slate-700">Month</span>
            <select
              value={period.month}
              onChange={(event) =>
                setPeriod({ ...period, month: Number.parseInt(event.target.value, 10) })
              }
              className="rounded border border-slate-300 px-3 py-2 text-sm"
            >
              {MONTH_NUMBERS.map((monthNumber) => (
                <option key={monthNumber} value={monthNumber}>
                  {getMonthName(monthNumber)}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-sm font-medium text-slate-700">Year</span>
            <input
              type="number"
              value={period.year}
              onChange={(event) =>
                setPeriod({ ...period, year: Number.parseInt(event.target.value, 10) })
              }
              className="w-28 rounded border border-slate-300 px-3 py-2 text-sm"
            />
          </label>

          {canGenerate && (
            <button
              type="button"
              onClick={() => void openPreview()}
              disabled={isBusy}
              className="rounded bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
            >
              Run Monthly Billing
            </button>
          )}
          {canGenerate && (
            <button
              type="button"
              onClick={() => void postAllDrafts()}
              disabled={isBusy}
              className="rounded border border-slate-300 px-4 py-2 text-sm font-medium disabled:opacity-50"
            >
              Post All Draft
            </button>
          )}
          {canGenerate && (
            <button
              type="button"
              onClick={() => void chargeLateFees()}
              disabled={isBusy}
              className="rounded border border-amber-400 px-4 py-2 text-sm font-medium text-amber-800 disabled:opacity-50"
            >
              Apply Late Fees
            </button>
          )}
        </div>
      </section>

      {preview !== null && (
        <div className="fixed inset-0 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="w-full max-w-md space-y-4 rounded-lg bg-white p-6 shadow-lg">
            <h2 className="text-base font-medium">Confirm monthly billing</h2>
            <p className="text-sm text-slate-700">
              This will generate invoices for {preview.accountsToBill} account(s) totalling{" "}
              <strong>{formatCentavos(preview.totalAmountCentavos)}</strong>. Proceed?
            </p>
            <p className="text-xs text-slate-500">
              {preview.accountsAlreadyBilled} account(s) already have an invoice for this period and
              will be skipped.
            </p>
            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setPreview(null)}
                className="rounded border border-slate-300 px-4 py-2 text-sm font-medium"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void confirmRun()}
                disabled={isBusy}
                className="rounded bg-slate-800 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                Proceed
              </button>
            </div>
          </div>
        </div>
      )}

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-medium">Billing run history</h2>
          <button
            type="button"
            onClick={() => navigate("/invoices")}
            className="text-sm font-medium text-slate-700 underline"
          >
            View invoices
          </button>
        </div>
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="px-4 py-3 font-medium">Period</th>
                <th className="px-4 py-3 font-medium">Accounts</th>
                <th className="px-4 py-3 font-medium">Generated</th>
                <th className="px-4 py-3 font-medium">Total</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">By</th>
                <th className="px-4 py-3 font-medium">Date</th>
              </tr>
            </thead>
            <BillingRunTable runs={runs} isLoading={isLoadingRuns} />
          </table>
        </div>
      </section>
    </main>
  );
}
