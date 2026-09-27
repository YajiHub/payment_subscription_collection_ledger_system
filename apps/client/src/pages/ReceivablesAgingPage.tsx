import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { extractApiErrorMessage, downloadArAgingXlsx, getArAging, type ArAgingEntry, type ArAgingReport } from "../lib/api-client";
import { formatCentavos } from "../lib/format";
import { AppShell } from "../components/layout/AppShell";
import { DataTable, type TableColumn } from "../components/table/DataTable";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { ErrorBanner } from "../components/ui/ErrorBanner";
import { TableSkeleton } from "../components/ui/Skeleton";

/** Today as YYYY-MM-DD in the office's local calendar day. */
function todayDateOnly(): string {
  const today = new Date();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  return `${today.getFullYear()}-${month}-${day}`;
}

// Colour coding per aging bucket, as the spec requires:
// current = green, 1-30 = yellow, 31-60 = orange, 61-90 = red, 90+ = dark red.
// The five steps are the plain token and its darker `-strong` derivation, exactly
// the pairing DashboardPage uses for the same buckets (`bg-warning` /
// `bg-warning-strong`), so the two screens read the same scale and no fourth
// severity colour has to be invented.
const BUCKET_TEXT_CLASSES = {
  current: "text-success-strong",
  "1_to_30": "text-warning",
  "31_to_60": "text-warning-strong",
  "61_to_90": "text-danger",
  over_90: "text-danger-strong",
} as const;

// The aging report is a fixed, bounded set (one row per service account with a
// balance), so it sorts in place; the endpoint has no page parameter to drive.
const AGING_COLUMNS: TableColumn<ArAgingEntry>[] = [
  {
    id: "subscriberName",
    header: "Subscriber",
    cellClassName: "text-content-primary",
    sortValue: (entry) => entry.subscriberName,
    cell: (entry) => entry.subscriberName,
  },
  {
    id: "serviceAccountNumber",
    header: "Account #",
    cellClassName: "font-mono text-xs text-content-secondary",
    sortValue: (entry) => entry.serviceAccountNumber,
    cell: (entry) => entry.serviceAccountNumber,
  },
  {
    id: "planName",
    header: "Plan",
    cellClassName: "text-content-primary",
    sortValue: (entry) => entry.planName,
    cell: (entry) => entry.planName,
  },
  {
    id: "currentCentavos",
    header: "Current",
    align: "right",
    cellClassName: `tabular-nums ${BUCKET_TEXT_CLASSES.current}`,
    sortValue: (entry) => entry.currentCentavos,
    cell: (entry) => formatCentavos(entry.currentCentavos),
  },
  {
    id: "bucket_1_30_centavos",
    header: "1–30",
    align: "right",
    cellClassName: `tabular-nums ${BUCKET_TEXT_CLASSES["1_to_30"]}`,
    sortValue: (entry) => entry.bucket_1_30_centavos,
    cell: (entry) => formatCentavos(entry.bucket_1_30_centavos),
  },
  {
    id: "bucket_31_60_centavos",
    header: "31–60",
    align: "right",
    cellClassName: `tabular-nums ${BUCKET_TEXT_CLASSES["31_to_60"]}`,
    sortValue: (entry) => entry.bucket_31_60_centavos,
    cell: (entry) => formatCentavos(entry.bucket_31_60_centavos),
  },
  {
    id: "bucket_61_90_centavos",
    header: "61–90",
    align: "right",
    cellClassName: `tabular-nums ${BUCKET_TEXT_CLASSES["61_to_90"]}`,
    sortValue: (entry) => entry.bucket_61_90_centavos,
    cell: (entry) => formatCentavos(entry.bucket_61_90_centavos),
  },
  {
    id: "over_90_centavos",
    header: "90+",
    align: "right",
    cellClassName: `tabular-nums ${BUCKET_TEXT_CLASSES.over_90}`,
    sortValue: (entry) => entry.over_90_centavos,
    cell: (entry) => formatCentavos(entry.over_90_centavos),
  },
  {
    id: "totalOutstandingCentavos",
    header: "Total",
    align: "right",
    cellClassName: "font-semibold tabular-nums",
    sortValue: (entry) => entry.totalOutstandingCentavos,
    cell: (entry) => formatCentavos(entry.totalOutstandingCentavos),
  },
];

const FIELD_CLASS =
  "h-9 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

