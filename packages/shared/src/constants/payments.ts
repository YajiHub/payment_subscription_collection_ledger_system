// Payment constants shared by the client and the server.
//
// Amounts are always integer centavos (see types/money.ts). A receipt number is
// permanent: an Official Receipt number is never reused, even after a reversal —
// the reversal gets its own RV number and both remain in the audit trail.

import type { PaymentMethod } from "./statuses";

// The lifecycle of a payment row. A reversed payment is kept forever; that is
// the whole point of reversal instead of deletion.
export const PAYMENT_STATUSES = ["posted", "reversed"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** Human-readable payment status names, used in badges and filters. */
export const PAYMENT_STATUS_LABELS = {
  posted: "Posted",
  reversed: "Reversed",
} as const satisfies Record<PaymentStatus, string>;

/** Human-readable payment method names, used on screen and on receipts. */
export const PAYMENT_METHOD_LABELS = {
  cash: "Cash",
  gcash: "GCash",
  check: "Check",
  bank_transfer: "Bank Transfer",
} as const satisfies Record<PaymentMethod, string>;

/**
 * The methods a cashier may post across the counter.
 * The database enum is a superset (check and bank transfer are reserved for later
 * phases); the API accepts only these two today.
 */
export const POSTABLE_PAYMENT_METHODS = ["cash", "gcash"] as const;
export type PostablePaymentMethod = (typeof POSTABLE_PAYMENT_METHODS)[number];

/** Official Receipt numbers look like OR-2025-000042. */
export const RECEIPT_NUMBER_PREFIX = "OR";

/** Reversal receipts look like RV-2025-000042. */
export const REVERSAL_RECEIPT_PREFIX = "RV";

/**
 * The GCash proof screenshot rules from the spec: only these image formats, and
 * never more than 5 MB. Enforced on the server before a single byte is written.
 */
export const GCASH_SCREENSHOT_MAX_BYTES = 5 * 1024 * 1024;
export const GCASH_SCREENSHOT_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type GcashScreenshotMimeType = (typeof GCASH_SCREENSHOT_MIME_TYPES)[number];
