// Request/response validation schemas for field collection and receivables.
//
// These schemas are the contract between the client and the server: the server
// parses every request body and query string with one of them before touching the
// database, so a malformed request always becomes a readable 400.
//
// Every monetary field is an integer number of centavos. The schemas reject a
// fractional amount outright, because a float peso amount would silently lose a
// centavo somewhere in the allocation arithmetic.

import { z } from "zod";

import { COLLECTED_METHODS, COLLECTION_RESULTS, COLLECTOR_BATCH_STATUSES } from "../constants/collections";
import { calendarDateSchema } from "./calendar-date";
import { queryNumber } from "./query-number";
import { reportAccountFilterFields } from "./report.types";

/**
 * A calendar day in the office's local timezone, e.g. "2025-01-24".
 *
 * Validated for existence as well as shape, so a collection date or an "as of"
 * day the calendar does not contain is a readable 400.
 */
const dateOnlySchema = calendarDateSchema;

/** A non-negative integer number of centavos. */
const centavosSchema = z
  .number()
  .int("Amounts must be whole centavos")
  .nonnegative("Amounts cannot be negative");

/** POST /api/collector-batches — create a batch for a collector with its accounts. */
export const createCollectorBatchSchema = z.object({
  collectorId: z.string().uuid("A collector must be selected"),
  collectionDate: dateOnlySchema,
  serviceAccountIds: z
    .array(z.string().uuid("Each service account id must be a UUID"))
    .min(1, "Assign at least one service account to the batch"),
});
export type CreateCollectorBatchInput = z.infer<typeof createCollectorBatchSchema>;

/** POST /api/collector-batches/:id/assignments — add more accounts to an open batch. */
export const addBatchAssignmentsSchema = z.object({
  serviceAccountIds: z
    .array(z.string().uuid("Each service account id must be a UUID"))
    .min(1, "Assign at least one service account to the batch"),
});
export type AddBatchAssignmentsInput = z.infer<typeof addBatchAssignmentsSchema>;

/**
 * PUT /api/collector-batches/:id/assignments/:serviceAccountId — record the
 * result of visiting one subscriber.
 *
 * A result that represents money ("collected" or "partial") must carry a positive
 * amount and the method it was received by; every other result carries no money.
 */
export const recordCollectionSchema = z
  .object({
    result: z.enum(COLLECTION_RESULTS),
    collectedAmountCentavos: centavosSchema.optional(),
    collectedMethod: z.enum(COLLECTED_METHODS).optional(),
    collectorNotes: z.string().max(500).optional(),
    gcash: z
      .object({
        referenceNumber: z.string().min(1).max(50),
        senderName: z.string().max(100).optional(),
        senderGcashNumber: z.string().max(20).optional(),
      })
      .optional(),
  })
  .superRefine((value, context) => {
    const takesMoney = value.result === "collected" || value.result === "partial";

    if (takesMoney && (value.collectedAmountCentavos ?? 0) <= 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["collectedAmountCentavos"],
        message: "A collected amount greater than zero is required",
      });
    }

    if (takesMoney && value.collectedMethod === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["collectedMethod"],
        message: "The method the money was received by is required",
      });
    }

    if (!takesMoney && value.collectedAmountCentavos !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["collectedAmountCentavos"],
        message: "Only a collected or partial result may carry an amount",
      });
    }

    if (value.collectedMethod === "gcash" && value.gcash === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["gcash"],
        message: "A GCash reference number is required for a GCash collection",
      });
    }
  });
export type RecordCollectionInput = z.infer<typeof recordCollectionSchema>;

/** PUT /api/collector-batches/:id/assignments/:serviceAccountId/void — undo a collection. */
export const voidCollectionSchema = z.object({
  reason: z.string().min(10, "A reason of at least 10 characters is required").max(500),
});
export type VoidCollectionInput = z.infer<typeof voidCollectionSchema>;

/** POST /api/collector-batches/:id/submit — declare the field run finished. */
export const submitBatchSchema = z.object({
  notes: z.string().max(500).optional(),
});
export type SubmitBatchInput = z.infer<typeof submitBatchSchema>;

/**
 * POST /api/collector-batches/:id/remit — record the cash handed in (S4-2).
 *
 * A batch may be remitted more than once. With neither split half supplied the
 * whole amount is cash; with one half supplied the other is the remainder. A
 * negative amount is a correction to an earlier remittance, so the service allows
 * it only when the running total stays non-negative.
 */
