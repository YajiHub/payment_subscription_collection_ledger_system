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
  type CollectorBatchStatus,
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
import { AppShell } from "../components/layout/AppShell";
import { Badge, type BadgeVariant } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { ErrorBanner } from "../components/ui/ErrorBanner";
import { TableSkeleton } from "../components/ui/Skeleton";

const STATUS_BADGE_VARIANTS = {
  open: "info",
  submitted: "warning",
  reconciled: "success",
  cancelled: "neutral",
} satisfies Record<CollectorBatchStatus, BadgeVariant>;

const FIELD_CLASS =
  "h-9 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

/** The variance as text, coloured: green exact, amber overage, red shortage. */
function formatVariance(varianceCentavos: number | null): ReactNode {
  if (varianceCentavos === null) {
    return <span className="text-content-secondary">Not yet submitted</span>;
  }
  if (varianceCentavos === 0) {
    return <span className="tabular-nums text-success-strong">{formatCentavos(0)} (exact)</span>;
  }
  return (
    <span
      className={`tabular-nums ${varianceCentavos > 0 ? "text-warning-strong" : "text-danger-strong"}`}
    >
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
    <tr className="border-t border-line transition-colors hover:bg-canvas/60">
      <td className="px-4 py-3">{assignment.subscriberName}</td>
      <td className="px-4 py-3 font-mono text-xs">{assignment.serviceAccountNumber}</td>
      <td className="px-4 py-3 text-right tabular-nums">
        {formatCentavos(assignment.outstandingBalanceCentavos)}
      </td>
      <td className="px-4 py-3 text-right tabular-nums">
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
        {isVoided && <Badge variant="danger" size="sm" className="ml-2">voided</Badge>}
      </td>
      <td className="px-4 py-3 text-xs text-content-secondary">{assignment.collectorNotes ?? "—"}</td>
      <td className="px-4 py-3">
        {isOpen && !isVoided && (
          <div className="flex gap-2">
            {canRecord && assignment.collectionResult === null && (
              <Button variant="secondary" size="sm" onClick={() => onRecord(assignment)}>
                Record Collection
              </Button>
            )}
            {canVoid && assignment.collectionResult !== null && (
              <Button variant="danger" size="sm" onClick={() => onVoid(assignment)}>
                Void
              </Button>
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
    return (
      <AppShell pageTitle="Collector Batch" pageDescription="Loading batch…">
        <div className="mx-auto max-w-5xl space-y-6">
          <Card>
            <TableSkeleton rows={5} columns={8} />
          </Card>
        </div>
      </AppShell>
    );
  }

  if (batch === null) {
    return (
      <AppShell pageTitle="Collector Batch" pageDescription="The requested batch could not be loaded">
        <div className="mx-auto max-w-5xl space-y-4">
          <ErrorBanner
            message={errorMessage ?? "Batch not found."}
            onRetry={() => void loadBatch()}
          />
          <Link to="/collector-batches" className="text-sm font-medium text-content-primary underline">
            Back to batches
          </Link>
        </div>
      </AppShell>
    );
  }

  const canAddAccounts = isOpen && canCreate;

  return (
    <AppShell
      pageTitle={batch.batchNumber}
      pageDescription={`${batch.collectorName} · field date ${formatDateOnly(batch.collectionDate)}`}
      headerActions={
        <Badge variant={STATUS_BADGE_VARIANTS[batch.status]} size="md" dot>
          {COLLECTOR_BATCH_STATUS_LABELS[batch.status]}
        </Badge>
      }
    >
      <div className="mx-auto max-w-5xl space-y-6">
        <Link to="/collector-batches" className="text-sm text-content-secondary underline">
          ← Back to batches
        </Link>

        <Card>
          <CardContent className="grid gap-3 text-sm sm:grid-cols-3">
            <p>
              <span className="block text-content-secondary">Expected (collected)</span>
              <span className="text-lg tabular-nums">
                {formatCentavos(batch.expectedRemittanceCentavos)}
              </span>
            </p>
            <p>
              <span className="block text-content-secondary">Actual (cash in hand)</span>
              <span className="text-lg tabular-nums">
                {batch.actualRemittanceCentavos === null
                  ? "—"
                  : formatCentavos(batch.actualRemittanceCentavos)}
              </span>
            </p>
            <p>
              <span className="block text-content-secondary">Variance</span>
              <span className="text-lg">{formatVariance(batch.varianceCentavos)}</span>
            </p>
            {batch.varianceNotes !== null && (
              <p className="text-content-secondary sm:col-span-3">
                <span className="font-medium">Variance notes:</span> {batch.varianceNotes}
              </p>
            )}
          </CardContent>
        </Card>

        {actionMessage !== null && (
          <p className="rounded-xl border border-line bg-canvas px-4 py-3 text-sm text-content-primary">
            {actionMessage}
          </p>
        )}
        {errorMessage !== null && (
          <ErrorBanner message={errorMessage} onRetry={() => void loadBatch()} />
        )}

        {isOpen && canCreate && (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setIsAddingAccounts((open) => !open)}
            >
              {isAddingAccounts ? "Close add accounts" : "Add accounts"}
            </Button>
            <Button variant="danger" size="sm" onClick={() => void handleCancel()}>
              Cancel batch
            </Button>
          </div>
        )}

        {isAddingAccounts && (
          <Card>
            <CardContent>
              <form onSubmit={(event) => void handleAddAccounts(event)} className="space-y-3">
                <ServiceAccountPicker selectedIds={newAccountIds} onChange={setNewAccountIds} />
                <Button type="submit" variant="secondary" size="sm">
                  Add to batch
                </Button>
              </form>
            </CardContent>
          </Card>
        )}

        {batch.assignments.length === 0 ? (
          <Card>
            <CardContent>
              <EmptyState
                title="No service accounts assigned"
                description="This batch has no assigned accounts yet. Add accounts to start recording field collections."
                actionLabel={canAddAccounts ? "Add accounts" : undefined}
                onAction={canAddAccounts ? () => setIsAddingAccounts(true) : undefined}
              />
            </CardContent>
          </Card>
        ) : (
          <Card>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-canvas text-content-secondary">
                  <tr>
                    <th className="px-4 py-3 font-medium">Subscriber</th>
                    <th className="px-4 py-3 font-medium">Service</th>
                    <th className="px-4 py-3 font-medium text-right">Outstanding</th>
                    <th className="px-4 py-3 font-medium text-right">Collected</th>
                    <th className="px-4 py-3 font-medium">Method</th>
                    <th className="px-4 py-3 font-medium">Result</th>
                    <th className="px-4 py-3 font-medium">Notes</th>
                    <th className="px-4 py-3 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {batch.assignments.map((assignment) => (
                    <AssignmentRow
                      key={assignment.id}
                      assignment={assignment}
                      isOpen={isOpen}
                      canRecord={canRecord}
                      canVoid={canReconcile}
                      onRecord={setRecordingFor}
                      onVoid={(target) => void handleVoid(target)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        {recordingFor !== null && (
          <Card>
            <CardHeader>
              <CardTitle>
                Record collection — {recordingFor.subscriberName} ({recordingFor.serviceAccountNumber})
              </CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={(event) => void handleRecord(event)} className="space-y-3">
                <div className="flex flex-wrap gap-3">
                  <label className="block space-y-1.5">
                    <span className="text-xs font-medium text-content-secondary">Result</span>
                    <select
                      value={recordResult}
                      onChange={(event) => setRecordResult(event.target.value as CollectionResult)}
                      className={FIELD_CLASS}
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
                      <label className="block space-y-1.5">
                        <span className="text-xs font-medium text-content-secondary">Amount (₱)</span>
                        <input
                          type="text"
                          value={recordAmount}
                          onChange={(event) => setRecordAmount(event.target.value)}
                          placeholder="500.00"
                          className={FIELD_CLASS}
                        />
                      </label>
                      <label className="block space-y-1.5">
                        <span className="text-xs font-medium text-content-secondary">Method</span>
                        <select
                          value={recordMethod}
                          onChange={(event) =>
                            setRecordMethod(event.target.value as CollectedMethod)
                          }
                          className={FIELD_CLASS}
                        >
                          {COLLECTED_METHODS.map((method) => (
                            <option key={method} value={method}>
                              {COLLECTED_METHOD_LABELS[method]}
                            </option>
                          ))}
                        </select>
                      </label>
                      {recordMethod === "gcash" && (
                        <label className="block space-y-1.5">
                          <span className="text-xs font-medium text-content-secondary">
                            GCash reference
                          </span>
                          <input
                            type="text"
                            value={recordGcashReference}
                            onChange={(event) => setRecordGcashReference(event.target.value)}
                            className={FIELD_CLASS}
                          />
                        </label>
                      )}
                    </>
                  )}
                </div>

                <label className="block space-y-1.5">
                  <span className="text-xs font-medium text-content-secondary">Collector notes</span>
                  <input
                    type="text"
                    value={recordNotes}
                    onChange={(event) => setRecordNotes(event.target.value)}
                    className={FIELD_CLASS}
                  />
                </label>

                <div className="flex gap-2">
                  <Button type="submit" variant="secondary" size="sm">
                    Save collection
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setRecordingFor(null)}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        )}

        {isOpen && canRecord && (
          <Card>
            <CardHeader>
              <CardTitle>Submit remittance</CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={(event) => void handleSubmit(event)} className="space-y-3">
                <p className="text-sm text-content-secondary">
                  Enter the cash you are handing in. It will be compared with the{" "}
                  <span className="tabular-nums">{formatCentavos(batch.expectedRemittanceCentavos)}</span> you
            collected.
                </p>
                <label className="block space-y-1.5">
                  <span className="text-xs font-medium text-content-secondary">Cash in hand (₱)</span>
                  <input
                    type="text"
                    value={actualCash}
                    onChange={(event) => setActualCash(event.target.value)}
                    placeholder="4500.00"
                    className={FIELD_CLASS}
                  />
                </label>
                <Button
                  type="submit"
                  variant="secondary"
                  size="sm"
                  isLoading={isSubmitting}
                  onClick={() => setIsSubmitting(true)}
                >
                  Submit remittance
                </Button>
              </form>
            </CardContent>
          </Card>
        )}

        {batch.status === "submitted" && canReconcile && (
          <Card>
            <CardHeader>
              <CardTitle>Reconcile batch</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {batch.varianceCentavos !== 0 && (
                <p className="text-sm text-warning-strong tabular-nums">
                  This batch has a variance of {formatCentavos(batch.varianceCentavos ?? 0)}. Notes
                  are required.
                </p>
              )}
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-content-secondary">Variance notes</span>
                <input
                  type="text"
                  value={varianceNotes}
                  onChange={(event) => setVarianceNotes(event.target.value)}
                  className={FIELD_CLASS}
                />
              </label>
              <Button variant="secondary" size="sm" onClick={() => void handleReconcile()}>
                Reconcile
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </AppShell>
  );
}
