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
  const [selectedPlanId, setSelectedPlanId] = useState("");
  const [activationDate, setActivationDate] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const loadPlans = useCallback(async (): Promise<void> => {
    try {
      const activePlans = await listPlans();
      setPlans(activePlans);
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
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
    <main className="mx-auto max-w-2xl space-y-6 p-8">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Add Subscriber</h1>
          <p className="text-sm text-slate-600">
            Step {step} of 2 — {step === 1 ? "subscriber details" : "first service account"}
          </p>
        </div>
        <Link to="/subscribers" className="text-sm font-medium text-slate-700 underline">
          Back to list
        </Link>
      </header>

      {errorMessage !== null && (
        <p
          role="alert"
          className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {errorMessage}
        </p>
      )}

      {step === 1 && (
        <form onSubmit={goToServiceStep} className="space-y-4 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
          <div className="grid grid-cols-2 gap-4">
            <label className="space-y-1">
              <span className="text-sm font-medium text-slate-700">First Name</span>
              <input
                type="text"
                value={form.firstName}
                onChange={(event) => updateForm("firstName", event.target.value)}
                required
                className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
              />
            </label>
            <label className="space-y-1">
              <span className="text-sm font-medium text-slate-700">Last Name</span>
              <input
                type="text"
                value={form.lastName}
                onChange={(event) => updateForm("lastName", event.target.value)}
                required
                className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
              />
            </label>
          </div>

          <label className="space-y-1">
            <span className="text-sm font-medium text-slate-700">Middle Name (optional)</span>
            <input
              type="text"
              value={form.middleName}
              onChange={(event) => updateForm("middleName", event.target.value)}
              className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
            />
          </label>

          <div className="grid grid-cols-2 gap-4">
            <label className="space-y-1">
              <span className="text-sm font-medium text-slate-700">Primary Phone</span>
              <input
                type="tel"
                value={form.primaryPhone}
                onChange={(event) => updateForm("primaryPhone", event.target.value)}
                required
                className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
              />
            </label>
            <label className="space-y-1">
              <span className="text-sm font-medium text-slate-700">Secondary Phone (optional)</span>
              <input
                type="tel"
                value={form.secondaryPhone}
                onChange={(event) => updateForm("secondaryPhone", event.target.value)}
                className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
              />
            </label>
          </div>

          <label className="space-y-1">
            <span className="text-sm font-medium text-slate-700">Email (optional)</span>
            <input
              type="email"
              value={form.emailAddress}
              onChange={(event) => updateForm("emailAddress", event.target.value)}
              className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
            />
          </label>

          <label className="space-y-1">
            <span className="text-sm font-medium text-slate-700">Service Address</span>
            <input
              type="text"
              value={form.serviceAddress}
              onChange={(event) => updateForm("serviceAddress", event.target.value)}
              required
              minLength={5}
              className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
            />
          </label>

          <div className="grid grid-cols-3 gap-4">
            <label className="space-y-1">
              <span className="text-sm font-medium text-slate-700">Barangay</span>
              <input
                type="text"
                value={form.serviceBarangay}
                onChange={(event) => updateForm("serviceBarangay", event.target.value)}
                required
                className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
              />
            </label>
            <label className="space-y-1">
              <span className="text-sm font-medium text-slate-700">Municipality</span>
              <input
                type="text"
                value={form.serviceMunicipality}
                onChange={(event) => updateForm("serviceMunicipality", event.target.value)}
                required
                className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
              />
            </label>
            <label className="space-y-1">
              <span className="text-sm font-medium text-slate-700">Province</span>
              <input
                type="text"
                value={form.serviceProvince}
                onChange={(event) => updateForm("serviceProvince", event.target.value)}
                required
                className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
              />
            </label>
          </div>

          <label className="space-y-1">
            <span className="text-sm font-medium text-slate-700">Internal Notes (optional)</span>
            <textarea
              value={form.internalNotes}
              onChange={(event) => updateForm("internalNotes", event.target.value)}
              rows={3}
              className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
            />
          </label>

          <div className="flex justify-end">
            <button
              type="submit"
              className="rounded bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
            >
              Next: Service Account
            </button>
          </div>
        </form>
      )}

      {step === 2 && (
        <section className="space-y-4 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
          <label className="space-y-1">
            <span className="text-sm font-medium text-slate-700">Service Plan</span>
            <select
              value={selectedPlanId}
              onChange={(event) => setSelectedPlanId(event.target.value)}
              required
              className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
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

          <label className="space-y-1">
            <span className="text-sm font-medium text-slate-700">
              Activation Date (leave blank if installation is pending)
            </span>
            <input
              type="date"
              value={activationDate}
              onChange={(event) => setActivationDate(event.target.value)}
              className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
            />
            <span className="text-xs text-slate-500">
              With a date the account starts as Active. Without one it stays Pending until service
              begins.
            </span>
          </label>

          <div className="flex justify-between">
            <button
              type="button"
              onClick={() => setStep(1)}
              className="rounded border border-slate-300 px-4 py-2 text-sm"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={isSubmitting}
              className="rounded bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-60"
            >
              {isSubmitting ? "Saving…" : "Save Subscriber"}
            </button>
          </div>
        </section>
      )}
    </main>
  );
}