/** AR aging report: buckets of outstanding invoices by how long they are overdue. */
export function ReceivablesAgingPage(): ReactNode {
  const navigate = useNavigate();
  const [asOfDate, setAsOfDate] = useState(todayDateOnly());
  const [report, setReport] = useState<ArAgingReport | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);

  const loadReport = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      setReport(await getArAging(asOfDate));
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  }, [asOfDate]);

  useEffect(() => {
    void loadReport();
  }, [loadReport]);

  function printReport(): void {
    // Electron's print dialog can "Save as PDF"; in a plain browser, window.print does.
    if (window.electronAPI !== undefined) {
      void window.electronAPI.printCurrentWindow();
      return;
    }
    window.print();
  }

  async function exportXlsx(): Promise<void> {
    setIsExporting(true);
    setErrorMessage(null);
    try {
      const { fileName, bytes } = await downloadArAgingXlsx(asOfDate);
      const blob = new Blob([bytes], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsExporting(false);
    }
  }

  return (
    <AppShell
      pageTitle="Accounts Receivable Aging"
      pageDescription="Outstanding invoices bucketed by how long they have been overdue"
      headerActions={
        <Link
          to="/receivables/overdue"
          className="inline-flex h-9 items-center rounded-lg border border-line-strong bg-surface px-3.5 text-sm font-medium text-content-primary transition-colors hover:bg-canvas"
        >
          Overdue accounts
        </Link>
      }
    >
      <div className="space-y-5">
        <Card className="print:hidden">
          <CardContent className="flex flex-wrap items-end gap-3">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-content-secondary">As of</span>
              <input
                type="date"
                value={asOfDate}
                onChange={(event) => setAsOfDate(event.target.value)}
                className={`${FIELD_CLASS} w-40`}
              />
            </label>
            <Button type="button" variant="secondary" onClick={printReport}>
              Export PDF
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => void exportXlsx()}
              isLoading={isExporting}
            >
              Export XLSX
            </Button>
          </CardContent>
        </Card>

        {errorMessage !== null && (
          <ErrorBanner message={errorMessage} onRetry={() => void loadReport()} />
        )}

        {isLoading || report === null ? (
          <Card>
            <TableSkeleton rows={5} columns={9} />
          </Card>
        ) : (
          <>
            <section className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <Card>
                <CardContent className="space-y-1" padding="sm">
                  <span className="block text-xs text-content-secondary">Current</span>
                  <span className={`block tabular-nums ${BUCKET_TEXT_CLASSES.current}`}>
                    {formatCentavos(report.totals.current)}
                  </span>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="space-y-1" padding="sm">
                  <span className="block text-xs text-content-secondary">1–30 Days</span>
                  <span className={`block tabular-nums ${BUCKET_TEXT_CLASSES["1_to_30"]}`}>
                    {formatCentavos(report.totals.bucket_1_30)}
                  </span>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="space-y-1" padding="sm">
                  <span className="block text-xs text-content-secondary">31–60 Days</span>
                  <span className={`block tabular-nums ${BUCKET_TEXT_CLASSES["31_to_60"]}`}>
                    {formatCentavos(report.totals.bucket_31_60)}
                  </span>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="space-y-1" padding="sm">
                  <span className="block text-xs text-content-secondary">61–90 Days</span>
                  <span className={`block tabular-nums ${BUCKET_TEXT_CLASSES["61_to_90"]}`}>
                    {formatCentavos(report.totals.bucket_61_90)}
                  </span>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="space-y-1" padding="sm">
                  <span className="block text-xs text-content-secondary">90+ Days</span>
                  <span className={`block tabular-nums ${BUCKET_TEXT_CLASSES.over_90}`}>
                    {formatCentavos(report.totals.over_90)}
                  </span>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="space-y-1" padding="sm">
                  <span className="block text-xs text-content-secondary">Total</span>
                  <span className="block font-semibold tabular-nums">
                    {formatCentavos(report.totals.grandTotal)}
                  </span>
                </CardContent>
              </Card>
            </section>

            <Card>
              <CardHeader className="flex-row items-center justify-between">
                <CardTitle>Accounts receivable aging</CardTitle>
                <Badge variant="neutral" size="sm" dot>
                  As of {asOfDate}
                </Badge>
              </CardHeader>
              {report.entries.length === 0 ? (
                <EmptyState
                  title="No outstanding invoices"
                  description="No service account has an outstanding balance as of this date. Try an earlier as-of date, or review overdue accounts."
                  actionLabel="Overdue accounts"
                  onAction={() => navigate("/receivables/overdue")}
                />
              ) : (
                <DataTable
                  columns={AGING_COLUMNS}
                  data={report.entries}
                  getRowId={(entry) => entry.serviceAccountId}
                />
              )}
            </Card>
          </>
        )}
      </div>
    </AppShell>
  );
}
