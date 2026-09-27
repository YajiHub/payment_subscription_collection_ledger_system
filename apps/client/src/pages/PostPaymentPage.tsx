import type { ReactNode } from "react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useForm } from "react-hook-form";
import { z } from "zod";

import {
  PAYMENT_METHOD_LABELS,
  POSTABLE_PAYMENT_METHODS,
  gcashPaymentDetailsSchema,
  postPaymentSchema,
} from "@bcis/shared";
import {
  extractApiErrorMessage,
  getServiceAccountPaymentSummary,
  postPayment,
  searchSubscribers,
  uploadGcashScreenshot,
  type OutstandingInvoiceSummary,
  type PostPaymentInput,
  type PostPaymentResult,
  type ServiceAccountPaymentSummary,
} from "../lib/api-client";
import { formatCentavos, formatDateOnly, parsePesosToCentavos } from "../lib/format";
import { TextField } from "../components/form/TextField";
import { TextareaField } from "../components/form/TextareaField";
import { formResolver } from "../components/form/form-resolver";
import { normalizeOptionalText } from "../components/form/form-values";

interface ServiceAccountChoice {
  serviceAccountId: string;
  serviceAccountNumber: string;
  subscriberName: string;
  planName: string;
}

interface AllocationPreviewLine {
  label: string;
  amountCentavos: number;
}

interface ScreenshotUpload {
  fileName: string;
  contentType: string;
  dataBase64: string;
}

// The server's own field rules, read straight out of the schema it validates a
// payment body with. `postPaymentSchema` wraps its object in a refinement (the
// GCash rule), so `innerType()` is how you reach the individual fields. Reusing
// them means the client cannot accept an amount or a reference the server refuses.
const serverPaymentRules = postPaymentSchema.innerType().shape;

/**
 * Reads the typed peso amount and reports what is wrong with it.
 *
 * `parsePesosToCentavos` does the conversion with integer arithmetic only and
 * refuses anything that is not digits with at most two decimal places, so a
 * negative, non-numeric or over-precise entry never reaches the check below.
 * Zero does reach it — and is refused by `amountCentavos`, the rule the server
 * applies, which is why a zero amount is reported in the server's own words.
 */
function checkPaymentAmount(text: string, ctx: z.RefinementCtx): void {
  const centavos = parsePesosToCentavos(text);

  if (centavos === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Enter a peso amount in digits with at most two decimal places — for example 999.00",
    });
    return;
  }

  const fromServer = serverPaymentRules.amountCentavos.safeParse(centavos);
  if (!fromServer.success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: fromServer.error.issues[0]?.message ?? "The amount was rejected",
    });
  }
}

/**
 * The fields the payment form captures.
 *
 * The amount, the payment date and the GCash details are the server's own field
 * rulers taken straight from `postPaymentSchema`, so the client cannot accept an
 * amount or a reference the server would refuse. The GCash reference is the one
 * exception: it is optional overall — it is required only for a GCash payment —
 * so its rule is applied by the refinement below rather than to the field.
 */
const paymentFormFields = z.object({
  paymentMethod: serverPaymentRules.paymentMethod,
  amountText: z.string().trim().min(1, "Enter the amount").superRefine(checkPaymentAmount),
  paymentDate: serverPaymentRules.paymentDate,
  notes: serverPaymentRules.notes,
  gcashReference: z.string().trim(),
  gcashSenderName: gcashPaymentDetailsSchema.shape.senderName,
  gcashSenderNumber: gcashPaymentDetailsSchema.shape.senderGcashNumber,
});

type PaymentFormValues = z.input<typeof paymentFormFields>;
type PaymentFormFields = z.output<typeof paymentFormFields>;

/**
 * A GCash reference number is required only when the method is GCash — the same
 * condition, and the same rule and message, as `postPaymentSchema`'s own
 * refinement. The issue is aimed at the reference field so it can be shown beside
 * it instead of on the GCash group as a whole.
 */
function checkGcashReference(values: PaymentFormFields, ctx: z.RefinementCtx): void {
  if (values.paymentMethod !== "gcash") {
    return;
  }

  const fromServer = gcashPaymentDetailsSchema.shape.referenceNumber.safeParse(
    values.gcashReference
  );
  if (!fromServer.success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["gcashReference"],
      message: fromServer.error.issues[0]?.message ?? "Enter the GCash reference number",
    });
  }
}

