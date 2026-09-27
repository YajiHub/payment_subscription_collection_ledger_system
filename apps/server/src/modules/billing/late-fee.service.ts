// Late fees: adds a fee line item to invoices that are past due and still owe money.
//
// Run after the due date. Each overdue invoice gets one late fee line for the run,
// its totals are increased, and a matching ledger debit is written.
//
// The coarse "overdue invoices" query runs first, but it is only a candidate list:
// every write happens inside a per-invoice transaction that re-reads the invoice
// FOR UPDATE and re-checks its status. That re-read is what stops the job from
// resurrecting an invoice that was voided (or paid) between the candidate read and
// the write, and it stops two concurrent runs from charging the same fee twice.

import { and, eq, gt, inArray, lt } from "drizzle-orm";
import { OUTSTANDING_INVOICE_STATUSES, type InvoiceStatus } from "@bcis/shared";

import { db, type DbExecutor } from "../../db/connection";
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
  status: InvoiceStatus;
  totalAmountCentavos: number;
  lateFeesCentavos: number;
  remainingBalanceCentavos: number;
  billingPeriodYear: number | null;
  billingPeriodMonth: number | null;
}

/** Only these statuses still represent a live debt that a late fee may attach to. */
const CHARGEABLE_STATUSES: readonly InvoiceStatus[] = OUTSTANDING_INVOICE_STATUSES;

/** Posted invoices that are past due and still have an unpaid balance. */
async function findOverdueInvoices(today: Date): Promise<OverdueInvoice[]> {
  return db
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      serviceAccountId: invoices.serviceAccountId,
      status: invoices.status,
      totalAmountCentavos: invoices.totalAmountCentavos,
      lateFeesCentavos: invoices.lateFeesCentavos,
      remainingBalanceCentavos: invoices.remainingBalanceCentavos,
      billingPeriodYear: invoices.billingPeriodYear,
      billingPeriodMonth: invoices.billingPeriodMonth,
    })
    .from(invoices)
    .where(
      and(
        inArray(invoices.status, [...OUTSTANDING_INVOICE_STATUSES]),
        lt(invoices.dueDate, formatDateOnly(today)),
        gt(invoices.remainingBalanceCentavos, 0)
      )
    );
}

/**
 * Re-reads one invoice inside the transaction and locks its row.
 *
 * Returns the freshly-locked invoice only when it is still chargeable; a voided or
 * paid invoice returns undefined so the caller skips it without writing anything.
 */
async function lockChargeableInvoice(
  tx: DbExecutor,
  invoiceId: string
): Promise<OverdueInvoice | undefined> {
  const invoice = await tx
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      serviceAccountId: invoices.serviceAccountId,
      status: invoices.status,
      totalAmountCentavos: invoices.totalAmountCentavos,
      lateFeesCentavos: invoices.lateFeesCentavos,
      remainingBalanceCentavos: invoices.remainingBalanceCentavos,
      billingPeriodYear: invoices.billingPeriodYear,
      billingPeriodMonth: invoices.billingPeriodMonth,
    })
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .limit(1)
    .for("update")
    .then((rows) => rows[0]);

  if (invoice === undefined || !CHARGEABLE_STATUSES.includes(invoice.status)) {
    return undefined;
  }

  return invoice;
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

  let charged = 0;

  for (const candidate of overdueInvoices) {
    const wasCharged = await db.transaction(async (tx) => {
      // Lock and re-check first: a void committed after the candidate read must
      // not be flipped back to overdue or charged a fee.
      const invoice = await lockChargeableInvoice(tx, candidate.id);
      if (invoice === undefined) {
        return false;
      }

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
      return true;
    });

    if (wasCharged) {
      charged++;
    }
  }

  return charged;
}