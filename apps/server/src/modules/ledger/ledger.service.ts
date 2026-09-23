// Writes the financial entries that billing creates.
//
// Ledger entries are NEVER created directly by a route or handler — always through
// one of these functions, so the balance arithmetic and the debit/credit direction
// stay in one place.
//
// Phase 4 posts invoices (debit) and voids them (credit). Phase 5 adds payments,
// and Phase 6 builds the Statement of Account on top of this table.

import { and, asc, eq, sql } from "drizzle-orm";

import type { DbExecutor } from "../../db/connection";
import { DEBIT_ENTRY_TYPES, ledgerEntries } from "../../db/schema/ledger";
import type { NewLedgerEntry } from "../../db/schema/ledger";
import { getMonthYearLabel } from "@bcis/shared";

/** The invoice fields a ledger entry needs to describe its source document. */
export interface InvoiceForLedger {
  id: string;
  invoiceNumber: string;
  serviceAccountId: string;
  totalAmountCentavos: number;
  // What the invoice still owes once any advance credit has been applied to it.
  // This is the debt that actually reaches the ledger when the invoice is posted;
  // it equals the total when no credit was applied while the invoice was a draft.
  remainingBalanceCentavos: number;
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

/** One unapplied advance-credit credit, and the payment that created it. */
export interface AdvanceCreditSource {
  paymentId: string;
  amountCentavos: number;
}

/**
 * The advance-credit credits still unapplied, oldest first.
 *
 * An advance credit is written when a payment exceeds every outstanding invoice.
 * Applying it to a later invoice writes an `advance_credit_applied` debit; the two
 * cancel, so the credit still available is the credits minus the debits, consumed
 * oldest first. A credit with no payment (a manual credit) is skipped: it cannot be
 * attributed to the payment that created it.
 */
export async function getUnappliedAdvanceCreditSources(
  executor: DbExecutor,
  serviceAccountId: string,
  availableCentavos: number
): Promise<AdvanceCreditSource[]> {
  if (availableCentavos <= 0) {
    return [];
  }

  const credits = await executor
    .select({
      paymentId: ledgerEntries.paymentId,
      amountCentavos: ledgerEntries.amountCentavos,
    })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.serviceAccountId, serviceAccountId),
        eq(ledgerEntries.entryType, "advance_credit")
      )
    )
    .orderBy(asc(ledgerEntries.entryDate), asc(ledgerEntries.id));

  // Anything already applied comes off the oldest credits first. Clamp at zero so
  // a balance made negative by a non-advance credit (e.g. a manual credit) never
  // makes a credit look bigger than it is.
  const totalCredited = credits.reduce((sum, credit) => sum + credit.amountCentavos, 0);
  let alreadyApplied = Math.max(0, totalCredited - availableCentavos);

  const sources: AdvanceCreditSource[] = [];
  for (const credit of credits) {
    if (alreadyApplied >= credit.amountCentavos) {
      alreadyApplied -= credit.amountCentavos;
      continue;
    }

    const unappliedCentavos = credit.amountCentavos - alreadyApplied;
    alreadyApplied = 0;

    if (credit.paymentId !== null) {
      sources.push({ paymentId: credit.paymentId, amountCentavos: unappliedCentavos });
    }
  }

  return sources;
}

/**
 * Records the debit that consumes an advance credit when it is applied to a new
 * invoice. The advance credit was a credit; this debit cancels it so the same money
 * cannot be spent twice.
 */
