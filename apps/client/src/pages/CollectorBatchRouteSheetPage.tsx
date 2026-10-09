import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { roleHasPermission } from "@bcis/shared";
import {
  downloadBatchRouteSheet,
  extractApiErrorMessage,
  getBatchRouteSheet,
  type BatchRouteSheet,
} from "../lib/api-client";
import { formatCentavos, formatDateOnly } from "../lib/format";
import { describePrintOutcome } from "../lib/print-outcome";
import { useAuthStore } from "../stores/auth.store";
import { AppShell } from "../components/layout/AppShell";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { ErrorBanner } from "../components/ui/ErrorBanner";
import { TableSkeleton } from "../components/ui/Skeleton";

/** Saves an exported file to disk through the browser / Electron download path. */
function saveBytes(fileName: string, bytes: ArrayBuffer, mimeType: string): void {
  const blob = new Blob([bytes], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * The printable route sheet for one collector batch (S4-3): who to visit, where,
 * and how much to ask for, split into the current bill and arrears.
 *
 * The screen is the same document the print stylesheet and the PDF/XLSX exports
 * render, so a sheet that prints and a sheet that exports cannot disagree. Taking
 * the file out of the building needs `reports:export`, exactly as the server's
 * export route does; the buttons are hidden without it, and the server re-checks.
 */
export function CollectorBatchRouteSheetPage(): ReactNode {
  const { id = "" } = useParams();
  const user = useAuthStore((state) => state.user);
  const canExport = user !== null && roleHasPermission(user.role, "reports:export");

  const [sheet, setSheet] = useState<BatchRouteSheet | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);

  const loadSheet = useCallback(async (): Promise<void> => {
    if (id === "") {
      return;
    }
    setIsLoading(true);
    setErrorMessage(null);
    try {
      setSheet(await getBatchRouteSheet(id));
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void loadSheet();
  }, [loadSheet]);

  /** Opens the PDF preview window, or the browser's own printer in dev. */
  async function printSheet(): Promise<void> {
    if (window.electronAPI === undefined) {
      window.print();
      return;
    }

    const report = describePrintOutcome(await window.electronAPI.printCurrentWindow());

    if (report.tone === "error") {
      setErrorMessage(report.message);
    }
  }

  async function exportSheet(format: "pdf" | "xlsx"): Promise<void> {
    setIsExporting(true);
    setErrorMessage(null);
    try {
      const { fileName, bytes } = await downloadBatchRouteSheet(id, format);
      saveBytes(
        fileName,
        bytes,
        format === "pdf"
          ? "application/pdf"
          : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsExporting(false);
    }
  }

  return (
    <AppShell
      pageTitle={sheet === null ? "Route Sheet" : `Route Sheet — ${sheet.batchNumber}`}
      pageDescription={
        sheet === null
          ? "Who to visit, where, and how much to ask for"
          : `${sheet.collectorName} · field date ${formatDateOnly(sheet.collectionDate)}${
              sheet.areaName === null ? "" : ` · ${sheet.areaName}`
            }`
      }
      headerActions={
        <Link
          to={`/collector-batches/${id}`}
          className="inline-flex h-9 items-center rounded-lg border border-line-strong bg-surface px-3.5 text-sm font-medium text-content-primary transition-colors hover:bg-canvas"
        >
          Batches
        </Link>
      }
    >
      <div className="w-full max-w-6xl space-y-5">
        <div className="flex flex-wrap gap-2 print:hidden">
          <Button variant="secondary" onClick={() => void printSheet()} disabled={sheet === null}>
            Print / Save as PDF
          </Button>
          {canExport && (
            <>
              <Button
                variant="outline"
                onClick={() => void exportSheet("pdf")}
                isLoading={isExporting}
                disabled={sheet === null}
              >
                Export PDF
              </Button>
              <Button
                variant="outline"
                onClick={() => void exportSheet("xlsx")}
                isLoading={isExporting}
                disabled={sheet === null}
              >
                Export XLSX
              </Button>
            </>
          )}
          {!canExport && (
            <p className="self-center text-xs text-content-secondary">
              Your role may view the sheet but not export it.
            </p>
          )}
        </div>

        {errorMessage !== null && (
          <ErrorBanner message={errorMessage} onRetry={() => void loadSheet()} />
        )}

        {isLoading || sheet === null ? (
          <Card>
            <TableSkeleton rows={6} columns={8} />
          </Card>
        ) : sheet.rows.length === 0 ? (
          <Card>
            <EmptyState
              title="No accounts on this route sheet"
              description="This batch has no assigned service accounts, so there is nothing to visit yet."
            />
          </Card>
        ) : (
          <Card>
            <header className="space-y-1 border-b border-line px-4 py-4 sm:px-6">
              <h2 className="text-lg font-semibold text-content-primary">
                Route Sheet — {sheet.batchNumber}
              </h2>
              <p className="text-sm text-content-secondary">
                Collector: {sheet.collectorName} · Field date{" "}
                {formatDateOnly(sheet.collectionDate)}
                {sheet.areaName === null ? "" : ` · Area: ${sheet.areaName}`}
              </p>
            </header>
            <div className="overflow-x-auto">
              <table className="route-sheet w-full text-left text-sm">
                <thead className="bg-canvas text-content-secondary">
                  <tr>
                    <th className="px-4 py-3 font-medium">Account #</th>
                    <th className="px-4 py-3 font-medium">Subscriber</th>
                    <th className="px-4 py-3 font-medium">Address</th>
                    <th className="px-4 py-3 text-right font-medium">Current Bill</th>
                    <th className="px-4 py-3 text-right font-medium">Arrears</th>
                    <th className="px-4 py-3 text-right font-medium">Total Due</th>
                    <th className="px-4 py-3 font-medium">Collector</th>
                    <th className="px-4 py-3 font-medium">Area</th>
                  </tr>
                </thead>
                <tbody>
                  {sheet.rows.map((row) => (
                    <tr key={row.serviceAccountId} className="border-t border-line">
                      <td className="px-4 py-3 font-mono text-xs">{row.serviceAccountNumber}</td>
                      <td className="px-4 py-3">{row.subscriberName}</td>
                      <td className="px-4 py-3 text-content-secondary">{row.address}</td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {formatCentavos(row.currentBillCentavos)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {formatCentavos(row.arrearsCentavos)}
                      </td>
                      <td className="px-4 py-3 text-right font-medium tabular-nums">
                        {formatCentavos(row.totalDueCentavos)}
                      </td>
                      <td className="px-4 py-3">{row.collectorName}</td>
                      <td className="px-4 py-3">{row.areaName}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-canvas font-semibold">
                  <tr className="border-t border-line">
                    <td className="px-4 py-3" colSpan={3}>
                      Total ({sheet.totals.accountCount} account{sheet.totals.accountCount === 1 ? "" : "s"})
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {formatCentavos(sheet.totals.currentBillCentavos)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {formatCentavos(sheet.totals.arrearsCentavos)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {formatCentavos(sheet.totals.totalDueCentavos)}
                    </td>
                    <td className="px-4 py-3" colSpan={2} />
                  </tr>
                </tfoot>
              </table>
            </div>
          </Card>
        )}
      </div>
    </AppShell>
  );
}
