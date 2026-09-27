import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import {
  SERVICE_ACCOUNT_STATUS_LABELS,
  SERVICE_TYPE_LABELS,
  roleHasPermission,
  type ServiceAccountStatus,
} from "@bcis/shared";
import {
  extractApiErrorMessage,
  getSubscriber,
  reconnectServiceAccount,
  suspendServiceAccount,
  terminateServiceAccount,
  updateSubscriber,
  type ServiceAccount,
  type Subscriber,
} from "../lib/api-client";
import { formatCentavos, formatDateOnly, formatSubscriberName } from "../lib/format";
import { useAuthStore } from "../stores/auth.store";
import { AppShell } from "../components/layout/AppShell";
import { Badge, type BadgeVariant } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardContent } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { ErrorBanner } from "../components/ui/ErrorBanner";
import { Modal } from "../components/ui/Modal";
import { Skeleton } from "../components/ui/Skeleton";

const STATUS_BADGE_VARIANTS = {
  active: "success",
  suspended: "warning",
  terminated: "neutral",
  pending: "info",
} satisfies Record<ServiceAccountStatus, BadgeVariant>;

type PendingAction = "suspend" | "reconnect" | "terminate";

const ACTION_TITLES: Record<PendingAction, string> = {
  suspend: "Suspend service",
  reconnect: "Reconnect service",
  terminate: "Terminate service",
};

/** Which lifecycle actions are legal from the account's current state. */
function availableActions(status: ServiceAccountStatus): PendingAction[] {
  if (status === "terminated") {
    return [];
  }
  if (status === "suspended") {
    return ["reconnect", "terminate"];
  }
  if (status === "pending") {
    return ["terminate"];
  }
  return ["suspend", "terminate"];
}

interface ServiceAccountCardProps {
  account: ServiceAccount;
  onAction: (account: ServiceAccount, action: PendingAction) => void;
  canSuspend: boolean;
  canReconnect: boolean;
  canViewLedger: boolean;
}

