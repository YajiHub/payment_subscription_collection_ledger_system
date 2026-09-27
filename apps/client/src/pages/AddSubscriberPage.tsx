import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { SERVICE_TYPE_LABELS } from "@bcis/shared";
import {
  createSubscriber,
  extractApiErrorMessage,
  listPlans,
  type Plan,
} from "../lib/api-client";
import { formatCentavos } from "../lib/format";
import { AppShell } from "../components/layout/AppShell";
import { Button } from "../components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/Card";
import { ErrorBanner } from "../components/ui/ErrorBanner";
import { Skeleton } from "../components/ui/Skeleton";

interface SubscriberFormState {
  firstName: string;
  lastName: string;
  middleName: string;
  primaryPhone: string;
  secondaryPhone: string;
  emailAddress: string;
  serviceAddress: string;
  serviceBarangay: string;
  serviceMunicipality: string;
  serviceProvince: string;
  internalNotes: string;
}

const emptySubscriberForm: SubscriberFormState = {
  firstName: "",
  lastName: "",
  middleName: "",
  primaryPhone: "",
  secondaryPhone: "",
  emailAddress: "",
  serviceAddress: "",
  serviceBarangay: "",
  serviceMunicipality: "",
  serviceProvince: "",
  internalNotes: "",
};

