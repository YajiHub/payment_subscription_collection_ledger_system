import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useForm, type FieldPath } from "react-hook-form";
import { z } from "zod";

import {
  SERVICE_TYPE_LABELS,
  createServiceAccountSchema,
  createSubscriberWithServiceAccountSchema,
} from "@bcis/shared";
import {
  createSubscriber,
  extractApiErrorMessage,
  listPlans,
  type CreateSubscriberInput,
  type Plan,
} from "../lib/api-client";
import { formatCentavos } from "../lib/format";
import { AppShell } from "../components/layout/AppShell";
import { SelectField } from "../components/form/SelectField";
import { TextField } from "../components/form/TextField";
import { TextareaField } from "../components/form/TextareaField";
import { blankToUndefined } from "../components/form/form-values";
import { formResolver } from "../components/form/form-resolver";
import { Button } from "../components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/Card";
import { ErrorBanner } from "../components/ui/ErrorBanner";
import { Skeleton } from "../components/ui/Skeleton";

/**
 * The Add Subscriber rules.
 *
 * This *is* the schema the server validates the request body with —
 * `createSubscriberWithServiceAccountSchema` — with one override. The plan picker
 * is a hand-filled control, so leaving it blank deserves a sentence a clerk can
 * act on rather than Zod's default "Invalid uuid". No rule is relaxed or added;
 * only the wording of that one message changes.
 */
const addSubscriberFormSchema = createSubscriberWithServiceAccountSchema.extend({
  serviceAccount: createServiceAccountSchema.extend({
    planId: z.string().uuid("Choose a service plan — a subscriber needs at least one service."),
  }),
});

type AddSubscriberFormValues = z.input<typeof addSubscriberFormSchema>;

const emptySubscriberForm = {
  firstName: "",
  lastName: "",
  middleName: undefined,
  primaryPhone: "",
  secondaryPhone: undefined,
  emailAddress: undefined,
  serviceAddress: "",
  serviceBarangay: "",
  serviceMunicipality: "",
  serviceProvince: "",
  internalNotes: undefined,
  serviceAccount: { planId: "", activationDate: undefined },
} satisfies AddSubscriberFormValues;

/** The fields step 1 owns. Step 2 judges the service picker. */
const HOUSEHOLD_FIELDS: readonly FieldPath<AddSubscriberFormValues>[] = [
  "firstName",
  "lastName",
  "middleName",
  "primaryPhone",
  "secondaryPhone",
  "emailAddress",
  "serviceAddress",
  "serviceBarangay",
  "serviceMunicipality",
  "serviceProvince",
  "internalNotes",
];

/**
 * Maps the validated form onto the request body.
 *
 * The optional keys arrive as `undefined` when the clerk left them blank, which is
 * exactly what the screen did before: an absent key in the JSON body.
 */
function buildSubscriberPayload(values: AddSubscriberFormValues): CreateSubscriberInput {
  return {
    firstName: values.firstName,
    lastName: values.lastName,
    middleName: values.middleName,
    primaryPhone: values.primaryPhone,
    secondaryPhone: values.secondaryPhone,
    emailAddress: values.emailAddress,
    serviceAddress: values.serviceAddress,
    serviceBarangay: values.serviceBarangay,
    serviceMunicipality: values.serviceMunicipality,
    serviceProvince: values.serviceProvince,
    internalNotes: values.internalNotes,
    serviceAccount: {
      planId: values.serviceAccount.planId,
      activationDate: values.serviceAccount.activationDate,
    },
  };
}

/**
 * Two-step Add Subscriber form.
 *
 * Step 1 captures the household, step 2 its first service. The form cannot be
 * saved without a plan: a subscriber with no service has nothing to bill, so the
 * screen refuses to create a half-finished record.
 */
