// Section 4.3 / S7-6 — the GCash verification queue.
//
// Section 3.7 splits a GCash payment in two: a teller records the transfer, and an
// authorised verifier confirms it. The server half already exists and is tested
// (`GET /api/payments/gcash/pending`, `POST .../:id/verify`, `POST .../:id/reject`).
// This screen is the verifier's way in.
//
// The rule the screen is built around: a screenshot is evidence to be JUDGED, never
// automatic proof. Only the verify control moves money, and it asks the operator to
// confirm what will happen first. Rejecting leaves the invoice exactly as it was.

import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { ImageOff, ShieldQuestion } from "lucide-react";
import type { z } from "zod";

import { GCASH_REJECTION_REASON_MIN_LENGTH, rejectGcashPaymentSchema, roleHasPermission } from "@bcis/shared";
import {
  extractApiErrorMessage,
  fetchGcashScreenshot,
  listPendingGcashPayments,
  rejectGcashPayment,
  verifyGcashPayment,
  type PendingGcashPayment,
} from "../lib/api-client";
import { formatCentavos, formatDateOnly, formatTimestamp } from "../lib/format";
import { useAuthStore } from "../stores/auth.store";
import { AppShell } from "../components/layout/AppShell";
import { formResolver } from "../components/form/form-resolver";
import { TextareaField } from "../components/form/TextareaField";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { ErrorBanner } from "../components/ui/ErrorBanner";
import { Modal } from "../components/ui/Modal";
import { Skeleton } from "../components/ui/Skeleton";

type RejectFormValues = z.input<typeof rejectGcashPaymentSchema>;

/**
 * The proof image for one claim.
 *
 * Fetched through the API client so the bearer token travels with it, then shown
 * from an object URL and revoked on unmount. The screen labels it as evidence, not
 * as proof, so an operator never reads the picture as a settled payment.
 */
