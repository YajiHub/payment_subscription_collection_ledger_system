import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";

import {
  REPORT_TYPES,
  REPORT_TYPE_DESCRIPTIONS,
  REPORT_TYPE_LABELS,
  REPORT_TYPE_VIEW_PERMISSIONS,
  roleHasPermission,
  type ReportType,
} from "@bcis/shared";
import {
  exportReportPdf,
  exportReportXlsx,
  extractApiErrorMessage,
  getArAgingReport,
  getCollectorRemittanceReport,
  getDailyCollectionReport,
  getMonthlyBillingReport,
  getOutstandingByCollectorReport,
  getServiceAccountStatement,
  type ReportExportParams,
} from "../lib/api-client";
import {
  buildArAgingView,
  buildCollectorRemittanceView,
  buildDailyCollectionView,
  buildMonthlyBillingView,
  buildOutstandingByCollectorView,
  buildStatementView,
  type DisplayTable,
} from "../lib/report-views";
import { useAuthStore } from "../stores/auth.store";
import { AppShell } from "../components/layout/AppShell";
import { Button } from "../components/ui/Button";
import { Card, CardContent } from "../components/ui/Card";
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

/** The parameters the Reports Center collects for the chosen report. */
interface ReportParameters {
  date: string;
  year: number;
  month: number;
  asOf: string;
  batchId: string;
  serviceAccountId: string;
  fromDate: string;
  toDate: string;
}

function initialParameters(): ReportParameters {
  const today = new Date();
  return {
    date: todayDateOnly(),
    year: today.getFullYear(),
    month: today.getMonth() + 1,
    asOf: todayDateOnly(),
    batchId: "",
    serviceAccountId: "",
    fromDate: "",
    toDate: "",
  };
}

/**
 * Thrown when a report the catalogue lists has no wiring on this screen yet.
 *
 * The catalogue in `@bcis/shared` is the authority on which reports exist; the
 * screens that render them are added one family at a time (S6-1). Until a family
 * has its API call and its view here, asking for it is an error rather than a
 * blank page or a request the server would reject.
 */
function reportNotWiredUp(reportType: ReportType): Error {
  return new Error(`The ${reportType} report is not wired up in this screen yet.`);
}

/** The parameter object the export endpoint expects, for the chosen report. */
function exportParameters(
  reportType: ReportType,
  parameters: ReportParameters
): ReportExportParams {
  switch (reportType) {
    case "daily_collection":
      return { date: parameters.date };
    case "monthly_billing":
      return { year: parameters.year, month: parameters.month };
    case "ar_aging":
    case "outstanding_by_collector":
      return { asOf: parameters.asOf };
    case "collector_remittance":
      return { batchId: parameters.batchId };
    case "subscriber_soa":
      return {
        serviceAccountId: parameters.serviceAccountId,
        fromDate: parameters.fromDate === "" ? undefined : parameters.fromDate,
        toDate: parameters.toDate === "" ? undefined : parameters.toDate,
      };
    default:
      throw reportNotWiredUp(reportType);
  }
}

/** True when the parameters the chosen report needs have been filled in. */
function parametersAreComplete(reportType: ReportType, parameters: ReportParameters): boolean {
  if (reportType === "collector_remittance") {
    return parameters.batchId.trim() !== "";
  }
  if (reportType === "subscriber_soa") {
    return parameters.serviceAccountId.trim() !== "";
  }
  return true;
}

/** The on-screen table for a report, built from the data the server sent. */
async function loadReportTable(
  reportType: ReportType,
  parameters: ReportParameters
): Promise<DisplayTable> {
  switch (reportType) {
    case "daily_collection":
      return buildDailyCollectionView(await getDailyCollectionReport(parameters.date));
    case "monthly_billing":
      return buildMonthlyBillingView(
        await getMonthlyBillingReport(parameters.year, parameters.month)
      );
    case "ar_aging":
      return buildArAgingView(await getArAgingReport(parameters.asOf));
    case "collector_remittance":
      return buildCollectorRemittanceView(await getCollectorRemittanceReport(parameters.batchId));
    case "outstanding_by_collector":
      return buildOutstandingByCollectorView(
        await getOutstandingByCollectorReport(parameters.asOf)
      );
    case "subscriber_soa":
      return buildStatementView(
        await getServiceAccountStatement(parameters.serviceAccountId, {
          fromDate: parameters.fromDate === "" ? undefined : parameters.fromDate,
          toDate: parameters.toDate === "" ? undefined : parameters.toDate,
        })
      );
    default:
      throw reportNotWiredUp(reportType);
  }
}

