import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import {
  SERVICE_TYPES,
  SERVICE_TYPE_LABELS,
  createPlanSchema,
  roleHasPermission,
  type ServiceType,
} from "@bcis/shared";
import {
  createPlan,
  extractApiErrorMessage,
  listPlans,
  retirePlan,
  type CreatePlanInput,
  type Plan,
} from "../lib/api-client";
import { formatCentavos } from "../lib/format";
import { useAuthStore } from "../stores/auth.store";
import { AppShell } from "../components/layout/AppShell";
import { SelectField } from "../components/form/SelectField";
import { TextField } from "../components/form/TextField";
import { formResolver } from "../components/form/form-resolver";
import { DataTable, type TableColumn } from "../components/table/DataTable";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { ErrorBanner } from "../components/ui/ErrorBanner";
import { Modal } from "../components/ui/Modal";

/** The plan form's fields. Money is typed in pesos and converted on the way out. */
type PlanFormValues = {
  name: string;
  serviceType: ServiceType;
  speedMbps: string;
  cablePackageDescription: string;
  monthlyRatePesos: string;
  reconnectionFeePesos: string;
};

const emptyPlanForm: PlanFormValues = {
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

/**
 * Builds the request body for a new plan.
 *
 * This is the one place the form is turned into a payload: the schema below
 * validates exactly this object against the same `createPlanSchema` the server
 * uses, so a body the client accepts is a body the server accepts.
 */
function buildPlanPayload(values: PlanFormValues): CreatePlanInput {
  return {
    name: values.name,
    serviceType: values.serviceType,
    speedMbps: values.speedMbps === "" ? undefined : Number.parseInt(values.speedMbps, 10),
    cablePackageDescription:
      values.cablePackageDescription === "" ? undefined : values.cablePackageDescription,
    monthlyRateCentavos: pesosToCentavos(values.monthlyRatePesos),
    reconnectionFeeCentavos:
      values.reconnectionFeePesos === "" ? 0 : pesosToCentavos(values.reconnectionFeePesos),
  };
}

/** The form field each request field is typed into, so an error lands on the box. */
const FORM_FIELD_FOR_REQUEST_FIELD: Record<string, keyof PlanFormValues> = {
  name: "name",
  serviceType: "serviceType",
  speedMbps: "speedMbps",
  cablePackageDescription: "cablePackageDescription",
  monthlyRateCentavos: "monthlyRatePesos",
  reconnectionFeeCentavos: "reconnectionFeePesos",
};

/**
 * The Add Plan rules.
 *
 * The name and the service type are `createPlanSchema`'s own fields, and the whole
 * request body this form builds is checked against that same schema, so the two
 * sides cannot drift. The peso boxes are text, so they carry one extra rule each:
 * they must hold something a number can be read from.
 */
const planFormSchema = z
  .object({
    name: createPlanSchema.shape.name,
    serviceType: createPlanSchema.shape.serviceType,
    speedMbps: z.string(),
    cablePackageDescription: z.string(),
    monthlyRatePesos: z
      .string()
      .trim()
      .min(1, "Enter the monthly rate")
      .refine((text) => Number.isFinite(Number.parseFloat(text)), "Enter a valid amount"),
    reconnectionFeePesos: z
      .string()
      .trim()
      .refine((text) => text === "" || Number.isFinite(Number.parseFloat(text)), "Enter a valid amount"),
  })
  .superRefine((values, ctx) => {
    const fromServer = createPlanSchema.safeParse(buildPlanPayload(values));
    if (fromServer.success) {
      return;
    }
    // An issue the field rules above already reported keeps its own wording:
    // zodResolver keeps the first message it sees for a field.
    for (const issue of fromServer.error.issues) {
      const field = FORM_FIELD_FOR_REQUEST_FIELD[String(issue.path[0] ?? "")] ?? "name";
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: issue.message });
    }
  });

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

  const canCreate = user !== null && roleHasPermission(user.role, "plans:create");
  const canUpdate = user !== null && roleHasPermission(user.role, "plans:update");

  const {
    register,
    handleSubmit,
    reset,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<PlanFormValues>({
    resolver: formResolver(planFormSchema),
    defaultValues: emptyPlanForm,
  });

  const serviceType = watch("serviceType");

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
    reset(emptyPlanForm);
    setErrorMessage(null);
    setIsFormOpen(true);
  }

  const onSubmit = handleSubmit(async (values) => {
    setErrorMessage(null);

    try {
      await createPlan(buildPlanPayload(values));
      setIsFormOpen(false);
      await loadPlans();
    } catch (error) {
      // A duplicate plan name is the server's answer to a valid-looking form.
      setErrorMessage(extractApiErrorMessage(error));
    }
  });

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
        <form
          noValidate
          onSubmit={(event) => void onSubmit(event)}
          className="space-y-4 p-6"
        >
          <TextField
            id="planName"
            label="Plan Name"
            required
            autoFocus
            error={errors.name?.message}
            {...register("name")}
          />

          <SelectField
            id="planServiceType"
            label="Service Type"
            error={errors.serviceType?.message}
            {...register("serviceType")}
          >
            {SERVICE_TYPES.map((serviceTypeOption) => (
              <option key={serviceTypeOption} value={serviceTypeOption}>
                {SERVICE_TYPE_LABELS[serviceTypeOption]}
              </option>
            ))}
          </SelectField>

          {serviceType === "internet" || serviceType === "bundle" ? (
            <TextField
              id="planSpeedMbps"
              label="Speed (Mbps)"
              type="number"
              min={1}
              error={errors.speedMbps?.message}
              {...register("speedMbps")}
            />
          ) : (
            <TextField
              id="planPackageDescription"
              label="Package Description"
              placeholder="e.g. 40 channels"
              error={errors.cablePackageDescription?.message}
              {...register("cablePackageDescription")}
            />
          )}

          <div className="grid grid-cols-2 gap-4">
            <TextField
              id="planMonthlyRate"
              label="Monthly Rate (₱)"
              type="number"
              step="0.01"
              min={0}
              required
              error={errors.monthlyRatePesos?.message}
              {...register("monthlyRatePesos")}
            />
            <TextField
              id="planReconnectionFee"
              label="Reconnection Fee (₱)"
              type="number"
              step="0.01"
              min={0}
              error={errors.reconnectionFeePesos?.message}
              {...register("reconnectionFeePesos")}
            />
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