function ProofImage({ paymentId }: { paymentId: string }): ReactNode {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [hasFailed, setHasFailed] = useState(false);

  useEffect(() => {
    let isActive = true;
    let objectUrl: string | null = null;

    async function load(): Promise<void> {
      setIsLoading(true);
      setHasFailed(false);
      try {
        const blob = await fetchGcashScreenshot(paymentId);
        if (!isActive) {
          return;
        }
        if (blob === null) {
          setImageUrl(null);
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        setImageUrl(objectUrl);
      } catch {
        if (isActive) {
          setHasFailed(true);
        }
      } finally {
        if (isActive) {
          setIsLoading(false);
        }
      }
    }

    void load();

    return () => {
      isActive = false;
      if (objectUrl !== null) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [paymentId]);

  if (isLoading) {
    return <Skeleton className="h-64 w-full" />;
  }

  if (hasFailed || imageUrl === null) {
    return (
      <EmptyState
        icon={<ImageOff className="h-6 w-6" aria-hidden="true" />}
        title="No proof image attached"
        description="No screenshot was uploaded with this claim, or the file could not be read. Judge it on the reference and sender details alone."
      />
    );
  }

  return (
    <img
      src={imageUrl}
      alt={`GCash proof screenshot for claim ${paymentId}`}
      className="max-h-[28rem] w-full rounded-lg border border-line object-contain"
    />
  );
}

/** One row of the pending-claims list on the left pane. */
function ClaimListItem({
  claim,
  isSelected,
  onSelect,
}: {
  claim: PendingGcashPayment;
  isSelected: boolean;
  onSelect: () => void;
}): ReactNode {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={isSelected}
        className={`w-full space-y-1 rounded-lg border px-3 py-2 text-left transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none ${
          isSelected
            ? "border-accent bg-accent-soft"
            : "border-line hover:bg-canvas"
        }`}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-xs text-content-secondary">{claim.receiptNumber}</span>
          <span className="text-sm font-medium tabular-nums">
            {formatCentavos(claim.amountCentavos)}
          </span>
        </div>
        <p className="text-sm text-content-primary">{claim.subscriberName}</p>
        <p className="font-mono text-xs text-content-secondary">{claim.referenceNumber}</p>
      </button>
    </li>
  );
}

/** One labelled fact in the selected claim's detail pane. */
function ClaimFact({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="flex items-start justify-between gap-4 border-t border-line py-2 text-sm">
      <dt className="text-content-secondary">{label}</dt>
      <dd className="text-right text-content-primary">{children}</dd>
    </div>
  );
}

/** The verification queue (section 4.3, S7-6). */
export function GcashVerificationPage(): ReactNode {
  const user = useAuthStore((state) => state.user);
  // Confirming and refusing are separate authorities (the server enforces both);
  // the matrix grants them together today, but the control still asks its own.
  const mayReject = user !== null && roleHasPermission(user.role, "payments:reject_gcash");

  const [claims, setClaims] = useState<PendingGcashPayment[]>([]);
  const [selectedPaymentId, setSelectedPaymentId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [verifyTarget, setVerifyTarget] = useState<PendingGcashPayment | null>(null);
  const [rejectTarget, setRejectTarget] = useState<PendingGcashPayment | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<RejectFormValues>({ resolver: formResolver(rejectGcashPaymentSchema) });

  const loadClaims = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const pending = await listPendingGcashPayments();
      setClaims(pending);
      // Keep the current selection only if its claim is still waiting.
      setSelectedPaymentId((current) =>
        pending.some((claim) => claim.paymentId === current) ? current : null
      );
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadClaims();
  }, [loadClaims]);

  const selectedClaim = claims.find((claim) => claim.paymentId === selectedPaymentId) ?? null;

  /** Clears the claim from the queue and reports what the decision did. */
  function removeClaimAndReport(claim: PendingGcashPayment, report: string): void {
    setClaims((current) => current.filter((item) => item.paymentId !== claim.paymentId));
    setSelectedPaymentId(null);
    setStatusMessage(report);
  }

  async function confirmVerify(): Promise<void> {
    if (verifyTarget === null) {
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      const result = await verifyGcashPayment(verifyTarget.paymentId);
      const allocationCount = result.allocations.length;
      const advanceNote =
        result.advanceCreditCentavos > 0
          ? ` ${formatCentavos(result.advanceCreditCentavos)} held as advance credit.`
          : "";
      removeClaimAndReport(
        verifyTarget,
        `Verified ${verifyTarget.receiptNumber}. ${formatCentavos(result.allocatedCentavos)} ` +
          `allocated to ${allocationCount} invoice${allocationCount === 1 ? "" : "s"}.${advanceNote}`
      );
      setVerifyTarget(null);
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function submitReject(values: RejectFormValues): Promise<void> {
    if (rejectTarget === null) {
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      await rejectGcashPayment(rejectTarget.paymentId, values.reason);
      removeClaimAndReport(
        rejectTarget,
        `Rejected ${rejectTarget.receiptNumber}. Nothing was posted — the invoice is untouched.`
      );
      setRejectTarget(null);
      reset();
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <AppShell
      pageTitle="GCash Verification"
      pageDescription="Review the proofs tellers recorded and confirm or refuse each claim."
    >
      <div className="space-y-6">
        {errorMessage !== null && (
          <ErrorBanner message={errorMessage} onRetry={() => void loadClaims()} />
        )}

        {statusMessage !== null && (
          <p className="rounded-xl border border-success-line bg-success-soft px-4 py-3 text-sm text-success-strong">
            {statusMessage}
          </p>
        )}

        <div className="flex items-start gap-3 rounded-xl border border-warning-line bg-warning-soft px-4 py-3 text-sm text-warning-strong">
          <ShieldQuestion className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
          <p>
            A screenshot is <strong>evidence to review, not proof of payment</strong>. Compare the
            reference number, sender and amount against the GCash record before you decide. Only
            verifying posts the money and moves the balance; a claim an operator recorded has
            changed nothing yet.
          </p>
        </div>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
          <Card>
            <CardHeader className="flex-row items-center">
              <CardTitle>Pending claims</CardTitle>
              <Badge variant={claims.length > 0 ? "warning" : "neutral"}>
                {claims.length} waiting
              </Badge>
            </CardHeader>
            <CardContent padding="sm">
              {isLoading ? (
                <div className="space-y-2">
                  <Skeleton className="h-16 w-full" />
                  <Skeleton className="h-16 w-full" />
                </div>
              ) : claims.length === 0 ? (
                <EmptyState
                  title="No claims are waiting"
                  description="Every GCash payment recorded so far has been verified or rejected. New claims appear here as tellers record them."
                />
              ) : (
                <ul className="space-y-2">
                  {claims.map((claim) => (
                    <ClaimListItem
                      key={claim.paymentId}
                      claim={claim}
                      isSelected={claim.paymentId === selectedPaymentId}
                      onSelect={() => setSelectedPaymentId(claim.paymentId)}
                    />
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {selectedClaim === null ? (
            <Card>
              <CardContent>
                <EmptyState
                  title="Select a claim to review"
                  description="Pick a pending claim on the left to see its proof image, its details, and the verify and reject controls."
                />
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-6">
              <Card>
                <CardHeader className="flex-row items-center">
                  <CardTitle>Proof image</CardTitle>
                  <Badge variant="warning">Evidence, not proof</Badge>
                </CardHeader>
                <CardContent>
                  {selectedClaim.screenshotFilePath === null ? (
                    <EmptyState
                      icon={<ImageOff className="h-6 w-6" aria-hidden="true" />}
                      title="No proof image attached"
                      description="No screenshot was uploaded with this claim. Judge it on the reference and sender details below."
                    />
                  ) : (
                    <ProofImage paymentId={selectedClaim.paymentId} />
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex-row items-center">
                  <CardTitle>Claim details</CardTitle>
                  <Badge variant="info">Pending Verification</Badge>
                </CardHeader>
                <CardContent>
                  <dl>
                    <ClaimFact label="Receipt number">
                      <span className="font-mono">{selectedClaim.receiptNumber}</span>
                    </ClaimFact>
                    <ClaimFact label="Subscriber">{selectedClaim.subscriberName}</ClaimFact>
                    <ClaimFact label="Service account">
                      <span className="font-mono">{selectedClaim.serviceAccountNumber}</span>
                    </ClaimFact>
                    <ClaimFact label="Amount">
                      <span className="font-medium tabular-nums">
                        {formatCentavos(selectedClaim.amountCentavos)}
                      </span>
                    </ClaimFact>
                    <ClaimFact label="Payment date">
                      {formatDateOnly(selectedClaim.paymentDate)}
                    </ClaimFact>
                    <ClaimFact label="GCash reference">
                      <span className="font-mono">{selectedClaim.referenceNumber}</span>
                    </ClaimFact>
                    <ClaimFact label="Sender">{selectedClaim.senderName ?? "—"}</ClaimFact>
                    <ClaimFact label="Sender number">
                      <span className="font-mono">{selectedClaim.senderGcashNumber ?? "—"}</span>
                    </ClaimFact>
                    <ClaimFact label="Recorded by">
                      {selectedClaim.recordedByName} on {formatTimestamp(selectedClaim.recordedAt)}
                    </ClaimFact>
                  </dl>

                  <div className="mt-4 flex flex-wrap gap-3">
                    <Button
                      variant="primary"
                      onClick={() => setVerifyTarget(selectedClaim)}
                      disabled={isSubmitting}
                    >
                      Verify &amp; post payment
                    </Button>
                    {mayReject && (
                      <Button
                        variant="outline"
                        className="border-danger-line text-danger-strong"
                        onClick={() => {
                          reset();
                          setRejectTarget(selectedClaim);
                        }}
                        disabled={isSubmitting}
                      >
                        Reject claim
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      </div>

      <Modal
        isOpen={verifyTarget !== null}
        onClose={() => setVerifyTarget(null)}
        title="Verify this GCash payment?"
        description="This is the step that makes the money real."
        footer={
          <>
            <Button variant="outline" onClick={() => setVerifyTarget(null)} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button onClick={() => void confirmVerify()} isLoading={isSubmitting}>
              Verify and post
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-sm text-content-secondary">
          <p>
            Verifying posts{" "}
            <span className="font-medium text-content-primary">
              {verifyTarget === null ? "" : formatCentavos(verifyTarget.amountCentavos)}
            </span>{" "}
            to {verifyTarget?.subscriberName ?? "the subscriber"} and allocates it to the oldest
            outstanding invoices first. Any amount left over becomes an advance credit.
          </p>
          <p>Once verified, the claim leaves the queue and the receipt is live.</p>
        </div>
      </Modal>

      <Modal
        isOpen={rejectTarget !== null}
        onClose={() => setRejectTarget(null)}
        title="Reject this GCash claim?"
        description="Nothing is posted and the invoice is left exactly as it was."
        footer={
          <>
            <Button
              variant="outline"
              onClick={() => setRejectTarget(null)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => void handleSubmit(submitReject)()}
              isLoading={isSubmitting}
            >
              Reject claim
            </Button>
          </>
        }
      >
        <form
          id="reject-gcash-form"
          onSubmit={(event) => void handleSubmit(submitReject)(event)}
          noValidate
        >
          <p className="mb-3 text-sm text-content-secondary">
            Rejecting records your reason against{" "}
            <span className="font-mono">{rejectTarget?.receiptNumber ?? ""}</span> and leaves the
            invoice untouched — no balance moves. A reason is required and is kept in the audit
            trail.
          </p>
          <TextareaField
            id="gcash-reject-reason"
            label="Reason for rejection"
            rows={3}
            hint={`At least ${GCASH_REJECTION_REASON_MIN_LENGTH} characters.`}
            error={errors.reason?.message}
            {...register("reason")}
          />
        </form>
      </Modal>
    </AppShell>
  );
}