/** Renders a report table with its totals lines beneath it. */
function ReportTableView({ table }: { table: DisplayTable }): ReactNode {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold text-content-primary">{table.title}</h2>
        <p className="text-sm text-content-secondary">{table.subtitle}</p>
      </div>

      {table.isEmpty ? (
        <Card>
          <EmptyState
            title="Nothing to report"
            description="There is nothing to report for these parameters. Try a different date range, or pick another report from the list."
          />
        </Card>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-canvas text-content-secondary">
                <tr>
                  {table.columns.map((column) => (
                    <th
                      key={column.header}
                      className={`px-4 py-3 font-medium ${column.align === "right" ? "text-right" : "text-left"}`}
                    >
                      {column.header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row, rowIndex) => (
                  <tr
                    key={rowIndex}
                    className="border-t border-line transition-colors hover:bg-canvas/60"
                  >
                    {row.map((cell, cellIndex) => (
                      <td
                        key={cellIndex}
                        className={`px-4 py-3 ${
                          table.columns[cellIndex]?.align === "right"
                            ? "text-right tabular-nums"
                            : "text-left"
                        }`}
                      >
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              {table.totalsRows.length > 0 && (
                <tfoot className="bg-canvas font-semibold">
                  {table.totalsRows.map((row, rowIndex) => (
                    <tr key={rowIndex} className="border-t border-line">
                      {row.map((cell, cellIndex) => (
                        <td
                          key={cellIndex}
                          className={`px-4 py-3 ${
                            table.columns[cellIndex]?.align === "right"
                              ? "text-right tabular-nums"
                              : "text-left"
                          }`}
                        >
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tfoot>
              )}
            </table>
          </div>
        </Card>
      )}
    </section>
  );
}

const FIELD_CLASS =
  "h-9 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

/**
 * The Reports Center: pick a report, set its parameters, generate it on screen,
 * then export it or print it.
 *
 * The sidebar lists only the reports the role may view, and the export buttons are
 * hidden from a role without `reports:export`. The server enforces the same
 * boundaries per route — the hidden entry is only a convenience.
 */
export function ReportsCenterPage(): ReactNode {
  const user = useAuthStore((state) => state.user);
  const canExportReports = user !== null && roleHasPermission(user.role, "reports:export");
  const visibleReportTypes = REPORT_TYPES.filter(
    (type) => user !== null && roleHasPermission(user.role, REPORT_TYPE_VIEW_PERMISSIONS[type])
  );

  const [reportType, setReportType] = useState<ReportType>("daily_collection");
  const [parameters, setParameters] = useState<ReportParameters>(initialParameters);
  const [table, setTable] = useState<DisplayTable | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  function updateParameter<Key extends keyof ReportParameters>(
    key: Key,
    value: ReportParameters[Key]
  ): void {
    setParameters((current) => ({ ...current, [key]: value }));
  }

  const generate = useCallback(async (): Promise<void> => {
    setIsGenerating(true);
    setErrorMessage(null);
    try {
      setTable(await loadReportTable(reportType, parameters));
    } catch (error) {
      setTable(null);
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsGenerating(false);
    }
  }, [reportType, parameters]);

  // Generate once when the screen opens so it is never blank.
  useEffect(() => {
    void generate();
    // Only on mount: a later change is applied by the Generate button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function exportReport(format: "pdf" | "xlsx"): Promise<void> {
    setIsExporting(true);
    setErrorMessage(null);
    try {
      const request = { reportType, params: exportParameters(reportType, parameters) };
      const { fileName, bytes } =
        format === "pdf" ? await exportReportPdf(request) : await exportReportXlsx(request);

      const blob = new Blob([bytes], {
        type:
          format === "pdf"
            ? "application/pdf"
            : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
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

  /** Opens the report in Electron's print-preview window, or the browser's printer. */
  function openPrintPreview(): void {
    if (table === null) {
      return;
    }

    if (window.electronAPI?.openPrintPreview !== undefined) {
      void window.electronAPI.openPrintPreview(buildPrintableHtml(table));
      return;
    }

    // A plain browser (vite dev) has no Electron bridge; use its own print dialog.
    window.print();
  }

  const canGenerate = parametersAreComplete(reportType, parameters);

  return (
    <AppShell
      pageTitle="Reports Center"
      pageDescription="Pick a report, set its parameters, then view, export, or print it"
    >
      <div className="grid gap-6 lg:grid-cols-[16rem_1fr]">
        <nav className="space-y-1 self-start rounded-xl border border-line/80 bg-surface p-2 shadow-xs print:hidden">
          {visibleReportTypes.map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => setReportType(type)}
              className={`w-full rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors ${
                type === reportType
                  ? "bg-accent text-surface"
                  : "text-content-primary hover:bg-canvas"
              }`}
            >
              {REPORT_TYPE_LABELS[type]}
            </button>
          ))}
        </nav>

        <div className="space-y-6">
          <Card className="print:hidden">
            <CardContent className="space-y-4">
              <p className="text-sm text-content-secondary">{REPORT_TYPE_DESCRIPTIONS[reportType]}</p>

              <div className="flex flex-wrap items-end gap-3">
                {(reportType === "daily_collection" || reportType === "subscriber_soa") && (
                  <label className="block space-y-1.5">
                    <span className="text-xs font-medium text-content-secondary">Date</span>
                    <input
                      type="date"
                      value={parameters.date}
                      onChange={(event) => updateParameter("date", event.target.value)}
                      className={`${FIELD_CLASS} w-40`}
                    />
                  </label>
                )}

                {reportType === "monthly_billing" && (
                  <>
                    <label className="block space-y-1.5">
                      <span className="text-xs font-medium text-content-secondary">Year</span>
                      <input
                        type="number"
                        value={parameters.year}
                        onChange={(event) =>
                          updateParameter("year", Number.parseInt(event.target.value, 10) || 0)
                        }
                        className={`${FIELD_CLASS} w-28`}
                      />
                    </label>
                    <label className="block space-y-1.5">
                      <span className="text-xs font-medium text-content-secondary">Month</span>
                      <input
                        type="number"
                        min={1}
                        max={12}
                        value={parameters.month}
                        onChange={(event) =>
                          updateParameter("month", Number.parseInt(event.target.value, 10) || 1)
                        }
                        className={`${FIELD_CLASS} w-24`}
                      />
                    </label>
                  </>
                )}

                {(reportType === "ar_aging" || reportType === "outstanding_by_collector") && (
                  <label className="block space-y-1.5">
                    <span className="text-xs font-medium text-content-secondary">As of</span>
                    <input
                      type="date"
                      value={parameters.asOf}
                      onChange={(event) => updateParameter("asOf", event.target.value)}
                      className={`${FIELD_CLASS} w-40`}
                    />
                  </label>
                )}

                {reportType === "collector_remittance" && (
                  <label className="block space-y-1.5">
                    <span className="text-xs font-medium text-content-secondary">Collector batch id</span>
                    <input
                      type="text"
                      value={parameters.batchId}
                      onChange={(event) => updateParameter("batchId", event.target.value)}
                      placeholder="Paste the batch id from the batch screen"
                      className={`${FIELD_CLASS} w-96`}
                    />
                  </label>
                )}

                {reportType === "subscriber_soa" && (
                  <>
                    <label className="block space-y-1.5">
                      <span className="text-xs font-medium text-content-secondary">Service account id</span>
                      <input
                        type="text"
                        value={parameters.serviceAccountId}
                        onChange={(event) => updateParameter("serviceAccountId", event.target.value)}
                        placeholder="Paste the account id from the ledger screen"
                        className={`${FIELD_CLASS} w-96`}
                      />
                    </label>
                    <label className="block space-y-1.5">
                      <span className="text-xs font-medium text-content-secondary">From (optional)</span>
                      <input
                        type="date"
                        value={parameters.fromDate}
                        onChange={(event) => updateParameter("fromDate", event.target.value)}
                        className={`${FIELD_CLASS} w-40`}
                      />
                    </label>
                    <label className="block space-y-1.5">
                      <span className="text-xs font-medium text-content-secondary">To (optional)</span>
                      <input
                        type="date"
                        value={parameters.toDate}
                        onChange={(event) => updateParameter("toDate", event.target.value)}
                        className={`${FIELD_CLASS} w-40`}
                      />
                    </label>
                  </>
                )}

                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void generate()}
                  disabled={!canGenerate}
                  isLoading={isGenerating}
                >
                  Generate
                </Button>

                {canExportReports && (
                  <>
                    <Button
                      type="button"
                      variant="danger"
                      onClick={() => void exportReport("pdf")}
                      disabled={!canGenerate}
                      isLoading={isExporting}
                    >
                      Export PDF
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void exportReport("xlsx")}
                      disabled={!canGenerate}
                      isLoading={isExporting}
                    >
                      Export XLSX
                    </Button>
                  </>
                )}

                <Button
                  type="button"
                  variant="outline"
                  onClick={openPrintPreview}
                  disabled={table === null}
                >
                  Print preview
                </Button>
              </div>

              {!canGenerate && (
                <p className="text-xs text-content-secondary">
                  This report needs an identifier before it can be generated.
                </p>
              )}
              {!canExportReports && (
                <p className="text-xs text-content-secondary">
                  Your role may view reports but not export them.
                </p>
              )}
            </CardContent>
          </Card>

          {errorMessage !== null && (
            <ErrorBanner message={errorMessage} onRetry={() => void generate()} />
          )}

          {isGenerating ? (
            <Card>
              <TableSkeleton rows={6} columns={6} />
            </Card>
          ) : (
            table !== null && <ReportTableView table={table} />
          )}
        </div>
      </div>
    </AppShell>
  );
}

/**
 * The report as a stand-alone HTML document for the print-preview window.
 *
 * The Electron main process prints this content with the OS print dialog, so the
 * preview and the printed page are the same document.
 */
function buildPrintableHtml(table: DisplayTable): string {
  const escapeHtml = (text: string): string =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const headerCells = table.columns
    .map(
      (column) =>
        `<th style="text-align:${column.align}; border-bottom:1px solid #000; padding:4px 8px;">${escapeHtml(column.header)}</th>`
    )
    .join("");

  const bodyRows = table.rows
    .map(
      (row) =>
        `<tr>${row
          .map(
            (cell, index) =>
              `<td style="text-align:${table.columns[index]?.align ?? "left"}; padding:4px 8px;">${escapeHtml(cell)}</td>`
          )
          .join("")}</tr>`
    )
    .join("");

  const totalsRows = table.totalsRows
    .map(
      (row) =>
        `<tr style="font-weight:bold;">${row
          .map(
            (cell, index) =>
              `<td style="text-align:${table.columns[index]?.align ?? "left"}; padding:4px 8px; border-top:1px solid #000;">${escapeHtml(cell)}</td>`
          )
          .join("")}</tr>`
    )
    .join("");

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(table.title)}</title></head>
<body style="font-family: sans-serif; font-size: 12px; padding: 16px;">
  <h1 style="font-size: 18px; margin: 0;">${escapeHtml(table.title)}</h1>
  <p style="margin: 4px 0 16px; color: #000;">${escapeHtml(table.subtitle)}</p>
  <table style="border-collapse: collapse; width: 100%;">
    <thead><tr>${headerCells}</tr></thead>
    <tbody>${bodyRows}</tbody>
    <tfoot>${totalsRows}</tfoot>
  </table>
</body></html>`;
}