const fieldClass =
  "h-9 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

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
  const [form, setForm] = useState<SubscriberFormState>(emptySubscriberForm);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [isPlansLoading, setIsPlansLoading] = useState(true);
  const [selectedPlanId, setSelectedPlanId] = useState("");
  const [activationDate, setActivationDate] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

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

  function updateForm(field: keyof SubscriberFormState, value: string): void {
    setForm({ ...form, [field]: value });
  }

  function goToServiceStep(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setErrorMessage(null);
    setStep(2);
  }

  async function handleSave(): Promise<void> {
    setErrorMessage(null);

    if (selectedPlanId === "") {
      setErrorMessage("Choose a service plan — a subscriber needs at least one service.");
      return;
    }

    setIsSubmitting(true);
    try {
      const created = await createSubscriber({
        firstName: form.firstName,
        lastName: form.lastName,
        middleName: form.middleName === "" ? undefined : form.middleName,
        primaryPhone: form.primaryPhone,
        secondaryPhone: form.secondaryPhone === "" ? undefined : form.secondaryPhone,
        emailAddress: form.emailAddress === "" ? undefined : form.emailAddress,
        serviceAddress: form.serviceAddress,
        serviceBarangay: form.serviceBarangay,
        serviceMunicipality: form.serviceMunicipality,
        serviceProvince: form.serviceProvince,
        internalNotes: form.internalNotes === "" ? undefined : form.internalNotes,
        serviceAccount: {
          planId: selectedPlanId,
          activationDate: activationDate === "" ? undefined : activationDate,
        },
      });

      navigate(`/subscribers/${created.id}`, { replace: true });
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
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
      <div className="max-w-2xl space-y-5">
        {errorMessage !== null && (
          <ErrorBanner message={errorMessage} onRetry={() => void loadPlans()} />
        )}

        {step === 1 && (
          <Card>
            <CardContent>
              <form onSubmit={goToServiceStep} className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <label className="block space-y-1.5">
                    <span className="text-xs font-medium text-content-secondary">First Name</span>
                    <input
                      type="text"
                      value={form.firstName}
                      onChange={(event) => updateForm("firstName", event.target.value)}
                      required
                      className={fieldClass}
                    />
                  </label>
                  <label className="block space-y-1.5">
                    <span className="text-xs font-medium text-content-secondary">Last Name</span>
                    <input
                      type="text"
                      value={form.lastName}
                      onChange={(event) => updateForm("lastName", event.target.value)}
                      required
                      className={fieldClass}
                    />
                  </label>
                </div>

                <label className="block space-y-1.5">
                  <span className="text-xs font-medium text-content-secondary">Middle Name (optional)</span>
                  <input
                    type="text"
                    value={form.middleName}
                    onChange={(event) => updateForm("middleName", event.target.value)}
                    className={fieldClass}
                  />
                </label>

                <div className="grid grid-cols-2 gap-4">
                  <label className="block space-y-1.5">
                    <span className="text-xs font-medium text-content-secondary">Primary Phone</span>
                    <input
                      type="tel"
                      value={form.primaryPhone}
                      onChange={(event) => updateForm("primaryPhone", event.target.value)}
                      required
                      className={fieldClass}
                    />
                  </label>
                  <label className="block space-y-1.5">
                    <span className="text-xs font-medium text-content-secondary">
                      Secondary Phone (optional)
                    </span>
                    <input
                      type="tel"
                      value={form.secondaryPhone}
                      onChange={(event) => updateForm("secondaryPhone", event.target.value)}
                      className={fieldClass}
                    />
                  </label>
                </div>

                <label className="block space-y-1.5">
                  <span className="text-xs font-medium text-content-secondary">Email (optional)</span>
                  <input
                    type="email"
                    value={form.emailAddress}
                    onChange={(event) => updateForm("emailAddress", event.target.value)}
                    className={fieldClass}
                  />
                </label>

                <label className="block space-y-1.5">
                  <span className="text-xs font-medium text-content-secondary">Service Address</span>
                  <input
                    type="text"
                    value={form.serviceAddress}
                    onChange={(event) => updateForm("serviceAddress", event.target.value)}
                    required
                    minLength={5}
                    className={fieldClass}
                  />
                </label>

                <div className="grid grid-cols-3 gap-4">
                  <label className="block space-y-1.5">
                    <span className="text-xs font-medium text-content-secondary">Barangay</span>
                    <input
                      type="text"
                      value={form.serviceBarangay}
                      onChange={(event) => updateForm("serviceBarangay", event.target.value)}
                      required
                      className={fieldClass}
                    />
                  </label>
                  <label className="block space-y-1.5">
                    <span className="text-xs font-medium text-content-secondary">Municipality</span>
                    <input
                      type="text"
                      value={form.serviceMunicipality}
                      onChange={(event) => updateForm("serviceMunicipality", event.target.value)}
                      required
                      className={fieldClass}
                    />
                  </label>
                  <label className="block space-y-1.5">
                    <span className="text-xs font-medium text-content-secondary">Province</span>
                    <input
                      type="text"
                      value={form.serviceProvince}
                      onChange={(event) => updateForm("serviceProvince", event.target.value)}
                      required
                      className={fieldClass}
                    />
                  </label>
                </div>

                <label className="block space-y-1.5">
                  <span className="text-xs font-medium text-content-secondary">Internal Notes (optional)</span>
                  <textarea
                    value={form.internalNotes}
                    onChange={(event) => updateForm("internalNotes", event.target.value)}
                    rows={3}
                    className="w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  />
                </label>

                <div className="flex justify-end">
                  <Button type="submit" variant="secondary" size="md">
                    Next: Service Account
                  </Button>
                </div>
              </form>
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
                  <label className="block space-y-1.5">
                    <span className="text-xs font-medium text-content-secondary">Service Plan</span>
                    <select
                      value={selectedPlanId}
                      onChange={(event) => setSelectedPlanId(event.target.value)}
                      required
                      className={`${fieldClass} tabular-nums`}
                    >
                      <option value="">Select a plan…</option>
                      {plans.map((plan) => (
                        <option key={plan.id} value={plan.id}>
                          {plan.name} — {SERVICE_TYPE_LABELS[plan.serviceType]} —{" "}
                          {formatCentavos(plan.monthlyRateCentavos)}/month
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="block space-y-1.5">
                    <span className="text-xs font-medium text-content-secondary">
                      Activation Date (leave blank if installation is pending)
                    </span>
                    <input
                      type="date"
                      value={activationDate}
                      onChange={(event) => setActivationDate(event.target.value)}
                      className={fieldClass}
                    />
                    <span className="text-xs text-content-secondary">
                      With a date the account starts as Active. Without one it stays Pending until
                      service begins.
                    </span>
                  </label>
                </>
              )}

              <div className="flex justify-between">
                <Button type="button" variant="outline" size="md" onClick={() => setStep(1)}>
                  Back
                </Button>
                <Button
                  type="button"
                  size="md"
                  onClick={() => void handleSave()}
                  isLoading={isSubmitting}
                >
                  Save Subscriber
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </AppShell>
  );
}
