// Validation schemas for the billing and invoice endpoints.
//
// The server validates every request body with these schemas; the client uses the
// same shapes to disable a Submit button before a round trip. The server remains
// the authority — the client check only makes mistakes obvious sooner.
//
// Money is always an integer number of centavos (see types/money.ts).

import { z } from "zod";

import { INVOICE_STATUS_INPUTS, normalizeInvoiceStatusInput } from "../constants/statuses";
import { queryNumber } from "./query-number";

/** A calendar month, 1–12, with a plausible four-digit year. */
export const billingPeriodSchema = z.object({
  year: z.number().int().min(2000).max(2100),
  month: z.number().int().min(1).max(12),
});
export type BillingPeriodFields = z.infer<typeof billingPeriodSchema>;

/** Query strings arrive as text; coerce so `?year=2025` validates as a number. */
export const billingPeriodQuerySchema = z.object({
  year: queryNumber("year", (schema) => schema.int().min(2000).max(2100)),
  month: queryNumber("month", (schema) => schema.int().min(1).max(12)),
});
export type BillingPeriodQuery = z.infer<typeof billingPeriodQuerySchema>;

export const runBillingSchema = billingPeriodSchema;
export type RunBillingFields = z.infer<typeof runBillingSchema>;

export const postAllDraftSchema = billingPeriodSchema;
export type PostAllDraftFields = z.infer<typeof postAllDraftSchema>;

/**
 * Applies late fees to overdue invoices.
 * The amount defaults to the shared constant when omitted, so the client may send
 * only `{}` and still get the documented default.
 */
export const applyLateFeesSchema = z.object({
  lateFeeCentavos: z.number().int().nonnegative().optional(),
});
export type ApplyLateFeesFields = z.infer<typeof applyLateFeesSchema>;

/** The filters the invoice list screen may apply. */
export const listInvoicesQuerySchema = z.object({
  // Accepts the canonical statuses plus the one-release `posted` alias, and
  // normalizes the alias to `unpaid` before the service sees it.
  status: z
    .enum(INVOICE_STATUS_INPUTS)
    .transform(normalizeInvoiceStatusInput)
    .optional(),
  year: queryNumber("year", (schema) => schema.int().min(2000).max(2100)).optional(),
  month: queryNumber("month", (schema) => schema.int().min(1).max(12)).optional(),
  subscriberId: z.string().uuid().optional(),
  page: queryNumber("page", (schema) => schema.int().min(1)).default(1),
  pageSize: queryNumber("pageSize", (schema) => schema.int().min(1).max(200)).default(50),
});
export type ListInvoicesQuery = z.infer<typeof listInvoicesQuerySchema>;

/**
 * Generates a reconnection fee invoice for a service account.
 * A reason is optional but is copied onto the invoice for the audit trail.
 */
export const createReconnectionFeeSchema = z.object({
  serviceAccountId: z.string().uuid(),
  reason: z.string().trim().min(3).max(500).optional(),
});
export type CreateReconnectionFeeFields = z.infer<typeof createReconnectionFeeSchema>;

/**
 * Charges an installation fee (S2-3) as a first-class line item on a NEW draft
 * invoice for a service account. The fee is a whole number of centavos — the
 * boundary never accepts a float. A reason is optional but is copied onto the
 * invoice and into the audit trail.
 */
export const createInstallationFeeSchema = z.object({
  serviceAccountId: z.string().uuid(),
  installationFeeCentavos: z
    .number()
    .int("The installation fee must be a whole number of centavos")
    .positive("The installation fee must be greater than zero"),
  reason: z.string().trim().min(3).max(500).optional(),
});
export type CreateInstallationFeeFields = z.infer<typeof createInstallationFeeSchema>;

/**
 * Applies a discount (S2-3) to a DRAFT invoice. Exactly one form is required:
 *
 *   • `discountCentavos`        — a fixed amount in whole centavos, or
 *   • `discountRateBasisPoints` — a percentage as an integer basis-point count
 *                                 (1% = 100 bp), never a float.
 *
 * A reason is mandatory: a discount — like a fee waiver — is exactly the action
 * an auditor asks about, so it is recorded with the actor and the old/new totals.
 */
export const applyDiscountSchema = z
  .object({
    discountCentavos: z
      .number()
      .int("The discount must be a whole number of centavos")
      .positive("The discount must be greater than zero")
      .optional(),
    discountRateBasisPoints: z
      .number()
      .int("The discount rate must be a whole number of basis points")
      .positive("The discount rate must be greater than zero")
      .max(10_000, "A discount rate cannot exceed 100%")
      .optional(),
    reason: z.string().trim().min(3, "A discount reason is required").max(500),
  })
  .refine(
    (value) =>
      (value.discountCentavos === undefined) !==
      (value.discountRateBasisPoints === undefined),
    { message: "Provide either a discount amount or a discount rate, but not both" }
  );
export type ApplyDiscountFields = z.infer<typeof applyDiscountSchema>;

/** Voiding requires a human-readable reason; the invoice row is never deleted. */
export const voidInvoiceSchema = z.object({
  reason: z.string().trim().min(10, "Void reason must be at least 10 characters"),
});
export type VoidInvoiceFields = z.infer<typeof voidInvoiceSchema>;

/** An invoice id path parameter. */
export const invoiceIdParamsSchema = z.object({ id: z.string().uuid("A valid invoice id is required") });
