import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import {
  LEDGER_ENTRY_TYPE_LABELS,
  LOW_BALANCE_THRESHOLD_CENTAVOS,
  SERVICE_ACCOUNT_STATUS_LABELS,
  SERVICE_TYPE_LABELS,
  roleHasPermission,
} from "@bcis/shared";
import {
  extractApiErrorMessage,
  getServiceAccountLedger,
  postManualLedgerEntry,
  verifyLedgerIntegrity,
  type LedgerEntrySummary,
  type LedgerIntegrityResult,
  type ServiceAccountLedger,
} from "../lib/api-client";
import { formatCentavos, formatDateOnly, parsePesosToCentavos } from "../lib/format";
import { useAuthStore } from "../stores/auth.store";
import { AppShell } from "../components/layout/AppShell";
import { DataTable, type TableColumn } from "../components/table/DataTable";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { ErrorBanner } from "../components/ui/ErrorBanner";
import { TableSkeleton } from "../components/ui/Skeleton";

/** The page size the ledger opens with. Server-side paging caps it at 200. */
const DEFAULT_PAGE_SIZE = 50;

/** Green when paid up, amber while a small balance remains, red when overdue. */
function balanceToneClass(balanceCentavos: number): string {
  if (balanceCentavos <= 0) {
    return "text-success-strong";
  }
  if (balanceCentavos <= LOW_BALANCE_THRESHOLD_CENTAVOS) {
    return "text-warning-strong";
  }
  return "text-danger-strong";
}

/** The date part of an ISO timestamp, for the `formatDateOnly` helper. */
function toDateOnly(isoTimestamp: string): string {
  return isoTimestamp.slice(0, 10);
}

// The running balance is cumulative, so a column sort would reorder the ledger and
// make the balance column read as if it were wrong. Only the description sorts; the
// ledger's real order is sequence order, which the server owns.
const LEDGER_COLUMNS: TableColumn<LedgerEntrySummary>[] = [
  {
    id: "entryDate",
    header: "Date",
    cellClassName: "whitespace-nowrap text-content-secondary",
    sortValue: (entry) => entry.entryDate,
    cell: (entry) => formatDateOnly(toDateOnly(entry.entryDate)),
  },
  {
    id: "description",
    header: "Description",
    sortValue: (entry) => entry.description,
    cell: (entry) => (
      <>
        <span className="block text-content-primary">{entry.description}</span>
        <span className="text-xs text-content-secondary">
          {LEDGER_ENTRY_TYPE_LABELS[entry.entryType]}
        </span>
      </>
    ),
  },
  {
    id: "debitCentavos",
    header: "Debit",
    align: "right",
    cellClassName: "tabular-nums",
    sortValue: (entry) => entry.debitCentavos,
    cell: (entry) => (entry.debitCentavos > 0 ? formatCentavos(entry.debitCentavos) : "—"),
  },
  {
    id: "creditCentavos",
    header: "Credit",
    align: "right",
    cellClassName: "tabular-nums",
    sortValue: (entry) => entry.creditCentavos,
    cell: (entry) => (entry.creditCentavos > 0 ? formatCentavos(entry.creditCentavos) : "—"),
  },
  {
    id: "runningBalanceCentavos",
    header: "Balance",
    align: "right",
    cellClassName: "font-medium tabular-nums",
    cell: (entry) => formatCentavos(entry.runningBalanceCentavos),
  },
  {
    id: "referenceNumber",
    header: "Reference",
    cellClassName: "font-mono text-xs text-content-secondary",
    sortValue: (entry) => entry.referenceNumber,
    cell: (entry) => (entry.referenceNumber === "" ? "—" : entry.referenceNumber),
  },
];

/**
 * Service account ledger: the account header, the running balance, and every
 * financial entry in order. The balance shown is always computed from the ledger.
 */
