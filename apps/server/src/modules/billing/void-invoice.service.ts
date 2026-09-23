// Voiding an invoice: the original row is kept forever, and a credit ledger entry
// reverses the debit it had created.
//
// A fully paid invoice cannot be voided — the money has already been received, so
// it must be corrected with a payment reversal (Phase 5), not by erasing the debt.

import { eq } from "drizzle-orm";

import { db } from "../../db/connection";
import { invoices } from "../../db/schema/billing";
import { ConflictError, NotFoundError } from "../../shared/errors";
import { recordInvoiceVoided } from "../ledger/ledger.service";
import { getInvoiceById, type InvoiceDetail } from "./invoices.service";

/**
 * Voids an invoice and records the reversing credit entry.
 *
 * The status change and the ledger credit commit together, so an invoice can never
 * be marked void without the reversal appearing in the ledger.
 */
export async function voidInvoice(
  invoiceId: string,
  reason: string,
  voidedByUserId: string
): Promise<InvoiceDetail> {
  await db.transaction(async (tx) => {
    const invoice = await tx
      .select({
        id: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        serviceAccountId: invoices.serviceAccountId,
        status: invoices.status,
        totalAmountCentavos: invoices.totalAmountCentavos,
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

    // Write the credit first so the invoice can point at the entry that reversed it.
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
  });

  // Re-read outside the transaction so the returned document reflects committed state.
  return getInvoiceById(invoiceId);
}
