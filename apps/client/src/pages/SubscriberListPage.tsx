import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import {
  SERVICE_ACCOUNT_STATUSES,
  SERVICE_ACCOUNT_STATUS_LABELS,
  SERVICE_TYPE_LABELS,
  roleHasPermission,
  type ServiceAccountStatus,
} from "@bcis/shared";
import { extractApiErrorMessage, listSubscribers, type Subscriber } from "../lib/api-client";
import { formatSubscriberName } from "../lib/format";
import { useAuthStore } from "../stores/auth.store";

// Colours per state. `satisfies` keeps the keys exhaustive without widening the
// literal class strings into plain `string`.
const STATUS_BADGE_CLASSES = {
  active: "bg-emerald-50 text-emerald-700",
  suspended: "bg-amber-50 text-amber-700",
  terminated: "bg-slate-100 text-slate-600",
  pending: "bg-sky-50 text-sky-700",
} satisfies Record<ServiceAccountStatus, string>;

/** The services a subscriber holds, as a single readable cell. */
function summariseServices(subscriber: Subscriber): string {
  if (subscriber.serviceAccounts.length === 0) {
    return "No services";
  }
  return subscriber.serviceAccounts
    .map((account) => SERVICE_TYPE_LABELS[account.serviceType])
    .join(", ");
}

/**
 * The state a clerk scans for: the worst state across the subscriber's services.
 * Internet may be active while Cable TV is suspended, and the row should show that
 * something needs attention.
 */
function summariseStatus(subscriber: Subscriber): ServiceAccountStatus {
  const statuses = subscriber.serviceAccounts.map((account) => account.status);

  if (statuses.includes("suspended")) {
    return "suspended";
  }
  if (statuses.includes("terminated")) {
    return "terminated";
  }
  if (statuses.includes("pending")) {
    return "pending";
  }
  return "active";
}

interface SubscriberTableProps {
  subscribers: Subscriber[];
  isLoading: boolean;
}

/** The results table. Presentational only — the page owns loading and filtering. */
function SubscriberTable({ subscribers, isLoading }: SubscriberTableProps): ReactNode {
  if (isLoading) {
    return (
      <tbody>
        <tr>
          <td colSpan={6} className="px-4 py-6 text-center text-slate-500">
            Loading subscribers…
          </td>
        </tr>
      </tbody>
    );
  }

  if (subscribers.length === 0) {
    return (
      <tbody>
        <tr>
          <td colSpan={6} className="px-4 py-6 text-center text-slate-500">
            No subscribers match this search.
          </td>
        </tr>
      </tbody>
    );
  }

  return (
    <tbody>
      {subscribers.map((subscriber) => {
        const status = summariseStatus(subscriber);
        return (
          <tr key={subscriber.id} className="border-t border-slate-100">
            <td className="px-4 py-3 font-mono">{subscriber.accountNumber}</td>
            <td className="px-4 py-3">{formatSubscriberName(subscriber)}</td>
            <td className="px-4 py-3">{subscriber.primaryPhone}</td>
            <td className="px-4 py-3">{summariseServices(subscriber)}</td>
            <td className="px-4 py-3">
              <span className={`rounded-full px-2 py-0.5 text-xs ${STATUS_BADGE_CLASSES[status]}`}>
                {SERVICE_ACCOUNT_STATUS_LABELS[status]}
              </span>
            </td>
            <td className="px-4 py-3">
              <Link to={`/subscribers/${subscriber.id}`} className="text-slate-700 underline">
                View
              </Link>
            </td>
          </tr>
        );
      })}
    </tbody>
  );
}

/**
 * Subscriber list: search by name, account number, or phone, filter by status and
 * municipality, and open a subscriber's detail page.
 */
export function SubscriberListPage(): ReactNode {
  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);

  const [subscribers, setSubscribers] = useState<Subscriber[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<ServiceAccountStatus | "">("");
  const [municipalityFilter, setMunicipalityFilter] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const canCreate = user !== null && roleHasPermission(user.role, "subscribers:create");

  const loadSubscribers = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const page = await listSubscribers({
        page: 1,
        pageSize: 100,
        search: searchTerm.trim() === "" ? undefined : searchTerm.trim(),
        status: statusFilter === "" ? undefined : statusFilter,
        municipality: municipalityFilter.trim() === "" ? undefined : municipalityFilter.trim(),
      });
      setSubscribers(page.items);
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  }, [searchTerm, statusFilter, municipalityFilter]);

  useEffect(() => {
    void loadSubscribers();
  }, [loadSubscribers]);

  function handleSearchSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void loadSubscribers();
  }

  return (
    <main className="mx-auto max-w-6xl space-y-6 p-8">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Subscribers</h1>
          <p className="text-sm text-slate-600">Search by name, account number, or phone number.</p>
        </div>
        <div className="flex items-center gap-3">
          <Link to="/" className="text-sm font-medium text-slate-700 underline">
            Dashboard
          </Link>
          {canCreate && (
            <button
              type="button"
              onClick={() => navigate("/subscribers/new")}
              className="rounded bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
            >
              Add Subscriber
            </button>
          )}
        </div>
      </header>

      <form onSubmit={handleSearchSubmit} className="flex flex-wrap items-end gap-3">
        <label className="flex-1 space-y-1">
          <span className="text-sm font-medium text-slate-700">Search</span>
          <input
            type="text"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder="Name, account number, or phone"
            className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
          />
        </label>

        <label className="space-y-1">
          <span className="text-sm font-medium text-slate-700">Status</span>
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as ServiceAccountStatus | "")}
            className="rounded border border-slate-300 px-3 py-2 text-sm"
          >
            <option value="">All</option>
            {SERVICE_ACCOUNT_STATUSES.map((status) => (
              <option key={status} value={status}>
                {SERVICE_ACCOUNT_STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1">
          <span className="text-sm font-medium text-slate-700">Municipality</span>
          <input
            type="text"
            value={municipalityFilter}
            onChange={(event) => setMunicipalityFilter(event.target.value)}
            className="rounded border border-slate-300 px-3 py-2 text-sm"
          />
        </label>

        <button
          type="submit"
          className="rounded border border-slate-300 px-4 py-2 text-sm font-medium"
        >
          Search
        </button>
      </form>

      {errorMessage !== null && (
        <p
          role="alert"
          className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {errorMessage}
        </p>
      )}

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="px-4 py-3 font-medium">Account #</th>
              <th className="px-4 py-3 font-medium">Full Name</th>
              <th className="px-4 py-3 font-medium">Phone</th>
              <th className="px-4 py-3 font-medium">Services</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Actions</th>
            </tr>
          </thead>
          <SubscriberTable subscribers={subscribers} isLoading={isLoading} />
        </table>
      </div>
    </main>
  );
}
