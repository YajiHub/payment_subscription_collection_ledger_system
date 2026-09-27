import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  SERVICE_TYPES,
  SERVICE_TYPE_LABELS,
  roleHasPermission,
  type ServiceType,
} from "@bcis/shared";
import {
  createPlan,
  extractApiErrorMessage,
  listPlans,
  retirePlan,
  type Plan,
} from "../lib/api-client";
import { formatCentavos } from "../lib/format";
import { useAuthStore } from "../stores/auth.store";
import { AppShell } from "../components/layout/AppShell";
import { DataTable, type TableColumn } from "../components/table/DataTable";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { ErrorBanner } from "../components/ui/ErrorBanner";
import { Modal } from "../components/ui/Modal";

interface PlanFormState {
  name: string;
  serviceType: ServiceType;
  speedMbps: string;
  cablePackageDescription: string;
  monthlyRatePesos: string;
  reconnectionFeePesos: string;
}

const emptyPlanForm: PlanFormState = {
  name: "",
  serviceType: "internet",
  speedMbps: "",
  cablePackageDescription: "",
  monthlyRatePesos: "",
  reconnectionFeePesos: "",
};

/**
 * Converts a peso amount typed by a clerk into integer centavos.
 *
 * The multiplication is rounded immediately so no floating-point value is ever
 * stored: "999.00" → 99900, not 99900.00000000001.
 */
function pesosToCentavos(pesos: string): number {
  return Math.round(Number.parseFloat(pesos) * 100);
}

/** The "Speed / Package" cell: a speed for internet, a channel list for cable. */
function describePlanDetails(plan: Plan): string {
  if (plan.speedMbps !== null) {
    return `${plan.speedMbps} Mbps`;
  }
  return plan.cablePackageDescription ?? "—";
}

/**
 * Plan management.
 *
 * Plans are versioned: the table has no price field to edit. Changing a monthly
 * rate means creating a new plan, so existing subscribers are never re-priced.
 */
