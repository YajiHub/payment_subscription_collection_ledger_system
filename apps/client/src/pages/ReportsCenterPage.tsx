import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import {
  REPORT_TYPES,
  REPORT_TYPE_DESCRIPTIONS,
  REPORT_TYPE_LABELS,
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
  }
}

/** Renders a report table with its totals lines beneath it. */
function ReportTableView({ table }: { table: DisplayTable }): ReactNode {
  return (
    <section className="space-y-2">
      <div>
        <h2 className="text-lg font-semibold">{table.title}</h2>
        <p className="text-sm text-slate-600">{table.subtitle}</p>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              {table.columns.map((column) => (
                <th
                  key={column.header}
                  className={`px-3 py-2 ${column.align === "right" ? "text-right" : "text-left"}`}
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.isEmpty ? (
              <tr>
                <td colSpan={table.columns.length} className="px-3 py-6 text-center text-slate-500">
                  There is nothing to report for these parameters.
                </td>
              </tr>
            ) : (
              table.rows.map((row, rowIndex) => (
                <tr key={rowIndex} className="border-t border-slate-100">
                  {row.map((cell, cellIndex) => (
                    <td
                      key={cellIndex}
                      className={`px-3 py-2 ${
                        table.columns[cellIndex]?.align === "right" ? "text-right" : "text-left"
                      }`}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
          {table.totalsRows.length > 0 && (
            <tfoot className="bg-slate-50 font-semibold">
              {table.totalsRows.map((row, rowIndex) => (
                <tr key={rowIndex} className="border-t border-slate-200">
                  {row.map((cell, cellIndex) => (
                    <td
                      key={cellIndex}
                      className={`px-3 py-2 ${
                        table.columns[cellIndex]?.align === "right" ? "text-right" : "text-left"
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
    </section>
  );
}

/**
 * The Reports Center: pick a report, set its parameters, generate it on screen,
 * then export it or print it.
 *
 * The export buttons are hidden from a role without `reports:export`, and the server
 * refuses the same request anyway — the hidden button is only a convenience.
 */
export function ReportsCenterPage(): ReactNode {
  const user = useAuthStore((state) => state.user);
  const canExportReports = user !== null && roleHasPermission(user.role, "reports:export");

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
    <main className="mx-auto max-w-6xl space-y-6 p-8">
      <header className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <h1 className="text-2xl font-semibold">Reports Center</h1>
        <nav className="flex items-center gap-3 text-sm font-medium">
          <Link to="/dashboard" className="text-slate-800 underline">
            Dashboard
          </Link>
          <Link to="/" className="text-slate-800 underline">
            Home
          </Link>
        </nav>
      </header>

      <div className="grid gap-6 lg:grid-cols-[16rem_1fr]">
        <nav className="space-y-1 rounded-lg border border-slate-200 bg-white p-2 shadow-sm print:hidden">
          {REPORT_TYPES.map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => setReportType(type)}
              className={`w-full rounded px-3 py-2 text-left text-sm ${
                type === reportType
                  ? "bg-slate-800 text-white"
                  : "text-slate-800 hover:bg-slate-100"
              }`}
            >
              {REPORT_TYPE_LABELS[type]}
            </button>
          ))}
        </nav>

        <div className="space-y-6">
          <section className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm print:hidden">
            <p className="text-sm text-slate-600">{REPORT_TYPE_DESCRIPTIONS[reportType]}</p>

            <div className="flex flex-wrap items-end gap-3">
              {(reportType === "daily_collection" || reportType === "subscriber_soa") && (
                <label className="text-sm">
                  <span className="block text-slate-600">Date</span>
                  <input
                    type="date"
                    value={parameters.date}
                    onChange={(event) => updateParameter("date", event.target.value)}
                    className="rounded border border-slate-300 px-2 py-1"
                  />
                </label>
              )}

              {reportType === "monthly_billing" && (
                <>
                  <label className="text-sm">
                    <span className="block text-slate-600">Year</span>
                    <input
                      type="number"
                      value={parameters.year}
                      onChange={(event) =>
                        updateParameter("year", Number.parseInt(event.target.value, 10) || 0)
                      }
                      className="w-24 rounded border border-slate-300 px-2 py-1"
                    />
                  </label>
                  <label className="text-sm">
                    <span className="block text-slate-600">Month</span>
                    <input
                      type="number"
                      min={1}
                      max={12}
                      value={parameters.month}
                      onChange={(event) =>
                        updateParameter("month", Number.parseInt(event.target.value, 10) || 1)
                      }
                      className="w-20 rounded border border-slate-300 px-2 py-1"
                    />
                  </label>
                </>
              )}

              {(reportType === "ar_aging" || reportType === "outstanding_by_collector") && (
                <label className="text-sm">
                  <span className="block text-slate-600">As of</span>
                  <input
                    type="date"
                    value={parameters.asOf}
                    onChange={(event) => updateParameter("asOf", event.target.value)}
                    className="rounded border border-slate-300 px-2 py-1"
                  />
                </label>
              )}

              {reportType === "collector_remittance" && (
                <label className="text-sm">
                  <span className="block text-slate-600">Collector batch id</span>
                  <input
                    type="text"
                    value={parameters.batchId}
                    onChange={(event) => updateParameter("batchId", event.target.value)}
                    placeholder="Paste the batch id from the batch screen"
                    className="w-96 rounded border border-slate-300 px-2 py-1"
                  />
                </label>
              )}

              {reportType === "subscriber_soa" && (
                <>
                  <label className="text-sm">
                    <span className="block text-slate-600">Service account id</span>
                    <input
                      type="text"
                      value={parameters.serviceAccountId}
                      onChange={(event) => updateParameter("serviceAccountId", event.target.value)}
                      placeholder="Paste the account id from the ledger screen"
                      className="w-96 rounded border border-slate-300 px-2 py-1"
                    />
                  </label>
                  <label className="text-sm">
                    <span className="block text-slate-600">From (optional)</span>
                    <input
                      type="date"
                      value={parameters.fromDate}
                      onChange={(event) => updateParameter("fromDate", event.target.value)}
                      className="rounded border border-slate-300 px-2 py-1"
                    />
                  </label>
                  <label className="text-sm">
                    <span className="block text-slate-600">To (optional)</span>
                    <input
                      type="date"
                      value={parameters.toDate}
                      onChange={(event) => updateParameter("toDate", event.target.value)}
                      className="rounded border border-slate-300 px-2 py-1"
                    />
                  </label>
                </>
              )}

              <button
                type="button"
                onClick={() => void generate()}
                disabled={!canGenerate || isGenerating}
                className="rounded bg-slate-800 px-3 py-1.5 text-sm text-white disabled:opacity-50"
              >
                {isGenerating ? "Generating…" : "Generate"}
              </button>

              {canExportReports && (
                <>
                  <button
                    type="button"
                    onClick={() => void exportReport("pdf")}
                    disabled={!canGenerate || isExporting}
                    className="rounded bg-red-700 px-3 py-1.5 text-sm text-white disabled:opacity-50"
                  >
                    {isExporting ? "Preparing…" : "Export PDF"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void exportReport("xlsx")}
                    disabled={!canGenerate || isExporting}
                    className="rounded bg-emerald-700 px-3 py-1.5 text-sm text-white disabled:opacity-50"
                  >
                    {isExporting ? "Preparing…" : "Export XLSX"}
                  </button>
                </>
              )}

              <button
                type="button"
                onClick={openPrintPreview}
                disabled={table === null}
                className="rounded border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-50"
              >
                Print preview
              </button>
            </div>

            {!canGenerate && (
              <p className="text-xs text-slate-500">
                This report needs an identifier before it can be generated.
              </p>
            )}
            {!canExportReports && (
              <p className="text-xs text-slate-500">
                Your role may view reports but not export them.
              </p>
            )}
          </section>

          {errorMessage !== null && <p className="text-sm text-red-700">{errorMessage}</p>}

          {table !== null && <ReportTableView table={table} />}
        </div>
      </div>
    </main>
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
        `<th style="text-align:${column.align}; border-bottom:1px solid #999; padding:4px 8px;">${escapeHtml(column.header)}</th>`
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
              `<td style="text-align:${table.columns[index]?.align ?? "left"}; padding:4px 8px; border-top:1px solid #ccc;">${escapeHtml(cell)}</td>`
          )
          .join("")}</tr>`
    )
    .join("");

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(table.title)}</title></head>
<body style="font-family: sans-serif; font-size: 12px; padding: 16px;">
  <h1 style="font-size: 18px; margin: 0;">${escapeHtml(table.title)}</h1>
  <p style="margin: 4px 0 16px; color: #555;">${escapeHtml(table.subtitle)}</p>
  <table style="border-collapse: collapse; width: 100%;">
    <thead><tr>${headerCells}</tr></thead>
    <tbody>${bodyRows}</tbody>
    <tfoot>${totalsRows}</tfoot>
  </table>
</body></html>`;
}
