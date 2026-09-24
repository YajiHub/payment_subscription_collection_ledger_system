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

const STATUS_BADGE_CLASSES = {
  open: "bg-sky-50 text-sky-700",
  submitted: "bg-amber-50 text-amber-700",
  reconciled: "bg-emerald-50 text-emerald-700",
  cancelled: "bg-slate-100 text-slate-500",
} satisfies Record<CollectorBatchStatus, string>;

/** A human label for the variance, colour-coded, or a dash while unsubmitted. */
function VarianceCell({ batch }: { batch: CollectorBatchSummary }): ReactNode {
  if (batch.varianceCentavos === null) {
    return <span className="text-slate-400">—</span>;
  }
  if (batch.varianceCentavos === 0) {
    return <span className="text-emerald-700">{formatCentavos(0)}</span>;
  }
  return (
    <span className={batch.varianceCentavos > 0 ? "text-amber-700" : "text-red-700"}>
      {formatCentavos(batch.varianceCentavos)}
    </span>
  );
}

/** Field-collection batch list: filter, browse, and open a batch. */
export function CollectorBatchListPage(): ReactNode {
  const [batches, setBatches] = useState<CollectorBatchSummary[]>([]);
  const [collectors, setCollectors] = useState<AssignableCollector[]>([]);
  const [statusFilter, setStatusFilter] = useState<CollectorBatchStatus | "">("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
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
        page: 1,
        pageSize: 100,
      });
      setBatches(result.items);
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  }, [statusFilter, dateFrom, dateTo]);

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
    <main className="mx-auto max-w-5xl space-y-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Collector Batches</h1>
        <div className="flex gap-3 text-sm">
          <Link to="/receivables/aging" className="text-slate-800 underline">
            AR Aging
          </Link>
          <Link to="/receivables/overdue" className="text-slate-800 underline">
            Overdue Accounts
          </Link>
        </div>
      </header>

      <section className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="block text-slate-600">Status</span>
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as CollectorBatchStatus | "")}
              className="rounded border border-slate-300 px-2 py-1"
            >
              <option value="">All</option>
              {COLLECTOR_BATCH_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {COLLECTOR_BATCH_STATUS_LABELS[status]}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-slate-600">From</span>
            <input
              type="date"
              value={dateFrom}
              onChange={(event) => setDateFrom(event.target.value)}
              className="rounded border border-slate-300 px-2 py-1"
            />
          </label>
          <label className="text-sm">
            <span className="block text-slate-600">To</span>
            <input
              type="date"
              value={dateTo}
              onChange={(event) => setDateTo(event.target.value)}
              className="rounded border border-slate-300 px-2 py-1"
            />
          </label>
          <button
            type="button"
            onClick={() => setIsCreating((open) => !open)}
            className="rounded bg-slate-800 px-3 py-1.5 text-sm text-white"
          >
            {isCreating ? "Close" : "Create Batch"}
          </button>
        </div>

        {isCreating && (
          <form onSubmit={(event) => void handleCreate(event)} className="space-y-3 border-t pt-3">
            <div className="flex flex-wrap gap-3">
              <label className="text-sm">
                <span className="block text-slate-600">Collector</span>
                <select
                  value={collectorId}
                  onChange={(event) => setCollectorId(event.target.value)}
                  className="rounded border border-slate-300 px-2 py-1"
                >
                  <option value="">Select a collector…</option>
                  {collectors.map((collector) => (
                    <option key={collector.id} value={collector.id}>
                      {collector.fullName}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm">
                <span className="block text-slate-600">Field date</span>
                <input
                  type="date"
                  value={collectionDate}
                  onChange={(event) => setCollectionDate(event.target.value)}
                  className="rounded border border-slate-300 px-2 py-1"
                />
              </label>
            </div>

            <ServiceAccountPicker
              selectedIds={selectedAccountIds}
              onChange={setSelectedAccountIds}
            />

            {createError !== null && <p className="text-sm text-red-700">{createError}</p>}

            <button type="submit" className="rounded bg-emerald-700 px-3 py-1.5 text-sm text-white">
              Create Batch
            </button>
          </form>
        )}

        {errorMessage !== null && <p className="text-sm text-red-700">{errorMessage}</p>}
      </section>

      <section className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-left text-slate-600">
            <tr>
              <th className="px-4 py-3">Batch #</th>
              <th className="px-4 py-3">Collector</th>
              <th className="px-4 py-3">Date</th>
              <th className="px-4 py-3">Accounts</th>
              <th className="px-4 py-3">Expected</th>
              <th className="px-4 py-3">Actual</th>
              <th className="px-4 py-3">Variance</th>
              <th className="px-4 py-3">Status</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-slate-500">
                  Loading batches…
                </td>
              </tr>
            ) : batches.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-slate-500">
                  No batches match these filters.
                </td>
              </tr>
            ) : (
              batches.map((batch) => (
                <tr key={batch.id} className="border-t border-slate-100">
                  <td className="px-4 py-3">
                    <Link
                      to={`/collector-batches/${batch.id}`}
                      className="font-mono text-slate-700 underline"
                    >
                      {batch.batchNumber}
                    </Link>
                  </td>
                  <td className="px-4 py-3">{batch.collectorName}</td>
                  <td className="px-4 py-3">{formatDateOnly(batch.collectionDate)}</td>
                  <td className="px-4 py-3">
                    {batch.collectedCount}/{batch.assignmentCount}
                  </td>
                  <td className="px-4 py-3">{formatCentavos(batch.expectedRemittanceCentavos)}</td>
                  <td className="px-4 py-3">
                    {batch.actualRemittanceCentavos === null
                      ? "—"
                      : formatCentavos(batch.actualRemittanceCentavos)}
                  </td>
                  <td className="px-4 py-3">
                    <VarianceCell batch={batch} />
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${STATUS_BADGE_CLASSES[batch.status]}`}
                    >
                      {COLLECTOR_BATCH_STATUS_LABELS[batch.status]}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </main>
  );
}