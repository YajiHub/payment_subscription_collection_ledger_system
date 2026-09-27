import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import {
  COLLECTOR_BATCH_STATUSES,
  COLLECTOR_BATCH_STATUS_LABELS,
  type CollectorBatchStatus,
} from "@bcis/shared";
import { ServiceAccountPicker } from "../components/ServiceAccountPicker";
import {
  createCollectorBatch,
  extractApiErrorMessage,
  listAssignableCollectors,
  listCollectorBatches,
  type AssignableCollector,
  type CollectorBatchSummary,
} from "../lib/api-client";
import { formatCentavos, formatDateOnly } from "../lib/format";
import { AppShell } from "../components/layout/AppShell";
import { DataTable, type TableColumn } from "../components/table/DataTable";
import { Badge, type BadgeVariant } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { ErrorBanner } from "../components/ui/ErrorBanner";

const STATUS_BADGE_VARIANTS = {
  open: "info",
  submitted: "warning",
  reconciled: "success",
  cancelled: "neutral",
} satisfies Record<CollectorBatchStatus, BadgeVariant>;

/** The page size the list opens with. Server-side paging caps it at 200. */
const DEFAULT_PAGE_SIZE = 20;

const fieldClass =
  "h-9 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

/** A human label for the variance, colour-coded, or a dash while unsubmitted. */
function VarianceCell({ batch }: { batch: CollectorBatchSummary }): ReactNode {
  if (batch.varianceCentavos === null) {
    return <span className="text-content-secondary">—</span>;
  }
  if (batch.varianceCentavos === 0) {
    return <span className="tabular-nums text-success-strong">{formatCentavos(0)}</span>;
  }
  return (
    <span
      className={`tabular-nums ${batch.varianceCentavos > 0 ? "text-warning-strong" : "text-danger-strong"}`}
    >
      {formatCentavos(batch.varianceCentavos)}
    </span>
  );
}

const BATCH_COLUMNS: TableColumn<CollectorBatchSummary>[] = [
  {
    id: "batchNumber",
    header: "Batch #",
    sortValue: (batch) => batch.batchNumber,
    cell: (batch) => (
      <Link
        to={`/collector-batches/${batch.id}`}
        className="font-mono text-sm text-accent underline-offset-4 hover:underline"
      >
        {batch.batchNumber}
      </Link>
    ),
  },
  {
    id: "collectorName",
    header: "Collector",
    cellClassName: "text-content-primary",
    sortValue: (batch) => batch.collectorName,
    cell: (batch) => batch.collectorName,
  },
  {
    id: "collectionDate",
    header: "Date",
    cellClassName: "text-content-secondary",
    sortValue: (batch) => batch.collectionDate,
    cell: (batch) => formatDateOnly(batch.collectionDate),
  },
  {
    id: "collectedCount",
    header: "Accounts",
    cellClassName: "text-content-primary",
    sortValue: (batch) => batch.collectedCount,
    cell: (batch) => `${batch.collectedCount}/${batch.assignmentCount}`,
  },
  {
    id: "expectedRemittanceCentavos",
    header: "Expected",
    align: "right",
    cellClassName: "tabular-nums",
    sortValue: (batch) => batch.expectedRemittanceCentavos,
    cell: (batch) => formatCentavos(batch.expectedRemittanceCentavos),
  },
  {
    id: "actualRemittanceCentavos",
    header: "Actual",
    align: "right",
    cellClassName: "tabular-nums",
    sortValue: (batch) => batch.actualRemittanceCentavos ?? -1,
    cell: (batch) =>
      batch.actualRemittanceCentavos === null
        ? "—"
        : formatCentavos(batch.actualRemittanceCentavos),
  },
  {
    id: "varianceCentavos",
    header: "Variance",
    align: "right",
    sortValue: (batch) => batch.varianceCentavos ?? -1,
    cell: (batch) => <VarianceCell batch={batch} />,
  },
  {
    id: "status",
    header: "Status",
    sortValue: (batch) => batch.status,
    cell: (batch) => (
      <Badge variant={STATUS_BADGE_VARIANTS[batch.status]} size="sm" dot>
        {COLLECTOR_BATCH_STATUS_LABELS[batch.status]}
      </Badge>
    ),
  },
];

