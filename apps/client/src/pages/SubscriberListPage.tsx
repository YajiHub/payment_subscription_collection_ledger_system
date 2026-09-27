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
import { DataTable, type TableColumn } from "../components/table/DataTable";
import { EmptyState } from "../components/ui/EmptyState";

/** The page size the list opens with. Server-side paging caps it at 200. */
const DEFAULT_PAGE_SIZE = 20;

// Colours per state. `satisfies` keeps the keys exhaustive without widening the
// literal class strings into plain `string`.
const STATUS_BADGE_CLASSES = {
  active: "bg-success-soft text-success-strong",
  suspended: "bg-warning-soft text-warning-strong",
  terminated: "bg-canvas text-content-secondary",
  pending: "bg-accent-soft text-accent-strong",
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

const SUBSCRIBER_COLUMNS: TableColumn<Subscriber>[] = [
  {
    id: "accountNumber",
    header: "Account #",
    cellClassName: "font-mono",
    sortValue: (subscriber) => subscriber.accountNumber,
    cell: (subscriber) => subscriber.accountNumber,
  },
  {
    id: "fullName",
    header: "Full Name",
    sortValue: (subscriber) => formatSubscriberName(subscriber),
    cell: (subscriber) => formatSubscriberName(subscriber),
  },
  {
    id: "phone",
    header: "Phone",
    sortValue: (subscriber) => subscriber.primaryPhone,
    cell: (subscriber) => subscriber.primaryPhone,
  },
  {
    id: "services",
    header: "Services",
    sortValue: (subscriber) => summariseServices(subscriber),
    cell: (subscriber) => summariseServices(subscriber),
  },
  {
    id: "status",
    header: "Status",
    sortValue: (subscriber) => summariseStatus(subscriber),
    cell: (subscriber) => {
      const status = summariseStatus(subscriber);
      return (
        <span className={`rounded-full px-2 py-0.5 text-xs ${STATUS_BADGE_CLASSES[status]}`}>
          {SERVICE_ACCOUNT_STATUS_LABELS[status]}
        </span>
      );
    },
  },
  {
    id: "actions",
    header: "Actions",
    cell: (subscriber) => (
      <Link to={`/subscribers/${subscriber.id}`} className="text-content-primary underline">
        View
      </Link>
    ),
  },
];

/**
 * Subscriber list: search by name, account number, or phone, filter by status and
 * municipality, and open a subscriber's detail page. The list is paged on the
 * server, so only the page on screen is ever fetched (spec S7-4).
 */
export function SubscriberListPage(): ReactNode {
  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);

  const [subscribers, setSubscribers] = useState<Subscriber[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<ServiceAccountStatus | "">("");
  const [municipalityFilter, setMunicipalityFilter] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const canCreate = user !== null && roleHasPermission(user.role, "subscribers:create");

  const loadSubscribers = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const result = await listSubscribers({
        page,
        pageSize,
        search: searchTerm.trim() === "" ? undefined : searchTerm.trim(),
        status: statusFilter === "" ? undefined : statusFilter,
        municipality: municipalityFilter.trim() === "" ? undefined : municipalityFilter.trim(),
      });
      setSubscribers(result.items);
      setTotal(result.total);
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  }, [page, pageSize, searchTerm, statusFilter, municipalityFilter]);

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
          <p className="text-sm text-content-secondary">Search by name, account number, or phone number.</p>
        </div>
        <div className="flex items-center gap-3">
          <Link to="/" className="text-sm font-medium text-content-primary underline">
            Dashboard
          </Link>
          {canCreate && (
            <button
              type="button"
              onClick={() => navigate("/subscribers/new")}
              className="rounded bg-navy px-4 py-2 text-sm font-medium text-surface hover:bg-navy-strong"
            >
              Add Subscriber
            </button>
          )}
        </div>
      </header>

      <form onSubmit={handleSearchSubmit} className="flex flex-wrap items-end gap-3">
        <label className="flex-1 space-y-1">
          <span className="text-sm font-medium text-content-primary">Search</span>
          <input
            type="text"
            value={searchTerm}
            onChange={(event) => {
              setSearchTerm(event.target.value);
              setPage(1);
            }}
            placeholder="Name, account number, or phone"
            className="w-full rounded border border-line-strong px-3 py-2 text-sm"
          />
        </label>

        <label className="space-y-1">
          <span className="text-sm font-medium text-content-primary">Status</span>
          <select
            value={statusFilter}
            onChange={(event) => {
              setStatusFilter(event.target.value as ServiceAccountStatus | "");
              setPage(1);
            }}
            className="rounded border border-line-strong px-3 py-2 text-sm"
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
          <span className="text-sm font-medium text-content-primary">Municipality</span>
          <input
            type="text"
            value={municipalityFilter}
            onChange={(event) => {
              setMunicipalityFilter(event.target.value);
              setPage(1);
            }}
            className="rounded border border-line-strong px-3 py-2 text-sm"
          />
        </label>

        <button
          type="submit"
          className="rounded border border-line-strong px-4 py-2 text-sm font-medium"
        >
          Search
        </button>
      </form>

      {errorMessage !== null && (
        <p
          role="alert"
          className="rounded border border-danger-line bg-danger-soft px-3 py-2 text-sm text-danger-strong"
        >
          {errorMessage}
        </p>
      )}

      <div className="overflow-hidden rounded-lg border border-line bg-surface shadow-sm">
        <DataTable
          columns={SUBSCRIBER_COLUMNS}
          data={subscribers}
          getRowId={(subscriber) => subscriber.id}
          isLoading={isLoading}
          emptyState={
            <EmptyState
              title="No subscribers match this search"
              description="Try a different name, account number, or phone number, or clear the status and municipality filters."
            />
          }
          pagination={{
            page,
            pageSize,
            total,
            rowNoun: "subscriber",
            onPageChange: setPage,
            onPageSizeChange: (nextPageSize) => {
              setPageSize(nextPageSize);
              setPage(1);
            },
          }}
        />
      </div>
    </main>
  );
}
