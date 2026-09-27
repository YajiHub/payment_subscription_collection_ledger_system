// Voiding an invoice: the original row is kept forever, and a credit ledger entry
// reverses the debt the invoice actually created.
//
// An invoice that was never posted has not created any debt yet, so voiding it (a
// draft the operator abandons before it is ever sent) writes NO ledger entry. A
// draft that an advance credit already paid down has created a debt — the credit it
// consumed — so exactly that much is credited back, never the whole total.
//
// A fully paid invoice cannot be voided — the money has already been received, so
// it must be corrected with a payment reversal (Phase 5), not by erasing the debt.

import { eq } from "drizzle-orm";
import type { InvoiceStatus } from "@bcis/shared";

import { db } from "../../db/connection";
import { invoices } from "../../db/schema/billing";
import { ConflictError, NotFoundError } from "../../shared/errors";
import { recordInvoiceVoided } from "../ledger/ledger.service";
import { getInvoiceById, type InvoiceDetail } from "./invoices.service";

/** The voided invoice, plus the status it held before it was voided. */
export interface VoidInvoiceResult {
  invoice: InvoiceDetail;
  /** What the invoice was before the void — the audit trail records this. */
  previousStatus: InvoiceStatus;
}

/**
 * Voids an invoice and records the reversing credit entry.
 *
 * The status change and the ledger credit commit together, so an invoice can never
 * be marked void without the reversal appearing in the ledger. When the invoice had
 * debited nothing, no entry is written and the ledger is left untouched.
 */
export async function voidInvoice(
  invoiceId: string,
  reason: string,
  voidedByUserId: string
): Promise<VoidInvoiceResult> {
  const previousStatus = await db.transaction(async (tx) => {
    const invoice = await tx
      .select({
        id: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        serviceAccountId: invoices.serviceAccountId,
        status: invoices.status,
        totalAmountCentavos: invoices.totalAmountCentavos,
        remainingBalanceCentavos: invoices.remainingBalanceCentavos,
        billingPeriodYear: invoices.billingPeriodYear,
        billingPeriodMonth: invoices.billingPeriodMonth,
      })
      .from(invoices)
      .where(eq(invoices.id, invoiceId))
      .limit(1)
      .for("update")
      .then((rows) => rows[0]);

    if (invoice === undefined) {
      throw new NotFoundError("Invoice not found");
    }

    if (invoice.status === "void") {
      throw new ConflictError("Invoice is already voided");
    }

    if (invoice.status === "paid") {
      throw new ConflictError("Cannot void a fully paid invoice. Use a payment reversal instead.");
    }

    // A CREDITED invoice was settled by an advance credit, so posting it wrote no
    // ledger debit of its own to reverse. Voiding it would hand the credit back and
    // erase the record that the credit was spent, so it is refused like a paid
    // invoice: correct it by reversing the credit instead.
    if (invoice.status === "credited") {
      throw new ConflictError(
        "Cannot void an invoice settled by advance credit. Reverse the credit instead."
      );
    }

    // Write the credit first so the invoice can point at the entry that reversed it.
    // A draft that was never posted (and never paid down by an advance credit) has
    // debited nothing, so this writes no entry and returns an empty id.
    const reversalEntryId = await recordInvoiceVoided(tx, invoice, reason, voidedByUserId);

    await tx
      .update(invoices)
      .set({
        status: "void",
        voidedAt: new Date(),
        voidedBy: voidedByUserId,
        voidedByTransactionId: reversalEntryId === "" ? null : reversalEntryId,
        notes: reason,
      })
      .where(eq(invoices.id, invoiceId));

    return invoice.status;
  });

  // Re-read outside the transaction so the returned document reflects committed state.
  return { invoice: await getInvoiceById(invoiceId), previousStatus };
}
