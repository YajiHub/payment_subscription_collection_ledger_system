// Applies a service account's unapplied advance credit to a newly created draft
// invoice.
//
// An advance credit is money the subscriber paid beyond every outstanding invoice.
// The spec requires it to be applied to the next invoice automatically, so a
// subscriber who overpaid is not billed (and asked to pay) again for money already
// in hand.
//
// This runs inside the caller's billing transaction, with the service account row
// already locked, so two concurrent billing runs cannot spend the same credit twice.
// The invoice is left as a DRAFT: it becomes a debt only when it is posted, at which
// point the ledger debits exactly its remaining (already credit-reduced) balance.

import { eq } from "drizzle-orm";

import type { DbExecutor } from "../../db/connection";
import { invoices } from "../../db/schema/billing";
import { paymentAllocations } from "../../db/schema/payments";
import {
  getCurrentBalanceCentavos,
  getUnappliedAdvanceCreditSources,
  recordAdvanceCreditApplied,
} from "../ledger/ledger.service";

/** The invoice facts needed to apply advance credit to it. */
export interface DraftInvoiceForAdvanceCredit {
  id: string;
  invoiceNumber: string;
  serviceAccountId: string;
  totalAmountCentavos: number;
}

/**
 * Consumes as much unapplied advance credit as the draft invoice can absorb.
 *
 * Returns how many centavos of credit were applied. The invoice's paid amount rises
 * and its remaining balance falls by exactly that amount, each advance payment that
 * funded the credit gets an allocation row, and one `advance_credit_applied` debit
 * records the consumption. Returns 0 when the account has no credit available.
 */
export async function applyAdvanceCreditToInvoice(
  executor: DbExecutor,
  invoice: DraftInvoiceForAdvanceCredit,
  createdByUserId: string
): Promise<number> {
  const balance = await getCurrentBalanceCentavos(executor, invoice.serviceAccountId);
  const availableCredit = balance < 0 ? -balance : 0;

  if (availableCredit <= 0) {
    return 0;
  }

  const sources = await getUnappliedAdvanceCreditSources(
    executor,
    invoice.serviceAccountId,
    availableCredit
  );
  const creditableCentavos = sources.reduce((sum, source) => sum + source.amountCentavos, 0);
  const appliedCentavos = Math.min(creditableCentavos, invoice.totalAmountCentavos);

  if (appliedCentavos <= 0) {
    return 0;
  }

  let remainingToApply = appliedCentavos;
  for (const source of sources) {
    if (remainingToApply <= 0) {
      break;
    }

    const allocatedCentavos = Math.min(source.amountCentavos, remainingToApply);
    remainingToApply -= allocatedCentavos;

    await executor.insert(paymentAllocations).values({
      paymentId: source.paymentId,
      invoiceId: invoice.id,
      allocatedAmountCentavos: allocatedCentavos,
    });
  }

  await executor
    .update(invoices)
    .set({
      paidAmountCentavos: appliedCentavos,
      remainingBalanceCentavos: invoice.totalAmountCentavos - appliedCentavos,
    })
    .where(eq(invoices.id, invoice.id));

  await recordAdvanceCreditApplied(executor, {
    serviceAccountId: invoice.serviceAccountId,
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    amountCentavos: appliedCentavos,
    createdByUserId,
  });

  return appliedCentavos;
}
