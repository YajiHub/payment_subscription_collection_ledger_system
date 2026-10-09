import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { AppShell } from "../components/layout/AppShell";
import { roleHasPermission } from "@bcis/shared";
import {
  extractApiErrorMessage,
  getArAgingReport,
  getCollectorPerformanceReport,
  getDashboardKpis,
  listPayments,
  type ArAgingReport,
  type CollectorPerformanceReport,
  type DashboardKpis,
  type PaymentSummary,
} from "../lib/api-client";
import { formatCentavos, formatDateOnly } from "../lib/format";
import { useAuthStore } from "../stores/auth.store";

/** How many of the most recent payments the dashboard shows. */
const RECENT_PAYMENT_COUNT = 10;

/** The aging buckets, in the order the mini chart and the totals read them. */
const AGING_BUCKETS = [
  { key: "current", label: "Current", barClass: "bg-success" },
  { key: "bucket_1_30", label: "1-30 Days", barClass: "bg-warning" },
  { key: "bucket_31_60", label: "31-60 Days", barClass: "bg-warning-strong" },
  { key: "bucket_61_90", label: "61-90 Days", barClass: "bg-danger" },
  { key: "over_90", label: "90+ Days", barClass: "bg-danger-strong" },
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
    <div className="min-w-0 rounded-2xl border border-line/90 bg-surface p-5 shadow-xs transition-all duration-200 hover:border-line-strong hover:shadow-md hover:-translate-y-0.5 flex flex-col justify-between">
      <p className="text-xs font-bold tracking-wider text-content-secondary uppercase truncate">{label}</p>
      <p className="mt-2 text-right text-xl sm:text-2xl font-extrabold tracking-tight text-content-primary tabular-nums truncate" title={value}>
        {value}
      </p>
      {hint !== undefined && <p className="mt-1 text-right text-xs text-content-secondary truncate">{hint}</p>}
    </div>
  );
}

/** A horizontal bar chart of the outstanding balance per aging bucket. */
function ArAgingMiniChart({ aging }: { aging: ArAgingReport }): ReactNode {
  const grandTotal = aging.totals.grandTotal;

  return (
    <div className="space-y-4 rounded-2xl border border-line/90 bg-surface p-6 shadow-xs">
      <div className="flex items-baseline justify-between">
        <h2 className="text-base font-bold text-content-primary">AR Aging Analysis</h2>
        <span className="text-base font-extrabold text-content-primary tabular-nums">{formatCentavos(grandTotal)}</span>
      </div>

      {grandTotal === 0 ? (
        <p className="text-sm text-content-secondary">
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
                <div className="flex justify-between text-xs text-content-secondary">
                  <span>{bucket.label}</span>
                  <span className="tabular-nums">{formatCentavos(amountCentavos)}</span>
                </div>
                <div className="mt-1 h-2 w-full rounded bg-canvas">
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

      <Link to="/receivables/aging" className="inline-block text-sm text-content-primary underline">
        Open the full AR aging report
      </Link>
    </div>
  );
}

/**
 * The payment-method summary block (S6-3, section 4.3).
 *
 * Cash and GCash are the split the server's collection rule records; anything else
 * (bank transfer, cheque, other) is the remainder, so the three method lines always
 * add up to the total collected. Every figure comes from the Collector Performance
 * report's month totals — the same numbers the report shows for the same range.
 */
function PaymentMethodSummaryBlock({
  performance,
}: {
  performance: CollectorPerformanceReport;
}): ReactNode {
  const { totals } = performance;
  const otherMethodsCentavos = totals.collectedCentavos - totals.cashCentavos - totals.gcashCentavos;

  const rows = [
    { label: "Cash", amountCentavos: totals.cashCentavos },
    { label: "GCash", amountCentavos: totals.gcashCentavos },
    { label: "Other methods", amountCentavos: otherMethodsCentavos },
  ];

  return (
    <section className="rounded-lg border border-line bg-surface p-4 shadow-sm">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-medium">Payment methods</h2>
        <span className="text-xs text-content-secondary">
          {formatDateOnly(performance.fromDate)} to {formatDateOnly(performance.toDate)}
        </span>
      </div>

      <table className="mt-3 w-full text-sm">
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} className="border-t border-line">
              <th scope="row" className="py-2 text-left font-normal text-content-secondary">
                {row.label}
              </th>
              <td className="py-2 text-right tabular-nums">{formatCentavos(row.amountCentavos)}</td>
            </tr>
          ))}
          <tr className="border-t border-line font-semibold">
            <th scope="row" className="py-2 text-left">
              Collected total
            </th>
            <td className="py-2 text-right tabular-nums">
              {formatCentavos(totals.collectedCentavos)}
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}

