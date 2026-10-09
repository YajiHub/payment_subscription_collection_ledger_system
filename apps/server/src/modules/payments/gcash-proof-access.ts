// Who may view a GCash proof screenshot.
//
// A proof screenshot is customer evidence: it shows the sender's name and GCash
// number. `payments:read` is "list and read payments and receipts" — the amounts,
// receipt numbers and statuses — and does NOT cover these images. Leaving the
// download route on `payments:read` let a Technician (who holds nothing relevant)
// and a Read-only Viewer fetch any subscriber's proof.
//
// The rule enforced here is the narrow set of people who legitimately need the
// image:
//
//   • a user who can ACT on the claim — `payments:verify_gcash` or
//     `payments:reject_gcash` (the verifier must see the proof to accept or refuse
//     it), or
//   • the user who recorded the claim (`payments.posted_by`), reviewing the proof
//     they attached.
//
// The accounting auditor is deliberately NOT granted proof viewing. The auditor's
// job is reading the financial trail, which the amounts and statuses already give
// them; the customer-identifying image is not needed for it and is the personal
// data this defect was about. `audit:read` therefore does not open the image.

import type { FastifyReply, FastifyRequest } from "fastify";
import type { Permission } from "@bcis/shared";

import { callerHasPermission } from "../../shared/rbac/permission-resolver";
import { sendError } from "../../shared/response";
import { getPaymentRecorderId } from "./payments.service";

/** The permissions that let a caller act on a claim, and so see its proof. */
const PROOF_VIEW_PERMISSIONS = ["payments:verify_gcash", "payments:reject_gcash"] as const;

/**
 * A preHandler that guards the proof download route.
 *
 * `permission` names the primary authority so the RBAC sweep test reads the real
 * value. Every role that holds `payments:reject_gcash` also holds
 * `payments:verify_gcash` in the compiled and stored matrices, so the swept
 * allowed/denied sets match exactly.
 */
export interface GcashProofViewGuard {
  (request: FastifyRequest, reply: FastifyReply): Promise<void>;
  permission: Permission;
}

/** Whether the caller holds the authority to act on the claim they are viewing. */
async function callerMayActOnClaim(request: FastifyRequest): Promise<boolean> {
  const user = request.user;
  if (user === undefined) {
    return false;
  }

  for (const permission of PROOF_VIEW_PERMISSIONS) {
    if (await callerHasPermission(user.id, user.role, permission)) {
      return true;
    }
  }

  return false;
}

/**
 * The preHandler for `GET /api/payments/gcash/screenshot/:paymentId`.
 *
 * The permission check runs first so the common wrong-role request is refused
 * without a database read; only a caller with neither permission is asked whether
 * they recorded this claim.
 */
export function requireGcashProofViewer(): GcashProofViewGuard {
  const guard = async function requireGcashProofViewer(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    if (request.user === undefined) {
      return sendError(reply, 401, "UNAUTHORIZED", "Authentication required");
    }

    const { paymentId } = request.params as { paymentId?: string };

    if (await callerMayActOnClaim(request)) {
      return;
    }

    // The recorder may view the proof they attached. A missing payment (or one
    // they did not record) reads as not-theirs, so the refusal is the same 403
    // whether or not the row exists.
    const recordedBy =
      typeof paymentId === "string" && paymentId.length > 0
        ? await getPaymentRecorderId(paymentId)
        : null;

    if (recordedBy !== null && recordedBy === request.user.id) {
      return;
    }

    return sendError(
      reply,
      403,
      "FORBIDDEN",
      "Access denied. A GCash proof screenshot may only be viewed by the cashier who recorded the claim or by a user who may verify or reject it."
    );
  } as GcashProofViewGuard;

  guard.permission = "payments:verify_gcash";
  return guard;
}
