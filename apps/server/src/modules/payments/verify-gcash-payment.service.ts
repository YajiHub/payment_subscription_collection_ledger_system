// The GCash verification workflow (S3-2, S3-3, S12-7).
//
// Section 3.7 splits a GCash payment in two: staff record the transfer, and an
// authorized person confirms it. This module is the second half.
//
//   recorded  → payments.status = pending_verification   (nothing has moved)
//   verify    → payments.status = posted                  (allocated, ledgered,
//                gcash_payments.verified_at / verified_by written)
//   reject    → payments.status = rejected                (invoice untouched, a
//                reason is required and audited)
//
// The screenshot a teller uploads is evidence of a CLAIM. It never marks an account
// paid: only the verify step below writes a ledger entry, and only a caller holding
// `payments:verify_gcash` reaches it (enforced by the route's preHandler).
//
// Both steps run in one transaction, so a verified payment is always fully posted
// and a rejected one is always fully untouched.

import { GCASH_REJECTION_REASON_MIN_LENGTH } from "@bcis/shared";
import { eq } from "drizzle-orm";

import { db, type DbExecutor } from "../../db/connection";
import {
  gcashPayments,
  payments,
  type GcashPayment,
  type Payment,
} from "../../db/schema/payments";
import { audit, type AuditActor } from "../../shared/audit/audit-logger";
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors";
import { recordPaymentPosted } from "../ledger/ledger.service";
import {
  allocatePayment,
  type PaymentAllocationDraft,
} from "./payment-allocation";
import {
  applyAllocationToInvoices,
  loadOutstandingInvoicesOldestFirst,
} from "./post-payment.service";

/**
 * The GCash verification result: the now-posted payment, its GCash detail row, and
 * the exact split that was applied.
 */
export interface GcashVerificationResult {
  payment: Payment;
  gcash: GcashPayment;
  allocations: PaymentAllocationDraft[];
  allocatedCentavos: number;
  advanceCreditCentavos: number;
}

export interface VerifyGcashPaymentInput {
  paymentId: string;
  verifiedByUserId: string;
  actor?: AuditActor;
}

/**
 * Confirms a pending GCash payment, which posts and allocates it.
 *
 * The split is the same oldest-invoice-first sweep cash uses. A manual split is
 * deliberately NOT accepted here: the operator who records the payment does not yet
 * know a verifier will approve it, so `postPayment` refuses to carry one for GCash.
 * See docs/technical/README.md for the boundary this draws.
 */
export async function verifyGcashPayment(
  input: VerifyGcashPaymentInput
): Promise<GcashVerificationResult> {
  return db.transaction((tx) => verifyGcashPaymentWithinTransaction(tx, input));
}

/** Confirms a pending GCash payment inside a transaction the caller already owns. */
export async function verifyGcashPaymentWithinTransaction(
  executor: DbExecutor,
  input: VerifyGcashPaymentInput
): Promise<GcashVerificationResult> {
  const pendingPayment = await loadPaymentForUpdate(executor, input.paymentId);

  if (pendingPayment.paymentMethod !== "gcash") {
    throw new ValidationError("Only a GCash payment goes through verification");
  }

  if (pendingPayment.status !== "pending_verification") {
    throw new ConflictError(
      `Only a GCash payment awaiting verification can be verified; this payment is ${pendingPayment.status}`
    );
  }

  const gcashDetails = await loadGcashDetails(executor, pendingPayment.id);

  const outstandingInvoices = await loadOutstandingInvoicesOldestFirst(
    executor,
    pendingPayment.serviceAccountId
  );

  const allocation = allocatePayment(pendingPayment.amountCentavos, outstandingInvoices);

  await applyAllocationToInvoices(executor, pendingPayment.id, allocation, outstandingInvoices);

  const verifiedAt = new Date();
  await executor
    .update(payments)
    .set({
      status: "posted",
      allocatedCentavos: allocation.allocatedCentavos,
      advanceCreditCentavos: allocation.advanceCreditCentavos,
    })
    .where(eq(payments.id, pendingPayment.id));

  await executor
    .update(gcashPayments)
    .set({ verifiedAt, verifiedBy: input.verifiedByUserId })
    .where(eq(gcashPayments.paymentId, pendingPayment.id));

  const postedPayment: Payment = {
    ...pendingPayment,
    status: "posted",
    allocatedCentavos: allocation.allocatedCentavos,
    advanceCreditCentavos: allocation.advanceCreditCentavos,
  };

  await recordPaymentPosted(executor, postedPayment, input.verifiedByUserId);

  const actor = input.actor ?? { userId: input.verifiedByUserId };
  await audit.gcashPaymentVerified(pendingPayment.id, gcashDetails.gcashReferenceNumber, actor);

  return {
    payment: postedPayment,
    gcash: { ...gcashDetails, verifiedAt, verifiedBy: input.verifiedByUserId },
    allocations: allocation.allocations,
    allocatedCentavos: allocation.allocatedCentavos,
    advanceCreditCentavos: allocation.advanceCreditCentavos,
  };
}

