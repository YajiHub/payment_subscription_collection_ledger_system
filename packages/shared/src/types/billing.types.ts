// Validation schemas for the billing and invoice endpoints.
//
// The server validates every request body with these schemas; the client uses the
// same shapes to disable a Submit button before a round trip. The server remains
// the authority — the client check only makes mistakes obvious sooner.
//
// Money is always an integer number of centavos (see types/money.ts).

import { z } from "zod";

import { INVOICE_STATUSES } from "../constants/statuses";

/** A calendar month, 1–12, with a plausible four-digit year. */
export const billingPeriodSchema = z.object({
  year: z.number().int().min(2000).max(2100),
  month: z.number().int().min(1).max(12),
});
export type BillingPeriodFields = z.infer<typeof billingPeriodSchema>;

/** Query strings arrive as text; coerce so `?year=2025` validates as a number. */
export const billingPeriodQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
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
  status: z.enum(INVOICE_STATUSES).optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
  subscriberId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
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

/** Voiding requires a human-readable reason; the invoice row is never deleted. */
export const voidInvoiceSchema = z.object({
  reason: z.string().trim().min(10, "Void reason must be at least 10 characters"),
});
export type VoidInvoiceFields = z.infer<typeof voidInvoiceSchema>;

/** An invoice id path parameter. */
export const invoiceIdParamsSchema = z.object({ id: z.string().uuid("A valid invoice id is required") });
