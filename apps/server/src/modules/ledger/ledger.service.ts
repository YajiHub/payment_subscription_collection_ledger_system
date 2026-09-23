// Writes the financial entries that billing creates.
//
// Ledger entries are NEVER created directly by a route or handler — always through
// one of these functions, so the balance arithmetic and the debit/credit direction
// stay in one place.
//
// Phase 4 posts invoices (debit) and voids them (credit). Phase 5 adds payments,
// and Phase 6 builds the Statement of Account on top of this table.

import { eq, sql } from "drizzle-orm";

import type { DbExecutor } from "../../db/connection";
import { DEBIT_ENTRY_TYPES, ledgerEntries } from "../../db/schema/ledger";
import { getMonthYearLabel } from "@bcis/shared";

/** The invoice fields a ledger entry needs to describe its source document. */
export interface InvoiceForLedger {
  id: string;
  invoiceNumber: string;
  serviceAccountId: string;
  totalAmountCentavos: number;
  billingPeriodYear: number | null;
  billingPeriodMonth: number | null;
}

// A debit increases what the subscriber owes; a credit decreases it.
// Built once from the shared list so a new debit type cannot be forgotten here.
const debitTypeList = sql.join(
  DEBIT_ENTRY_TYPES.map((entryType) => sql`${entryType}`),
  sql`, `
);

const balanceExpression = sql<number>`coalesce(sum(case when ${ledgerEntries.entryType} in (${debitTypeList}) then ${ledgerEntries.amountCentavos} else -${ledgerEntries.amountCentavos} end), 0)`;

/** The current balance of a service account: debits minus credits. */
export async function getCurrentBalanceCentavos(
  executor: DbExecutor,
  serviceAccountId: string
): Promise<number> {
  const balance = await executor
    .select({ balanceCentavos: balanceExpression })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.serviceAccountId, serviceAccountId))
    .then((rows) => rows[0]?.balanceCentavos ?? 0);

  // `pg` may hand back a string for a numeric aggregate; coerce so callers do
  // integer arithmetic, never string concatenation.
  return Number(balance);
}

/** A human label for the invoice's billing period, or a generic fallback. */
function periodLabel(invoice: InvoiceForLedger): string {
  if (invoice.billingPeriodYear === null || invoice.billingPeriodMonth === null) {
    return "one-off charge";
  }
  return getMonthYearLabel(invoice.billingPeriodMonth, invoice.billingPeriodYear);
}

/**
 * Records the debit created when an invoice is posted.
 * Returns the ledger entry id so the invoice can point back at its entry.
 */
export async function recordInvoicePosted(
  executor: DbExecutor,
  invoice: InvoiceForLedger,
  createdByUserId: string
): Promise<string> {
  const previousBalance = await getCurrentBalanceCentavos(executor, invoice.serviceAccountId);

  const entry = await executor
    .insert(ledgerEntries)
    .values({
      serviceAccountId: invoice.serviceAccountId,
      entryType: "invoice_posted",
      amountCentavos: invoice.totalAmountCentavos,
      runningBalanceCentavos: previousBalance + invoice.totalAmountCentavos,
      description: `Invoice ${invoice.invoiceNumber} — ${periodLabel(invoice)}`,
      invoiceId: invoice.id,
      createdBy: createdByUserId,
    })
    .returning({ id: ledgerEntries.id })
    .then((rows) => rows[0]);

  return entry?.id ?? "";
}

/** Records the credit that reverses a voided invoice. The invoice row is kept. */
export async function recordInvoiceVoided(
  executor: DbExecutor,
  invoice: InvoiceForLedger,
  reason: string,
  createdByUserId: string
): Promise<string> {
  const previousBalance = await getCurrentBalanceCentavos(executor, invoice.serviceAccountId);

  const entry = await executor
    .insert(ledgerEntries)
    .values({
      serviceAccountId: invoice.serviceAccountId,
      entryType: "invoice_void",
      amountCentavos: invoice.totalAmountCentavos,
      runningBalanceCentavos: previousBalance - invoice.totalAmountCentavos,
      description: `Invoice ${invoice.invoiceNumber} Voided — ${reason}`,
      invoiceId: invoice.id,
      createdBy: createdByUserId,
    })
    .returning({ id: ledgerEntries.id })
    .then((rows) => rows[0]);

  return entry?.id ?? "";
}

/** Records the debit created when a late fee is added to an overdue invoice. */
export async function recordLateFeeApplied(
  executor: DbExecutor,
  invoice: InvoiceForLedger,
  lateFeeCentavos: number,
  createdByUserId: string
): Promise<string> {
  const previousBalance = await getCurrentBalanceCentavos(executor, invoice.serviceAccountId);

  const entry = await executor
    .insert(ledgerEntries)
    .values({
      serviceAccountId: invoice.serviceAccountId,
      entryType: "late_fee",
      amountCentavos: lateFeeCentavos,
      runningBalanceCentavos: previousBalance + lateFeeCentavos,
      description: `Late Fee — Invoice ${invoice.invoiceNumber}`,
      invoiceId: invoice.id,
      createdBy: createdByUserId,
    })
    .returning({ id: ledgerEntries.id })
    .then((rows) => rows[0]);

  return entry?.id ?? "";
}
