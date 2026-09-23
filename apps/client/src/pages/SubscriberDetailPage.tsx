import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

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

const STATUS_BADGE_CLASSES = {
  active: "bg-emerald-50 text-emerald-700",
  suspended: "bg-amber-50 text-amber-700",
  terminated: "bg-slate-100 text-slate-600",
  pending: "bg-sky-50 text-sky-700",
} satisfies Record<ServiceAccountStatus, string>;

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
}

/** One card per service. The subscriber may hold Internet, Cable TV, or both. */
function ServiceAccountCard({
  account,
  onAction,
  canSuspend,
  canReconnect,
}: ServiceAccountCardProps): ReactNode {
  const actions = availableActions(account.status);

  return (
    <article className="space-y-3 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <header className="flex items-start justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
              {SERVICE_TYPE_LABELS[account.serviceType]}
            </span>
            <span className="font-mono text-xs text-slate-500">
              {account.serviceAccountNumber}
            </span>
          </div>
          <h3 className="text-base font-medium">{account.planName}</h3>
          <p className="text-sm text-slate-600">
            {formatCentavos(account.monthlyRateCentavos)} per month
          </p>
        </div>
        <span
          className={`rounded-full px-2 py-0.5 text-xs ${STATUS_BADGE_CLASSES[account.status]}`}
        >
          {SERVICE_ACCOUNT_STATUS_LABELS[account.status]}
        </span>
      </header>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        <dt className="text-slate-600">Activated</dt>
        <dd>{formatDateOnly(account.activationDate)}</dd>
        <dt className="text-slate-600">Suspended</dt>
        <dd>{formatDateOnly(account.suspensionDate)}</dd>
        <dt className="text-slate-600">Terminated</dt>
        <dd>{formatDateOnly(account.terminationDate)}</dd>
        <dt className="text-slate-600">Current balance</dt>
        {/* The ledger arrives in Phase 6; until then the balance is unknown, not zero. */}
        <dd>{account.balanceCentavos === null ? "—" : formatCentavos(account.balanceCentavos)}</dd>
      </dl>

      {actions.length === 0 ? (
        <p className="text-xs text-slate-500">
          This service is terminated. It stays in history and cannot be reactivated.
        </p>
      ) : (
        <div className="flex flex-wrap gap-3">
          {actions.includes("suspend") && canSuspend && (
            <button
              type="button"
              onClick={() => onAction(account, "suspend")}
              className="rounded border border-amber-400 px-3 py-1.5 text-sm text-amber-800"
            >
              Suspend
            </button>
          )}
          {actions.includes("reconnect") && canReconnect && (
            <button
              type="button"
              onClick={() => onAction(account, "reconnect")}
              className="rounded border border-emerald-400 px-3 py-1.5 text-sm text-emerald-800"
            >
              Reconnect
            </button>
          )}
          {actions.includes("terminate") && canSuspend && (
            <button
              type="button"
              onClick={() => onAction(account, "terminate")}
              className="rounded border border-red-300 px-3 py-1.5 text-sm text-red-700"
            >
              Terminate
            </button>
          )}
        </div>
      )}
    </article>
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
      <main className="mx-auto max-w-4xl p-8">
        <p className="text-sm text-slate-500">Loading subscriber…</p>
      </main>
    );
  }

  if (subscriber === null) {
    return (
      <main className="mx-auto max-w-4xl space-y-4 p-8">
        <p role="alert" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          {errorMessage ?? "Subscriber not found."}
        </p>
        <Link to="/subscribers" className="text-sm font-medium text-slate-700 underline">
          Back to list
        </Link>
      </main>
    );
  }

  const reasonIsRequired = pendingAction !== null && pendingAction.action !== "reconnect";
  const reasonIsTooShort = reasonIsRequired && reason.trim().length < 10;

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-8">
      <header className="flex items-start justify-between">
        <div className="space-y-1">
          <p className="font-mono text-sm text-slate-500">{subscriber.accountNumber}</p>
          <h1 className="text-2xl font-semibold">{formatSubscriberName(subscriber)}</h1>
          <p className="text-sm text-slate-600">
            {subscriber.primaryPhone}
            {subscriber.emailAddress !== null && ` · ${subscriber.emailAddress}`}
          </p>
          <p className="text-sm text-slate-600">
            {subscriber.serviceAddress}, {subscriber.serviceBarangay},{" "}
            {subscriber.serviceMunicipality}, {subscriber.serviceProvince}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link to="/subscribers" className="text-sm font-medium text-slate-700 underline">
            Back to list
          </Link>
          {canUpdate && (
            <button
              type="button"
              onClick={() => setEditForm(toEditForm(subscriber))}
              className="rounded bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
            >
              Edit
            </button>
          )}
        </div>
      </header>

      {errorMessage !== null && (
        <p
          role="alert"
          className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {errorMessage}
        </p>
      )}

      {statusMessage !== null && (
        <p className="rounded border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {statusMessage}
        </p>
      )}

      <section className="space-y-4">
        <h2 className="text-lg font-medium">Service Accounts</h2>
        {subscriber.serviceAccounts.length === 0 ? (
          <p className="rounded border border-slate-200 bg-white px-4 py-3 text-sm text-slate-500">
            This subscriber has no services yet.
          </p>
        ) : (
          <div className="space-y-4">
            {subscriber.serviceAccounts.map((account) => (
              <ServiceAccountCard
                key={account.id}
                account={account}
                onAction={openAction}
                canSuspend={canSuspend}
                canReconnect={canReconnect}
              />
            ))}
          </div>
        )}
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-base font-medium">Recent Payment History</h2>
        <p className="mt-1 text-sm text-slate-500">
          Payments are recorded in Phase 5. Until then this section stays empty.
        </p>
      </section>

      {pendingAction !== null && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md space-y-4 rounded-lg bg-white p-6 shadow-lg">
            <h2 className="text-lg font-semibold">
              {ACTION_TITLES[pendingAction.action]} — {pendingAction.account.serviceAccountNumber}
            </h2>
            <p className="text-sm text-slate-600">
              {pendingAction.action === "reconnect"
                ? "Reconnecting creates a reconnection fee entry for this account."
                : "Give a reason. It is written to the account's status history."}
            </p>

            <label className="block space-y-1">
              <span className="text-sm font-medium text-slate-700">
                Reason {reasonIsRequired ? "(at least 10 characters)" : "(optional)"}
              </span>
              <textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                rows={3}
                className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
              />
            </label>

            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setPendingAction(null)}
                className="rounded border border-slate-300 px-4 py-2 text-sm"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void confirmAction()}
                disabled={isSubmitting || reasonIsTooShort}
                className="rounded bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-60"
              >
                {isSubmitting ? "Working…" : "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}

      {editForm !== null && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/40 p-4">
          <form
            onSubmit={saveEdits}
            className="w-full max-w-lg space-y-4 rounded-lg bg-white p-6 shadow-lg"
          >
            <h2 className="text-lg font-semibold">Edit Subscriber</h2>

            <div className="grid grid-cols-2 gap-4">
              <label className="space-y-1">
                <span className="text-sm font-medium text-slate-700">Primary Phone</span>
                <input
                  type="tel"
                  value={editForm.primaryPhone}
                  onChange={(event) =>
                    setEditForm({ ...editForm, primaryPhone: event.target.value })
                  }
                  required
                  className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
                />
              </label>
              <label className="space-y-1">
                <span className="text-sm font-medium text-slate-700">Secondary Phone</span>
                <input
                  type="tel"
                  value={editForm.secondaryPhone}
                  onChange={(event) =>
                    setEditForm({ ...editForm, secondaryPhone: event.target.value })
                  }
                  className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
                />
              </label>
            </div>

            <label className="space-y-1">
              <span className="text-sm font-medium text-slate-700">Email</span>
              <input
                type="email"
                value={editForm.emailAddress}
                onChange={(event) => setEditForm({ ...editForm, emailAddress: event.target.value })}
                className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
              />
            </label>

            <label className="space-y-1">
              <span className="text-sm font-medium text-slate-700">Service Address</span>
              <input
                type="text"
                value={editForm.serviceAddress}
                onChange={(event) =>
                  setEditForm({ ...editForm, serviceAddress: event.target.value })
                }
                required
                className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
              />
            </label>

            <div className="grid grid-cols-3 gap-4">
              <label className="space-y-1">
                <span className="text-sm font-medium text-slate-700">Barangay</span>
                <input
                  type="text"
                  value={editForm.serviceBarangay}
                  onChange={(event) =>
                    setEditForm({ ...editForm, serviceBarangay: event.target.value })
                  }
                  required
                  className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
                />
              </label>
              <label className="space-y-1">
                <span className="text-sm font-medium text-slate-700">Municipality</span>
                <input
                  type="text"
                  value={editForm.serviceMunicipality}
                  onChange={(event) =>
                    setEditForm({ ...editForm, serviceMunicipality: event.target.value })
                  }
                  required
                  className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
                />
              </label>
              <label className="space-y-1">
                <span className="text-sm font-medium text-slate-700">Province</span>
                <input
                  type="text"
                  value={editForm.serviceProvince}
                  onChange={(event) =>
                    setEditForm({ ...editForm, serviceProvince: event.target.value })
                  }
                  required
                  className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
                />
              </label>
            </div>

            <label className="space-y-1">
              <span className="text-sm font-medium text-slate-700">Internal Notes</span>
              <textarea
                value={editForm.internalNotes}
                onChange={(event) =>
                  setEditForm({ ...editForm, internalNotes: event.target.value })
                }
                rows={3}
                className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
              />
            </label>

            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setEditForm(null)}
                className="rounded border border-slate-300 px-4 py-2 text-sm"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitting}
                className="rounded bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-60"
              >
                {isSubmitting ? "Saving…" : "Save"}
              </button>
            </div>
          </form>
        </div>
      )}
    </main>
  );
}