/**
 * The collector-performance block (S6-3, section 4.3).
 *
 * One line per collector for the current month: what they collected and the
 * variance between what their batches expected and what was remitted. The numbers
 * are the Collector Performance report's own, so the block cannot disagree with it.
 */
function CollectorPerformanceBlock({
  performance,
}: {
  performance: CollectorPerformanceReport;
}): ReactNode {
  return (
    <section className="rounded-lg border border-line bg-surface p-4 shadow-sm">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-medium">Collector performance</h2>
        <span className="text-xs text-content-secondary">
          {performance.groups.length} collector(s)
        </span>
      </div>

      {performance.groups.length === 0 ? (
        <p className="mt-3 text-sm text-content-secondary">
          No collections have been posted this month.
        </p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-content-secondary">
              <tr>
                <th className="py-2 font-medium">Collector</th>
                <th className="py-2 text-right font-medium">Payments</th>
                <th className="py-2 text-right font-medium">Collected</th>
                <th className="py-2 text-right font-medium">Variance</th>
              </tr>
            </thead>
            <tbody>
              {performance.groups.map((group) => (
                <tr key={group.collectorId ?? group.collectorName} className="border-t border-line">
                  <td className="py-2 text-content-primary">{group.collectorName}</td>
                  <td className="py-2 text-right tabular-nums">{group.paymentCount}</td>
                  <td className="py-2 text-right tabular-nums">
                    {formatCentavos(group.collectedCentavos)}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {group.batchCount === 0 ? "—" : formatCentavos(group.varianceCentavos)}
                  </td>
                </tr>
              ))}
              <tr className="border-t border-line font-semibold">
                <td className="py-2">TOTAL</td>
                <td className="py-2 text-right tabular-nums">{performance.totals.paymentCount}</td>
                <td className="py-2 text-right tabular-nums">
                  {formatCentavos(performance.totals.collectedCentavos)}
                </td>
                <td className="py-2 text-right tabular-nums">
                  {performance.totals.batchCount === 0
                    ? "—"
                    : formatCentavos(performance.totals.varianceCentavos)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </section>
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
  const [performance, setPerformance] = useState<CollectorPerformanceReport | null>(null);
  const [recentPayments, setRecentPayments] = useState<PaymentSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const loadDashboard = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const [kpiResult, agingResult, paymentResult, performanceResult] = await Promise.all([
        getDashboardKpis(),
        getArAgingReport(),
        listPayments({ page: 1, pageSize: RECENT_PAYMENT_COUNT }),
        // The dashboard endpoint returns KPIs only. The payment-method summary and
        // the collector-performance block are the same figures the Collector
        // Performance report computes for the current month, so they reuse that
        // existing endpoint rather than inventing a second calculation that could
        // drift from the report (S6-3).
        getCollectorPerformanceReport(),
      ]);
      setKpis(kpiResult);
      setAging(agingResult);
      setRecentPayments(paymentResult.items);
      setPerformance(performanceResult);
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
    <AppShell
      pageTitle="Management Dashboard"
      pageDescription={
        kpis === null
          ? "Loading the pulse of the business…"
          : `Last billing run: ${kpis.lastBillingRunDate === null ? "never" : formatDateOnly(kpis.lastBillingRunDate)}`
      }
      headerActions={
        canExportReports ? (
          <Link
            to="/reports"
            className="rounded bg-navy px-4 py-2 text-sm font-medium text-surface hover:bg-navy-strong"
          >
            Reports Center
          </Link>
        ) : undefined
      }
    >
    <div className="w-full space-y-6">
        {errorMessage !== null && <p className="text-sm text-danger-strong">{errorMessage}</p>}

      {isLoading || kpis === null || aging === null ? (
        <p className="text-content-secondary">Loading the dashboard…</p>
      ) : (
        <>
          {kpis.submittedBatchesPendingReconciliation > 0 && (
            <section className="rounded-xl border border-warning-line bg-warning-soft p-4 text-sm text-warning-strong shadow-xs flex items-center justify-between">
              <p className="font-semibold">
                {kpis.submittedBatchesPendingReconciliation} collector batch(es) awaiting
                reconciliation.
              </p>
              <Link to="/collector-batches" className="rounded-lg bg-warning px-3 py-1 text-xs font-bold text-white hover:bg-warning-strong transition-colors">
                Open Batches
              </Link>
            </section>
          )}

          <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
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
              label="Suspended / Terminated"
              value={`${kpis.suspendedAccounts} / ${kpis.terminatedAccounts}`}
              hint={`${kpis.openCollectorBatches} open batch(es)`}
            />
          </section>

          <ArAgingMiniChart aging={aging} />

          <p className="text-sm text-content-secondary">
            Overdue more than 30 days:{" "}
            <span className="font-semibold tabular-nums text-content-primary">
              {formatCentavos(kpis.overdueOver30DaysCentavos)}
            </span>{" "}
            — more than 90 days:{" "}
            <span className="font-semibold tabular-nums text-content-primary">
              {formatCentavos(kpis.overdueOver90DaysCentavos)}
            </span>
          </p>

          {performance !== null && (
            <div className="grid gap-6 lg:grid-cols-2">
              <PaymentMethodSummaryBlock performance={performance} />
              <CollectorPerformanceBlock performance={performance} />
            </div>
          )}

          <section className="overflow-hidden rounded-2xl border border-line/90 bg-surface shadow-xs">
            <div className="border-b border-line/70 px-6 py-4 bg-canvas/30 flex items-center justify-between">
              <h2 className="text-base font-bold text-content-primary">Recent Payments</h2>
              <Link to="/payments" className="text-xs font-semibold text-accent hover:underline">
                View all payments &rarr;
              </Link>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm sm:text-base">
                <thead className="bg-canvas/90 text-left text-xs font-semibold text-content-secondary uppercase tracking-wider">
                  <tr>
                    <th className="px-5 py-3">Receipt #</th>
                    <th className="px-5 py-3">Date</th>
                    <th className="px-5 py-3">Subscriber</th>
                    <th className="px-5 py-3">Method</th>
                    <th className="px-5 py-3 text-right">Amount</th>
                    <th className="px-5 py-3">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/70">
                  {recentPayments.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-5 py-6 text-center text-content-secondary">
                        No payments have been posted yet.
                      </td>
                    </tr>
                  ) : (
                    recentPayments.map((payment) => (
                      <tr key={payment.id} className="hover:bg-accent/[0.04] transition-colors">
                        <td className="px-5 py-3 font-mono text-xs sm:text-sm">
                          <Link to={`/payments/${payment.id}`} className="font-semibold text-accent hover:underline">
                            {payment.receiptNumber}
                          </Link>
                        </td>
                        <td className="px-5 py-3">{formatDateOnly(payment.paymentDate)}</td>
                        <td className="px-5 py-3 font-medium">{payment.subscriberName}</td>
                        <td className="px-5 py-3">{payment.paymentMethod}</td>
                        <td className="px-5 py-3 text-right tabular-nums font-semibold">
                          {formatCentavos(payment.amountCentavos)}
                        </td>
                        <td className="px-5 py-3">
                          <span className="inline-block rounded-full px-2 py-0.5 text-xs font-semibold bg-slate-100 text-slate-700">
                            {payment.status}
                          </span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <p className="text-xs text-content-secondary">
            {canExportReports
              ? "You may export reports from the Reports Center."
              : "Your role may view reports but not take a copy out of the building."}
          </p>
        </>
      )}
      </div>
    </AppShell>
  );
}
