// Writes the financial entries that billing, payments, and manual adjustments create.
//
// Ledger entries are NEVER created directly by a route or handler — always through
// one of these functions, so the balance arithmetic and the debit/credit direction
// stay in one place. They are also NEVER updated and NEVER deleted: a correction is
// always a new, offsetting entry.
//
// Ordering and concurrency
// ------------------------
// Every entry carries a `sequenceNumber` that starts at 1 and increases by one per
// service account. The running balance is only meaningful as a chain, so writers
// for the SAME service account must be serialized. Each write takes a transaction
// advisory lock keyed by the service account id BEFORE reading the previous balance
// and sequence number. Two concurrent postings for one account therefore queue;
// two for different accounts do not block each other. A unique index on
// (service_account_id, sequence_number) is the database-level backstop if the lock
// were ever bypassed.
//
// The balance is COMPUTED from the entries — there is no balance column anywhere.

import { and, asc, desc, eq, lt, sql } from "drizzle-orm";

import { getMonthYearLabel, type LedgerEntryType } from "@bcis/shared";
import { db, type DbExecutor } from "../../db/connection";
import { DEBIT_ENTRY_TYPES, ledgerEntries } from "../../db/schema/ledger";
import type { NewLedgerEntry } from "../../db/schema/ledger";
import { computeRunningBalanceCentavos, verifyLedgerChain } from "./ledger-integrity";
import type { LedgerIntegrityResult } from "./ledger-integrity";

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

// The same direction rule, but only for the debit side: what one invoice has
// charged the account. Used by the void workflow to credit back no more than this.
const invoiceDebitExpression = sql<number>`coalesce(sum(case when ${ledgerEntries.entryType} in (${debitTypeList}) then ${ledgerEntries.amountCentavos} else 0 end), 0)`;

/** The balance and the next sequence number a writer needs, from the latest entry. */
interface LedgerState {
  balanceCentavos: number;
  nextSequenceNumber: number;
}

/**
 * Serializes writers for one service account for the rest of the current
 * transaction. The lock is keyed by the account id and released automatically when
 * the transaction ends, so a crash can never leave the ledger permanently locked.
 */
export async function lockServiceAccountLedger(
  executor: DbExecutor,
  serviceAccountId: string
): Promise<void> {
  await executor.execute(sql`select pg_advisory_xact_lock(hashtext(${serviceAccountId}))`);
}

/**
 * Reads the latest entry of an account in ONE query: its running balance is the
 * current balance, and its sequence number + 1 is the next free position.
 *
 * Reading the last entry (rather than summing every row) is what lets the ledger
 * page show a balance in O(1) and proves the balance is derived from the entries,
 * never stored.
 */
async function loadLedgerState(
  executor: DbExecutor,
  serviceAccountId: string
): Promise<LedgerState> {
  const latestEntry = await executor
    .select({
      balanceCentavos: ledgerEntries.runningBalanceCentavos,
      sequenceNumber: ledgerEntries.sequenceNumber,
    })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.serviceAccountId, serviceAccountId))
    .orderBy(desc(ledgerEntries.sequenceNumber), desc(ledgerEntries.id))
    .limit(1)
    .then((rows) => rows[0]);

  return {
    balanceCentavos: Number(latestEntry?.balanceCentavos ?? 0),
    nextSequenceNumber: Number(latestEntry?.sequenceNumber ?? 0) + 1,
  };
}

/**
 * The current balance of a service account, read from its latest ledger entry.
 *
 * A positive balance means the subscriber owes money, zero means current, and a
 * negative balance means they hold an advance credit. There is no balance column:
 * this value always comes from the ledger.
 */
export async function getCurrentBalanceCentavos(
  executor: DbExecutor,
  serviceAccountId: string
): Promise<number> {
  const state = await loadLedgerState(executor, serviceAccountId);
  return state.balanceCentavos;
}

/**
 * The balance computed from scratch by summing every entry.
 *
 * Used by the integrity check and by tests to confirm the running-balance chain
 * agrees with the arithmetic. Slower than reading the latest entry, which is the
 * point — it is a second, independent way to arrive at the same number.
 */
export async function getComputedBalanceCentavos(
  executor: DbExecutor,
  serviceAccountId: string
): Promise<number> {
  const balance = await executor
    .select({ balanceCentavos: balanceExpression })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.serviceAccountId, serviceAccountId))
    .then((rows) => rows[0]?.balanceCentavos ?? 0);

  return Number(balance);
}

/**
 * The balance as it stood immediately before `instant`.
 *
 * This is the opening balance of a statement: the sum of every entry dated before
 * the statement period. With no prior entries it is 0.
 */
