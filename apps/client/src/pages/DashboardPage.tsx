import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { roleHasPermission } from "@bcis/shared";
import {
  extractApiErrorMessage,
  getArAgingReport,
  getDashboardKpis,
  listPayments,
  type ArAgingReport,
  type DashboardKpis,
  type PaymentSummary,
} from "../lib/api-client";
import { formatCentavos, formatDateOnly } from "../lib/format";
import { useAuthStore } from "../stores/auth.store";

/** How many of the most recent payments the dashboard shows. */
const RECENT_PAYMENT_COUNT = 10;

/** The aging buckets, in the order the mini chart and the totals read them. */
const AGING_BUCKETS = [
  { key: "current", label: "Current", barClass: "bg-emerald-600" },
  { key: "bucket_1_30", label: "1-30 Days", barClass: "bg-yellow-500" },
  { key: "bucket_31_60", label: "31-60 Days", barClass: "bg-orange-500" },
  { key: "bucket_61_90", label: "61-90 Days", barClass: "bg-red-600" },
  { key: "over_90", label: "90+ Days", barClass: "bg-red-900" },
] as const;

/** One KPI card: a label and the figure it claims, formatted by the caller. */
function KpiCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}): ReactNode {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-xl font-semibold">{value}</p>
      {hint !== undefined && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

/** A horizontal bar chart of the outstanding balance per aging bucket. */
function ArAgingMiniChart({ aging }: { aging: ArAgingReport }): ReactNode {
  const grandTotal = aging.totals.grandTotal;

  return (
    <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-medium">AR Aging</h2>
        <span className="text-sm font-semibold">{formatCentavos(grandTotal)}</span>
      </div>

      {grandTotal === 0 ? (
        <p className="text-sm text-slate-500">
          Nothing outstanding as of {formatDateOnly(aging.asOfDate)}.
        </p>
      ) : (
        <ul className="space-y-2">
          {AGING_BUCKETS.map((bucket) => {
            const amountCentavos = aging.totals[bucket.key];
            // Widths are a share of the grand total; a bucket of zero still shows a
            // hairline so the row stays visible.
            const widthPercent = grandTotal === 0 ? 0 : (amountCentavos / grandTotal) * 100;

            return (
              <li key={bucket.key}>
                <div className="flex justify-between text-xs text-slate-600">
                  <span>{bucket.label}</span>
                  <span>{formatCentavos(amountCentavos)}</span>
                </div>
                <div className="mt-1 h-2 w-full rounded bg-slate-100">
                  <div
                    className={`h-2 rounded ${bucket.barClass}`}
                    style={{ width: `${widthPercent}%` }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Link to="/receivables/aging" className="inline-block text-sm text-slate-800 underline">
        Open the full AR aging report
      </Link>
    </div>
  );
}

/**
 * The Management Dashboard — the first screen after login for an Administrator or
 * a Manager.
 *
 * Each figure shown here is the one the server computed; the page never adds money
 * up itself, so it cannot disagree with the report it summarises.
 */
export function DashboardPage(): ReactNode {
  const user = useAuthStore((state) => state.user);
  const canExportReports = user !== null && roleHasPermission(user.role, "reports:export");

  const [kpis, setKpis] = useState<DashboardKpis | null>(null);
  const [aging, setAging] = useState<ArAgingReport | null>(null);
  const [recentPayments, setRecentPayments] = useState<PaymentSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const loadDashboard = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const [kpiResult, agingResult, paymentResult] = await Promise.all([
        getDashboardKpis(),
        getArAgingReport(),
        listPayments(),
      ]);
      setKpis(kpiResult);
      setAging(agingResult);
      setRecentPayments(paymentResult.slice(0, RECENT_PAYMENT_COUNT));
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  return (
    <main className="mx-auto max-w-6xl space-y-6 p-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Management Dashboard</h1>
          <p className="text-sm text-slate-600">
            {kpis === null
              ? "Loading the pulse of the business…"
              : `Last billing run: ${kpis.lastBillingRunDate === null ? "never" : formatDateOnly(kpis.lastBillingRunDate)}`}
          </p>
        </div>
        <nav className="flex items-center gap-3 text-sm font-medium">
          <Link to="/reports" className="text-slate-800 underline">
            Reports Center
          </Link>
          <Link to="/" className="text-slate-800 underline">
            Home
          </Link>
        </nav>
      </header>

      {errorMessage !== null && <p className="text-sm text-red-700">{errorMessage}</p>}

      {isLoading || kpis === null || aging === null ? (
        <p className="text-slate-500">Loading the dashboard…</p>
      ) : (
        <>
          {kpis.submittedBatchesPendingReconciliation > 0 && (
            <section className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
              <p className="font-medium">
                {kpis.submittedBatchesPendingReconciliation} collector batch(es) awaiting
                reconciliation.
              </p>
              <Link to="/collector-batches" className="underline">
                Open the collector batches
              </Link>
            </section>
          )}

          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <KpiCard
              label="Active Accounts"
              value={kpis.totalActiveServiceAccounts.toLocaleString("en-PH")}
              hint={`${kpis.newServiceAccountsThisMonth} new this month`}
            />
            <KpiCard
              label="Monthly Invoiced"
              value={formatCentavos(kpis.totalInvoicedThisMonthCentavos)}
              hint="Calendar month to date"
            />
            <KpiCard
              label="Monthly Collected"
              value={formatCentavos(kpis.totalCollectedThisMonthCentavos)}
              hint="Posted payments only"
            />
            <KpiCard
              label="Collection Rate"
              value={`${kpis.collectionRatePercent}%`}
              hint="Collected / invoiced"
            />
            <KpiCard
              label="Total Outstanding AR"
              value={formatCentavos(kpis.totalOutstandingArCentavos)}
              hint="As of today"
            />
            <KpiCard
              label="Overdue 30+ Days"
              value={formatCentavos(kpis.overdueOver30DaysCentavos)}
              hint="More than 30 days past due"
            />
            <KpiCard
              label="Overdue 90+ Days"
              value={formatCentavos(kpis.overdueOver90DaysCentavos)}
              hint="More than 90 days past due"
            />
            <KpiCard
              label="Suspended / Terminated"
              value={`${kpis.suspendedAccounts} / ${kpis.terminatedAccounts}`}
              hint={`${kpis.openCollectorBatches} open batch(es)`}
            />
          </section>

          <ArAgingMiniChart aging={aging} />

          <section className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
            <h2 className="px-4 py-3 text-sm font-medium">Recent payments</h2>
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-slate-600">
                <tr>
                  <th className="px-4 py-2">Receipt #</th>
                  <th className="px-4 py-2">Date</th>
                  <th className="px-4 py-2">Subscriber</th>
                  <th className="px-4 py-2">Method</th>
                  <th className="px-4 py-2 text-right">Amount</th>
                  <th className="px-4 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {recentPayments.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-6 text-center text-slate-500">
                      No payments have been posted yet.
                    </td>
                  </tr>
                ) : (
                  recentPayments.map((payment) => (
                    <tr key={payment.id} className="border-t border-slate-100">
                      <td className="px-4 py-2 font-mono text-xs">
                        <Link to={`/payments/${payment.id}`} className="underline">
                          {payment.receiptNumber}
                        </Link>
                      </td>
                      <td className="px-4 py-2">{formatDateOnly(payment.paymentDate)}</td>
                      <td className="px-4 py-2">{payment.subscriberName}</td>
                      <td className="px-4 py-2">{payment.paymentMethod}</td>
                      <td className="px-4 py-2 text-right">
                        {formatCentavos(payment.amountCentavos)}
                      </td>
                      <td className="px-4 py-2">{payment.status}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </section>

          <p className="text-xs text-slate-500">
            {canExportReports
              ? "You may export reports from the Reports Center."
              : "Your role may view reports but not take a copy out of the building."}
          </p>
        </>
      )}
    </main>
  );
}
