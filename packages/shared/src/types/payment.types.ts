// Validation schemas for the payment endpoints.
//
// The server validates every request body with these schemas; the client uses the
// same shapes to disable a Post button before a round trip. The server remains the
// authority — the client check only makes mistakes obvious sooner.
//
// Money is always an integer number of centavos (see types/money.ts).

import { z } from "zod";

import { queryNumber } from "./query-number";
import {
  GCASH_REJECTION_REASON_MIN_LENGTH,
  GCASH_SCREENSHOT_MIME_TYPES,
  MANUAL_ALLOCATION_REASON_MIN_LENGTH,
  MANUALLY_ALLOCATABLE_PAYMENT_METHODS,
  PAYMENT_STATUSES,
  POSTABLE_PAYMENT_METHODS,
} from "../constants/payments";
import { PAYMENT_METHODS } from "../constants/statuses";

/** The GCash-only details captured alongside a GCash payment. */
export const gcashPaymentDetailsSchema = z.object({
  referenceNumber: z
    .string()
    .trim()
    .min(4, "A GCash reference number is required")
    .max(50, "GCash reference numbers are at most 50 characters"),
  senderGcashNumber: z.string().trim().max(20).optional(),
  senderName: z.string().trim().max(100).optional(),
  /** Relative path returned by the screenshot upload endpoint. */
  screenshotFilePath: z.string().trim().max(500).optional(),
});
export type GcashPaymentDetailsFields = z.infer<typeof gcashPaymentDetailsSchema>;

/**
 * Posts a payment. Cash needs no extra details; a GCash payment must carry its
 * reference number, because that is what protects against duplicate postings.
 */
export const postPaymentSchema = z
  .object({
    serviceAccountId: z.string().uuid(),
    paymentMethod: z.enum(POSTABLE_PAYMENT_METHODS),
    amountCentavos: z
      .number()
      .int("Payment amount must be a whole number of centavos")
      .positive("Payment amount must be greater than zero"),
    paymentDate: z.string().date("Payment date must be a calendar date (YYYY-MM-DD)"),
    notes: z.string().trim().max(1000).optional(),
    gcash: gcashPaymentDetailsSchema.optional(),
  })
  .refine((value) => value.paymentMethod !== "gcash" || value.gcash !== undefined, {
    message: "A GCash reference number is required for a GCash payment",
    path: ["gcash"],
  });
export type PostPaymentFields = z.infer<typeof postPaymentSchema>;

/**
 * One "pay this invoice by this much" instruction from an operator (S3-5).
 */
export const manualAllocationLineSchema = z.object({
  invoiceId: z.string().uuid("A valid invoice id is required"),
  amountCentavos: z
    .number()
    .int("An allocation must be a whole number of centavos")
    .positive("An allocation must be greater than zero"),
});
export type ManualAllocationLineFields = z.infer<typeof manualAllocationLineSchema>;

/**
 * An operator's chosen split, with the leftover DECLARED rather than assumed. The
 * server refuses the request unless the chosen amounts plus `advanceCreditCentavos`
 * equal the payment exactly, so a split can neither over- nor under-allocate; see
 * `buildManualAllocation`.
 */
export const manualAllocationSchema = z.object({
  allocations: z.array(manualAllocationLineSchema).max(200),
  advanceCreditCentavos: z
    .number()
    .int("Advance credit must be a whole number of centavos")
    .nonnegative("Advance credit cannot be negative"),
  reason: z
    .string()
    .trim()
    .min(
      MANUAL_ALLOCATION_REASON_MIN_LENGTH,
      `A manual allocation needs a reason of at least ${MANUAL_ALLOCATION_REASON_MIN_LENGTH} characters`
    )
    .max(1000),
});
export type ManualAllocationFields = z.infer<typeof manualAllocationSchema>;

/**
 * Posts a payment whose money is already in hand and directs it at chosen invoices.
 * GCash is not one of the methods here: a GCash split is applied when a verifier
 * confirms the transfer.
 */
export const manualAllocationPaymentSchema = z.object({
  serviceAccountId: z.string().uuid(),
  paymentMethod: z.enum(MANUALLY_ALLOCATABLE_PAYMENT_METHODS),
  amountCentavos: z
    .number()
    .int("Payment amount must be a whole number of centavos")
    .positive("Payment amount must be greater than zero"),
  paymentDate: z.string().date("Payment date must be a calendar date (YYYY-MM-DD)"),
  notes: z.string().trim().max(1000).optional(),
  manualAllocation: manualAllocationSchema,
});
export type ManualAllocationPaymentFields = z.infer<typeof manualAllocationPaymentSchema>;

/** Refuses a pending GCash payment. The reason is mandatory and audited. */
export const rejectGcashPaymentSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(
      GCASH_REJECTION_REASON_MIN_LENGTH,
      `A GCash rejection needs a reason of at least ${GCASH_REJECTION_REASON_MIN_LENGTH} characters`
    )
    .max(1000),
});
export type RejectGcashPaymentFields = z.infer<typeof rejectGcashPaymentSchema>;

/** The filters the payment history screen may apply. */
export const listPaymentsQuerySchema = z.object({
  serviceAccountId: z.string().uuid().optional(),
  // Filters the history to one subscriber's payments across all their accounts.
  subscriberId: z.string().uuid().optional(),
  method: z.enum(PAYMENT_METHODS).optional(),
  status: z.enum(PAYMENT_STATUSES).optional(),
  dateFrom: z.string().date().optional(),
  dateTo: z.string().date().optional(),
  page: queryNumber("page", (schema) => schema.int().min(1)).default(1),
  pageSize: queryNumber("pageSize", (schema) => schema.int().min(1).max(200)).default(50),
});
export type ListPaymentsQuery = z.infer<typeof listPaymentsQuerySchema>;

/**
 * A reversal always needs a reason. The original payment row is never deleted or
 * edited beyond its status; a reversal record is created beside it.
 */
export const reversePaymentSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(10, "Reversal reason must be at least 10 characters")
    .max(1000),
});
export type ReversePaymentFields = z.infer<typeof reversePaymentSchema>;

/** A payment id path parameter. */
export const paymentIdParamsSchema = z.object({
  id: z.string().uuid("A valid payment id is required"),
});

/** A receipt number path parameter, e.g. OR-2025-000042. */
export const receiptNumberParamsSchema = z.object({
  receiptNumber: z.string().trim().min(1).max(30),
});

/**
 * Uploads a GCash proof screenshot. The renderer picks the file with the native
 * dialog and sends its bytes; the path it gets back is stored on the payment.
 */
export const uploadGcashScreenshotSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  contentType: z.enum(GCASH_SCREENSHOT_MIME_TYPES, {
    message: "Only JPEG, PNG, or WebP screenshots are accepted",
  }),
  /** Base64-encoded file contents (no data URL prefix). */
  dataBase64: z.string().min(1, "The screenshot file is empty"),
});
export type UploadGcashScreenshotFields = z.infer<typeof uploadGcashScreenshotSchema>;