export async function getBalanceBeforeCentavos(
  executor: DbExecutor,
  serviceAccountId: string,
  instant: Date
): Promise<number> {
  const balance = await executor
    .select({ balanceCentavos: balanceExpression })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.serviceAccountId, serviceAccountId),
        lt(ledgerEntries.entryDate, instant)
      )
    )
    .then((rows) => rows[0]?.balanceCentavos ?? 0);

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
    .orderBy(asc(ledgerEntries.sequenceNumber), asc(ledgerEntries.id));

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
 * Builds one ledger entry bound to the transaction: it locks the account, reads the
 * latest balance and sequence number, and computes the running balance from the
 * direction of `entryType`.
 */
async function buildLedgerEntry(
  executor: DbExecutor,
  input: {
    serviceAccountId: string;
    entryType: LedgerEntryType;
    amountCentavos: number;
    description: string;
    createdByUserId: string;
    invoiceId?: string | null;
    paymentId?: string | null;
  }
): Promise<NewLedgerEntry> {
  await lockServiceAccountLedger(executor, input.serviceAccountId);
  const state = await loadLedgerState(executor, input.serviceAccountId);

  return {
    serviceAccountId: input.serviceAccountId,
    entryType: input.entryType,
    amountCentavos: input.amountCentavos,
    sequenceNumber: state.nextSequenceNumber,
    runningBalanceCentavos: computeRunningBalanceCentavos(
      state.balanceCentavos,
      input.entryType,
      input.amountCentavos
    ),
    description: input.description,
    invoiceId: input.invoiceId ?? null,
    paymentId: input.paymentId ?? null,
    createdBy: input.createdByUserId,
  };
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
  const entry = await buildLedgerEntry(executor, {
    serviceAccountId: input.serviceAccountId,
    entryType: "advance_credit_applied",
    amountCentavos: input.amountCentavos,
    description: `Advance Credit Applied — Invoice ${input.invoiceNumber}`,
    invoiceId: input.invoiceId,
    createdByUserId: input.createdByUserId,
  });

  await executor.insert(ledgerEntries).values(entry);
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

  const entry = await buildLedgerEntry(executor, {
    serviceAccountId: invoice.serviceAccountId,
    entryType: "invoice_posted",
    amountCentavos: debitCentavos,
    description: `Invoice ${invoice.invoiceNumber} — ${periodLabel(invoice)}`,
    invoiceId: invoice.id,
    createdByUserId,
  });

  const inserted = await executor
    .insert(ledgerEntries)
    .values(entry)
    .returning({ id: ledgerEntries.id })
    .then((rows) => rows[0]);

  return inserted?.id ?? "";
}

/**
 * Records the credit that reverses a voided invoice. The invoice row is kept.
 *
 * The amount comes from the ledger (`getInvoiceDebitedCentavos`), never from
 * `invoice.totalAmountCentavos`: the invoice's total says what it WOULD cost, while
 * the ledger says what it actually owes — the two differ for a draft that was never
 * posted, which is exactly the case that must not be credited.
 */
export async function recordInvoiceVoided(
  executor: DbExecutor,
  invoice: InvoiceForLedger,
  reason: string,
  createdByUserId: string
): Promise<string> {
  // Credit back exactly what this invoice actually debited, never more. A draft that
  // was never posted debited nothing, so it is voided with no ledger entry at all;
  // a draft an advance credit already paid down debited exactly that much.
  const debitedCentavos = await getInvoiceDebitedCentavos(executor, invoice);

  if (debitedCentavos <= 0) {
    return "";
  }

  const entry = await buildLedgerEntry(executor, {
    serviceAccountId: invoice.serviceAccountId,
    entryType: "invoice_void",
    amountCentavos: debitedCentavos,
    description: `Invoice ${invoice.invoiceNumber} Voided — ${reason}`,
    invoiceId: invoice.id,
    createdByUserId,
  });

  const inserted = await executor
    .insert(ledgerEntries)
    .values(entry)
    .returning({ id: ledgerEntries.id })
    .then((rows) => rows[0]);

  return inserted?.id ?? "";
}

/**
 * What this invoice has ACTUALLY debited to the ledger.
 *
 * An invoice debits the ledger when it is posted (its still-owed balance), when an
 * advance credit is applied to it while it is still a draft, and when a late fee is
 * charged against it. A draft that was never posted and was never touched by an
 * advance credit has debited nothing, so this is 0.
 *
 * This is the amount a void may credit: money that never reached the ledger must
 * never be credited back out of it, or the account's balance would fall below what
 * it owed before the invoice existed.
 */
async function getInvoiceDebitedCentavos(
  executor: DbExecutor,
  invoice: { id: string; serviceAccountId: string }
): Promise<number> {
  const rows = await executor
    .select({ debitedCentavos: invoiceDebitExpression })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.serviceAccountId, invoice.serviceAccountId),
        eq(ledgerEntries.invoiceId, invoice.id)
      )
    );

  return Number(rows[0]?.debitedCentavos ?? 0);
}