/**
 * The Post Payment rules.
 *
 * The clerk types pesos and the API takes whole centavos, so this cannot be
 * `postPaymentSchema` itself. It reuses that schema's rules and mirrors none: the
 * amount rule is applied to the parsed centavos, and the transform below hands
 * the submit handler the integer the API is sent.
 */
const paymentFormSchema = paymentFormFields
  .superRefine(checkGcashReference)
  .transform((values) => ({
    ...values,
    // The amount rule has already refused any text `parsePesosToCentavos` cannot
    // read, so this fallback is unreachable; it keeps the transform total.
    amountCentavos: parsePesosToCentavos(values.amountText) ?? 0,
  }));

type PaymentFormPayload = z.output<typeof paymentFormSchema>;

/** The form as it opens: cash, today, and nothing typed in yet. */
function emptyPaymentForm(): PaymentFormValues {
  return {
    paymentMethod: "cash",
    amountText: "",
    paymentDate: new Date().toISOString().slice(0, 10),
    notes: undefined,
    gcashReference: "",
    gcashSenderName: undefined,
    gcashSenderNumber: undefined,
  };
}

/**
 * Builds the request body.
 *
 * This is the one place the form becomes a payload, and it is the shape the screen
 * has always sent: the amount is the integer centavos of the typed pesos, the
 * optional text is trimmed and left out when it is blank, and the GCash block is
 * present only for a GCash payment.
 */
function buildPaymentPayload(
  values: PaymentFormPayload,
  serviceAccountId: string,
  screenshotFilePath: string | null
): PostPaymentInput {
  return {
    serviceAccountId,
    paymentMethod: values.paymentMethod,
    amountCentavos: values.amountCentavos,
    paymentDate: values.paymentDate,
    notes: normalizeOptionalText(values.notes),
    gcash:
      values.paymentMethod === "gcash"
        ? {
            referenceNumber: values.gcashReference,
            senderName: normalizeOptionalText(values.gcashSenderName),
            senderGcashNumber: normalizeOptionalText(values.gcashSenderNumber),
            screenshotFilePath: screenshotFilePath ?? undefined,
          }
        : undefined,
  };
}

/**
 * A display-only preview of how the amount would be spread, oldest invoice first.
 *
 * This mirrors the server's allocation rule for the cashier's benefit; the server
 * re-runs it authoritatively when the payment is posted, so the preview can never
 * change what actually happens.
 */
function previewAllocation(
  amountCentavos: number,
  outstandingInvoices: readonly OutstandingInvoiceSummary[]
): AllocationPreviewLine[] {
  let remaining = amountCentavos;
  const lines: AllocationPreviewLine[] = [];

  for (const invoice of outstandingInvoices) {
    if (remaining <= 0) {
      break;
    }
    const applied = Math.min(remaining, invoice.remainingBalanceCentavos);
    if (applied <= 0) {
      continue;
    }
    lines.push({ label: `Invoice ${invoice.invoiceNumber}`, amountCentavos: applied });
    remaining -= applied;
  }

  if (remaining > 0) {
    lines.push({ label: "Advance Credit", amountCentavos: remaining });
  }

  return lines;
}

/** Reads a chosen image file into base64 so it can be uploaded through the API. */
function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("The screenshot could not be read"));
        return;
      }
      // FileReader returns a data URL; the API wants the bytes after the comma.
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(new Error("The screenshot could not be read"));
    reader.readAsDataURL(file);
  });
}