export function PlanManagementPage(): ReactNode {
  const user = useAuthStore((state) => state.user);

  const [plans, setPlans] = useState<Plan[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [form, setForm] = useState<PlanFormState>(emptyPlanForm);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const canCreate = user !== null && roleHasPermission(user.role, "plans:create");
  const canUpdate = user !== null && roleHasPermission(user.role, "plans:update");

  const loadPlans = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      // The management screen shows retired plans too, so they stay auditable.
      // `/api/plans` is not paged: it returns the whole (small, deliberate)
      // catalogue, so the table sorts in place and renders no pagination footer.
      const loaded = await listPlans({ includeInactive: true });
      setPlans(loaded);
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPlans();
  }, [loadPlans]);

  function openForm(): void {
    setForm(emptyPlanForm);
    setErrorMessage(null);
    setIsFormOpen(true);
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      await createPlan({
        name: form.name,
        serviceType: form.serviceType,
        speedMbps: form.speedMbps === "" ? undefined : Number.parseInt(form.speedMbps, 10),
        cablePackageDescription:
          form.cablePackageDescription === "" ? undefined : form.cablePackageDescription,
        monthlyRateCentavos: pesosToCentavos(form.monthlyRatePesos),
        reconnectionFeeCentavos:
          form.reconnectionFeePesos === "" ? 0 : pesosToCentavos(form.reconnectionFeePesos),
      });
      setIsFormOpen(false);
      await loadPlans();
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  const handleRetire = useCallback(
    async (plan: Plan): Promise<void> => {
      setErrorMessage(null);
      try {
        await retirePlan(plan.id);
        await loadPlans();
      } catch (error) {
        setErrorMessage(extractApiErrorMessage(error));
      }
    },
    [loadPlans]
  );

  const columns = useMemo<TableColumn<Plan>[]>(
    () => [
      {
        id: "name",
        header: "Plan Name",
        cellClassName: "font-medium text-content-primary",
        sortValue: (plan) => plan.name,
        cell: (plan) => plan.name,
      },
      {
        id: "serviceType",
        header: "Type",
        cellClassName: "text-content-primary",
        sortValue: (plan) => plan.serviceType,
        cell: (plan) => SERVICE_TYPE_LABELS[plan.serviceType],
      },
      {
        id: "details",
        header: "Speed / Package",
        cellClassName: "text-content-secondary",
        sortValue: (plan) => describePlanDetails(plan),
        cell: (plan) => describePlanDetails(plan),
      },
      {
        id: "monthlyRateCentavos",
        header: "Monthly Rate",
        align: "right",
        cellClassName: "tabular-nums",
        sortValue: (plan) => plan.monthlyRateCentavos,
        cell: (plan) => formatCentavos(plan.monthlyRateCentavos),
      },
      {
        id: "reconnectionFeeCentavos",
        header: "Reconnection Fee",
        align: "right",
        cellClassName: "tabular-nums",
        sortValue: (plan) => plan.reconnectionFeeCentavos,
        cell: (plan) => formatCentavos(plan.reconnectionFeeCentavos),
      },
      {
        id: "isActive",
        header: "Status",
        sortValue: (plan) => (plan.isActive ? 1 : 0),
        cell: (plan) => (
          <Badge variant={plan.isActive ? "success" : "neutral"} size="sm" dot>
            {plan.isActive ? "Active" : "Retired"}
          </Badge>
        ),
      },
      {
        id: "actions",
        header: "Actions",
        cell: (plan) =>
          plan.isActive && canUpdate ? (
            <Button variant="link" size="sm" onClick={() => void handleRetire(plan)}>
              Retire
            </Button>
          ) : (
            <span className="text-content-secondary">—</span>
          ),
      },
    ],
    [canUpdate, handleRetire]
  );

  const fieldClass =
    "h-9 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

  return (
    <AppShell
      pageTitle="Subscription Plans"
      pageDescription="A price change means a new plan — existing subscribers keep the plan they signed up for"
      headerActions={
        canCreate ? (
          <Button size="md" onClick={openForm}>
            Add Plan
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-5">
        {errorMessage !== null && <ErrorBanner message={errorMessage} onRetry={() => void loadPlans()} />}

        <Card>
          <DataTable
            columns={columns}
            data={plans}
            getRowId={(plan) => plan.id}
            isLoading={isLoading}
            emptyState={
              <EmptyState
                title="No plans yet"
                description="Create the first subscription plan so subscribers have something to subscribe to."
                actionLabel={canCreate ? "Add Plan" : undefined}
                onAction={canCreate ? openForm : undefined}
              />
            }
          />
        </Card>
      </div>

      <Modal
        isOpen={isFormOpen}
        onClose={() => setIsFormOpen(false)}
        title="Add Plan"
        description="New plans start active; price changes are a new plan, never an edit."
      >
        <form onSubmit={handleCreate} className="space-y-4 p-6">
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-content-secondary">Plan Name</span>
            <input
              type="text"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              required
              autoFocus
              className={fieldClass}
            />
          </label>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-content-secondary">Service Type</span>
            <select
              value={form.serviceType}
              onChange={(event) => setForm({ ...form, serviceType: event.target.value as ServiceType })}
              className={fieldClass}
            >
              {SERVICE_TYPES.map((serviceType) => (
                <option key={serviceType} value={serviceType}>
                  {SERVICE_TYPE_LABELS[serviceType]}
                </option>
              ))}
            </select>
          </label>

          {form.serviceType === "internet" || form.serviceType === "bundle" ? (
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-content-secondary">Speed (Mbps)</span>
              <input
                type="number"
                min={1}
                value={form.speedMbps}
                onChange={(event) => setForm({ ...form, speedMbps: event.target.value })}
                className={fieldClass}
              />
            </label>
          ) : (
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-content-secondary">Package Description</span>
              <input
                type="text"
                value={form.cablePackageDescription}
                onChange={(event) => setForm({ ...form, cablePackageDescription: event.target.value })}
                placeholder="e.g. 40 channels"
                className={fieldClass}
              />
            </label>
          )}

          <div className="grid grid-cols-2 gap-4">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-content-secondary">Monthly Rate (₱)</span>
              <input
                type="number"
                step="0.01"
                min={0}
                value={form.monthlyRatePesos}
                onChange={(event) => setForm({ ...form, monthlyRatePesos: event.target.value })}
                required
                className={fieldClass}
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-content-secondary">Reconnection Fee (₱)</span>
              <input
                type="number"
                step="0.01"
                min={0}
                value={form.reconnectionFeePesos}
                onChange={(event) => setForm({ ...form, reconnectionFeePesos: event.target.value })}
                className={fieldClass}
              />
            </label>
          </div>

          <p className="text-xs text-content-secondary">
            Amounts are stored as whole centavos. ₱999.00 becomes 99900.
          </p>

          <div className="flex justify-end gap-3 pt-1">
            <Button type="button" variant="outline" size="md" onClick={() => setIsFormOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" size="md" isLoading={isSubmitting}>
              Save Plan
            </Button>
          </div>
        </form>
      </Modal>
    </AppShell>
  );
}