export const recordBatchRemittanceSchema = z
  .object({
    amountCentavos: z.number().int("Amounts must be whole centavos"),
    cashAmountCentavos: z.number().int("Amounts must be whole centavos").optional(),
    gcashAmountCentavos: z.number().int("Amounts must be whole centavos").optional(),
    notes: z.string().max(500).optional(),
  })
  .superRefine((value, context) => {
    if (value.amountCentavos === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["amountCentavos"],
        message: "A non-zero remittance amount is required",
      });
      return;
    }

    if (
      value.cashAmountCentavos !== undefined &&
      value.gcashAmountCentavos !== undefined &&
      value.cashAmountCentavos + value.gcashAmountCentavos !== value.amountCentavos
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cashAmountCentavos"],
        message: "The cash and GCash split must add up to the remittance amount",
      });
    }
  });
export type RecordBatchRemittanceInput = z.infer<typeof recordBatchRemittanceSchema>;

/** POST /api/collector-batches/:id/reconcile — reconcile a remitted batch. */
export const reconcileBatchSchema = z.object({
  varianceNotes: z.string().max(1000).optional(),
});
export type ReconcileBatchInput = z.infer<typeof reconcileBatchSchema>;

/** POST /api/collector-batches/:id/close — the separate final sign-off (S4-1). */
export const closeBatchSchema = z.object({
  notes: z.string().max(500).optional(),
});
export type CloseBatchInput = z.infer<typeof closeBatchSchema>;

/** POST /api/collector-batches/:id/cancel — abandon a batch with no collections. */
export const cancelBatchSchema = z.object({
  reason: z.string().max(500).optional(),
});
export type CancelBatchInput = z.infer<typeof cancelBatchSchema>;

/** GET /api/collector-batches — filters for the batch list. */
export const listCollectorBatchesQuerySchema = z.object({
  collectorId: z.string().uuid("The collector id must be a UUID").optional(),
  status: z.enum(COLLECTOR_BATCH_STATUSES).optional(),
  dateFrom: dateOnlySchema.optional(),
  dateTo: dateOnlySchema.optional(),
  page: queryNumber("page", (schema) => schema.int().min(1)).default(1),
  pageSize: queryNumber("pageSize", (schema) => schema.int().min(1).max(200)).default(50),
});
export type ListCollectorBatchesQuery = z.infer<typeof listCollectorBatchesQuerySchema>;

/**
 * GET /api/receivables/ar-aging — the report's "as of" date and its filters (S6-2).
 *
 * The same collector/area/plan/service-type filters every report accepts, so the
 * aging report can be narrowed instead of always returning the whole book.
 */
export const arAgingQuerySchema = z
  .object({
    asOfDate: dateOnlySchema.optional(),
    ...reportAccountFilterFields,
  })
  .strict();
export type ArAgingQuery = z.infer<typeof arAgingQuerySchema>;

/** GET /api/receivables/ar-aging/export — the format to download. */
export const arAgingExportQuerySchema = z
  .object({
    asOfDate: dateOnlySchema.optional(),
    format: z.enum(["xlsx"]).default("xlsx"),
    ...reportAccountFilterFields,
  })
  .strict();
export type ArAgingExportQuery = z.infer<typeof arAgingExportQuerySchema>;

/** GET /api/receivables/overdue — filters for the overdue account list. */
export const overdueAccountsQuerySchema = z.object({
  // Only accounts with no payment in the last N days (omit for any).
  noPaymentInDays: queryNumber("noPaymentInDays", (schema) => schema.int().min(0)).optional(),
  // Only accounts overdue for at least this many consecutive months.
  minConsecutiveOverdueMonths: queryNumber("minConsecutiveOverdueMonths", (schema) =>
    schema.int().min(0)
  ).optional(),
  // Only accounts whose oldest overdue invoice is at least this many days past due.
  minOverdueDays: queryNumber("minOverdueDays", (schema) => schema.int().min(0)).optional(),
  // The shared account filters, so the overdue list can be narrowed to a
  // collector, area, plan, or service type like every other report.
  ...reportAccountFilterFields,
}).strict();
export type OverdueAccountsQuery = z.infer<typeof overdueAccountsQuerySchema>;

/** POST /api/receivables/overdue/suspend — bulk suspension of selected accounts. */
export const suspendOverdueAccountsSchema = z.object({
  serviceAccountIds: z
    .array(z.string().uuid("Each service account id must be a UUID"))
    .min(1, "Select at least one account to suspend"),
  reason: z.string().min(5, "A suspension reason is required").max(500),
});
export type SuspendOverdueAccountsInput = z.infer<typeof suspendOverdueAccountsSchema>;