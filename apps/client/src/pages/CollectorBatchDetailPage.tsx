import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import {
  COLLECTED_METHODS,
  COLLECTED_METHOD_LABELS,
  COLLECTION_RESULTS,
  COLLECTION_RESULT_LABELS,
  COLLECTOR_BATCH_STATUS_LABELS,
  roleHasPermission,
  type CollectedMethod,
  type CollectionResult,
} from "@bcis/shared";
import { ServiceAccountPicker } from "../components/ServiceAccountPicker";
import {
  addBatchAssignments,
  cancelCollectorBatch,
  extractApiErrorMessage,
  getCollectorBatch,
  reconcileBatch,
  recordCollection,
  submitBatchRemittance,
  voidCollection,
  type BatchAssignmentSummary,
  type CollectorBatchDetail,
} from "../lib/api-client";
import { formatCentavos, formatDateOnly, parsePesosToCentavos } from "../lib/format";
import { useAuthStore } from "../stores/auth.store";

/** The variance as text, coloured: green exact, amber overage, red shortage. */
function formatVariance(varianceCentavos: number | null): ReactNode {
  if (varianceCentavos === null) {
    return <span className="text-slate-400">Not yet submitted</span>;
  }
  if (varianceCentavos === 0) {
    return <span className="text-emerald-700">{formatCentavos(0)} (exact)</span>;
  }
  return (
    <span className={varianceCentavos > 0 ? "text-amber-700" : "text-red-700"}>
      {formatCentavos(varianceCentavos)} ({varianceCentavos > 0 ? "overage" : "shortage"})
    </span>
  );
}

/** One assignment row plus the office actions available on it. */
interface AssignmentRowProps {
  assignment: BatchAssignmentSummary;
  isOpen: boolean;
  canRecord: boolean;
  canVoid: boolean;
  onRecord: (assignment: BatchAssignmentSummary) => void;
  onVoid: (assignment: BatchAssignmentSummary) => void;
}

function AssignmentRow({
  assignment,
  isOpen,
  canRecord,
  canVoid,
  onRecord,
  onVoid,
}: AssignmentRowProps): ReactNode {
  const isVoided = assignment.voidedAt !== null;

  return (
    <tr className="border-t border-slate-100">
      <td className="px-4 py-3">{assignment.subscriberName}</td>
      <td className="px-4 py-3 font-mono text-xs">{assignment.serviceAccountNumber}</td>
      <td className="px-4 py-3">{formatCentavos(assignment.outstandingBalanceCentavos)}</td>
      <td className="px-4 py-3">
        {assignment.collectedAmountCentavos === null
          ? "—"
          : formatCentavos(assignment.collectedAmountCentavos)}
      </td>
      <td className="px-4 py-3">
        {assignment.collectedMethod === null
          ? "—"
          : COLLECTED_METHOD_LABELS[assignment.collectedMethod]}
      </td>
      <td className="px-4 py-3">
        {assignment.collectionResult === null
          ? "Pending"
          : COLLECTION_RESULT_LABELS[assignment.collectionResult]}
        {isVoided && <span className="ml-2 text-xs text-red-700">voided</span>}
      </td>
      <td className="px-4 py-3 text-xs text-slate-600">{assignment.collectorNotes ?? "—"}</td>
      <td className="px-4 py-3">
        {isOpen && !isVoided && (
          <div className="flex gap-2">
            {canRecord && assignment.collectionResult === null && (
              <button
                type="button"
                onClick={() => onRecord(assignment)}
                className="rounded bg-slate-800 px-2 py-1 text-xs text-white"
              >
                Record Collection
              </button>
            )}
            {canVoid && assignment.collectionResult !== null && (
              <button
                type="button"
                onClick={() => onVoid(assignment)}
                className="rounded bg-red-700 px-2 py-1 text-xs text-white"
              >
                Void
              </button>
            )}
          </div>
        )}
      </td>
    </tr>
  );
}