/** The Post Payment screen for the cashier. */
export function PostPaymentPage(): ReactNode {
  const navigate = useNavigate();

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<ServiceAccountChoice[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  const [selectedAccount, setSelectedAccount] = useState<ServiceAccountChoice | null>(null);
  const [summary, setSummary] = useState<ServiceAccountPaymentSummary | null>(null);

  const [screenshot, setScreenshot] = useState<ScreenshotUpload | null>(null);
  const [screenshotPath, setScreenshotPath] = useState<string | null>(null);

  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [result, setResult] = useState<PostPaymentResult | null>(null);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    reset,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<PaymentFormValues, unknown, PaymentFormPayload>({
    resolver: formResolver(paymentFormSchema),
    defaultValues: emptyPaymentForm(),
  });

  const paymentMethod = watch("paymentMethod");
  const amountCentavos = parsePesosToCentavos(watch("amountText"));

  const preview =
    amountCentavos !== null && summary !== null
      ? previewAllocation(amountCentavos, summary.outstandingInvoices)
      : [];

  async function handleSearch(): Promise<void> {
    if (searchQuery.trim() === "") {
      return;
    }
    setIsSearching(true);
    setErrorMessage(null);
    try {
      const page = await searchSubscribers(searchQuery.trim());
      const choices = page.items.flatMap((subscriber) =>
        subscriber.serviceAccounts.map((account) => ({
          serviceAccountId: account.id,
          serviceAccountNumber: account.serviceAccountNumber,
          subscriberName: `${subscriber.lastName}, ${subscriber.firstName}`,
          planName: account.planName,
        }))
      );
      setSearchResults(choices);
      if (choices.length === 0) {
        setErrorMessage("No service accounts matched that search.");
      }
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    } finally {
      setIsSearching(false);
    }
  }

  async function selectAccount(choice: ServiceAccountChoice): Promise<void> {
    setSelectedAccount(choice);
    setSearchResults([]);
    setSummary(null);
    setResult(null);
    setErrorMessage(null);
    try {
      setSummary(await getServiceAccountPaymentSummary(choice.serviceAccountId));
    } catch (error) {
      setErrorMessage(extractApiErrorMessage(error));
    }
  }

  async function handleScreenshotChosen(file: File | undefined): Promise<void> {
    if (file === undefined) {
      return;
    }
    setErrorMessage(null);
    try {
      const dataBase64 = await readFileAsBase64(file);
      const contentType = file.type;
      const uploaded = await uploadGcashScreenshot({
        fileName: file.name,
        contentType,
        dataBase64,
      });
      setScreenshot({ fileName: file.name, contentType, dataBase64 });
      setScreenshotPath(uploaded.filePath);
    } catch (error) {
      setScreenshot(null);
      setScreenshotPath(null);
      setErrorMessage(extractApiErrorMessage(error));
    }
  }

  const onSubmit = handleSubmit(async (values) => {
    setErrorMessage(null);

    if (selectedAccount === null) {
      // Not a field: the account is chosen by search, not typed into the form.
      setErrorMessage("Select a service account first.");
      return;
    }

    try {
      const posted = await postPayment(
        buildPaymentPayload(values, selectedAccount.serviceAccountId, screenshotPath)
      );
      setResult(posted);
    } catch (error) {
      // A duplicate GCash reference or a closed period is the server's answer to a
      // form the client had every reason to accept.
      setErrorMessage(extractApiErrorMessage(error));
    }
  });

  function startAnotherPayment(): void {
    setResult(null);
    setSummary(null);
    setSelectedAccount(null);
    // Only what the screen cleared before: the amount and the reference.
    reset({ ...getValues(), amountText: "", gcashReference: "" });
    setScreenshot(null);
    setScreenshotPath(null);
  }

  if (result !== null) {
    // A GCash payment is recorded as claimed, not received: the server returns it
    // in `pending_verification` with no allocation and no ledger entry, so the
    // screen must not tell the cashier the account has been settled. The returned
    // status is the authority, not the method that was selected.
    const isAwaitingVerification = result.payment.status === "pending_verification";

    return (
      <main className="mx-auto max-w-3xl space-y-6 p-8">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold">
            {isAwaitingVerification ? "GCash payment awaiting verification" : "Payment posted"}
          </h1>
          <p className="text-sm text-content-secondary tabular-nums">
            Receipt <span className="font-mono">{result.payment.receiptNumber}</span> was issued for{" "}
            {formatCentavos(result.payment.amountCentavos)}.
          </p>
        </header>

        {isAwaitingVerification && (
          <p
            role="status"
            className="rounded-xl border border-warning-line bg-warning-soft px-4 py-3 text-sm text-warning-strong"
          >
            Nothing has been applied to the account. A verifier must confirm the GCash transfer
            before this payment is posted; until then the outstanding balance stands as it was.
          </p>
        )}

        <section className="space-y-2 rounded-lg border border-line bg-surface p-5 text-sm shadow-sm">
          <h2 className="text-base font-medium">
            {isAwaitingVerification ? "Allocation once verified" : "Allocation"}
          </h2>
          {isAwaitingVerification ? (
            <p className="text-content-secondary">
              No invoice balance has moved. The payment is applied oldest invoice first when it is
              verified.
            </p>
          ) : (
            result.allocations.length === 0 &&
            result.advanceCreditCentavos === 0 && (
              <p className="text-content-secondary">No invoices were outstanding.</p>
            )
          )}
          {result.allocations.map((allocation) => (
            <div key={allocation.invoiceId} className="flex justify-between border-t border-line pt-2">
              <span>Invoice {allocation.invoiceNumber}</span>
              <span className="tabular-nums">
                {formatCentavos(allocation.allocatedAmountCentavos)}
              </span>
            </div>
          ))}
          {result.advanceCreditCentavos > 0 && (
            <div className="flex justify-between border-t border-line pt-2 font-medium">
              <span>Advance credit</span>
              <span className="tabular-nums">{formatCentavos(result.advanceCreditCentavos)}</span>
            </div>
          )}
        </section>

        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => navigate(`/payments/${result.payment.id}/receipt`)}
            className="rounded bg-navy px-4 py-2 text-sm font-medium text-surface hover:bg-navy-strong"
          >
            Print Receipt
          </button>
          <button
            type="button"
            onClick={startAnotherPayment}
            className="rounded border border-line-strong px-4 py-2 text-sm font-medium"
          >
            Post another payment
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Post Payment</h1>
        <p className="text-sm text-content-secondary">
          Find the service account, confirm the amount, then post. Cash or GCash.
        </p>
      </header>

      {errorMessage !== null && (
        <p role="alert" className="rounded border border-danger-line bg-danger-soft px-3 py-2 text-sm text-danger-strong">
          {errorMessage}
        </p>
      )}

      <section className="space-y-3 rounded-lg border border-line bg-surface p-5 shadow-sm">
        <h2 className="text-base font-medium">1. Service account</h2>
        <div className="flex gap-2">
          <input
            type="text"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Account number, subscriber name, or phone"
            className="flex-1 rounded border border-line-strong px-3 py-2 text-sm"
          />
          <button
            type="button"
            onClick={() => void handleSearch()}
            disabled={isSearching}
            className="rounded bg-navy px-4 py-2 text-sm font-medium text-surface disabled:opacity-50"
          >
            Search
          </button>
        </div>

        {searchResults.length > 0 && (
          <ul className="divide-y divide-line rounded border border-line">
            {searchResults.map((choice) => (
              <li key={choice.serviceAccountId}>
                <button
                  type="button"
                  onClick={() => void selectAccount(choice)}
                  className="w-full px-3 py-2 text-left text-sm hover:bg-canvas"
                >
                  <span className="font-mono">{choice.serviceAccountNumber}</span> ·{" "}
                  {choice.subscriberName} · {choice.planName}
                </button>
              </li>
            ))}
          </ul>
        )}

        {selectedAccount !== null && (
          <div className="rounded border border-line bg-canvas px-3 py-2 text-sm">
            Selected: <span className="font-mono">{selectedAccount.serviceAccountNumber}</span> ·{" "}
            {selectedAccount.subscriberName}
          </div>
        )}
      </section>

      {summary !== null && (
        <section className="space-y-3 rounded-lg border border-line bg-surface p-5 shadow-sm">
          <h2 className="text-base font-medium">2. Outstanding invoices</h2>
          {summary.outstandingInvoices.length === 0 ? (
            <p className="text-sm text-content-secondary">Nothing is outstanding on this account.</p>
          ) : (
            <table className="w-full text-left text-sm">
              <thead className="bg-canvas text-content-secondary">
                <tr>
                  <th className="px-3 py-2 font-medium">Invoice</th>
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 font-medium">Due</th>
                  <th className="px-3 py-2 font-medium">Balance</th>
                </tr>
              </thead>
              <tbody>
                {summary.outstandingInvoices.map((invoice) => (
                  <tr key={invoice.id} className="border-t border-line">
                    <td className="px-3 py-2 font-mono">{invoice.invoiceNumber}</td>
                    <td className="px-3 py-2">{formatDateOnly(invoice.invoiceDate)}</td>
                    <td className="px-3 py-2">{formatDateOnly(invoice.dueDate)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatCentavos(invoice.remainingBalanceCentavos)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="flex justify-between border-t border-line pt-2 text-sm">
            <span className="text-content-secondary">Total outstanding</span>
            <span className="font-medium tabular-nums">
              {formatCentavos(summary.outstandingTotalCentavos)}
            </span>
          </div>
          {summary.creditBalanceCentavos > 0 && (
            <div className="flex justify-between text-sm">
              <span className="text-content-secondary">Advance credit</span>
              <span className="font-medium text-success-strong tabular-nums">
                {formatCentavos(summary.creditBalanceCentavos)}
              </span>
            </div>
          )}
        </section>
      )}

      {summary !== null && (
        <form
          noValidate
          onSubmit={(event) => void onSubmit(event)}
          className="space-y-4 rounded-lg border border-line bg-surface p-5 shadow-sm"
        >
          <h2 className="text-base font-medium">3. Payment</h2>

          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              id="paymentAmount"
              label="Amount (₱)"
              inputMode="decimal"
              placeholder="999.00"
              hint={
                amountCentavos === null ? undefined : (
                  <span className="tabular-nums">{formatCentavos(amountCentavos)}</span>
                )
              }
              error={errors.amountText?.message}
              {...register("amountText")}
            />

            <TextField
              id="paymentDate"
              label="Payment date"
              type="date"
              error={errors.paymentDate?.message}
              {...register("paymentDate")}
            />
          </div>

          <div className="flex flex-wrap gap-2">
            {/* Driven by the shared list, so a method the API accepts can never be
                missing from the counter (S3-1). */}
            {POSTABLE_PAYMENT_METHODS.map((method) => (
              <button
                key={method}
                type="button"
                onClick={() => setValue("paymentMethod", method)}
                className={`rounded border px-4 py-2 text-sm font-medium ${
                  paymentMethod === method
                    ? "border-navy bg-navy text-surface"
                    : "border-line-strong text-content-primary"
                }`}
              >
                {PAYMENT_METHOD_LABELS[method]}
              </button>
            ))}
          </div>

          {paymentMethod === "gcash" && (
            <div className="space-y-3 rounded border border-line bg-canvas p-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <TextField
                  id="gcashReference"
                  label="Reference number"
                  error={errors.gcashReference?.message}
                  {...register("gcashReference")}
                />
                <TextField
                  id="gcashSenderName"
                  label="Sender name"
                  error={errors.gcashSenderName?.message}
                  {...register("gcashSenderName")}
                />
                <TextField
                  id="gcashSenderNumber"
                  label="Sender GCash number"
                  error={errors.gcashSenderNumber?.message}
                  {...register("gcashSenderNumber")}
                />
                <label className="block space-y-1">
                  <span className="text-xs font-medium text-content-secondary">Screenshot proof</span>
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    onChange={(event) => void handleScreenshotChosen(event.target.files?.[0])}
                    className="w-full text-sm text-content-primary"
                  />
                  {screenshot !== null && (
                    <span className="text-xs text-success-strong">Uploaded {screenshot.fileName}</span>
                  )}
                </label>
              </div>
            </div>
          )}

          <TextareaField
            id="paymentNotes"
            label="Notes (optional)"
            rows={2}
            error={errors.notes?.message}
            {...register("notes")}
          />

          {preview.length > 0 && (
            <div className="rounded border border-line bg-surface p-3 text-sm">
              <p className="font-medium">
                {paymentMethod === "gcash"
                  ? "Once a verifier confirms the transfer, this payment will be applied as follows:"
                  : "This payment will be applied as follows:"}
              </p>
              {preview.map((line) => (
                <div key={line.label} className="flex justify-between border-t border-line pt-1">
                  <span>{line.label}</span>
                  <span className="tabular-nums">{formatCentavos(line.amountCentavos)}</span>
                </div>
              ))}
            </div>
          )}

          {/* The button stays live while the amount is wrong: the message under the
              field is what tells the clerk why, and the resolver still refuses to
              post anything the server would reject. */}
          <button
            type="submit"
            disabled={isSubmitting}
            className="rounded bg-navy px-4 py-2 text-sm font-medium text-surface hover:bg-navy-strong disabled:opacity-50"
          >
            {isSubmitting ? "Posting…" : "Post Payment"}
          </button>
        </form>
      )}
    </main>
  );
}
