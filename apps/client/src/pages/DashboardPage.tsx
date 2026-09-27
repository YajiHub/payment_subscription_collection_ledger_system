import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { AppNavigation } from "../components/AppNavigation";
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
    <div className="rounded-lg border border-line bg-surface p-4 shadow-sm">
      <p className="text-xs uppercase tracking-wide text-content-secondary">{label}</p>
      <p className="mt-1 text-right text-xl font-semibold tabular-nums">{value}</p>
      {hint !== undefined && <p className="mt-1 text-xs text-content-secondary">{hint}</p>}
    </div>
  );
}

/** A horizontal bar chart of the outstanding balance per aging bucket. */
function ArAgingMiniChart({ aging }: { aging: ArAgingReport }): ReactNode {
  const grandTotal = aging.totals.grandTotal;

  return (
    <div className="space-y-3 rounded-lg border border-line bg-surface p-4 shadow-sm">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-medium">AR Aging</h2>
        <span className="text-sm font-semibold tabular-nums">{formatCentavos(grandTotal)}</span>
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
    <main className="mx-auto max-w-6xl space-y-6 p-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Management Dashboard</h1>
          <p className="text-sm text-content-secondary">
            {kpis === null
              ? "Loading the pulse of the business…"
              : `Last billing run: ${kpis.lastBillingRunDate === null ? "never" : formatDateOnly(kpis.lastBillingRunDate)}`}
          </p>
        </div>
        <AppNavigation />
      </header>

      {errorMessage !== null && <p className="text-sm text-danger-strong">{errorMessage}</p>}

      {isLoading || kpis === null || aging === null ? (
        <p className="text-content-secondary">Loading the dashboard…</p>
      ) : (
        <>
          {kpis.submittedBatchesPendingReconciliation > 0 && (
            <section className="rounded-lg border border-warning-line bg-warning-soft p-4 text-sm text-warning-strong">
              <p className="font-medium">
                {kpis.submittedBatchesPendingReconciliation} collector batch(es) awaiting
                reconciliation.
              </p>
              <Link to="/collector-batches" className="underline">
                Open the collector batches
              </Link>
            </section>
          )}

          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
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
            <span className="font-medium tabular-nums text-content-primary">
              {formatCentavos(kpis.overdueOver30DaysCentavos)}
            </span>{" "}
            — more than 90 days:{" "}
            <span className="font-medium tabular-nums text-content-primary">
              {formatCentavos(kpis.overdueOver90DaysCentavos)}
            </span>
          </p>

          {performance !== null && (
            <div className="grid gap-4 lg:grid-cols-2">
              <PaymentMethodSummaryBlock performance={performance} />
              <CollectorPerformanceBlock performance={performance} />
            </div>
          )}

          <section className="overflow-x-auto rounded-lg border border-line bg-surface shadow-sm">
            <h2 className="px-4 py-3 text-sm font-medium">Recent payments</h2>
            <table className="min-w-full text-sm">
              <thead className="bg-canvas text-left text-content-secondary">
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
                    <td colSpan={6} className="px-4 py-6 text-center text-content-secondary">
                      No payments have been posted yet.
                    </td>
                  </tr>
                ) : (
                  recentPayments.map((payment) => (
                    <tr key={payment.id} className="border-t border-line">
                      <td className="px-4 py-2 font-mono text-xs">
                        <Link to={`/payments/${payment.id}`} className="underline">
                          {payment.receiptNumber}
                        </Link>
                      </td>
                      <td className="px-4 py-2">{formatDateOnly(payment.paymentDate)}</td>
                      <td className="px-4 py-2">{payment.subscriberName}</td>
                      <td className="px-4 py-2">{payment.paymentMethod}</td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {formatCentavos(payment.amountCentavos)}
                      </td>
                      <td className="px-4 py-2">{payment.status}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </section>

          <p className="text-xs text-content-secondary">
            {canExportReports
              ? "You may export reports from the Reports Center."
              : "Your role may view reports but not take a copy out of the building."}
          </p>
        </>
      )}
    </main>
  );
}
