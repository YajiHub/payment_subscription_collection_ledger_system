import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { roleHasPermission } from "@bcis/shared";
import {
  extractApiErrorMessage,
  getSuspensionCandidates,
  runSuspensionCandidates,
  type SuspensionCandidatesResult,
} from "../lib/api-client";
import { formatCentavos, formatDateOnly } from "../lib/format";
import { useAuthStore } from "../stores/auth.store";
import { AppShell } from "../components/layout/AppShell";
import { Button } from "../components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { ErrorBanner } from "../components/ui/ErrorBanner";
import { Modal } from "../components/ui/Modal";

const FIELD_CLASS =
  "h-9 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

/** The threshold override box, or undefined to use the configured setting. */
function optionalWholeNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === "") {
    return undefined;
  }
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

/**
 * Suspension and reconnection operations (S4-7, S4-9).
 *
 * The screen keeps LOOKING and DOING apart on purpose. Previewing reads the
 * configured threshold and lists who would be cut off — it changes nothing. Running
 * the suspension is a separate, permission-gated action behind a confirmation, and
 * it can only be reached after a preview has been loaded, so an operator always sees
 * the effect before causing it.
 */
export function SuspensionOperationsPage(): ReactNode {
  const user = useAuthStore((state) => state.user);
  const canSuspend = user !== null && roleHasPermission(user.role, "subscribers:suspend");

  const [threshold, setThreshold] = useState("");
  const [preview, setPreview] = useState<SuspensionCandidatesResult | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [isRunDialogOpen, setIsRunDialogOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const loadPreview = useCallback(async (): Promise<void> => {
    setIsPreviewing(true);
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      setPreview(await getSuspensionCandidates(optionalWholeNumber(threshold)));
    } catch (error) {
      setPreview(null);
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsPreviewing(false);
    }
  }, [threshold]);

  // A preview belongs to the threshold that produced it. Changing the threshold
  // invalidates it, so a stale list can never be run against a new number.
  useEffect(() => {
    setPreview(null);
  }, [threshold]);

  async function handleRun(): Promise<void> {
    setIsRunDialogOpen(false);
    setIsRunning(true);
    setErrorMessage(null);
    try {
      const result = await runSuspensionCandidates({
        thresholdDays: optionalWholeNumber(threshold),
      });
      setStatusMessage(
        `Suspended ${result.suspended.length} account(s).` +
          (result.failed.length > 0 ? ` ${result.failed.length} could not be suspended.` : "")
      );
      await loadPreview();
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <AppShell
      pageTitle="Suspension & Reconnection"
      pageDescription="Preview who suspension would cut off, then run it deliberately — the preview itself changes nothing"
      headerActions={
        <Link
          to="/services/accounts"
          className="inline-flex h-9 items-center rounded-lg border border-line-strong bg-surface px-3.5 text-sm font-medium text-content-primary transition-colors hover:bg-canvas"
        >
          Service accounts
        </Link>
      }
    >
      <div className="space-y-5">
        <Card>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-end gap-3">
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-content-secondary">
                  Threshold days (blank uses the configured setting)
                </span>
                <input
                  type="number"
                  min={1}
                  value={threshold}
                  onChange={(event) => setThreshold(event.target.value)}
                  placeholder="e.g. 30"
                  className={`${FIELD_CLASS} w-56`}
                />
              </label>
              <Button
                type="button"
                variant="secondary"
                onClick={() => void loadPreview()}
                isLoading={isPreviewing}
              >
                Preview candidates (no changes)
              </Button>
              <Button
                type="button"
                variant="danger"
                disabled={!canSuspend || preview === null || preview.candidateCount === 0}
                isLoading={isRunning}
                onClick={() => setIsRunDialogOpen(true)}
                title={
                  !canSuspend
                    ? "Your role may preview suspensions but not run them."
                    : preview === null
                      ? "Preview the candidates before running the suspension."
                      : undefined
                }
              >
                Run suspension
              </Button>
            </div>
            {!canSuspend && (
              <p className="text-xs text-content-secondary">
                Your role may preview who would be suspended but not perform it.
              </p>
            )}
          </CardContent>
        </Card>

        {errorMessage !== null && (
          <ErrorBanner message={errorMessage} onRetry={() => void loadPreview()} />
        )}
        {statusMessage !== null && (
          <p className="rounded-xl border border-success-line bg-success-soft px-4 py-3 text-sm text-success-strong">
            {statusMessage}
          </p>
        )}

        <Card>
          <CardHeader>
            <CardTitle>
              {preview === null
                ? "Preview — nothing has been suspended"
                : `Preview — ${preview.candidateCount} account(s) would be suspended (nothing has been suspended)`}
            </CardTitle>
          </CardHeader>

          {preview === null ? (
            <EmptyState
              title="No preview loaded"
              description="Set a threshold and preview the candidates to see who suspension would affect. Previewing reads only; it changes nothing."
            />
          ) : (
            <CardContent className="space-y-3">
              <p className="text-sm text-content-secondary">
                Threshold {preview.thresholdDays} days as of {formatDateOnly(preview.asOfDate)} ·
                total overdue{" "}
                <span className="tabular-nums text-content-primary">
                  {formatCentavos(preview.totalOverdueCentavos)}
                </span>
              </p>

              {preview.candidates.length === 0 ? (
                <EmptyState
                  title="No account qualifies"
                  description="No active account is overdue enough to reach this threshold. Nothing would be suspended."
                />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-canvas text-content-secondary">
                      <tr>
                        <th className="px-4 py-3 font-medium">Account #</th>
                        <th className="px-4 py-3 font-medium">Subscriber</th>
                        <th className="px-4 py-3 font-medium">Oldest Due</th>
                        <th className="px-4 py-3 text-right font-medium">Days Past Due</th>
                        <th className="px-4 py-3 text-right font-medium">Total Overdue</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.candidates.map((candidate) => (
                        <tr key={candidate.serviceAccountId} className="border-t border-line">
                          <td className="px-4 py-3 font-mono text-xs">
                            {candidate.serviceAccountNumber}
                          </td>
                          <td className="px-4 py-3">{candidate.subscriberName}</td>
                          <td className="px-4 py-3 text-content-secondary">
                            {formatDateOnly(candidate.oldestDueDate)}
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums">
                            {candidate.daysPastDue}
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums">
                            {formatCentavos(candidate.totalOverdueCentavos)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          )}
        </Card>
      </div>

      <Modal
        isOpen={isRunDialogOpen}
        onClose={() => setIsRunDialogOpen(false)}
        title="Run suspension"
        description="This suspends every qualifying account. It cannot be undone in bulk; each reconnection is billed separately."
        footer={
          <>
            <Button variant="outline" onClick={() => setIsRunDialogOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" isLoading={isRunning} onClick={() => void handleRun()}>
              Suspend {preview?.candidateCount ?? 0} account(s)
            </Button>
          </>
        }
      >
        <p className="text-sm text-content-primary">
          You are about to suspend{" "}
          <span className="font-semibold tabular-nums">{preview?.candidateCount ?? 0}</span>{" "}
          account(s) at a {preview?.thresholdDays ?? optionalWholeNumber(threshold) ?? "configured"}{" "}
          day threshold. Each suspension records a reason and an audit entry.
        </p>
      </Modal>
    </AppShell>
  );
}
