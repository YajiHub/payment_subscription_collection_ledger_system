import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { AUDIT_ACTION_LABELS, AUDIT_ENTITY_TYPES, type AuditLogEntry } from "@bcis/shared";
import { extractApiErrorMessage, listAuditLogs } from "../lib/api-client";
import { AppShell } from "../components/layout/AppShell";
import { DataTable, type TableColumn } from "../components/table/DataTable";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { ErrorBanner } from "../components/ui/ErrorBanner";

/** The page size the trail opens with. Server-side paging caps it at 200. */
const DEFAULT_PAGE_SIZE = 25;

const fieldClass =
  "h-9 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

interface AuditFilters {
  action: string;
  entityType: string;
  performedBy: string;
  entityId: string;
}

const emptyFilters: AuditFilters = { action: "", entityType: "", performedBy: "", entityId: "" };

/** A human label for an action, falling back to the raw value. */
function actionLabel(action: string): string {
  return (AUDIT_ACTION_LABELS as Record<string, string>)[action] ?? action;
}

// Sorting runs on the loaded page: the audit endpoint takes no sort parameter.
const AUDIT_COLUMNS: TableColumn<AuditLogEntry>[] = [
  {
    id: "performedAt",
    header: "When",
    cellClassName: "whitespace-nowrap text-content-secondary",
    sortValue: (entry) => entry.performedAt,
    cell: (entry) => new Date(entry.performedAt).toLocaleString(),
  },
  {
    id: "action",
    header: "Action",
    cellClassName: "font-medium text-content-primary",
    sortValue: (entry) => entry.action,
    cell: (entry) => actionLabel(entry.action),
  },
  {
    id: "entityType",
    header: "Entity",
    cellClassName: "text-content-secondary",
    sortValue: (entry) => entry.entityType,
    cell: (entry) => (
      <>
        {entry.entityType}
        <span className="block font-mono text-xs text-content-secondary">{entry.entityId}</span>
      </>
    ),
  },
  {
    id: "description",
    header: "Description",
    cellClassName: "text-content-primary",
    sortValue: (entry) => entry.description,
    cell: (entry) => entry.description,
  },
  {
    id: "performedByUsername",
    header: "By",
    cellClassName: "text-content-secondary",
    sortValue: (entry) => entry.performedByUsername ?? "system",
    cell: (entry) => entry.performedByUsername ?? "system",
  },
  {
    id: "clientIpAddress",
    header: "From",
    cellClassName: "text-content-secondary",
    sortValue: (entry) => entry.clientIpAddress ?? "",
    cell: (entry) => entry.clientIpAddress ?? "—",
  },
];

/**
 * Admin-only audit trail screen.
 * The trail is append-only, so this screen only ever reads.
 */
export function AuditLogPage(): ReactNode {
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [filters, setFilters] = useState<AuditFilters>(emptyFilters);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const loadEntries = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const result = await listAuditLogs({
        page,
        pageSize,
        action: filters.action.trim() === "" ? undefined : filters.action.trim(),
        entityType: filters.entityType.trim() === "" ? undefined : filters.entityType.trim(),
        performedBy: filters.performedBy.trim() === "" ? undefined : filters.performedBy.trim(),
        entityId: filters.entityId.trim() === "" ? undefined : filters.entityId.trim(),
      });
      setEntries(result.items);
      setTotal(result.total);
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  }, [page, pageSize, filters]);

  useEffect(() => {
    void loadEntries();
  }, [loadEntries]);

  function handleFilterSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setPage(1);
    void loadEntries();
  }

  return (
    <AppShell
      pageTitle="Audit Trail"
      pageDescription="Every consequential action, with who did it and when. Entries are never edited or deleted."
      headerActions={
        <Link
          to="/"
          className="inline-flex h-9 items-center rounded-lg border border-line-strong bg-surface px-3.5 text-sm font-medium text-content-primary transition-colors hover:bg-canvas"
        >
          Dashboard
        </Link>
      }
    >
      <div className="space-y-5">
        <Card className="p-4">
          <form className="grid gap-3 sm:grid-cols-5" onSubmit={handleFilterSubmit}>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-content-secondary">Action</span>
              <input
                className={fieldClass}
                value={filters.action}
                onChange={(event) => setFilters({ ...filters, action: event.target.value })}
                placeholder="payment.reversed"
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-content-secondary">Entity type</span>
              <select
                className={fieldClass}
                value={filters.entityType}
                onChange={(event) => setFilters({ ...filters, entityType: event.target.value })}
              >
                <option value="">All</option>
                {AUDIT_ENTITY_TYPES.map((entityType) => (
                  <option key={entityType} value={entityType}>
                    {entityType}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-content-secondary">Entity id</span>
              <input
                className={fieldClass}
                value={filters.entityId}
                onChange={(event) => setFilters({ ...filters, entityId: event.target.value })}
                placeholder="UUID"
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-content-secondary">Performed by (user id)</span>
              <input
                className={fieldClass}
                value={filters.performedBy}
                onChange={(event) => setFilters({ ...filters, performedBy: event.target.value })}
                placeholder="UUID"
              />
            </label>
            <div className="flex items-end gap-2">
              <Button type="submit" variant="secondary" size="md">
                Filter
              </Button>
              <Button
                type="button"
                variant="outline"
                size="md"
                onClick={() => {
                  setFilters(emptyFilters);
                  setPage(1);
                }}
              >
                Clear
              </Button>
            </div>
          </form>
        </Card>

        {errorMessage !== null && (
          <ErrorBanner message={errorMessage} onRetry={() => void loadEntries()} />
        )}

        <Card>
          <DataTable
            columns={AUDIT_COLUMNS}
            data={entries}
            getRowId={(entry) => entry.id}
            isLoading={isLoading}
            emptyState={
              <EmptyState
                title="No audit entries match these filters"
                description="Try clearing the action, entity, or user filters to see the full append-only trail."
                actionLabel="Clear filters"
                onAction={() => {
                  setFilters(emptyFilters);
                  setPage(1);
                }}
              />
            }
            pagination={{
              page,
              pageSize,
              total,
              rowNoun: "entry",
              rowNounPlural: "entries",
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