export interface RejectGcashPaymentInput {
  paymentId: string;
  reason: string;
  rejectedByUserId: string;
  actor?: AuditActor;
}

/** Refuses a pending GCash payment. The invoice it aimed at is left untouched. */
export async function rejectGcashPayment(
  input: RejectGcashPaymentInput
): Promise<{ payment: Payment; gcash: GcashPayment }> {
  return db.transaction((tx) => rejectGcashPaymentWithinTransaction(tx, input));
}

/** Refuses a pending GCash payment inside a transaction the caller already owns. */
export async function rejectGcashPaymentWithinTransaction(
  executor: DbExecutor,
  input: RejectGcashPaymentInput
): Promise<{ payment: Payment; gcash: GcashPayment }> {
  const reason = input.reason.trim();

  if (reason.length < GCASH_REJECTION_REASON_MIN_LENGTH) {
    throw new ValidationError(
      `A GCash rejection needs a reason of at least ${GCASH_REJECTION_REASON_MIN_LENGTH} characters`
    );
  }

  const pendingPayment = await loadPaymentForUpdate(executor, input.paymentId);

  if (pendingPayment.paymentMethod !== "gcash") {
    throw new ValidationError("Only a GCash payment goes through verification");
  }

  if (pendingPayment.status !== "pending_verification") {
    throw new ConflictError(
      `Only a GCash payment awaiting verification can be rejected; this payment is ${pendingPayment.status}`
    );
  }

  const gcashDetails = await loadGcashDetails(executor, pendingPayment.id);

  const rejectedAt = new Date();
  await executor
    .update(payments)
    .set({ status: "rejected" })
    .where(eq(payments.id, pendingPayment.id));

  await executor
    .update(gcashPayments)
    .set({
      rejectedAt,
      rejectedBy: input.rejectedByUserId,
      rejectionReason: reason,
    })
    .where(eq(gcashPayments.paymentId, pendingPayment.id));

  await audit.gcashPaymentRejected(
    pendingPayment.id,
    gcashDetails.gcashReferenceNumber,
    reason,
    input.actor ?? { userId: input.rejectedByUserId }
  );

  return {
    payment: { ...pendingPayment, status: "rejected" },
    gcash: {
      ...gcashDetails,
      rejectedAt,
      rejectedBy: input.rejectedByUserId,
      rejectionReason: reason,
    },
  };
}

/** Loads the payment row and locks it, so two verifiers cannot race one decision. */
async function loadPaymentForUpdate(executor: DbExecutor, paymentId: string): Promise<Payment> {
  const payment = await executor
    .select()
    .from(payments)
    .where(eq(payments.id, paymentId))
    .limit(1)
    .for("update")
    .then((rows) => rows[0]);

  if (payment === undefined) {
    throw new NotFoundError("Payment not found");
  }

  return payment;
}

/** Loads the GCash detail row; a GCash payment always has one. */
async function loadGcashDetails(
  executor: DbExecutor,
  paymentId: string
): Promise<GcashPayment> {
  const details = await executor
    .select()
    .from(gcashPayments)
    .where(eq(gcashPayments.paymentId, paymentId))
    .limit(1)
    .then((rows) => rows[0]);

  if (details === undefined) {
    throw new NotFoundError("GCash details not found for this payment");
  }

  return details;
}
