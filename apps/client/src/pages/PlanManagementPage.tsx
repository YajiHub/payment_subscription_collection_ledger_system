import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

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

  async function handleRetire(plan: Plan): Promise<void> {
    setErrorMessage(null);
    try {
      await retirePlan(plan.id);
      await loadPlans();
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    }
  }

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-8">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Plans</h1>
          <p className="text-sm text-slate-600">
            A price change means a new plan — existing subscribers keep the plan they signed up for.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link to="/" className="text-sm font-medium text-slate-700 underline">
            Dashboard
          </Link>
          {canCreate && (
            <button
              type="button"
              onClick={openForm}
              className="rounded bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
            >
              Add Plan
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

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="px-4 py-3 font-medium">Plan Name</th>
              <th className="px-4 py-3 font-medium">Type</th>
              <th className="px-4 py-3 font-medium">Speed / Package</th>
              <th className="px-4 py-3 font-medium">Monthly Rate</th>
              <th className="px-4 py-3 font-medium">Reconnection Fee</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-slate-500">
                  Loading plans…
                </td>
              </tr>
            ) : plans.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-slate-500">
                  No plans yet.
                </td>
              </tr>
            ) : (
              plans.map((plan) => (
                <tr key={plan.id} className="border-t border-slate-100">
                  <td className="px-4 py-3">{plan.name}</td>
                  <td className="px-4 py-3">{SERVICE_TYPE_LABELS[plan.serviceType]}</td>
                  <td className="px-4 py-3">{describePlanDetails(plan)}</td>
                  <td className="px-4 py-3 font-mono">
                    {formatCentavos(plan.monthlyRateCentavos)}
                  </td>
                  <td className="px-4 py-3 font-mono">
                    {formatCentavos(plan.reconnectionFeeCentavos)}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={
                        plan.isActive
                          ? "rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700"
                          : "rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600"
                      }
                    >
                      {plan.isActive ? "Active" : "Retired"}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {plan.isActive && canUpdate ? (
                      <button
                        type="button"
                        onClick={() => void handleRetire(plan)}
                        className="text-red-700 underline"
                      >
                        Retire
                      </button>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {isFormOpen && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/40 p-4">
          <form
            onSubmit={handleCreate}
            className="w-full max-w-md space-y-4 rounded-lg bg-white p-6 shadow-lg"
          >
            <h2 className="text-lg font-semibold">Add Plan</h2>

            <label className="block space-y-1">
              <span className="text-sm font-medium text-slate-700">Plan Name</span>
              <input
                type="text"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                required
                className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
              />
            </label>

            <label className="block space-y-1">
              <span className="text-sm font-medium text-slate-700">Service Type</span>
              <select
                value={form.serviceType}
                onChange={(event) =>
                  setForm({ ...form, serviceType: event.target.value as ServiceType })
                }
                className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
              >
                {SERVICE_TYPES.map((serviceType) => (
                  <option key={serviceType} value={serviceType}>
                    {SERVICE_TYPE_LABELS[serviceType]}
                  </option>
                ))}
              </select>
            </label>

            {form.serviceType === "internet" || form.serviceType === "bundle" ? (
              <label className="block space-y-1">
                <span className="text-sm font-medium text-slate-700">Speed (Mbps)</span>
                <input
                  type="number"
                  min={1}
                  value={form.speedMbps}
                  onChange={(event) => setForm({ ...form, speedMbps: event.target.value })}
                  className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
                />
              </label>
            ) : (
              <label className="block space-y-1">
                <span className="text-sm font-medium text-slate-700">Package Description</span>
                <input
                  type="text"
                  value={form.cablePackageDescription}
                  onChange={(event) =>
                    setForm({ ...form, cablePackageDescription: event.target.value })
                  }
                  placeholder="e.g. 40 channels"
                  className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
                />
              </label>
            )}

            <div className="grid grid-cols-2 gap-4">
              <label className="block space-y-1">
                <span className="text-sm font-medium text-slate-700">Monthly Rate (₱)</span>
                <input
                  type="number"
                  step="0.01"
                  min={0}
                  value={form.monthlyRatePesos}
                  onChange={(event) => setForm({ ...form, monthlyRatePesos: event.target.value })}
                  required
                  className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
                />
              </label>
              <label className="block space-y-1">
                <span className="text-sm font-medium text-slate-700">Reconnection Fee (₱)</span>
                <input
                  type="number"
                  step="0.01"
                  min={0}
                  value={form.reconnectionFeePesos}
                  onChange={(event) =>
                    setForm({ ...form, reconnectionFeePesos: event.target.value })
                  }
                  className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
                />
              </label>
            </div>

            <p className="text-xs text-slate-500">
              Amounts are stored as whole centavos. ₱999.00 becomes 99900.
            </p>

            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setIsFormOpen(false)}
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
