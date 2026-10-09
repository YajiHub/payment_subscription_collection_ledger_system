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
import { AppShell } from "../components/layout/AppShell";

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
          <td colSpan={7} className="px-4 py-6 text-center text-content-secondary">
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
          <td colSpan={7} className="px-4 py-6 text-center text-content-secondary">
            The billing job has not been run yet.
          </td>
        </tr>
      </tbody>
    );
  }

  return (
    <tbody>
      {runs.map((run) => (
        <tr key={run.id} className="border-t border-line">
          <td className="px-4 py-3">
            {getMonthName(run.billingPeriodMonth)} {run.billingPeriodYear}
          </td>
          <td className="px-4 py-3 text-right tabular-nums">
            {run.totalServiceAccountsProcessed}
          </td>
          <td className="px-4 py-3 text-right tabular-nums">
            {run.totalInvoicesGenerated}
          </td>
          <td className="px-4 py-3 text-right tabular-nums">
            {formatCentavos(run.totalAmountBilledCentavos)}
          </td>
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
    <AppShell
      pageTitle="Billing Dashboard"
      pageDescription="Generate, review, and post the monthly invoices."
      headerActions={
        <Link
          to="/invoices"
          className="inline-flex h-9 items-center rounded-lg border border-line-strong bg-surface px-3.5 text-sm font-medium text-content-primary transition-colors hover:bg-canvas"
        >
          View Invoices
        </Link>
      }
    >

      {errorMessage !== null && (
        <p
          role="alert"
          className="rounded border border-danger-line bg-danger-soft px-3 py-2 text-sm text-danger-strong"
        >
          {errorMessage}
        </p>
      )}
      {statusMessage !== null && (
        <p className="rounded border border-success-line bg-success-soft px-3 py-2 text-sm text-success-strong">
          {statusMessage}
        </p>
      )}

      <section className="space-y-4 rounded-lg border border-line bg-surface p-6 shadow-sm">
        <h2 className="text-base font-medium">Billing period</h2>
        <div className="flex flex-wrap items-end gap-3">
          <label className="space-y-1">
            <span className="text-sm font-medium text-content-primary">Month</span>
            <select
              value={period.month}
              onChange={(event) =>
                setPeriod({ ...period, month: Number.parseInt(event.target.value, 10) })
              }
              className="rounded border border-line-strong px-3 py-2 text-sm"
            >
              {MONTH_NUMBERS.map((monthNumber) => (
                <option key={monthNumber} value={monthNumber}>
                  {getMonthName(monthNumber)}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-sm font-medium text-content-primary">Year</span>
            <input
              type="number"
              value={period.year}
              onChange={(event) =>
                setPeriod({ ...period, year: Number.parseInt(event.target.value, 10) })
              }
              className="w-28 rounded border border-line-strong px-3 py-2 text-sm"
            />
          </label>

          {canGenerate && (
            <button
              type="button"
              onClick={() => void openPreview()}
              disabled={isBusy}
              className="rounded bg-navy px-4 py-2 text-sm font-medium text-surface hover:bg-navy-strong disabled:opacity-50"
            >
              Run Monthly Billing
            </button>
          )}
          {canGenerate && (
            <button
              type="button"
              onClick={() => void postAllDrafts()}
              disabled={isBusy}
              className="rounded border border-line-strong px-4 py-2 text-sm font-medium disabled:opacity-50"
            >
              Post All Draft
            </button>
          )}
          {canGenerate && (
            <button
              type="button"
              onClick={() => void chargeLateFees()}
              disabled={isBusy}
              className="rounded border border-warning-line px-4 py-2 text-sm font-medium text-warning-strong disabled:opacity-50"
            >
              Apply Late Fees
            </button>
          )}
        </div>
      </section>

      {preview !== null && (
        <div className="fixed inset-0 flex items-center justify-center bg-content-primary/40 p-4">
          <div className="w-full max-w-md space-y-4 rounded-lg bg-surface p-6 shadow-lg">
            <h2 className="text-base font-medium">Confirm monthly billing</h2>
            <p className="text-sm text-content-primary">
              This will generate invoices for {preview.accountsToBill} account(s) totalling{" "}
              <strong className="tabular-nums">{formatCentavos(preview.totalAmountCentavos)}</strong>. Proceed?
            </p>
            <p className="text-xs text-content-secondary">
              {preview.accountsAlreadyBilled} account(s) already have an invoice for this period and
              will be skipped.
            </p>
            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setPreview(null)}
                className="rounded border border-line-strong px-4 py-2 text-sm font-medium"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void confirmRun()}
                disabled={isBusy}
                className="rounded bg-navy px-4 py-2 text-sm font-medium text-surface disabled:opacity-50"
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
            className="text-sm font-medium text-content-primary underline"
          >
            View invoices
          </button>
        </div>
        <div className="overflow-hidden rounded-lg border border-line bg-surface shadow-sm">
          <table className="w-full text-left text-sm">
            <thead className="bg-canvas text-content-secondary">
              <tr>
                <th className="px-4 py-3 font-medium">Period</th>
                <th className="px-4 py-3 text-right font-medium">Accounts</th>
                <th className="px-4 py-3 text-right font-medium">Generated</th>
                <th className="px-4 py-3 text-right font-medium">Total</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">By</th>
                <th className="px-4 py-3 font-medium">Date</th>
              </tr>
            </thead>
            <BillingRunTable runs={runs} isLoading={isLoadingRuns} />
          </table>
        </div>
      </section>
    </AppShell>
  );
}
