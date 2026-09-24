import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { AUDIT_ACTION_LABELS, AUDIT_ENTITY_TYPES, type AuditLogEntry } from "@bcis/shared";
import { extractApiErrorMessage, listAuditLogs } from "../lib/api-client";

const PAGE_SIZE = 25;

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

/**
 * Admin-only audit trail screen.
 * The trail is append-only, so this screen only ever reads.
 */
export function AuditLogPage(): ReactNode {
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<AuditFilters>(emptyFilters);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const loadEntries = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const result = await listAuditLogs({
        page,
        pageSize: PAGE_SIZE,
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
  }, [page, filters]);

  useEffect(() => {
    void loadEntries();
  }, [loadEntries]);

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <main className="mx-auto max-w-6xl space-y-6 p-8">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Audit Trail</h1>
          <p className="text-sm text-slate-600">
            Every consequential action, with who did it and when. Entries are never edited or
            deleted.
          </p>
        </div>
        <Link to="/" className="text-sm font-medium text-slate-700 underline">
          Dashboard
        </Link>
      </header>

      <form
        className="grid gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm sm:grid-cols-5"
        onSubmit={(event) => {
          event.preventDefault();
          setPage(1);
          void loadEntries();
        }}
      >
        <label className="space-y-1 text-sm">
          <span className="block font-medium text-slate-700">Action</span>
          <input
            className="w-full rounded border border-slate-300 px-2 py-1"
            value={filters.action}
            onChange={(event) => setFilters({ ...filters, action: event.target.value })}
            placeholder="payment.reversed"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="block font-medium text-slate-700">Entity type</span>
          <select
            className="w-full rounded border border-slate-300 px-2 py-1"
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
        <label className="space-y-1 text-sm">
          <span className="block font-medium text-slate-700">Entity id</span>
          <input
            className="w-full rounded border border-slate-300 px-2 py-1"
            value={filters.entityId}
            onChange={(event) => setFilters({ ...filters, entityId: event.target.value })}
            placeholder="UUID"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="block font-medium text-slate-700">Performed by (user id)</span>
          <input
            className="w-full rounded border border-slate-300 px-2 py-1"
            value={filters.performedBy}
            onChange={(event) => setFilters({ ...filters, performedBy: event.target.value })}
            placeholder="UUID"
          />
        </label>
        <div className="flex items-end gap-2">
          <button
            type="submit"
            className="rounded bg-slate-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700"
          >
            Filter
          </button>
          <button
            type="button"
            className="rounded border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700"
            onClick={() => {
              setFilters(emptyFilters);
              setPage(1);
            }}
          >
            Clear
          </button>
        </div>
      </form>

      {errorMessage !== null && (
        <p className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {errorMessage}
        </p>
      )}

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="px-4 py-2">When</th>
              <th className="px-4 py-2">Action</th>
              <th className="px-4 py-2">Entity</th>
              <th className="px-4 py-2">Description</th>
              <th className="px-4 py-2">By</th>
              <th className="px-4 py-2">From</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td className="px-4 py-6 text-slate-500" colSpan={6}>
                  Loading audit entries…
                </td>
              </tr>
            ) : entries.length === 0 ? (
              <tr>
                <td className="px-4 py-6 text-slate-500" colSpan={6}>
                  No audit entries match the filters.
                </td>
              </tr>
            ) : (
              entries.map((entry) => (
                <tr key={entry.id} className="border-t border-slate-100 align-top">
                  <td className="whitespace-nowrap px-4 py-2 text-slate-600">
                    {new Date(entry.performedAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-2 font-medium">{actionLabel(entry.action)}</td>
                  <td className="px-4 py-2 text-slate-600">
                    {entry.entityType}
                    <span className="block font-mono text-xs text-slate-400">{entry.entityId}</span>
                  </td>
                  <td className="px-4 py-2">{entry.description}</td>
                  <td className="px-4 py-2 text-slate-600">
                    {entry.performedByUsername ?? "system"}
                  </td>
                  <td className="px-4 py-2 text-slate-600">{entry.clientIpAddress ?? "—"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-sm text-slate-600">
        <span>
          {total} entr{total === 1 ? "y" : "ies"}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded border border-slate-300 px-3 py-1 disabled:opacity-40"
            disabled={page <= 1}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
          >
            Previous
          </button>
          <span>
            Page {page} of {lastPage}
          </span>
          <button
            type="button"
            className="rounded border border-slate-300 px-3 py-1 disabled:opacity-40"
            disabled={page >= lastPage}
            onClick={() => setPage((current) => current + 1)}
          >
            Next
          </button>
        </div>
      </div>
    </main>
  );
}
