// Payment constants shared by the client and the server.
//
// Amounts are always integer centavos (see types/money.ts). A receipt number is
// permanent: an Official Receipt number is never reused, even after a reversal —
// the reversal gets its own RV number and both remain in the audit trail.

import { PAYMENT_METHODS, type PaymentMethod } from "./statuses";

// The lifecycle of a payment row.
//
//   pending_verification → the money is CLAIMED, not received: a GCash payment
//                          whose reference a verifier has not confirmed yet. It
//                          has no allocations and no ledger entries, so it cannot
//                          move a balance. (S3-2)
//   posted               → the money is received. For GCash this is the state the
//                          verifier moves the payment to, and it is the value the
//                          spec calls VERIFIED: the verifier identity and
//                          timestamp are recorded on the gcash_payments row.
//   reversed             → cancelled by a reversal; the row is kept forever.
//   rejected             → a GCash payment a verifier refused, with a mandatory
//                          reason. The invoice is untouched.
//
// Only `posted` counts as money received, so every existing report that filters on
// `status === "posted"` excludes pending and rejected payments automatically.
export const PAYMENT_STATUSES = [
  "pending_verification",
  "posted",
  "reversed",
  "rejected",
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** Human-readable payment status names, used in badges and filters. */
export const PAYMENT_STATUS_LABELS = {
  pending_verification: "Pending Verification",
  posted: "Posted",
  reversed: "Reversed",
  rejected: "Rejected",
} as const satisfies Record<PaymentStatus, string>;

/** Human-readable payment method names, used on screen and on receipts. */
export const PAYMENT_METHOD_LABELS = {
  cash: "Cash",
  gcash: "GCash",
  check: "Cheque",
  bank_transfer: "Bank Transfer",
  other: "Other",
} as const satisfies Record<PaymentMethod, string>;

/**
 * The methods a cashier may post across the counter.
 *
 * The database enum, the shared `PAYMENT_METHODS` list and this list are the same
 * five values (S3-1). Bank transfer, cheque and other are posted exactly like cash
 * — the allocation algorithm does not care how the money arrived.
 */
export const POSTABLE_PAYMENT_METHODS = PAYMENT_METHODS;
export type PostablePaymentMethod = (typeof POSTABLE_PAYMENT_METHODS)[number];

/**
 * The methods whose money is already in hand when it is recorded, so it can be
 * allocated straight away. GCash is excluded on purpose: its split is applied when
 * a verifier confirms the transfer, not when a teller types the reference.
 */
export const MANUALLY_ALLOCATABLE_PAYMENT_METHODS = [
  "cash",
  "bank_transfer",
  "check",
  "other",
] as const;
export type ManuallyAllocatablePaymentMethod =
  (typeof MANUALLY_ALLOCATABLE_PAYMENT_METHODS)[number];

/**
 * How short a justification may be. A manual split and a rejection both move or
 * refuse money, so neither is allowed without one that says why.
 */
export const MANUAL_ALLOCATION_REASON_MIN_LENGTH = 10;
export const GCASH_REJECTION_REASON_MIN_LENGTH = 10;

/**
 * Where a GCash payment stands in the verification workflow, as the API reports it.
 *
 * This is DERIVED from `payments.status` (see `gcashVerificationStatus` in the
 * server's payments module) rather than stored twice: `payments.status` is the one
 * authority on whether a payment counts as money received, and `verified` here
 * means the same thing as `posted` there.
 */
export const GCASH_VERIFICATION_STATUSES = [
  "pending_verification",
  "verified",
  "rejected",
  "reversed",
] as const;
export type GcashVerificationStatus = (typeof GCASH_VERIFICATION_STATUSES)[number];

/** Human-readable verification-status names, used in the verification queue. */
export const GCASH_VERIFICATION_STATUS_LABELS = {
  pending_verification: "Pending Verification",
  verified: "Verified",
  rejected: "Rejected",
  reversed: "Reversed",
} as const satisfies Record<GcashVerificationStatus, string>;

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
