import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import {
  COLLECTED_METHODS,
  COLLECTED_METHOD_LABELS,
  COLLECTION_RESULTS,
  COLLECTION_RESULT_LABELS,
  COLLECTOR_BATCH_STATUS_LABELS,
  type CollectedMethod,
  type CollectionResult,
  type CollectorBatchStatus,
} from "@bcis/shared";
import { ServiceAccountPicker } from "../components/ServiceAccountPicker";
import {
  addBatchAssignments,
  cancelCollectorBatch,
  closeBatch,
  extractApiErrorMessage,
  getCollectorBatch,
  listBatchRemittances,
  recordBatchRemittance,
  recordCollection,
  reconcileBatch,
  submitBatch,
  voidCollection,
  type BatchAssignmentSummary,
  type BatchMethodSummary,
  type BatchRemittanceSummary,
  type CollectorBatchDetail,
} from "../lib/api-client";
import {
  assessBatchRemittance,
  collectorBatchActionsCard,
  COLLECTOR_BATCH_ACTION_LABELS,
  type CollectorBatchAction,
} from "../lib/collector-batch-actions";
import { formatCentavos, formatDateOnly, parsePesosToCentavos } from "../lib/format";
import { useAuthStore } from "../stores/auth.store";
import { AppShell } from "../components/layout/AppShell";
import { Badge, type BadgeVariant } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { ErrorBanner } from "../components/ui/ErrorBanner";
import { Modal } from "../components/ui/Modal";
import { TableSkeleton } from "../components/ui/Skeleton";

/**
 * The seven-state collection lifecycle. Only five badge tones exist, so
 * neighbouring steps deliberately share a tone and the label text always carries
 * the meaning: not-started and finished read neutral, work in flight reads info,
 * and money still to be reconciled reads warning.
 */
const STATUS_BADGE_VARIANTS = {
  open: "neutral",
  in_progress: "info",
  submitted: "warning",
  remitted: "warning",
  reconciled: "success",
  closed: "neutral",
  cancelled: "neutral",
} satisfies Record<CollectorBatchStatus, BadgeVariant>;

/** The forward path of the lifecycle, in order. `cancelled` is shown separately. */
const LIFECYCLE_STEPS: readonly CollectorBatchStatus[] = [
  "open",
  "in_progress",
  "submitted",
  "remitted",
  "reconciled",
  "closed",
];

const FIELD_CLASS =
  "h-9 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