/** One card per service. The subscriber may hold Internet, Cable TV, or both. */
function ServiceAccountCard({
  account,
  onAction,
  canSuspend,
  canReconnect,
  canViewLedger,
}: ServiceAccountCardProps): ReactNode {
  const actions = availableActions(account.status);

  return (
    <Card>
      <CardContent className="space-y-3">
        <header className="flex items-start justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Badge variant="neutral" size="sm">
                {SERVICE_TYPE_LABELS[account.serviceType]}
              </Badge>
              <span className="font-mono text-xs text-content-secondary">
                {account.serviceAccountNumber}
              </span>
            </div>
            <h3 className="text-base font-medium">{account.planName}</h3>
            <p className="text-sm text-content-secondary tabular-nums">
              {formatCentavos(account.monthlyRateCentavos)} per month
            </p>
          </div>
          <Badge variant={STATUS_BADGE_VARIANTS[account.status]} size="sm" dot>
            {SERVICE_ACCOUNT_STATUS_LABELS[account.status]}
          </Badge>
        </header>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          <dt className="text-content-secondary">Activated</dt>
          <dd>{formatDateOnly(account.activationDate)}</dd>
          <dt className="text-content-secondary">Suspended</dt>
          <dd>{formatDateOnly(account.suspensionDate)}</dd>
          <dt className="text-content-secondary">Terminated</dt>
          <dd>{formatDateOnly(account.terminationDate)}</dd>
          <dt className="text-content-secondary">Current balance</dt>
          {/* Computed from the ledger — never a stored column. */}
          <dd className="tabular-nums">
            {account.balanceCentavos === null ? "—" : formatCentavos(account.balanceCentavos)}
          </dd>
        </dl>

        {canViewLedger && (
          <Link
            to={`/service-accounts/${account.id}/ledger`}
            className="inline-block text-sm font-medium text-content-primary underline"
          >
            View ledger & statement
          </Link>
        )}

        {actions.length === 0 ? (
          <p className="text-xs text-content-secondary">
            This service is terminated. It stays in history and cannot be reactivated.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {actions.includes("suspend") && canSuspend && (
              <Button
                variant="outline"
                size="sm"
                className="border-warning-line text-warning-strong"
                onClick={() => onAction(account, "suspend")}
              >
                Suspend
              </Button>
            )}
            {actions.includes("reconnect") && canReconnect && (
              <Button
                variant="outline"
                size="sm"
                className="border-success-line text-success-strong"
                onClick={() => onAction(account, "reconnect")}
              >
                Reconnect
              </Button>
            )}
            {actions.includes("terminate") && canSuspend && (
              <Button variant="outline" size="sm" className="border-danger-line text-danger-strong" onClick={() => onAction(account, "terminate")}>
                Terminate
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface EditFormState {
  primaryPhone: string;
  secondaryPhone: string;
  emailAddress: string;
  serviceAddress: string;
  serviceBarangay: string;
  serviceMunicipality: string;
  serviceProvince: string;
  internalNotes: string;
}

function toEditForm(subscriber: Subscriber): EditFormState {
  return {
    primaryPhone: subscriber.primaryPhone,
    secondaryPhone: subscriber.secondaryPhone ?? "",
    emailAddress: subscriber.emailAddress ?? "",
    serviceAddress: subscriber.serviceAddress,
    serviceBarangay: subscriber.serviceBarangay,
    serviceMunicipality: subscriber.serviceMunicipality,
    serviceProvince: subscriber.serviceProvince,
    internalNotes: subscriber.internalNotes ?? "",
  };
}

/**
 * Subscriber detail: contact details, every service account, and the lifecycle
 * actions a clerk may take on each one.
 */
export function SubscriberDetailPage(): ReactNode {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);

  const [subscriber, setSubscriber] = useState<Subscriber | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<{
    account: ServiceAccount;
    action: PendingAction;
  } | null>(null);
  const [reason, setReason] = useState("");
  const [editForm, setEditForm] = useState<EditFormState | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const canUpdate = user !== null && roleHasPermission(user.role, "subscribers:update");
  const canSuspend = user !== null && roleHasPermission(user.role, "subscribers:suspend");
  const canReconnect = user !== null && roleHasPermission(user.role, "subscribers:reconnect");
  const canViewLedger = user !== null && roleHasPermission(user.role, "ledger:read");

  const loadSubscriber = useCallback(async (): Promise<void> => {
    if (id === undefined) {
      return;
    }
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const loaded = await getSubscriber(id);
      setSubscriber(loaded);
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void loadSubscriber();
  }, [loadSubscriber]);

  function openAction(account: ServiceAccount, action: PendingAction): void {
    setReason("");
    setErrorMessage(null);
    setStatusMessage(null);
    setPendingAction({ account, action });
  }

  async function confirmAction(): Promise<void> {
    if (pendingAction === null) {
      return;
    }

    const { account, action } = pendingAction;
    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      if (action === "suspend") {
        await suspendServiceAccount(account.id, reason);
        setStatusMessage(`Suspended ${account.serviceAccountNumber}.`);
      } else if (action === "terminate") {
        await terminateServiceAccount(account.id, reason);
        setStatusMessage(`Terminated ${account.serviceAccountNumber}.`);
      } else {
        const result = await reconnectServiceAccount(
          account.id,
          reason.trim() === "" ? undefined : reason
        );
        // Tell the clerk exactly what will be charged for the reconnection.
        const invoiceNote =
          result.reconnectionFeeInvoice === null
            ? ""
            : ` Invoice ${result.reconnectionFeeInvoice.invoice.invoiceNumber} generated.`;
        setStatusMessage(
          `Reconnected ${account.serviceAccountNumber}. Reconnection fee: ` +
            `${formatCentavos(result.reconnectionFeeEntry.amountCentavos)}.${invoiceNote}`
        );
      }

      setPendingAction(null);
      await loadSubscriber();
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function saveEdits(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (id === undefined || editForm === null) {
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      await updateSubscriber(id, {
        primaryPhone: editForm.primaryPhone,
        secondaryPhone: editForm.secondaryPhone === "" ? undefined : editForm.secondaryPhone,
        emailAddress: editForm.emailAddress === "" ? undefined : editForm.emailAddress,
        serviceAddress: editForm.serviceAddress,
        serviceBarangay: editForm.serviceBarangay,
        serviceMunicipality: editForm.serviceMunicipality,
        serviceProvince: editForm.serviceProvince,
        internalNotes: editForm.internalNotes === "" ? undefined : editForm.internalNotes,
      });
      setEditForm(null);
      await loadSubscriber();
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  if (isLoading) {
    return (
      <AppShell pageTitle="Subscriber" pageDescription="Loading subscriber…">
        <div className="mx-auto max-w-4xl space-y-6">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      </AppShell>
    );
  }

  if (subscriber === null) {
    return (
      <AppShell pageTitle="Subscriber" pageDescription="The requested subscriber could not be loaded">
        <div className="mx-auto max-w-4xl space-y-4">
          <ErrorBanner
            message={errorMessage ?? "Subscriber not found."}
            onRetry={() => void loadSubscriber()}
          />
          <Link to="/subscribers" className="text-sm font-medium text-content-primary underline">
            Back to list
          </Link>
        </div>
      </AppShell>
    );
  }

  const reasonIsRequired = pendingAction !== null && pendingAction.action !== "reconnect";
  const reasonIsTooShort = reasonIsRequired && reason.trim().length < 10;

  return (
    <AppShell
      pageTitle={formatSubscriberName(subscriber)}
      pageDescription={`${subscriber.accountNumber} · ${subscriber.primaryPhone}`}
      headerActions={
        canUpdate ? (
          <Button size="md" onClick={() => setEditForm(toEditForm(subscriber))}>
            Edit
          </Button>
        ) : undefined
      }
    >
      <div className="mx-auto max-w-4xl space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <p className="text-sm text-content-secondary">
              {subscriber.primaryPhone}
              {subscriber.emailAddress !== null && ` · ${subscriber.emailAddress}`}
            </p>
            <p className="text-sm text-content-secondary">
              {subscriber.serviceAddress}, {subscriber.serviceBarangay},{" "}
              {subscriber.serviceMunicipality}, {subscriber.serviceProvince}
            </p>
          </div>
          <Link to="/subscribers" className="text-sm font-medium text-content-primary underline">
            Back to list
          </Link>
        </div>

        {errorMessage !== null && (
          <ErrorBanner message={errorMessage} onRetry={() => void loadSubscriber()} />
        )}

        {statusMessage !== null && (
          <p className="rounded-xl border border-success-line bg-success-soft px-4 py-3 text-sm text-success-strong">
            {statusMessage}
          </p>
        )}

        <section className="space-y-4">
          <h2 className="text-lg font-medium">Service Accounts</h2>
          {subscriber.serviceAccounts.length === 0 ? (
            <EmptyState
              title="No services yet"
              description="This subscriber has no service accounts. Create one from the subscriber list to start billing."
              actionLabel="Back to subscribers"
              onAction={() => navigate("/subscribers")}
            />
          ) : (
            <div className="space-y-4">
              {subscriber.serviceAccounts.map((account) => (
                <ServiceAccountCard
                  key={account.id}
                  account={account}
                  onAction={openAction}
                  canSuspend={canSuspend}
                  canReconnect={canReconnect}
                  canViewLedger={canViewLedger}
                />
              ))}
            </div>
          )}
        </section>

        <Card>
          <CardContent>
            <h2 className="text-base font-medium">Recent Payment History</h2>
            <p className="mt-1 text-sm text-content-secondary">
              Payments are recorded in Phase 5. Until then this section stays empty.
            </p>
          </CardContent>
        </Card>
      </div>

      <Modal
        isOpen={pendingAction !== null}
        onClose={() => setPendingAction(null)}
        title={
          pendingAction === null
            ? ""
            : `${ACTION_TITLES[pendingAction.action]} — ${pendingAction.account.serviceAccountNumber}`
        }
        description={
          pendingAction?.action === "reconnect"
            ? "Reconnecting creates a reconnection fee entry for this account."
            : "Give a reason. It is written to the account's status history."
        }
        footer={
          <>
            <Button variant="outline" size="md" onClick={() => setPendingAction(null)}>
              Cancel
            </Button>
            <Button
              variant="secondary"
              size="md"
              isLoading={isSubmitting}
              disabled={reasonIsTooShort}
              onClick={() => void confirmAction()}
            >
              Confirm
            </Button>
          </>
        }
      >
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-content-secondary">
            Reason {reasonIsRequired ? "(at least 10 characters)" : "(optional)"}
          </span>
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={3}
            className="w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          />
        </label>
      </Modal>

      <Modal
        isOpen={editForm !== null}
        onClose={() => setEditForm(null)}
        title="Edit Subscriber"
        maxWidth="lg"
      >
        {editForm !== null && (
          <form onSubmit={saveEdits} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-content-secondary">Primary Phone</span>
                <input
                  type="tel"
                  value={editForm.primaryPhone}
                  onChange={(event) =>
                    setEditForm({ ...editForm, primaryPhone: event.target.value })
                  }
                  required
                  className="h-9 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                />
              </label>
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-content-secondary">Secondary Phone</span>
                <input
                  type="tel"
                  value={editForm.secondaryPhone}
                  onChange={(event) =>
                    setEditForm({ ...editForm, secondaryPhone: event.target.value })
                  }
                  className="h-9 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                />
              </label>
            </div>

            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-content-secondary">Email</span>
              <input
                type="email"
                value={editForm.emailAddress}
                onChange={(event) => setEditForm({ ...editForm, emailAddress: event.target.value })}
                className="h-9 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              />
            </label>

            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-content-secondary">Service Address</span>
              <input
                type="text"
                value={editForm.serviceAddress}
                onChange={(event) =>
                  setEditForm({ ...editForm, serviceAddress: event.target.value })
                }
                required
                className="h-9 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              />
            </label>

            <div className="grid grid-cols-3 gap-4">
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-content-secondary">Barangay</span>
                <input
                  type="text"
                  value={editForm.serviceBarangay}
                  onChange={(event) =>
                    setEditForm({ ...editForm, serviceBarangay: event.target.value })
                  }
                  required
                  className="h-9 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                />
              </label>
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-content-secondary">Municipality</span>
                <input
                  type="text"
                  value={editForm.serviceMunicipality}
                  onChange={(event) =>
                    setEditForm({ ...editForm, serviceMunicipality: event.target.value })
                  }
                  required
                  className="h-9 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                />
              </label>
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-content-secondary">Province</span>
                <input
                  type="text"
                  value={editForm.serviceProvince}
                  onChange={(event) =>
                    setEditForm({ ...editForm, serviceProvince: event.target.value })
                  }
                  required
                  className="h-9 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                />
              </label>
            </div>

            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-content-secondary">Internal Notes</span>
              <textarea
                value={editForm.internalNotes}
                onChange={(event) =>
                  setEditForm({ ...editForm, internalNotes: event.target.value })
                }
                rows={3}
                className="w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              />
            </label>

            <div className="flex justify-end gap-3 pt-1">
              <Button type="button" variant="outline" size="md" onClick={() => setEditForm(null)}>
                Cancel
              </Button>
              <Button type="submit" size="md" isLoading={isSubmitting}>
                Save
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </AppShell>
  );
}