/** Records the debit created when a late fee is added to an overdue invoice. */
export async function recordLateFeeApplied(
  executor: DbExecutor,
  invoice: InvoiceForLedger,
  lateFeeCentavos: number,
  createdByUserId: string
): Promise<string> {
  const entry = await buildLedgerEntry(executor, {
    serviceAccountId: invoice.serviceAccountId,
    entryType: "late_fee",
    amountCentavos: lateFeeCentavos,
    description: `Late Fee — Invoice ${invoice.invoiceNumber}`,
    invoiceId: invoice.id,
    createdByUserId,
  });

  const inserted = await executor
    .insert(ledgerEntries)
    .values(entry)
    .returning({ id: ledgerEntries.id })
    .then((rows) => rows[0]);

  return inserted?.id ?? "";
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
  await lockServiceAccountLedger(executor, payment.serviceAccountId);
  const state = await loadLedgerState(executor, payment.serviceAccountId);

  const entries: NewLedgerEntry[] = [];
  // Build the entries one after another so each carries the running balance after it.
  let sequenceNumber = state.nextSequenceNumber;
  let runningBalance = state.balanceCentavos;

  if (payment.allocatedCentavos > 0) {
    runningBalance = computeRunningBalanceCentavos(
      runningBalance,
      "payment_received",
      payment.allocatedCentavos
    );
    entries.push({
      serviceAccountId: payment.serviceAccountId,
      entryType: "payment_received",
      amountCentavos: payment.allocatedCentavos,
      sequenceNumber: sequenceNumber,
      runningBalanceCentavos: runningBalance,
      description: `Payment ${payment.receiptNumber}`,
      paymentId: payment.id,
      createdBy: createdByUserId,
    });
    sequenceNumber += 1;
  }

  if (payment.advanceCreditCentavos > 0) {
    runningBalance = computeRunningBalanceCentavos(
      runningBalance,
      "advance_credit",
      payment.advanceCreditCentavos
    );
    entries.push({
      serviceAccountId: payment.serviceAccountId,
      entryType: "advance_credit",
      amountCentavos: payment.advanceCreditCentavos,
      sequenceNumber: sequenceNumber,
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
  const entry = await buildLedgerEntry(executor, {
    serviceAccountId: payment.serviceAccountId,
    entryType: "payment_reversal",
    amountCentavos: payment.amountCentavos,
    description: `Payment ${payment.receiptNumber} Reversed — ${reason}`,
    paymentId: payment.id,
    createdByUserId,
  });

  await executor.insert(ledgerEntries).values(entry);
}

/**
 * Records an administrator's manual adjustment (a debit or a credit).
 *
 * The reason becomes the entry's description, and manual entries are never
 * updated or deleted afterwards — a mistake is corrected with another manual
 * entry that says so.
 */
export async function recordManualEntry(
  executor: DbExecutor,
  input: {
    serviceAccountId: string;
    entryType: "manual_debit" | "manual_credit";
    amountCentavos: number;
    reason: string;
    createdByUserId: string;
  }
): Promise<string> {
  const label = input.entryType === "manual_debit" ? "Manual Debit" : "Manual Credit";
  const entry = await buildLedgerEntry(executor, {
    serviceAccountId: input.serviceAccountId,
    entryType: input.entryType,
    amountCentavos: input.amountCentavos,
    description: `${label} — ${input.reason}`,
    createdByUserId: input.createdByUserId,
  });

  const inserted = await executor
    .insert(ledgerEntries)
    .values(entry)
    .returning({ id: ledgerEntries.id })
    .then((rows) => rows[0]);

  return inserted?.id ?? "";
}

/**
 * Verifies that an account's running balances are internally consistent and its
 * sequence numbers are unbroken.
 *
 * The pure decision lives in `verifyLedgerChain`; this function only fetches the
 * entries. It is used as an admin diagnostic and by the acceptance tests, which
 * inject a corrupted chain and expect `isValid: false`.
 */
export async function verifyLedgerIntegrity(
  serviceAccountId: string,
  executor: DbExecutor = db
): Promise<LedgerIntegrityResult> {
  const entries = await executor
    .select({
      id: ledgerEntries.id,
      sequenceNumber: ledgerEntries.sequenceNumber,
      entryType: ledgerEntries.entryType,
      amountCentavos: ledgerEntries.amountCentavos,
      runningBalanceCentavos: ledgerEntries.runningBalanceCentavos,
    })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.serviceAccountId, serviceAccountId))
    .orderBy(asc(ledgerEntries.sequenceNumber), asc(ledgerEntries.id));

  return verifyLedgerChain(entries);
}