export async function recordAdvanceCreditApplied(
  executor: DbExecutor,
  input: {
    serviceAccountId: string;
    invoiceId: string;
    invoiceNumber: string;
    amountCentavos: number;
    createdByUserId: string;
  }
): Promise<void> {
  const previousBalance = await getCurrentBalanceCentavos(executor, input.serviceAccountId);

  await executor.insert(ledgerEntries).values({
    serviceAccountId: input.serviceAccountId,
    entryType: "advance_credit_applied",
    amountCentavos: input.amountCentavos,
    runningBalanceCentavos: previousBalance + input.amountCentavos,
    description: `Advance Credit Applied — Invoice ${input.invoiceNumber}`,
    invoiceId: input.invoiceId,
    createdBy: input.createdByUserId,
  });
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
 *
 * The amount debited is the invoice's remaining balance, not its gross total: an
 * invoice that had advance credit applied while it was a draft is already partly
 * covered, so only the still-owed part becomes a new debt. Returns the ledger
 * entry id so the invoice can point back at its entry.
 */
export async function recordInvoicePosted(
  executor: DbExecutor,
  invoice: InvoiceForLedger,
  createdByUserId: string
): Promise<string> {
  const debitCentavos = invoice.remainingBalanceCentavos;

  // An invoice fully covered by advance credit owes nothing, so posting it adds no
  // debt: the advance_credit_applied debit already recorded what was owed.
  if (debitCentavos <= 0) {
    return "";
  }

  const previousBalance = await getCurrentBalanceCentavos(executor, invoice.serviceAccountId);

  const entry = await executor
    .insert(ledgerEntries)
    .values({
      serviceAccountId: invoice.serviceAccountId,
      entryType: "invoice_posted",
      amountCentavos: debitCentavos,
      runningBalanceCentavos: previousBalance + debitCentavos,
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

/** The payment fields the ledger needs to describe its source document. */
export interface PaymentForLedger {
  id: string;
  receiptNumber: string;
  serviceAccountId: string;
  amountCentavos: number;
  allocatedCentavos: number;
  advanceCreditCentavos: number;
}

/**
 * Records the credit(s) created when a payment is posted.
 *
 * The amount applied to invoices is a `payment_received` credit; anything left
 * over is an `advance_credit` credit that will net against the next invoice. The
 * two entries together credit exactly the amount received, so the ledger balance
 * falls by the full payment and an overpayment naturally shows as a credit
 * balance (a negative ledger balance).
 */
export async function recordPaymentPosted(
  executor: DbExecutor,
  payment: PaymentForLedger,
  createdByUserId: string
): Promise<void> {
  const previousBalance = await getCurrentBalanceCentavos(executor, payment.serviceAccountId);
  const entries: NewLedgerEntry[] = [];

  // Build the entries one after another so each carries the running balance after it.
  let runningBalance = previousBalance;

  if (payment.allocatedCentavos > 0) {
    runningBalance -= payment.allocatedCentavos;
    entries.push({
      serviceAccountId: payment.serviceAccountId,
      entryType: "payment_received",
      amountCentavos: payment.allocatedCentavos,
      runningBalanceCentavos: runningBalance,
      description: `Payment ${payment.receiptNumber}`,
      paymentId: payment.id,
      createdBy: createdByUserId,
    });
  }

  if (payment.advanceCreditCentavos > 0) {
    runningBalance -= payment.advanceCreditCentavos;
    entries.push({
      serviceAccountId: payment.serviceAccountId,
      entryType: "advance_credit",
      amountCentavos: payment.advanceCreditCentavos,
      runningBalanceCentavos: runningBalance,
      description: `Advance Credit — Payment ${payment.receiptNumber}`,
      paymentId: payment.id,
      createdBy: createdByUserId,
    });
  }

  if (entries.length > 0) {
    await executor.insert(ledgerEntries).values(entries);
  }
}

/**
 * Records the debit that cancels a reversed payment's credit.
 *
 * One debit for the full amount received cancels every credit the original
 * payment created (the allocated part and any advance credit), so the net effect
 * on the subscriber's balance is exactly zero.
 */
export async function recordPaymentReversed(
  executor: DbExecutor,
  payment: PaymentForLedger,
  reason: string,
  createdByUserId: string
): Promise<void> {
  const previousBalance = await getCurrentBalanceCentavos(executor, payment.serviceAccountId);

  await executor.insert(ledgerEntries).values({
    serviceAccountId: payment.serviceAccountId,
    entryType: "payment_reversal",
    amountCentavos: payment.amountCentavos,
    runningBalanceCentavos: previousBalance + payment.amountCentavos,
    description: `Payment ${payment.receiptNumber} Reversed — ${reason}`,
    paymentId: payment.id,
    createdBy: createdByUserId,
  });
}