/** Field-collection batch list: filter, browse, and open a batch. */
export function CollectorBatchListPage(): ReactNode {
  const [batches, setBatches] = useState<CollectorBatchSummary[]>([]);
  const [collectors, setCollectors] = useState<AssignableCollector[]>([]);
  const [statusFilter, setStatusFilter] = useState<CollectorBatchStatus | "">("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [isCreating, setIsCreating] = useState(false);
  const [collectorId, setCollectorId] = useState("");
  const [collectionDate, setCollectionDate] = useState("");
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [createError, setCreateError] = useState<string | null>(null);

  const loadBatches = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const result = await listCollectorBatches({
        status: statusFilter === "" ? undefined : statusFilter,
        dateFrom: dateFrom === "" ? undefined : dateFrom,
        dateTo: dateTo === "" ? undefined : dateTo,
        page,
        pageSize,
      });
      setBatches(result.items);
      setTotal(result.total);
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  }, [statusFilter, dateFrom, dateTo, page, pageSize]);

  useEffect(() => {
    void loadBatches();
  }, [loadBatches]);

  useEffect(() => {
    async function loadCollectorOptions(): Promise<void> {
      try {
        setCollectors(await listAssignableCollectors());
      } catch {
        // A Collector cannot list collectors; the picker simply stays empty for them.
        setCollectors([]);
      }
    }
    void loadCollectorOptions();
  }, []);

  async function handleCreate(event: FormEvent): Promise<void> {
    event.preventDefault();
    setCreateError(null);

    if (collectorId === "" || collectionDate === "" || selectedAccountIds.length === 0) {
      setCreateError("Choose a collector, a field date, and at least one service account.");
      return;
    }

    try {
      const created = await createCollectorBatch({
        collectorId,
        collectionDate,
        serviceAccountIds: selectedAccountIds,
      });
      setIsCreating(false);
      setSelectedAccountIds([]);
      window.location.hash = `#/collector-batches/${created.id}`;
    } catch (error) {
      setCreateError(extractApiErrorMessage(error));
    }
  }

  return (
    <AppShell
      pageTitle="Collector Batches"
      pageDescription="Field collections grouped by collector and date"
      headerActions={
        <div className="flex items-center gap-2">
          <Link
            to="/receivables/aging"
            className="inline-flex h-9 items-center rounded-lg border border-line-strong bg-surface px-3.5 text-sm font-medium text-content-primary transition-colors hover:bg-canvas"
          >
            AR Aging
          </Link>
          <Link
            to="/receivables/overdue"
            className="inline-flex h-9 items-center rounded-lg border border-line-strong bg-surface px-3.5 text-sm font-medium text-content-primary transition-colors hover:bg-canvas"
          >
            Overdue Accounts
          </Link>
        </div>
      }
    >
      <div className="space-y-5">
        <Card className="p-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-content-secondary">Status</span>
              <select
                value={statusFilter}
                onChange={(event) => {
                  setStatusFilter(event.target.value as CollectorBatchStatus | "");
                  setPage(1);
                }}
                className={fieldClass}
              >
                <option value="">All</option>
                {COLLECTOR_BATCH_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {COLLECTOR_BATCH_STATUS_LABELS[status]}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-content-secondary">From</span>
              <input
                type="date"
                value={dateFrom}
                onChange={(event) => {
                  setDateFrom(event.target.value);
                  setPage(1);
                }}
                className={fieldClass}
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-content-secondary">To</span>
              <input
                type="date"
                value={dateTo}
                onChange={(event) => {
                  setDateTo(event.target.value);
                  setPage(1);
                }}
                className={fieldClass}
              />
            </label>
            <Button
              type="button"
              variant={isCreating ? "outline" : "secondary"}
              size="md"
              onClick={() => setIsCreating((open) => !open)}
            >
              {isCreating ? "Close" : "Create Batch"}
            </Button>
          </div>

          {isCreating && (
            <form
              onSubmit={(event) => void handleCreate(event)}
              className="mt-4 space-y-4 border-t border-line pt-4"
            >
              <div className="flex flex-wrap gap-3">
                <label className="block space-y-1.5">
                  <span className="text-xs font-medium text-content-secondary">Collector</span>
                  <select
                    value={collectorId}
                    onChange={(event) => setCollectorId(event.target.value)}
                    className={fieldClass}
                  >
                    <option value="">Select a collector…</option>
                    {collectors.map((collector) => (
                      <option key={collector.id} value={collector.id}>
                        {collector.fullName}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block space-y-1.5">
                  <span className="text-xs font-medium text-content-secondary">Field date</span>
                  <input
                    type="date"
                    value={collectionDate}
                    onChange={(event) => setCollectionDate(event.target.value)}
                    className={fieldClass}
                  />
                </label>
              </div>

              <ServiceAccountPicker selectedIds={selectedAccountIds} onChange={setSelectedAccountIds} />

              {createError !== null && <ErrorBanner message={createError} />}

              <div className="flex justify-end">
                <Button type="submit" size="md">
                  Create Batch
                </Button>
              </div>
            </form>
          )}
        </Card>

        {errorMessage !== null && (
          <ErrorBanner message={errorMessage} onRetry={() => void loadBatches()} />
        )}

        <Card>
          <DataTable
            columns={BATCH_COLUMNS}
            data={batches}
            getRowId={(batch) => batch.id}
            isLoading={isLoading}
            emptyState={
              <EmptyState
                title="No collector batches match these filters"
                description="Widen the status or date range, or create a batch to assign service accounts to a collector."
                actionLabel="Create Batch"
                onAction={() => setIsCreating(true)}
              />
            }
            pagination={{
              page,
              pageSize,
              total,
              rowNoun: "batch",
              rowNounPlural: "batches",
              onPageChange: setPage,
              onPageSizeChange: (nextPageSize) => {
                setPageSize(nextPageSize);
                setPage(1);
              },
            }}
          />
        </Card>
      </div>
    </AppShell>
  );
}
