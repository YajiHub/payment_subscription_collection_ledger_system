import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { extractApiErrorMessage, downloadArAgingXlsx, getArAging, type ArAgingReport } from "../lib/api-client";
import { formatCentavos } from "../lib/format";

/** Today as YYYY-MM-DD in the office's local calendar day. */
function todayDateOnly(): string {
  const today = new Date();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  return `${today.getFullYear()}-${month}-${day}`;
}

// Colour coding per aging bucket, as the spec requires:
// current = green, 1-30 = yellow, 31-60 = orange, 61-90 = red, 90+ = dark red.
const BUCKET_TEXT_CLASSES = {
  current: "text-emerald-700",
  "1_to_30": "text-yellow-700",
  "31_to_60": "text-orange-700",
  "61_to_90": "text-red-700",
  over_90: "text-red-900",
} as const;

/** AR aging report: buckets of outstanding invoices by how long they are overdue. */
export function ReceivablesAgingPage(): ReactNode {
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
    <main className="mx-auto max-w-6xl space-y-6 p-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Accounts Receivable Aging</h1>
        <Link to="/receivables/overdue" className="text-sm text-slate-800 underline">
          Overdue accounts
        </Link>
      </header>

      <section className="flex flex-wrap items-end gap-3 print:hidden">
        <label className="text-sm">
          <span className="block text-slate-600">As of</span>
          <input
            type="date"
            value={asOfDate}
            onChange={(event) => setAsOfDate(event.target.value)}
            className="rounded border border-slate-300 px-2 py-1"
          />
        </label>
        <button
          type="button"
          onClick={printReport}
          className="rounded bg-slate-800 px-3 py-1.5 text-sm text-white"
        >
          Export PDF
        </button>
        <button
          type="button"
          onClick={() => void exportXlsx()}
          className="rounded bg-emerald-700 px-3 py-1.5 text-sm text-white"
          disabled={isExporting}
        >
          {isExporting ? "Preparing…" : "Export XLSX"}
        </button>
      </section>

      {errorMessage !== null && <p className="text-sm text-red-700">{errorMessage}</p>}

      {isLoading || report === null ? (
        <p className="text-slate-500">Loading the aging report…</p>
      ) : (
        <>
          <section className="grid gap-3 rounded-lg border border-slate-200 bg-white p-4 text-sm shadow-sm sm:grid-cols-6">
            <p>
              <span className="block text-slate-600">Current</span>
              <span className={BUCKET_TEXT_CLASSES.current}>
                {formatCentavos(report.totals.current)}
              </span>
            </p>
            <p>
              <span className="block text-slate-600">1–30 Days</span>
              <span className={BUCKET_TEXT_CLASSES["1_to_30"]}>
                {formatCentavos(report.totals.bucket_1_30)}
              </span>
            </p>
            <p>
              <span className="block text-slate-600">31–60 Days</span>
              <span className={BUCKET_TEXT_CLASSES["31_to_60"]}>
                {formatCentavos(report.totals.bucket_31_60)}
              </span>
            </p>
            <p>
              <span className="block text-slate-600">61–90 Days</span>
              <span className={BUCKET_TEXT_CLASSES["61_to_90"]}>
                {formatCentavos(report.totals.bucket_61_90)}
              </span>
            </p>
            <p>
              <span className="block text-slate-600">90+ Days</span>
              <span className={BUCKET_TEXT_CLASSES.over_90}>
                {formatCentavos(report.totals.over_90)}
              </span>
            </p>
            <p>
              <span className="block text-slate-600">Total</span>
              <span className="font-semibold">{formatCentavos(report.totals.grandTotal)}</span>
            </p>
          </section>

          <section className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-slate-600">
                <tr>
                  <th className="px-4 py-3">Subscriber</th>
                  <th className="px-4 py-3">Account #</th>
                  <th className="px-4 py-3">Plan</th>
                  <th className="px-4 py-3">Current</th>
                  <th className="px-4 py-3">1–30</th>
                  <th className="px-4 py-3">31–60</th>
                  <th className="px-4 py-3">61–90</th>
                  <th className="px-4 py-3">90+</th>
                  <th className="px-4 py-3">Total</th>
                </tr>
              </thead>
              <tbody>
                {report.entries.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-4 py-6 text-center text-slate-500">
                      No outstanding invoices as of this date.
                    </td>
                  </tr>
                ) : (
                  report.entries.map((entry) => (
                    <tr key={entry.serviceAccountId} className="border-t border-slate-100">
                      <td className="px-4 py-3">{entry.subscriberName}</td>
                      <td className="px-4 py-3 font-mono text-xs">{entry.serviceAccountNumber}</td>
                      <td className="px-4 py-3">{entry.planName}</td>
                      <td className={`px-4 py-3 ${BUCKET_TEXT_CLASSES.current}`}>
                        {formatCentavos(entry.currentCentavos)}
                      </td>
                      <td className={`px-4 py-3 ${BUCKET_TEXT_CLASSES["1_to_30"]}`}>
                        {formatCentavos(entry.bucket_1_30_centavos)}
                      </td>
                      <td className={`px-4 py-3 ${BUCKET_TEXT_CLASSES["31_to_60"]}`}>
                        {formatCentavos(entry.bucket_31_60_centavos)}
                      </td>
                      <td className={`px-4 py-3 ${BUCKET_TEXT_CLASSES["61_to_90"]}`}>
                        {formatCentavos(entry.bucket_61_90_centavos)}
                      </td>
                      <td className={`px-4 py-3 ${BUCKET_TEXT_CLASSES.over_90}`}>
                        {formatCentavos(entry.over_90_centavos)}
                      </td>
                      <td className="px-4 py-3 font-semibold">
                        {formatCentavos(entry.totalOutstandingCentavos)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </section>
        </>
      )}
    </main>
  );
}