export function ServiceAccountLedgerPage(): ReactNode {
  const { id } = useParams<{ id: string }>();
  const user = useAuthStore((state) => state.user);

  const [ledger, setLedger] = useState<ServiceAccountLedger | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [integrity, setIntegrity] = useState<LedgerIntegrityResult | null>(null);

  const [manualType, setManualType] = useState<"manual_debit" | "manual_credit">("manual_debit");
  const [manualAmount, setManualAmount] = useState("");
  const [manualReason, setManualReason] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const canVerify = user !== null && roleHasPermission(user.role, "ledger:verify");
  const canAdjust = user !== null && roleHasPermission(user.role, "ledger:adjust");

  const loadLedger = useCallback(async (): Promise<void> => {
    if (id === undefined) {
      return;
    }
    setIsLoading(true);
    setErrorMessage(null);
    try {
      setLedger(
        await getServiceAccountLedger(id, {
          fromDate: fromDate === "" ? undefined : fromDate,
          toDate: toDate === "" ? undefined : toDate,
          page,
          pageSize,
        })
      );
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  }, [id, fromDate, toDate, page, pageSize]);

  useEffect(() => {
    void loadLedger();
  }, [loadLedger]);

  async function runIntegrityCheck(): Promise<void> {
    if (id === undefined) {
      return;
    }
    setIntegrity(null);
    try {
      setIntegrity(await verifyLedgerIntegrity(id));
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    }
  }

  async function submitManualEntry(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (id === undefined) {
      return;
    }

    const amountCentavos = parsePesosToCentavos(manualAmount);
    if (amountCentavos === null || amountCentavos <= 0) {
      setErrorMessage("Enter an amount greater than zero, e.g. 500.00.");
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      const result = await postManualLedgerEntry({
        serviceAccountId: id,
        entryType: manualType,
        amountCentavos,
        reason: manualReason,
      });
      setStatusMessage(
        `Adjustment recorded. New balance: ${formatCentavos(result.balanceCentavos)}.`
      );
      setManualAmount("");
      setManualReason("");
      await loadLedger();
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  const fieldClass =
    "h-9 rounded-lg border border-line-strong bg-surface px-3 text-sm text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

  const pageDescription =
    ledger === null ? "Loading the account ledger" : `${ledger.header.subscriberName} · ${ledger.header.serviceAccountNumber}`;

  return (
    <AppShell pageTitle="Account Ledger" pageDescription={pageDescription}>
      <div className="space-y-5">
        {isLoading && ledger === null ? (
          <Card>
            <TableSkeleton rows={6} columns={6} />
          </Card>
        ) : ledger === null ? (
          <>
            <ErrorBanner
              message={errorMessage ?? "Ledger not found."}
              onRetry={() => void loadLedger()}
            />
            <Link to="/subscribers" className="inline-block text-sm font-medium text-content-primary underline">
              Back to subscribers
            </Link>
          </>
        ) : (
          <>
            {/* Account header with balance summary */}
            <Card className="p-6">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <Badge variant="neutral" size="sm">
                      {SERVICE_TYPE_LABELS[ledger.header.serviceType]}
                    </Badge>
                    <span className="font-mono text-xs text-content-secondary">
                      {ledger.header.serviceAccountNumber}
                    </span>
                  </div>
                  <h2 className="text-lg font-semibold text-content-primary">{ledger.header.planName}</h2>
                  <p className="text-sm text-content-secondary">
                    {ledger.header.subscriberName} ·{" "}
                    {SERVICE_ACCOUNT_STATUS_LABELS[ledger.header.status]} ·{" "}
                    {ledger.header.entryCount} ledger {ledger.header.entryCount === 1 ? "entry" : "entries"}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-xs text-content-secondary">Current balance</p>
                  <p className={`text-3xl font-semibold tabular-nums ${balanceToneClass(ledger.header.balanceCentavos)}`}>
                    {formatCentavos(ledger.header.balanceCentavos)}
                  </p>
                  <p className="text-xs text-content-secondary">
                    {ledger.header.balanceCentavos > 0
                      ? "Amount owed"
                      : ledger.header.balanceCentavos < 0
                        ? "Advance credit"
                        : "Paid up"}
                  </p>
                  <Link
                    to={`/service-accounts/${ledger.header.serviceAccountId}/statement`}
                    className="mt-3 inline-flex h-9 items-center rounded-lg border border-line-strong bg-surface px-3.5 text-sm font-medium text-content-primary transition-colors hover:bg-canvas"
                  >
                    Export Statement
                  </Link>
                </div>
              </div>
            </Card>

            {statusMessage !== null && (
              <p className="rounded-lg border border-success-line bg-success-soft px-4 py-3 text-sm text-success-strong">
                {statusMessage}
              </p>
            )}
            {errorMessage !== null && <ErrorBanner message={errorMessage} onRetry={() => void loadLedger()} />}

            {/* Date range filter + integrity check */}
            <Card className="p-4">
              <div className="flex flex-wrap items-end gap-3">
                <label className="space-y-1.5">
                  <span className="block text-xs font-medium text-content-secondary">From</span>
                  <input
                    type="date"
                    value={fromDate}
                    onChange={(event) => setFromDate(event.target.value)}
                    className={fieldClass}
                  />
                </label>
                <label className="space-y-1.5">
                  <span className="block text-xs font-medium text-content-secondary">To</span>
                  <input
                    type="date"
                    value={toDate}
                    onChange={(event) => setToDate(event.target.value)}
                    className={fieldClass}
                  />
                </label>
                <Button
                  type="button"
                  variant="secondary"
                  size="md"
                  onClick={() => {
                    setPage(1);
                    void loadLedger();
                  }}
                >
                  Apply filter
                </Button>
                {(fromDate !== "" || toDate !== "") && (
                  <Button
                    type="button"
                    variant="outline"
                    size="md"
                    onClick={() => {
                      setFromDate("");
                      setToDate("");
                      setPage(1);
                    }}
                  >
                    Clear
                  </Button>
                )}
                {canVerify && (
                  <Button
                    type="button"
                    variant="outline"
                    size="md"
                    onClick={() => void runIntegrityCheck()}
                    className="ml-auto"
                  >
                    Verify integrity
                  </Button>
                )}
              </div>
            </Card>

            {integrity !== null && (
              <p
                className={
                  integrity.isValid
                    ? "rounded-lg border border-success-line bg-success-soft px-4 py-3 text-sm text-success-strong tabular-nums"
                    : "rounded-lg border border-danger-line bg-danger-soft px-4 py-3 text-sm text-danger-strong tabular-nums"
                }
              >
                {integrity.isValid
                  ? `Ledger chain is sound (${integrity.entryCount} entries, closing ${formatCentavos(integrity.lastComputedBalanceCentavos)}).`
                  : `Ledger integrity FAILED (${integrity.failure}). Computed ${formatCentavos(integrity.lastComputedBalanceCentavos)}, stored ${formatCentavos(integrity.lastStoredBalanceCentavos)}.`}
              </p>
            )}

            {/* Ledger entries: paged on the server so a long-lived account does not
                ship its whole history to the renderer. */}
            <Card>
              <DataTable
                columns={LEDGER_COLUMNS}
                data={ledger.items}
                getRowId={(entry) => entry.id}
                emptyState={
                  <EmptyState
                    title="No ledger entries in this period"
                    description="Widen the date range, or the account has no financial activity yet."
                  />
                }
                pagination={{
                  page,
                  pageSize,
                  total: ledger.total,
                  rowNoun: "entry",
                  rowNounPlural: "entries",
                  onPageChange: setPage,
                  onPageSizeChange: (nextPageSize) => {
                    setPageSize(nextPageSize);
                    setPage(1);
                  },
                }}
              />
            </Card>

            {canAdjust && (
              <Card className="p-5">
                <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-content-secondary">
                  Manual adjustment (Admin)
                </h2>
                <form onSubmit={(event) => void submitManualEntry(event)} className="flex flex-wrap items-end gap-3">
                  <label className="space-y-1.5">
                    <span className="block text-xs font-medium text-content-secondary">Type</span>
                    <select
                      value={manualType}
                      onChange={(event) => setManualType(event.target.value as "manual_debit" | "manual_credit")}
                      className={fieldClass}
                    >
                      <option value="manual_debit">Manual debit (charge)</option>
                      <option value="manual_credit">Manual credit</option>
                    </select>
                  </label>
                  <label className="space-y-1.5">
                    <span className="block text-xs font-medium text-content-secondary">Amount</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={manualAmount}
                      onChange={(event) => setManualAmount(event.target.value)}
                      placeholder="0.00"
                      className={`${fieldClass} w-32`}
                    />
                  </label>
                  <label className="min-w-64 flex-1 space-y-1.5">
                    <span className="block text-xs font-medium text-content-secondary">
                      Justification (at least 10 characters)
                    </span>
                    <input
                      type="text"
                      value={manualReason}
                      onChange={(event) => setManualReason(event.target.value)}
                      className={`${fieldClass} w-full`}
                    />
                  </label>
                  <Button type="submit" size="md" isLoading={isSubmitting}>
                    Post adjustment
                  </Button>
                </form>
              </Card>
            )}
          </>
        )}
      </div>
    </AppShell>
  );
}