/** Batch detail: record field collections, submit the cash, and reconcile. */
export function CollectorBatchDetailPage(): ReactNode {
  const { id = "" } = useParams();
  const user = useAuthStore((state) => state.user);

  const [batch, setBatch] = useState<CollectorBatchDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const [recordingFor, setRecordingFor] = useState<BatchAssignmentSummary | null>(null);
  const [recordResult, setRecordResult] = useState<CollectionResult>("collected");
  const [recordAmount, setRecordAmount] = useState("");
  const [recordMethod, setRecordMethod] = useState<CollectedMethod>("cash");
  const [recordGcashReference, setRecordGcashReference] = useState("");
  const [recordNotes, setRecordNotes] = useState("");

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [actualCash, setActualCash] = useState("");
  const [varianceNotes, setVarianceNotes] = useState("");
  const [isAddingAccounts, setIsAddingAccounts] = useState(false);
  const [newAccountIds, setNewAccountIds] = useState<string[]>([]);

  const loadBatch = useCallback(async (): Promise<void> => {
    if (id === "") {
      return;
    }
    setIsLoading(true);
    setErrorMessage(null);
    try {
      setBatch(await getCollectorBatch(id));
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void loadBatch();
  }, [loadBatch]);

  const canRecord = user !== null && roleHasPermission(user.role, "collector_batches:remit");
  const canReconcile = user !== null && roleHasPermission(user.role, "collector_batches:reconcile");
  const canCreate = user !== null && roleHasPermission(user.role, "collector_batches:create");
  const isOpen = batch?.status === "open";
  const takesMoney = recordResult === "collected" || recordResult === "partial";

  async function handleRecord(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (batch === null || recordingFor === null) {
      return;
    }
    setActionMessage(null);

    const amountCentavos = takesMoney ? parsePesosToCentavos(recordAmount) : 0;
    if (takesMoney && (amountCentavos === null || amountCentavos <= 0)) {
      setActionMessage("Enter a collected amount greater than zero, e.g. 500.00.");
      return;
    }

    try {
      await recordCollection(batch.id, recordingFor.serviceAccountId, {
        result: recordResult,
        collectedAmountCentavos: takesMoney ? (amountCentavos ?? 0) : undefined,
        collectedMethod: takesMoney ? recordMethod : undefined,
        collectorNotes: recordNotes === "" ? undefined : recordNotes,
        gcash:
          takesMoney && recordMethod === "gcash"
            ? { referenceNumber: recordGcashReference }
            : undefined,
      });
      setRecordingFor(null);
      setRecordAmount("");
      setRecordGcashReference("");
      setRecordNotes("");
      await loadBatch();
    } catch (error) {
      setActionMessage(extractApiErrorMessage(error));
    }
  }

  async function handleVoid(assignment: BatchAssignmentSummary): Promise<void> {
    if (batch === null) {
      return;
    }
    const reason = window.prompt("Why is this collection being voided?");
    if (reason === null || reason.trim().length < 10) {
      setActionMessage("A reason of at least 10 characters is required to void a collection.");
      return;
    }

    setActionMessage(null);
    try {
      await voidCollection(batch.id, assignment.serviceAccountId, reason.trim());
      await loadBatch();
    } catch (error) {
      setActionMessage(extractApiErrorMessage(error));
    }
  }

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (batch === null) {
      return;
    }
    const actualCentavos = parsePesosToCentavos(actualCash);
    if (actualCentavos === null) {
      setActionMessage("Enter the cash handed in as a peso amount, e.g. 4500.00.");
      return;
    }

    setActionMessage(null);
    try {
      const result = await submitBatchRemittance(batch.id, actualCentavos);
      setIsSubmitting(false);
      setActionMessage(
        result.hasVariance
          ? `Submitted with a variance of ${formatCentavos(result.varianceCentavos)}.`
          : "Submitted with no variance."
      );
      await loadBatch();
    } catch (error) {
      setActionMessage(extractApiErrorMessage(error));
    }
  }

  async function handleReconcile(): Promise<void> {
    if (batch === null) {
      return;
    }
    setActionMessage(null);
    try {
      await reconcileBatch(batch.id, varianceNotes === "" ? undefined : varianceNotes);
      setVarianceNotes("");
      setActionMessage("Batch reconciled.");
      await loadBatch();
    } catch (error) {
      setActionMessage(extractApiErrorMessage(error));
    }
  }

  async function handleCancel(): Promise<void> {
    if (batch === null) {
      return;
    }
    const reason = window.prompt("Why is this batch being cancelled?") ?? undefined;
    setActionMessage(null);
    try {
      await cancelCollectorBatch(batch.id, reason);
      await loadBatch();
    } catch (error) {
      setActionMessage(extractApiErrorMessage(error));
    }
  }

  async function handleAddAccounts(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (batch === null || newAccountIds.length === 0) {
      return;
    }
    setActionMessage(null);
    try {
      await addBatchAssignments(batch.id, newAccountIds);
      setNewAccountIds([]);
      setIsAddingAccounts(false);
      await loadBatch();
    } catch (error) {
      setActionMessage(extractApiErrorMessage(error));
    }
  }

  if (isLoading) {
    return <main className="mx-auto max-w-5xl p-8 text-slate-500">Loading batch…</main>;
  }

  if (batch === null) {
    return (
      <main className="mx-auto max-w-5xl space-y-4 p-8">
        <p className="text-red-700">{errorMessage ?? "Batch not found."}</p>
        <Link to="/collector-batches" className="text-slate-800 underline">
          Back to batches
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-8">
      <header className="space-y-1">
        <Link to="/collector-batches" className="text-sm text-slate-600 underline">
          ← Back to batches
        </Link>
        <div className="flex items-center justify-between">
          <h1 className="font-mono text-2xl font-semibold">{batch.batchNumber}</h1>
          <span className="rounded-full bg-slate-100 px-3 py-1 text-sm">
            {COLLECTOR_BATCH_STATUS_LABELS[batch.status]}
          </span>
        </div>
        <p className="text-sm text-slate-600">
          {batch.collectorName} · field date {formatDateOnly(batch.collectionDate)}
        </p>
      </header>

      <section className="grid gap-3 rounded-lg border border-slate-200 bg-white p-4 text-sm shadow-sm sm:grid-cols-3">
        <p>
          <span className="block text-slate-600">Expected (collected)</span>
          <span className="text-lg">{formatCentavos(batch.expectedRemittanceCentavos)}</span>
        </p>
        <p>
          <span className="block text-slate-600">Actual (cash in hand)</span>
          <span className="text-lg">
            {batch.actualRemittanceCentavos === null
              ? "—"
              : formatCentavos(batch.actualRemittanceCentavos)}
          </span>
        </p>
        <p>
          <span className="block text-slate-600">Variance</span>
          <span className="text-lg">{formatVariance(batch.varianceCentavos)}</span>
        </p>
        {batch.varianceNotes !== null && (
          <p className="sm:col-span-3 text-slate-600">
            <span className="font-medium">Variance notes:</span> {batch.varianceNotes}
          </p>
        )}
      </section>

      {actionMessage !== null && (
        <p className="rounded bg-slate-50 px-3 py-2 text-sm text-slate-800">{actionMessage}</p>
      )}
      {errorMessage !== null && <p className="text-sm text-red-700">{errorMessage}</p>}

      {isOpen && canCreate && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setIsAddingAccounts((open) => !open)}
            className="rounded bg-slate-800 px-3 py-1.5 text-sm text-white"
          >
            {isAddingAccounts ? "Close add accounts" : "Add accounts"}
          </button>
          <button
            type="button"
            onClick={() => void handleCancel()}
            className="rounded bg-red-700 px-3 py-1.5 text-sm text-white"
          >
            Cancel batch
          </button>
        </div>
      )}

      {isAddingAccounts && (
        <form onSubmit={(event) => void handleAddAccounts(event)} className="space-y-3">
          <ServiceAccountPicker selectedIds={newAccountIds} onChange={setNewAccountIds} />
          <button type="submit" className="rounded bg-emerald-700 px-3 py-1.5 text-sm text-white">
            Add to batch
          </button>
        </form>
      )}

      <section className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-left text-slate-600">
            <tr>
              <th className="px-4 py-3">Subscriber</th>
              <th className="px-4 py-3">Service</th>
              <th className="px-4 py-3">Outstanding</th>
              <th className="px-4 py-3">Collected</th>
              <th className="px-4 py-3">Method</th>
              <th className="px-4 py-3">Result</th>
              <th className="px-4 py-3">Notes</th>
              <th className="px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {batch.assignments.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-slate-500">
                  No service accounts assigned yet.
                </td>
              </tr>
            ) : (
              batch.assignments.map((assignment) => (
                <AssignmentRow
                  key={assignment.id}
                  assignment={assignment}
                  isOpen={isOpen}
                  canRecord={canRecord}
                  canVoid={canReconcile}
                  onRecord={setRecordingFor}
                  onVoid={(target) => void handleVoid(target)}
                />
              ))
            )}
          </tbody>
        </table>
      </section>

      {recordingFor !== null && (
        <form
          onSubmit={(event) => void handleRecord(event)}
          className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
        >
          <h2 className="font-medium">
            Record collection — {recordingFor.subscriberName} ({recordingFor.serviceAccountNumber})
          </h2>
          <div className="flex flex-wrap gap-3">
            <label className="text-sm">
              <span className="block text-slate-600">Result</span>
              <select
                value={recordResult}
                onChange={(event) => setRecordResult(event.target.value as CollectionResult)}
                className="rounded border border-slate-300 px-2 py-1"
              >
                {COLLECTION_RESULTS.map((result) => (
                  <option key={result} value={result}>
                    {COLLECTION_RESULT_LABELS[result]}
                  </option>
                ))}
              </select>
            </label>

            {takesMoney && (
              <>
                <label className="text-sm">
                  <span className="block text-slate-600">Amount (₱)</span>
                  <input
                    type="text"
                    value={recordAmount}
                    onChange={(event) => setRecordAmount(event.target.value)}
                    placeholder="500.00"
                    className="rounded border border-slate-300 px-2 py-1"
                  />
                </label>
                <label className="text-sm">
                  <span className="block text-slate-600">Method</span>
                  <select
                    value={recordMethod}
                    onChange={(event) => setRecordMethod(event.target.value as CollectedMethod)}
                    className="rounded border border-slate-300 px-2 py-1"
                  >
                    {COLLECTED_METHODS.map((method) => (
                      <option key={method} value={method}>
                        {COLLECTED_METHOD_LABELS[method]}
                      </option>
                    ))}
                  </select>
                </label>
                {recordMethod === "gcash" && (
                  <label className="text-sm">
                    <span className="block text-slate-600">GCash reference</span>
                    <input
                      type="text"
                      value={recordGcashReference}
                      onChange={(event) => setRecordGcashReference(event.target.value)}
                      className="rounded border border-slate-300 px-2 py-1"
                    />
                  </label>
                )}
              </>
            )}
          </div>

          <label className="block text-sm">
            <span className="block text-slate-600">Collector notes</span>
            <input
              type="text"
              value={recordNotes}
              onChange={(event) => setRecordNotes(event.target.value)}
              className="w-full rounded border border-slate-300 px-2 py-1"
            />
          </label>

          <div className="flex gap-2">
            <button type="submit" className="rounded bg-emerald-700 px-3 py-1.5 text-sm text-white">
              Save collection
            </button>
            <button
              type="button"
              onClick={() => setRecordingFor(null)}
              className="rounded border border-slate-300 px-3 py-1.5 text-sm"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {isOpen && canRecord && (
        <form
          onSubmit={(event) => void handleSubmit(event)}
          className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
        >
          <h2 className="font-medium">Submit remittance</h2>
          <p className="text-sm text-slate-600">
            Enter the cash you are handing in. It will be compared with the{" "}
            {formatCentavos(batch.expectedRemittanceCentavos)} you collected.
          </p>
          <label className="block text-sm">
            <span className="block text-slate-600">Cash in hand (₱)</span>
            <input
              type="text"
              value={actualCash}
              onChange={(event) => setActualCash(event.target.value)}
              placeholder="4500.00"
              className="rounded border border-slate-300 px-2 py-1"
            />
          </label>
          <button
            type="submit"
            className="rounded bg-slate-800 px-3 py-1.5 text-sm text-white"
            onClick={() => setIsSubmitting(true)}
          >
            {isSubmitting ? "Submitting…" : "Submit remittance"}
          </button>
        </form>
      )}

      {batch.status === "submitted" && canReconcile && (
        <section className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="font-medium">Reconcile batch</h2>
          {batch.varianceCentavos !== 0 && (
            <p className="text-sm text-amber-700">
              This batch has a variance of {formatCentavos(batch.varianceCentavos ?? 0)}. Notes are
              required.
            </p>
          )}
          <label className="block text-sm">
            <span className="block text-slate-600">Variance notes</span>
            <input
              type="text"
              value={varianceNotes}
              onChange={(event) => setVarianceNotes(event.target.value)}
              className="w-full rounded border border-slate-300 px-2 py-1"
            />
          </label>
          <button
            type="button"
            onClick={() => void handleReconcile()}
            className="rounded bg-emerald-700 px-3 py-1.5 text-sm text-white"
          >
            Reconcile
          </button>
        </section>
      )}
    </main>
  );
}