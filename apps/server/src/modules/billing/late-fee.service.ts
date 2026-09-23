// Late fees: adds a fee line item to invoices that are past due and still owe money.
//
// Run after the due date. Each overdue invoice gets one late fee line for the run,
// its totals are increased, and a matching ledger debit is written.

import { and, eq, gt, inArray, lt } from "drizzle-orm";

import { db } from "../../db/connection";
import { invoiceLineItems, invoices } from "../../db/schema/billing";
import { formatDateOnly } from "../../shared/date";
import { ValidationError } from "../../shared/errors";
import { buildLateFeeLineItem } from "./invoice-calculations";
import { recordLateFeeApplied } from "../ledger/ledger.service";

/** The invoice fields the late-fee job needs, plus its current totals. */
interface OverdueInvoice {
  id: string;
  invoiceNumber: string;
  serviceAccountId: string;
  totalAmountCentavos: number;
  lateFeesCentavos: number;
  remainingBalanceCentavos: number;
  billingPeriodYear: number | null;
  billingPeriodMonth: number | null;
}

/** Posted invoices that are past due and still have an unpaid balance. */
async function findOverdueInvoices(today: Date): Promise<OverdueInvoice[]> {
  return db
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      serviceAccountId: invoices.serviceAccountId,
      totalAmountCentavos: invoices.totalAmountCentavos,
      lateFeesCentavos: invoices.lateFeesCentavos,
      remainingBalanceCentavos: invoices.remainingBalanceCentavos,
      billingPeriodYear: invoices.billingPeriodYear,
      billingPeriodMonth: invoices.billingPeriodMonth,
    })
    .from(invoices)
    .where(
      and(
        inArray(invoices.status, ["posted", "partially_paid", "overdue"]),
        lt(invoices.dueDate, formatDateOnly(today)),
        gt(invoices.remainingBalanceCentavos, 0)
      )
    );
}

/**
 * Adds a late fee to every overdue invoice and returns how many were charged.
 *
 * The fee amount is passed in (from system settings in Phase 9) so the caller owns
 * the policy; this service only applies it consistently.
 */
export async function applyLateFeesToOverdueInvoices(
  lateFeeCentavos: number,
  appliedByUserId: string
): Promise<number> {
  if (lateFeeCentavos <= 0) {
    throw new ValidationError("The late fee must be greater than zero");
  }

  const today = new Date();
  const overdueInvoices = await findOverdueInvoices(today);
  const appliedOnLabel = formatDateOnly(today);

  for (const invoice of overdueInvoices) {
    await db.transaction(async (tx) => {
      const lineItem = buildLateFeeLineItem(lateFeeCentavos, appliedOnLabel);

      await tx.insert(invoiceLineItems).values({
        invoiceId: invoice.id,
        description: lineItem.description,
        quantity: lineItem.quantity,
        unitAmountCentavos: lineItem.unitAmountCentavos,
        totalAmountCentavos: lineItem.totalAmountCentavos,
      });

      await tx
        .update(invoices)
        .set({
          lateFeesCentavos: invoice.lateFeesCentavos + lateFeeCentavos,
          totalAmountCentavos: invoice.totalAmountCentavos + lateFeeCentavos,
          remainingBalanceCentavos: invoice.remainingBalanceCentavos + lateFeeCentavos,
          status: "overdue",
        })
        .where(eq(invoices.id, invoice.id));

      await recordLateFeeApplied(tx, invoice, lateFeeCentavos, appliedByUserId);
    });
  }

  return overdueInvoices.length;
}
