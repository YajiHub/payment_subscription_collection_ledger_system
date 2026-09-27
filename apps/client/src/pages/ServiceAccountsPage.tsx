import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import {
  SERVICE_ACCOUNT_STATUSES,
  SERVICE_ACCOUNT_STATUS_LABELS,
  SERVICE_TYPE_LABELS,
  type ServiceAccountStatus,
} from "@bcis/shared";
import {
  extractApiErrorMessage,
  listSubscribers,
  type ServiceAccount,
  type Subscriber,
} from "../lib/api-client";
import { formatCentavos } from "../lib/format";
import { AppShell } from "../components/layout/AppShell";
import { DataTable, type TableColumn } from "../components/table/DataTable";
import { Badge, type BadgeVariant } from "../components/ui/Badge";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { ErrorBanner } from "../components/ui/ErrorBanner";

/** The default page size; the server caps it at 200. */
const DEFAULT_PAGE_SIZE = 20;

const FIELD_CLASS =
  "h-9 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

/** The status tone, so the four states scan at a glance. Text always carries it. */
const STATUS_BADGE_VARIANTS = {
  active: "success",
  suspended: "warning",
  pending: "info",
  terminated: "neutral",
} satisfies Record<ServiceAccountStatus, BadgeVariant>;

/** One service account joined with the subscriber it belongs to. */
interface ServiceAccountRow {
  account: ServiceAccount;
  subscriber: Subscriber;
}

/**
 * The Services section's Service Accounts screen (S4-9).
 *
 * One row per service account, with its plan, type, status and ledger balance, and
 * a link to the subscriber's page where suspend/reconnect/terminate are performed.
 * It replaces the old menu entry that merely pointed at the subscriber directory.
 */
export function ServiceAccountsPage(): ReactNode {
  const [rows, setRows] = useState<ServiceAccountRow[]>([]);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<ServiceAccountStatus | "">("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const loadAccounts = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const result = await listSubscribers({
        search: search.trim() === "" ? undefined : search.trim(),
        status: status === "" ? undefined : status,
        page,
        pageSize,
      });
      // One row per service account, not per subscriber: this screen is about the
      // accounts. A subscriber with two services contributes two rows.
      setRows(
        result.items.flatMap((subscriber) =>
          subscriber.serviceAccounts.map((account) => ({ account, subscriber }))
        )
      );
      // The endpoint pages subscribers, so the footer counts the pages we can ask
      // for rather than the flattened rows on this one.
      setTotal(result.total);
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  }, [search, status, page, pageSize]);

  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);

  const columns = useMemo<TableColumn<ServiceAccountRow>[]>(
    () => [
      {
        id: "serviceAccountNumber",
        header: "Account #",
        cellClassName: "font-mono text-xs text-content-secondary",
        sortValue: (row) => row.account.serviceAccountNumber,
        cell: (row) => row.account.serviceAccountNumber,
      },
      {
        id: "subscriberName",
        header: "Subscriber",
        cellClassName: "text-content-primary",
        sortValue: (row) => `${row.subscriber.lastName}, ${row.subscriber.firstName}`,
        cell: (row) => (
          <Link
            to={`/subscribers/${row.subscriber.id}`}
            className="text-accent underline-offset-4 hover:underline"
          >
            {row.subscriber.lastName}, {row.subscriber.firstName}
          </Link>
        ),
      },
      {
        id: "planName",
        header: "Plan",
        cellClassName: "text-content-primary",
        sortValue: (row) => row.account.planName,
        cell: (row) => row.account.planName,
      },
      {
        id: "serviceType",
        header: "Service",
        cellClassName: "text-content-secondary",
        sortValue: (row) => row.account.serviceType,
        cell: (row) => SERVICE_TYPE_LABELS[row.account.serviceType],
      },
      {
        id: "status",
        header: "Status",
        sortValue: (row) => row.account.status,
        cell: (row) => (
          <Badge variant={STATUS_BADGE_VARIANTS[row.account.status]} size="sm" dot>
            {SERVICE_ACCOUNT_STATUS_LABELS[row.account.status]}
          </Badge>
        ),
      },
      {
        id: "balanceCentavos",
        header: "Balance",
        align: "right",
        cellClassName: "tabular-nums",
        sortValue: (row) => row.account.balanceCentavos ?? 0,
        cell: (row) =>
          row.account.balanceCentavos === null ? "—" : formatCentavos(row.account.balanceCentavos),
      },
      {
        id: "actions",
        header: "Actions",
        cell: (row) => (
          <div className="flex gap-2">
            <Link
              to={`/service-accounts/${row.account.id}/ledger`}
              className="text-sm text-accent underline-offset-4 hover:underline"
            >
              Ledger
            </Link>
            <Link
              to={`/service-accounts/${row.account.id}/statement`}
              className="text-sm text-accent underline-offset-4 hover:underline"
            >
              Statement
            </Link>
          </div>
        ),
      },
    ],
    []
  );

  return (
    <AppShell
      pageTitle="Service Accounts"
      pageDescription="Every service account, its plan and status, and its ledger balance"
      headerActions={
        <Link
          to="/services/suspension"
          className="inline-flex h-9 items-center rounded-lg border border-line-strong bg-surface px-3.5 text-sm font-medium text-content-primary transition-colors hover:bg-canvas"
        >
          Suspension & Reconnection
        </Link>
      }
    >
      <div className="space-y-5">
        <Card>
          <div className="flex flex-wrap items-end gap-3 p-4">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-content-secondary">Search</span>
              <input
                type="search"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setPage(1);
                }}
                placeholder="Name, account number or phone"
                className={`${FIELD_CLASS} w-64`}
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-content-secondary">Status</span>
              <select
                value={status}
                onChange={(event) => {
                  setStatus(event.target.value as ServiceAccountStatus | "");
                  setPage(1);
                }}
                className={`${FIELD_CLASS} w-44`}
              >
                <option value="">All statuses</option>
                {SERVICE_ACCOUNT_STATUSES.map((option) => (
                  <option key={option} value={option}>
                    {SERVICE_ACCOUNT_STATUS_LABELS[option]}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </Card>

        {errorMessage !== null && (
          <ErrorBanner message={errorMessage} onRetry={() => void loadAccounts()} />
        )}

        <Card>
          <DataTable
            columns={columns}
            data={rows}
            getRowId={(row) => row.account.id}
            isLoading={isLoading}
            emptyState={
              <EmptyState
                title="No service accounts match these filters"
                description="Clear the search or status filter, or add a subscriber with a service account."
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
        </Card>
      </div>
    </AppShell>
  );
}
