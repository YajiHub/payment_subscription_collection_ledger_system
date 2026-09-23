// Validation schemas for the payment endpoints.
//
// The server validates every request body with these schemas; the client uses the
// same shapes to disable a Post button before a round trip. The server remains the
// authority — the client check only makes mistakes obvious sooner.
//
// Money is always an integer number of centavos (see types/money.ts).

import { z } from "zod";

import {
  GCASH_SCREENSHOT_MIME_TYPES,
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

/** The filters the payment history screen may apply. */
export const listPaymentsQuerySchema = z.object({
  serviceAccountId: z.string().uuid().optional(),
  method: z.enum(PAYMENT_METHODS).optional(),
  status: z.enum(PAYMENT_STATUSES).optional(),
  dateFrom: z.string().date().optional(),
  dateTo: z.string().date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
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