/** The variance as text, coloured: green exact, amber overage, red shortage. */
function formatVariance(varianceCentavos: number | null): ReactNode {
  if (varianceCentavos === null) {
    return <span className="text-content-secondary">Not yet remitted</span>;
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

/** Where the batch sits on the lifecycle, so its next legal step is obvious. */
function BatchLifecycleStepper({ status }: { status: CollectorBatchStatus }): ReactNode {
  if (status === "cancelled") {
    return (
      <ol aria-label="Batch lifecycle" className="flex flex-wrap items-center gap-1.5 text-xs">
        <li className="rounded-full border border-danger-line bg-danger-soft px-2.5 py-1 font-medium text-danger-strong">
          Cancelled
        </li>
      </ol>
    );
  }

  const currentIndex = LIFECYCLE_STEPS.indexOf(status);

  return (
    <ol aria-label="Batch lifecycle" className="flex flex-wrap items-center gap-1.5 text-xs">
      {LIFECYCLE_STEPS.map((step, index) => {
        const isCurrent = step === status;
        const isDone = index < currentIndex;
        const tone = isCurrent
          ? "border-accent-line bg-accent-soft text-accent-strong"
          : isDone
            ? "border-success-line bg-success-soft text-success-strong"
            : "border-line text-content-secondary";

        return (
          <li key={step} className="flex items-center gap-1.5">
            <span
              aria-current={isCurrent ? "step" : undefined}
              className={`rounded-full border px-2.5 py-1 font-medium ${tone}`}
            >
              {COLLECTOR_BATCH_STATUS_LABELS[step]}
            </span>
            {index < LIFECYCLE_STEPS.length - 1 && (
              <span aria-hidden="true" className="text-content-secondary/60">
                →
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** The S4-4 split: what the run was worth, and how the money came back. */
function MethodSummary({ summary }: { summary: BatchMethodSummary }): ReactNode {
  const items = [
    {
      label: "Expected receivable",
      value: summary.expectedReceivableCentavos,
      tone: "text-content-primary",
    },
    { label: "Cash", value: summary.cashCollectedCentavos, tone: "text-content-primary" },
    { label: "Non-cash (GCash/other)", value: summary.nonCashCollectedCentavos, tone: "text-content-primary" },
    {
      label: "Uncollected",
      value: summary.uncollectedCentavos,
      tone: summary.uncollectedCentavos > 0 ? "text-warning-strong" : "text-content-secondary",
    },
  ];

  return (
    <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
      {items.map((item) => (
        <div key={item.label} className="space-y-1">
          <dt className="text-content-secondary">{item.label}</dt>
          <dd className={`text-lg tabular-nums ${item.tone}`}>{formatCentavos(item.value)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** One assignment row plus the office actions available on it. */
interface AssignmentRowProps {
  assignment: BatchAssignmentSummary;
  canRecord: boolean;
  canVoid: boolean;
  onRecord: (assignment: BatchAssignmentSummary) => void;
  onVoid: (assignment: BatchAssignmentSummary) => void;
}

function AssignmentRow({
  assignment,
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
        {isVoided && (
          <Badge variant="danger" size="sm" className="ml-2">
            voided
          </Badge>
        )}
      </td>
      <td className="px-4 py-3 text-xs text-content-secondary">{assignment.collectorNotes ?? "—"}</td>
      <td className="px-4 py-3">
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
      </td>
    </tr>
  );
}

/** The remittance history: the rows the batch total is the signed sum of (S4-2). */
function RemittanceHistory({ remittances }: { remittances: BatchRemittanceSummary[] }): ReactNode {
  if (remittances.length === 0) {
    return (
      <EmptyState
        title="No remittances recorded"
        description="The cash hand-in has not been recorded for this batch yet. Record it once the collector pays in."
      />
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="bg-canvas text-content-secondary">
          <tr>
            <th className="px-4 py-3 font-medium">Recorded</th>
            <th className="px-4 py-3 font-medium">By</th>
            <th className="px-4 py-3 text-right font-medium">Amount</th>
            <th className="px-4 py-3 text-right font-medium">Cash</th>
            <th className="px-4 py-3 text-right font-medium">GCash</th>
            <th className="px-4 py-3 font-medium">Notes</th>
          </tr>
        </thead>
        <tbody>
          {remittances.map((remittance) => (
            <tr key={remittance.id} className="border-t border-line">
              <td className="px-4 py-3 text-content-secondary">
                {formatDateOnly(remittance.remittedAt.slice(0, 10))}
              </td>
              <td className="px-4 py-3">{remittance.remittedByName}</td>
              <td
                className={`px-4 py-3 text-right tabular-nums ${
                  remittance.amountCentavos < 0 ? "text-danger-strong" : ""
                }`}
              >
                {formatCentavos(remittance.amountCentavos)}
              </td>
              <td className="px-4 py-3 text-right tabular-nums">
                {formatCentavos(remittance.cashAmountCentavos)}
              </td>
              <td className="px-4 py-3 text-right tabular-nums">
                {formatCentavos(remittance.gcashAmountCentavos)}
              </td>
              <td className="px-4 py-3 text-content-secondary">{remittance.notes ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Batch detail: work the lifecycle, record the money, and remit it. */
export function CollectorBatchDetailPage(): ReactNode {
  const { id = "" } = useParams();
  const user = useAuthStore((state) => state.user);

  const [batch, setBatch] = useState<CollectorBatchDetail | null>(null);
  const [remittances, setRemittances] = useState<BatchRemittanceSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const [recordingFor, setRecordingFor] = useState<BatchAssignmentSummary | null>(null);
  const [recordResult, setRecordResult] = useState<CollectionResult>("collected");
  const [recordAmount, setRecordAmount] = useState("");
  const [recordMethod, setRecordMethod] = useState<CollectedMethod>("cash");
  const [recordGcashReference, setRecordGcashReference] = useState("");
  const [recordNotes, setRecordNotes] = useState("");

  // One dialog per lifecycle action that needs input. Keeping them separate is
  // what makes the remittance a deliberate, auditable step rather than a second
  // meaning bolted onto submit.
  const [activeDialog, setActiveDialog] = useState<CollectorBatchAction | null>(null);
  const [isWorking, setIsWorking] = useState(false);

  const [remitAmount, setRemitAmount] = useState("");
  const [remitIsCorrection, setRemitIsCorrection] = useState(false);
  const [remitNotes, setRemitNotes] = useState("");
  const [varianceNotes, setVarianceNotes] = useState("");
  const [closeNotes, setCloseNotes] = useState("");
  const [cancelReason, setCancelReason] = useState("");
  const [isAddingAccounts, setIsAddingAccounts] = useState(false);
  const [newAccountIds, setNewAccountIds] = useState<string[]>([]);

  const loadBatch = useCallback(async (): Promise<void> => {
    if (id === "") {
      return;
    }
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const [detail, history] = await Promise.all([
        getCollectorBatch(id),
        listBatchRemittances(id),
      ]);
      setBatch(detail);
      setRemittances(history);
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void loadBatch();
  }, [loadBatch]);

  // The card's content, decided in one place so it can never be silently empty.
  const actionsCard =
    batch === null || user === null ? null : collectorBatchActionsCard(batch.status, user.role);
  const offers = (action: CollectorBatchAction): boolean =>
    actionsCard !== null && actionsCard.permitted.includes(action);
  const takesMoney = recordResult === "collected" || recordResult === "partial";

  function closeDialog(): void {
    setActiveDialog(null);
    setRemitAmount("");
    setRemitIsCorrection(false);
    setRemitNotes("");
    setVarianceNotes("");
    setCloseNotes("");
    setCancelReason("");
  }

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

  async function handleSubmit(): Promise<void> {
    if (batch === null) {
      return;
    }
    setIsWorking(true);
    setActionMessage(null);
    try {
      // Submitting carries NO body: it only declares the run finished. The cash
      // handed in is the separate remittance step (S4-2).
      await submitBatch(batch.id);
      closeDialog();
      setActionMessage("Run submitted. Record the cash handed in as the next step.");
      await loadBatch();
    } catch (error) {
      setActionMessage(extractApiErrorMessage(error));
    } finally {
      setIsWorking(false);
    }
  }

  async function handleRemit(): Promise<void> {
    if (batch === null) {
      return;
    }

    const parsed = parsePesosToCentavos(remitAmount);
    if (parsed === null || parsed <= 0) {
      setActionMessage("Enter the amount handed in as a peso amount greater than zero, e.g. 4500.00.");
      return;
    }

    setIsWorking(true);
    setActionMessage(null);
    try {
      // A correction is an offsetting row BESIDE the one it fixes, never an edit.
      const amountCentavos = remitIsCorrection ? -parsed : parsed;
      const result = await recordBatchRemittance(batch.id, {
        amountCentavos,
        notes: remitNotes === "" ? undefined : remitNotes,
      });
      closeDialog();
      setActionMessage(
        result.hasVariance
          ? `Remittance recorded. The batch now stands at ${formatCentavos(result.varianceCentavos)} variance.`
          : "Remittance recorded with no variance."
      );
      await loadBatch();
    } catch (error) {
      setActionMessage(extractApiErrorMessage(error));
    } finally {
      setIsWorking(false);
    }
  }

  async function handleReconcile(): Promise<void> {
    if (batch === null) {
      return;
    }
    setIsWorking(true);
    setActionMessage(null);
    try {
      const result = await reconcileBatch(batch.id, varianceNotes === "" ? undefined : varianceNotes);
      closeDialog();
      setActionMessage(
        result.ledgerReconciles
          ? "Batch reconciled; the ledger matches the run exactly."
          : "Batch reconciled. The ledger and the run differ — review the variance."
      );
      await loadBatch();
    } catch (error) {
      setActionMessage(extractApiErrorMessage(error));
    } finally {
      setIsWorking(false);
    }
  }

  async function handleClose(): Promise<void> {
    if (batch === null) {
      return;
    }
    setIsWorking(true);
    setActionMessage(null);
    try {
      await closeBatch(batch.id, closeNotes === "" ? undefined : closeNotes);
      closeDialog();
      setActionMessage("Batch closed.");
      await loadBatch();
    } catch (error) {
      setActionMessage(extractApiErrorMessage(error));
    } finally {
      setIsWorking(false);
    }
  }

  async function handleCancel(): Promise<void> {
    if (batch === null) {
      return;
    }
    setIsWorking(true);
    setActionMessage(null);
    try {
      await cancelCollectorBatch(batch.id, cancelReason === "" ? undefined : cancelReason);
      closeDialog();
      setActionMessage("Batch cancelled.");
      await loadBatch();
    } catch (error) {
      setActionMessage(extractApiErrorMessage(error));
    } finally {
      setIsWorking(false);
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
        <div className="w-full max-w-6xl space-y-6">
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
        <div className="w-full max-w-6xl space-y-4">
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

  const alreadyRemittedCentavos = batch.actualRemittanceCentavos ?? 0;
  const parsedRemitAmount = parsePesosToCentavos(remitAmount);
  const remittanceAssessment =
    parsedRemitAmount === null
      ? null
      : assessBatchRemittance(
          batch.expectedRemittanceCentavos,
          alreadyRemittedCentavos,
          remitIsCorrection ? -parsedRemitAmount : parsedRemitAmount
        );

  return (
    <AppShell
      pageTitle={batch.batchNumber}
      pageDescription={`${batch.collectorName} · field date ${formatDateOnly(batch.collectionDate)}`}
      headerActions={
        <div className="flex items-center gap-2">
          <Link
            to={`/collector-batches/${batch.id}/route-sheet`}
            className="inline-flex h-9 items-center rounded-lg border border-line-strong bg-surface px-3.5 text-sm font-medium text-content-primary transition-colors hover:bg-canvas"
          >
            Route sheet
          </Link>
          <Badge variant={STATUS_BADGE_VARIANTS[batch.status]} size="md" dot>
            {COLLECTOR_BATCH_STATUS_LABELS[batch.status]}
          </Badge>
        </div>
      }
    >
      <div className="w-full max-w-6xl space-y-6">
        <Link to="/collector-batches" className="text-sm text-content-secondary underline">
          ← Back to batches
        </Link>

        <Card>
          <CardHeader>
            <CardTitle>Lifecycle</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <BatchLifecycleStepper status={batch.status} />
            <dl className="grid gap-3 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-content-secondary">Expected (collected)</dt>
                <dd className="text-lg tabular-nums">
                  {formatCentavos(batch.expectedRemittanceCentavos)}
                </dd>
              </div>
              <div>
                <dt className="text-content-secondary">Remitted (cash in hand)</dt>
                <dd className="text-lg tabular-nums">
                  {batch.actualRemittanceCentavos === null
                    ? "—"
                    : formatCentavos(batch.actualRemittanceCentavos)}
                </dd>
              </div>
              <div>
                <dt className="text-content-secondary">Variance</dt>
                <dd className="text-lg">{formatVariance(batch.varianceCentavos)}</dd>
              </div>
            </dl>
            {batch.varianceNotes !== null && (
              <p className="text-sm text-content-secondary">
                <span className="font-medium">Variance notes:</span> {batch.varianceNotes}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Collection summary by method</CardTitle>
          </CardHeader>
          <CardContent>
            <MethodSummary summary={batch.methodSummary} />
          </CardContent>
        </Card>

        {actionMessage !== null && (
          <p
            role="status"
            className="rounded-xl border border-line bg-canvas px-4 py-3 text-sm text-content-primary"
          >
            {actionMessage}
          </p>
        )}
        {errorMessage !== null && (
          <ErrorBanner message={errorMessage} onRetry={() => void loadBatch()} />
        )}

        <Card>
          <CardHeader>
            <CardTitle>Actions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {actionsCard === null || actionsCard.kind === "nothing-to-do" ? (
              <p className="text-sm text-content-secondary">
                This batch is {COLLECTOR_BATCH_STATUS_LABELS[batch.status].toLowerCase()}; there is
                nothing left to do.
              </p>
            ) : actionsCard.kind === "row-level-only" ? (
              <p className="text-sm text-content-secondary">
                This batch is {COLLECTOR_BATCH_STATUS_LABELS[batch.status].toLowerCase()}. The
                remaining actions are on individual accounts — use{" "}
                {actionsCard.rowActions
                  .map((action) => COLLECTOR_BATCH_ACTION_LABELS[action])
                  .join(" or ")}{" "}
                on the account row below.
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {offers("add_accounts") && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setIsAddingAccounts((open) => !open)}
                  >
                    {isAddingAccounts ? "Close add accounts" : "Add accounts"}
                  </Button>
                )}
                {offers("submit") && (
                  <Button variant="secondary" size="sm" onClick={() => setActiveDialog("submit")}>
                    Submit run
                  </Button>
                )}
                {offers("remit") && (
                  <Button variant="secondary" size="sm" onClick={() => setActiveDialog("remit")}>
                    Record remittance
                  </Button>
                )}
                {offers("reconcile") && (
                  <Button variant="secondary" size="sm" onClick={() => setActiveDialog("reconcile")}>
                    Reconcile
                  </Button>
                )}
                {offers("close") && (
                  <Button variant="secondary" size="sm" onClick={() => setActiveDialog("close")}>
                    Close batch
                  </Button>
                )}
                {offers("cancel") && (
                  <Button variant="danger" size="sm" onClick={() => setActiveDialog("cancel")}>
                    Cancel batch
                  </Button>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {isAddingAccounts && offers("add_accounts") && (
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
                actionLabel={offers("add_accounts") ? "Add accounts" : undefined}
                onAction={offers("add_accounts") ? () => setIsAddingAccounts(true) : undefined}
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
                    <th className="px-4 py-3 text-right font-medium">Outstanding</th>
                    <th className="px-4 py-3 text-right font-medium">Collected</th>
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
                      canRecord={offers("record_collection")}
                      canVoid={offers("void_collection")}
                      onRecord={setRecordingFor}
                      onVoid={(target) => void handleVoid(target)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        {recordingFor !== null && offers("record_collection") && (
          <Card>
            <CardHeader>
              <CardTitle>
                Record collection — {recordingFor.subscriberName} (
                {recordingFor.serviceAccountNumber})
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
                          onChange={(event) => setRecordMethod(event.target.value as CollectedMethod)}
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

        <Card>
          <CardHeader>
            <CardTitle>Remittance history</CardTitle>
          </CardHeader>
          <RemittanceHistory remittances={remittances} />
        </Card>

        {/* Submit: declares the run finished. No amount is collected here. */}
        <Modal
          isOpen={activeDialog === "submit"}
          onClose={closeDialog}
          title="Submit run"
          description="This freezes the field collections. The cash handed in is recorded separately as a remittance."
          footer={
            <>
              <Button variant="outline" onClick={closeDialog}>
                Cancel
              </Button>
              <Button variant="primary" isLoading={isWorking} onClick={() => void handleSubmit()}>
                Submit run
              </Button>
            </>
          }
        >
          <p className="text-sm text-content-secondary">
            The run collected{" "}
            <span className="tabular-nums text-content-primary">
              {formatCentavos(batch.expectedRemittanceCentavos)}
            </span>
            . Submitting records no cash and takes no further input; the remittance
            step records the money.
          </p>
        </Modal>

        {/* Remittance: its own dialog, with the variance shown before it is saved. */}
        <Modal
          isOpen={activeDialog === "remit"}
          onClose={closeDialog}
          title="Record remittance"
          description="Record the cash handed in. A batch may be remitted more than once, and a correction is a separate negative row."
          footer={
            <>
              <Button variant="outline" onClick={closeDialog}>
                Cancel
              </Button>
              <Button
                variant="primary"
                isLoading={isWorking}
                onClick={() => void handleRemit()}
              >
                Record remittance
              </Button>
            </>
          }
        >
          <dl className="grid gap-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-content-secondary">Expected</dt>
              <dd className="tabular-nums">{formatCentavos(batch.expectedRemittanceCentavos)}</dd>
            </div>
            <div>
              <dt className="text-content-secondary">Already remitted</dt>
              <dd className="tabular-nums">{formatCentavos(alreadyRemittedCentavos)}</dd>
            </div>
            <div>
              <dt className="text-content-secondary">This remittance</dt>
              <dd className="tabular-nums">
                {parsedRemitAmount === null
                  ? "—"
                  : formatCentavos(remitIsCorrection ? -parsedRemitAmount : parsedRemitAmount)}
              </dd>
            </div>
          </dl>

          <label className="mt-4 block space-y-1.5">
            <span className="text-xs font-medium text-content-secondary">Amount handed in (₱)</span>
            <input
              type="text"
              value={remitAmount}
              onChange={(event) => setRemitAmount(event.target.value)}
              placeholder="4500.00"
              className={FIELD_CLASS}
            />
          </label>

          <label className="mt-3 flex items-center gap-2 text-sm text-content-primary">
            <input
              type="checkbox"
              checked={remitIsCorrection}
              onChange={(event) => setRemitIsCorrection(event.target.checked)}
            />
            This is a correction (recorded as a negative row)
          </label>

          <label className="mt-3 block space-y-1.5">
            <span className="text-xs font-medium text-content-secondary">Notes (optional)</span>
            <input
              type="text"
              value={remitNotes}
              onChange={(event) => setRemitNotes(event.target.value)}
              className={FIELD_CLASS}
            />
          </label>

          {remittanceAssessment !== null && (
            <div
              role="status"
              className={`mt-4 space-y-1 rounded-lg border px-3 py-2 text-sm ${
                remittanceAssessment.tone === "success"
                  ? "border-success-line bg-success-soft text-success-strong"
                  : "border-warning-line bg-warning-soft text-warning-strong"
              }`}
            >
              <p>
                Resulting total{" "}
                <span className="tabular-nums">
                  {formatCentavos(remittanceAssessment.resultingTotalCentavos)}
                </span>{" "}
                · variance{" "}
                <span className="tabular-nums">
                  {formatCentavos(remittanceAssessment.varianceCentavos)}
                </span>
              </p>
              <p>{remittanceAssessment.message}</p>
            </div>
          )}
        </Modal>

        {/* Reconcile: confirms the amounts, requiring notes for any variance (AT-08). */}
        <Modal
          isOpen={activeDialog === "reconcile"}
          onClose={closeDialog}
          title="Reconcile batch"
          description="Confirm the remitted amounts against the ledger. This is not the final sign-off; closing is a separate step."
          footer={
            <>
              <Button variant="outline" onClick={closeDialog}>
                Cancel
              </Button>
              <Button variant="primary" isLoading={isWorking} onClick={() => void handleReconcile()}>
                Reconcile
              </Button>
            </>
          }
        >
          {batch.varianceCentavos !== 0 && (
            <p className="text-sm tabular-nums text-warning-strong">
              This batch has a variance of {formatCentavos(batch.varianceCentavos ?? 0)}. Notes are
              required.
            </p>
          )}
          <label className="mt-3 block space-y-1.5">
            <span className="text-xs font-medium text-content-secondary">Variance notes</span>
            <input
              type="text"
              value={varianceNotes}
              onChange={(event) => setVarianceNotes(event.target.value)}
              className={FIELD_CLASS}
            />
          </label>
        </Modal>

        {/* Close: the supervisor's separate final sign-off. */}
        <Modal
          isOpen={activeDialog === "close"}
          onClose={closeDialog}
          title="Close batch"
          description="Final sign-off. A closed batch cannot be changed again."
          footer={
            <>
              <Button variant="outline" onClick={closeDialog}>
                Cancel
              </Button>
              <Button variant="primary" isLoading={isWorking} onClick={() => void handleClose()}>
                Close batch
              </Button>
            </>
          }
        >
          <p className="text-sm text-content-secondary">
            Closing confirms the reconciled batch of{" "}
            <span className="tabular-nums text-content-primary">
              {formatCentavos(batch.actualRemittanceCentavos ?? 0)}
            </span>{" "}
            is final.
          </p>
          <label className="mt-4 block space-y-1.5">
            <span className="text-xs font-medium text-content-secondary">Note (optional)</span>
            <input
              type="text"
              value={closeNotes}
              onChange={(event) => setCloseNotes(event.target.value)}
              className={FIELD_CLASS}
            />
          </label>
        </Modal>

        {/* Cancel: abandons an open batch that collected nothing. */}
        <Modal
          isOpen={activeDialog === "cancel"}
          onClose={closeDialog}
          title="Cancel batch"
          description="Abandon an open batch that recorded no collections."
          footer={
            <>
              <Button variant="outline" onClick={closeDialog}>
                Keep batch
              </Button>
              <Button variant="danger" isLoading={isWorking} onClick={() => void handleCancel()}>
                Cancel batch
              </Button>
            </>
          }
        >
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-content-secondary">Reason</span>
            <input
              type="text"
              value={cancelReason}
              onChange={(event) => setCancelReason(event.target.value)}
              className={FIELD_CLASS}
            />
          </label>
        </Modal>
      </div>
    </AppShell>
  );
}
