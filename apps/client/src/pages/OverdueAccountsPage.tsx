import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { CheckCircle2 } from "lucide-react";

import {
  SERVICE_TYPES,
  SERVICE_TYPE_LABELS,
  roleHasPermission,
  type ServiceType,
} from "@bcis/shared";
import {
  extractApiErrorMessage,
  getOverdueAccounts,
  listAssignableCollectors,
  listPlans,
  suspendOverdueAccounts,
  type OverdueAccount,
  type OverdueAccountFilters,
} from "../lib/api-client";
import { formatCentavos, formatDateOnly } from "../lib/format";
import { useAuthStore } from "../stores/auth.store";
import { AppShell } from "../components/layout/AppShell";
import { DataTable, type TableColumn } from "../components/table/DataTable";
import { Button } from "../components/ui/Button";
import { Card, CardContent } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { ErrorBanner } from "../components/ui/ErrorBanner";

const FIELD_CLASS =
  "h-9 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

/** A whole-number filter value, or undefined when the box is empty or not a number. */
function optionalWholeNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === "") {
    return undefined;
  }
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/** Non-empty text, or undefined: an unfilled filter is omitted, never sent blank. */
function optionalText(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Overdue service accounts, with the filters the endpoint honours (S4-5, S6-2).
 *
 * Every control below is read by `/api/receivables/overdue`: the collector, area,
 * plan and service-type account filters, the no-payment-in-N-days and consecutive
 * months thresholds, and the delinquency age. Nothing is rendered that the query
 * ignores, and nothing it accepts is omitted. The list also carries the area and
 * the oldest unpaid invoice the audit found missing.
 */
export function OverdueAccountsPage(): ReactNode {
  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);

  const [accounts, setAccounts] = useState<OverdueAccount[]>([]);
  const [noPaymentInDays, setNoPaymentInDays] = useState("");
  const [minMonths, setMinMonths] = useState("");
  const [minOverdueDays, setMinOverdueDays] = useState("");
  const [collectorId, setCollectorId] = useState("");
  const [areaId, setAreaId] = useState("");
  const [planId, setPlanId] = useState("");
  const [serviceType, setServiceType] = useState<ServiceType | "">("");
  const [collectors, setCollectors] = useState<{ id: string; fullName: string }[]>([]);
  const [plans, setPlans] = useState<{ id: string; name: string }[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  /** The query the screen sends. Only filled controls become parameters. */
  const filters = useMemo<OverdueAccountFilters>(
    () => ({
      noPaymentInDays: optionalWholeNumber(noPaymentInDays),
      minConsecutiveOverdueMonths: optionalWholeNumber(minMonths),
      minOverdueDays: optionalWholeNumber(minOverdueDays),
      collectorId: optionalText(collectorId),
      areaId: optionalText(areaId),
      planId: optionalText(planId),
      serviceType: serviceType === "" ? undefined : serviceType,
    }),
    [noPaymentInDays, minMonths, minOverdueDays, collectorId, areaId, planId, serviceType]
  );

  const loadAccounts = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      // `/api/receivables/overdue` is not paged: it returns the bounded overdue
      // set for the current filters, so the table sorts in place and renders no
      // pagination footer.
      const result = await getOverdueAccounts(filters);
      setAccounts(result.items);
      setSelectedIds([]);
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);

  // The collector and plan pickers are best effort: a role that cannot read them
  // types the id instead, so a filter the endpoint honours is never unreachable.
  useEffect(() => {
    async function loadFilterOptions(): Promise<void> {
      try {
        const assignable = await listAssignableCollectors();
        setCollectors(assignable.map((c) => ({ id: c.id, fullName: c.fullName })));
      } catch {
        setCollectors([]);
      }
      try {
        const loadedPlans = await listPlans();
        setPlans(loadedPlans.map((plan) => ({ id: plan.id, name: plan.name })));
      } catch {
        setPlans([]);
      }
    }
    void loadFilterOptions();
  }, []);

  const canSuspend = user !== null && roleHasPermission(user.role, "subscribers:suspend");

  const toggle = useCallback((serviceAccountId: string): void => {
    setSelectedIds((current) =>
      current.includes(serviceAccountId)
        ? current.filter((id) => id !== serviceAccountId)
        : [...current, serviceAccountId]
    );
  }, []);

  const columns = useMemo<TableColumn<OverdueAccount>[]>(() => {
    const selectedColumn: TableColumn<OverdueAccount> = {
      id: "selected",
      header: " ",
      cell: (account) => (
        <input
          type="checkbox"
          checked={selectedIds.includes(account.serviceAccountId)}
          onChange={() => toggle(account.serviceAccountId)}
          aria-label={`Select ${account.serviceAccountNumber}`}
        />
      ),
    };

    return [
      ...(canSuspend ? [selectedColumn] : []),
      {
        id: "serviceAccountNumber",
        header: "Account #",
        cellClassName: "font-mono text-xs text-content-secondary",
        sortValue: (account) => account.serviceAccountNumber,
        cell: (account) => account.serviceAccountNumber,
      },
      {
        id: "subscriberName",
        header: "Subscriber",
        cellClassName: "text-content-primary",
        sortValue: (account) => account.subscriberName,
        cell: (account) => account.subscriberName,
      },
      {
        id: "planName",
        header: "Plan",
        cellClassName: "text-content-primary",
        sortValue: (account) => account.planName,
        cell: (account) => account.planName,
      },
      {
        id: "areaName",
        header: "Area",
        cellClassName: "text-content-secondary",
        sortValue: (account) => account.areaName ?? "",
        cell: (account) => account.areaName ?? "—",
      },
      {
        id: "consecutiveOverdueMonths",
        header: "Overdue Months",
        cellClassName: "text-content-secondary",
        sortValue: (account) => account.consecutiveOverdueMonths,
        cell: (account) => account.consecutiveOverdueMonths,
      },
      {
        id: "oldestUnpaidInvoiceNumber",
        header: "Oldest Unpaid",
        cellClassName: "font-mono text-xs text-content-secondary",
        sortValue: (account) => account.oldestUnpaidDueDate ?? "",
        cell: (account) =>
          account.oldestUnpaidInvoiceNumber === null ? (
            "—"
          ) : (
            <span>
              {account.oldestUnpaidInvoiceNumber}
              <span className="block text-content-secondary">
                {formatDateOnly(account.oldestUnpaidDueDate)}
              </span>
            </span>
          ),
      },
      {
        id: "totalOverdueCentavos",
        header: "Total Overdue",
        align: "right",
        cellClassName: "font-medium tabular-nums text-danger-strong",
        sortValue: (account) => account.totalOverdueCentavos,
        cell: (account) => formatCentavos(account.totalOverdueCentavos),
      },
      {
        id: "collectorName",
        header: "Collector",
        cellClassName: "text-content-primary",
        sortValue: (account) => account.collectorName ?? "Office",
        cell: (account) => account.collectorName ?? "Office",
      },
      {
        id: "lastPaymentDate",
        header: "Last Payment",
        cellClassName: "text-content-secondary",
        sortValue: (account) => account.lastPaymentDate ?? "",
        cell: (account) => formatDateOnly(account.lastPaymentDate),
      },
    ];
  }, [canSuspend, selectedIds, toggle]);

  async function handleSuspendSelected(): Promise<void> {
    if (selectedIds.length === 0) {
      return;
    }
    const reason = window.prompt("Reason for suspending the selected accounts?");
    if (reason === null || reason.trim().length < 5) {
      setErrorMessage("A suspension reason of at least 5 characters is required.");
      return;
    }

    setErrorMessage(null);
    setStatusMessage(null);
    try {
      const result = await suspendOverdueAccounts(selectedIds, reason.trim());
      setStatusMessage(
        `Suspended ${result.suspended.length} account(s).` +
          (result.failed.length > 0 ? ` ${result.failed.length} could not be suspended.` : "")
      );
      await loadAccounts();
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    }
  }

  return (
    <AppShell
      pageTitle="Overdue Accounts"
      pageDescription="Service accounts behind on payment, with bulk suspension of the selected ones"
      headerActions={
        <Link
          to="/receivables/aging"
          className="inline-flex h-9 items-center rounded-lg border border-line-strong bg-surface px-3.5 text-sm font-medium text-content-primary transition-colors hover:bg-canvas"
        >
          AR aging report
        </Link>
      }
    >
      <div className="space-y-5">
        <Card>
          <CardContent className="flex flex-wrap items-end gap-3">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-content-secondary">No payment in (days)</span>
              <input
                type="number"
                min={0}
                value={noPaymentInDays}
                onChange={(event) => setNoPaymentInDays(event.target.value)}
                placeholder="e.g. 60"
                className={`${FIELD_CLASS} w-32`}
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-content-secondary">
                Consecutive overdue months ≥
              </span>
              <input
                type="number"
                min={0}
                value={minMonths}
                onChange={(event) => setMinMonths(event.target.value)}
                placeholder="e.g. 3"
                className={`${FIELD_CLASS} w-32`}
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-content-secondary">
                Delinquency age ≥ (days)
              </span>
              <input
                type="number"
                min={0}
                value={minOverdueDays}
                onChange={(event) => setMinOverdueDays(event.target.value)}
                placeholder="e.g. 90"
                className={`${FIELD_CLASS} w-32`}
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-content-secondary">Collector</span>
              {collectors.length > 0 ? (
                <select
                  value={collectorId}
                  onChange={(event) => setCollectorId(event.target.value)}
                  className={`${FIELD_CLASS} w-52`}
                >
                  <option value="">All collectors</option>
                  {collectors.map((collector) => (
                    <option key={collector.id} value={collector.id}>
                      {collector.fullName}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={collectorId}
                  onChange={(event) => setCollectorId(event.target.value)}
                  placeholder="Paste the collector id"
                  className={`${FIELD_CLASS} w-52`}
                />
              )}
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-content-secondary">Area id</span>
              <input
                type="text"
                value={areaId}
                onChange={(event) => setAreaId(event.target.value)}
                placeholder="Paste the collection area id"
                className={`${FIELD_CLASS} w-52`}
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-content-secondary">Plan</span>
              {plans.length > 0 ? (
                <select
                  value={planId}
                  onChange={(event) => setPlanId(event.target.value)}
                  className={`${FIELD_CLASS} w-52`}
                >
                  <option value="">All plans</option>
                  {plans.map((plan) => (
                    <option key={plan.id} value={plan.id}>
                      {plan.name}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={planId}
                  onChange={(event) => setPlanId(event.target.value)}
                  placeholder="Paste the plan id"
                  className={`${FIELD_CLASS} w-52`}
                />
              )}
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-content-secondary">Service type</span>
              <select
                value={serviceType}
                onChange={(event) => setServiceType(event.target.value as ServiceType | "")}
                className={`${FIELD_CLASS} w-40`}
              >
                <option value="">All service types</option>
                {SERVICE_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {SERVICE_TYPE_LABELS[type]}
                  </option>
                ))}
              </select>
            </label>
            {canSuspend && (
              <Button
                type="button"
                variant="danger"
                onClick={() => void handleSuspendSelected()}
                disabled={selectedIds.length === 0}
              >
                Suspend Selected ({selectedIds.length})
              </Button>
            )}
          </CardContent>
        </Card>

        {errorMessage !== null && (
          <ErrorBanner message={errorMessage} onRetry={() => void loadAccounts()} />
        )}
        {statusMessage !== null && (
          <div className="flex items-center gap-2.5 rounded-xl border border-success-line bg-success-soft px-4 py-3">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-success-strong" />
            <p className="text-sm text-success-strong">{statusMessage}</p>
          </div>
        )}

        <Card>
          <DataTable
            columns={columns}
            data={accounts}
            getRowId={(account) => account.serviceAccountId}
            isLoading={isLoading}
            emptyState={
              <EmptyState
                title="No overdue accounts match these filters"
                description="Widen the filters by lowering the days or months threshold, or review the AR aging report to spot where balances sit."
                actionLabel="AR aging report"
                onAction={() => navigate("/receivables/aging")}
              />
            }
          />
        </Card>
      </div>
    </AppShell>
  );
}