export function AddSubscriberPage(): ReactNode {
  const navigate = useNavigate();

  const [step, setStep] = useState<1 | 2>(1);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [isPlansLoading, setIsPlansLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    trigger,
    getFieldState,
    setFocus,
    formState: { errors, isSubmitting },
  } = useForm<AddSubscriberFormValues>({
    resolver: formResolver(addSubscriberFormSchema),
    defaultValues: emptySubscriberForm,
  });

  const loadPlans = useCallback(async (): Promise<void> => {
    setIsPlansLoading(true);
    try {
      const activePlans = await listPlans();
      setPlans(activePlans);
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsPlansLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPlans();
  }, [loadPlans]);

  const saveSubscriber = handleSubmit(async (values) => {
    try {
      const created = await createSubscriber(buildSubscriberPayload(values));
      navigate(`/subscribers/${created.id}`, { replace: true });
    } catch (error) {
      // The server is the authority: a duplicate phone number or a retired plan
      // is not something the client could have predicted, so it stays a banner.
      setErrorMessage(extractApiErrorMessage(error));
    }
  });

  /**
   * One form, two steps: "Next" judges only the household fields, "Save" judges
   * both, so a clerk is never told about the service picker while still typing a
   * phone number.
   */
  async function handleFormSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setErrorMessage(null);

    if (step === 1) {
      if (await trigger([...HOUSEHOLD_FIELDS])) {
        setStep(2);
        return;
      }

      // `trigger` reports the errors but does not move focus the way a failed
      // submit does, so the first field still wrong is focused here — the same
      // thing the browser would do with its own bubble.
      const firstInvalidField = HOUSEHOLD_FIELDS.find((field) => getFieldState(field).invalid);
      if (firstInvalidField !== undefined) {
        setFocus(firstInvalidField);
      }
      return;
    }

    await saveSubscriber();
  }

  return (
    <AppShell
      pageTitle="Add Subscriber"
      pageDescription={`Step ${step} of 2 — ${step === 1 ? "subscriber details" : "first service account"}`}
      headerActions={
        <Link
          to="/subscribers"
          className="inline-flex h-9 items-center rounded-lg border border-line-strong bg-surface px-3.5 text-sm font-medium text-content-primary transition-colors hover:bg-canvas"
        >
          Back to list
        </Link>
      }
    >
      <form
        noValidate
        onSubmit={(event) => void handleFormSubmit(event)}
        className="max-w-3xl space-y-6"
      >
        {errorMessage !== null && (
          <ErrorBanner message={errorMessage} onRetry={() => void loadPlans()} />
        )}

        {step === 1 && (
          <Card>
            <CardContent>
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <TextField
                    id="firstName"
                    label="First Name"
                    required
                    autoComplete="given-name"
                    error={errors.firstName?.message}
                    {...register("firstName")}
                  />
                  <TextField
                    id="lastName"
                    label="Last Name"
                    required
                    autoComplete="family-name"
                    error={errors.lastName?.message}
                    {...register("lastName")}
                  />
                </div>

                <TextField
                  id="middleName"
                  label="Middle Name (optional)"
                  error={errors.middleName?.message}
                  {...register("middleName", { setValueAs: blankToUndefined })}
                />

                <div className="grid grid-cols-2 gap-4">
                  <TextField
                    id="primaryPhone"
                    label="Primary Phone"
                    type="tel"
                    required
                    error={errors.primaryPhone?.message}
                    {...register("primaryPhone")}
                  />
                  <TextField
                    id="secondaryPhone"
                    label="Secondary Phone (optional)"
                    type="tel"
                    error={errors.secondaryPhone?.message}
                    {...register("secondaryPhone", { setValueAs: blankToUndefined })}
                  />
                </div>

                <TextField
                  id="emailAddress"
                  label="Email (optional)"
                  type="email"
                  error={errors.emailAddress?.message}
                  {...register("emailAddress", { setValueAs: blankToUndefined })}
                />

                <TextField
                  id="serviceAddress"
                  label="Service Address"
                  required
                  error={errors.serviceAddress?.message}
                  {...register("serviceAddress")}
                />

                <div className="grid grid-cols-3 gap-4">
                  <TextField
                    id="serviceBarangay"
                    label="Barangay"
                    required
                    error={errors.serviceBarangay?.message}
                    {...register("serviceBarangay")}
                  />
                  <TextField
                    id="serviceMunicipality"
                    label="Municipality"
                    required
                    error={errors.serviceMunicipality?.message}
                    {...register("serviceMunicipality")}
                  />
                  <TextField
                    id="serviceProvince"
                    label="Province"
                    required
                    error={errors.serviceProvince?.message}
                    {...register("serviceProvince")}
                  />
                </div>

                <TextareaField
                  id="internalNotes"
                  label="Internal Notes (optional)"
                  rows={3}
                  error={errors.internalNotes?.message}
                  {...register("internalNotes", { setValueAs: blankToUndefined })}
                />
              </div>

              <div className="flex justify-end pt-4">
                <Button type="submit" variant="secondary" size="md">
                  Next: Service Account
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {step === 2 && (
          <Card>
            <CardHeader>
              <CardTitle>First Service Account</CardTitle>
              <CardDescription>
                A subscriber needs at least one service before they can be billed.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {isPlansLoading ? (
                <div className="space-y-3">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-9 w-full" />
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-9 w-full" />
                </div>
              ) : (
                <>
                  <SelectField
                    id="servicePlan"
                    label="Service Plan"
                    required
                    className="tabular-nums"
                    error={errors.serviceAccount?.planId?.message}
                    {...register("serviceAccount.planId")}
                  >
                    <option value="">Select a plan…</option>
                    {plans.map((plan) => (
                      <option key={plan.id} value={plan.id}>
                        {plan.name} — {SERVICE_TYPE_LABELS[plan.serviceType]} —{" "}
                        {formatCentavos(plan.monthlyRateCentavos)}/month
                      </option>
                    ))}
                  </SelectField>

                  <TextField
                    id="activationDate"
                    label="Activation Date (leave blank if installation is pending)"
                    type="date"
                    hint="With a date the account starts as Active. Without one it stays Pending until service begins."
                    error={errors.serviceAccount?.activationDate?.message}
                    {...register("serviceAccount.activationDate", { setValueAs: blankToUndefined })}
                  />
                </>
              )}

              <div className="flex justify-between">
                <Button type="button" variant="outline" size="md" onClick={() => setStep(1)}>
                  Back
                </Button>
                <Button type="submit" size="md" isLoading={isSubmitting}>
                  Save Subscriber
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </form>
    </AppShell>
  );
}
