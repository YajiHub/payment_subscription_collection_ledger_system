// The monthly billing job — the most financially critical code in the system.
//
// It must be correct and idempotent: running it twice for the same month produces
// exactly ONE invoice per active service account. The duplicate check and the
// insert happen inside one transaction that locks the service account, so two
// concurrent runs cannot both insert for the same period.
//
// Invoices are generated as DRAFT: an admin or billing clerk can review the batch
// before it affects subscriber balances, then post it in one action.

import { and, desc, eq, ne, sql } from "drizzle-orm";

import { db, type DbExecutor } from "../../db/connection";
import { billingRuns, invoiceLineItems, invoices } from "../../db/schema/billing";
import { serviceAccounts, subscriptionPlans } from "../../db/schema/subscribers";
import { formatDateOnly } from "../../shared/date";
import { MONTHLY_INVOICE_DUE_DAY } from "@bcis/shared";
import { buildMonthlyInvoiceDraft } from "./invoice-calculations";
import { allocateNextInvoiceNumber } from "./invoice-number.service";
import { postInvoiceInTransaction } from "./invoices.service";
import { applyAdvanceCreditToInvoice } from "./advance-credit.service";

/** One active service account that the billing job may invoice. */
export interface BillingCandidate {
  serviceAccountId: string;
  planName: string;
  monthlyRateCentavos: number;
}

export interface BillingRunResult {
  billingPeriodYear: number;
  billingPeriodMonth: number;
  totalServiceAccountsProcessed: number;
  totalInvoicesGenerated: number;
  totalInvoicesSkipped: number;
  totalAmountBilledCentavos: number;
}

export interface BillingPreview {
  billingPeriodYear: number;
  billingPeriodMonth: number;
  accountsToBill: number;
  accountsAlreadyBilled: number;
  totalAmountCentavos: number;
}

/** Every active service account, with the plan facts needed to invoice it. */
async function loadActiveBillingCandidates(executor: DbExecutor): Promise<BillingCandidate[]> {
  return executor
    .select({
      serviceAccountId: serviceAccounts.id,
      planName: subscriptionPlans.name,
      monthlyRateCentavos: subscriptionPlans.monthlyRateCentavos,
    })
    .from(serviceAccounts)
    .innerJoin(subscriptionPlans, eq(serviceAccounts.planId, subscriptionPlans.id))
    .where(eq(serviceAccounts.status, "active"));
}

/**
 * The existing, non-void monthly invoice for a service account and period, if any.
 *
 * A VOIDED invoice is deliberately excluded: it no longer represents a debt, so a
 * corrected invoice may be generated for the same period.
 */
async function findExistingMonthlyInvoice(
  executor: DbExecutor,
  serviceAccountId: string,
  year: number,
  month: number
): Promise<{ id: string } | undefined> {
  return executor
    .select({ id: invoices.id })
    .from(invoices)
    .where(
      and(
        eq(invoices.serviceAccountId, serviceAccountId),
        eq(invoices.billingPeriodYear, year),
        eq(invoices.billingPeriodMonth, month),
        ne(invoices.status, "void")
      )
    )
    .limit(1)
    .then((rows) => rows[0]);
}

/** The date a monthly invoice falls due: the configured day of the billing month. */
function monthlyDueDate(year: number, month: number): string {
  return formatDateOnly(new Date(year, month - 1, MONTHLY_INVOICE_DUE_DAY));
}

/**
 * Generates one draft invoice for a single account, or reports that one already
 * exists. Opens its own transaction; used by callers that bill one account.
 *
 * Returns true when a new invoice was created, false when the account was skipped.
 */
export async function generateInvoiceForCandidate(
  candidate: BillingCandidate,
  year: number,
  month: number,
  initiatedByUserId: string
): Promise<boolean> {
  return db.transaction((tx) =>
    generateInvoiceForCandidateInTransaction(tx, candidate, year, month, initiatedByUserId)
  );
}

/**
 * The body of `generateInvoiceForCandidate`, running inside a caller-supplied
 * transaction. The monthly billing run uses this so every invoice it generates
 * commits together with the billing-run record.
 */
export async function generateInvoiceForCandidateInTransaction(
  tx: DbExecutor,
  candidate: BillingCandidate,
  year: number,
  month: number,
  initiatedByUserId: string
): Promise<boolean> {
  // Lock the account row so two billing runs cannot both pass the duplicate
  // check and insert for the same period.
  await tx
    .select({ id: serviceAccounts.id })
    .from(serviceAccounts)
    .where(eq(serviceAccounts.id, candidate.serviceAccountId))
    .limit(1)
    .for("update");

  const existingInvoice = await findExistingMonthlyInvoice(
    tx,
    candidate.serviceAccountId,
    year,
    month
  );

  if (existingInvoice !== undefined) {
    return false; // already billed for this period — skip silently
  }

  const draft = buildMonthlyInvoiceDraft(
    { name: candidate.planName, monthlyRateCentavos: candidate.monthlyRateCentavos },
    year,
    month
  );
  const invoiceDate = formatDateOnly(new Date());
  const invoiceNumber = await allocateNextInvoiceNumber(tx, year, month);

  const insertedInvoice = await tx
    .insert(invoices)
    .values({
      invoiceNumber,
      serviceAccountId: candidate.serviceAccountId,
      invoiceType: "monthly_subscription",
      status: "draft",
      billingPeriodYear: year,
      billingPeriodMonth: month,
      invoiceDate,
      dueDate: monthlyDueDate(year, month),
      subtotalCentavos: draft.subtotalCentavos,
      lateFeesCentavos: draft.lateFeesCentavos,
      totalAmountCentavos: draft.totalAmountCentavos,
      remainingBalanceCentavos: draft.remainingBalanceCentavos,
      createdBy: initiatedByUserId,
    })
    .returning({ id: invoices.id })
    .then((rows) => rows[0]);

  if (insertedInvoice === undefined) {
    return false;
  }

  // The invoice and its line items commit together, or not at all.
  await tx.insert(invoiceLineItems).values(
    draft.lineItems.map((lineItem) => ({
      invoiceId: insertedInvoice.id,
      description: lineItem.description,
      quantity: lineItem.quantity,
      unitAmountCentavos: lineItem.unitAmountCentavos,
      totalAmountCentavos: lineItem.totalAmountCentavos,
    }))
  );

  // Any credit the subscriber is holding pays down this new invoice before it
  // ever reaches them.
  await applyAdvanceCreditToInvoice(
    tx,
    {
      id: insertedInvoice.id,
      invoiceNumber,
      serviceAccountId: candidate.serviceAccountId,
      totalAmountCentavos: draft.totalAmountCentavos,
    },
    initiatedByUserId
  );

  return true;
}

/**
 * The advisory lock that serializes billing runs for one period.
 *
 * Runs for different periods do not block each other. The lock is transaction
 * scoped, so it is released on commit or rollback.
 */
async function lockBillingPeriod(
  executor: DbExecutor,
  year: number,
  month: number
): Promise<void> {
  await executor.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`billing-run-${year}-${month}`}))`
  );
}

/** The completed run already recorded for a period, if any. */
async function findCompletedBillingRun(
  executor: DbExecutor,
  year: number,
  month: number
): Promise<typeof billingRuns.$inferSelect | undefined> {
  return executor
    .select()
    .from(billingRuns)
    .where(
      and(
        eq(billingRuns.billingPeriodYear, year),
        eq(billingRuns.billingPeriodMonth, month),
        eq(billingRuns.status, "completed")
      )
    )
    .orderBy(desc(billingRuns.ranAt))
    .limit(1)
    .then((rows) => rows[0]);
}

/**
 * Generates one draft invoice per active service account for a billing period.
 *
 * The whole run is ONE transaction: the billing_runs record and every generated
 * invoice commit together or not at all. A failure half way through therefore
 * leaves no invoices and no run record — a re-run starts from a clean slate.
 * Before touching anything the transaction takes a period-scoped advisory lock, so
 * two concurrent runs for the same period are serialized rather than racing on
 * invoice numbers.
 *
 * The run is idempotent per period: if a completed run already exists, its
 * recorded outcome is returned and nothing is generated again. Re-running is safe
 * and produces the same result.
 */
export async function runMonthlyBilling(
  billingYear: number,
  billingMonth: number,
  initiatedByUserId: string
): Promise<BillingRunResult> {
  return db.transaction(async (tx) => {
    await lockBillingPeriod(tx, billingYear, billingMonth);

    const completedRun = await findCompletedBillingRun(tx, billingYear, billingMonth);
    if (completedRun !== undefined) {
      return {
        billingPeriodYear: billingYear,
        billingPeriodMonth: billingMonth,
        totalServiceAccountsProcessed: completedRun.totalServiceAccountsProcessed,
        totalInvoicesGenerated: completedRun.totalInvoicesGenerated,
        totalInvoicesSkipped: completedRun.totalInvoicesSkipped,
        totalAmountBilledCentavos: completedRun.totalAmountBilledCentavos,
      };
    }

    const candidates = await loadActiveBillingCandidates(tx);

    let generated = 0;
    let skipped = 0;
    let totalAmountBilledCentavos = 0;

    for (const candidate of candidates) {
      const wasGenerated = await generateInvoiceForCandidateInTransaction(
        tx,
        candidate,
        billingYear,
        billingMonth,
        initiatedByUserId
      );

      if (wasGenerated) {
        generated++;
        totalAmountBilledCentavos += candidate.monthlyRateCentavos;
      } else {
        skipped++;
      }
    }

    // Commits with every invoice generated above, or rolls back with them.
    await tx.insert(billingRuns).values({
      billingPeriodYear: billingYear,
      billingPeriodMonth: billingMonth,
      totalServiceAccountsProcessed: candidates.length,
      totalInvoicesGenerated: generated,
      totalInvoicesSkipped: skipped,
      totalAmountBilledCentavos,
      status: "completed",
      ranBy: initiatedByUserId,
    });

    return {
      billingPeriodYear: billingYear,
      billingPeriodMonth: billingMonth,
      totalServiceAccountsProcessed: candidates.length,
      totalInvoicesGenerated: generated,
      totalInvoicesSkipped: skipped,
      totalAmountBilledCentavos,
    };
  });
}

/**
 * Describes what the billing job would do, without writing anything.
 * The dashboard shows this behind the confirmation dialog.
 */
export async function previewMonthlyBilling(
  billingYear: number,
  billingMonth: number
): Promise<BillingPreview> {
  const candidates = await loadActiveBillingCandidates(db);

  let accountsToBill = 0;
  let accountsAlreadyBilled = 0;
  let totalAmountCentavos = 0;

  for (const candidate of candidates) {
    const existingInvoice = await findExistingMonthlyInvoice(
      db,
      candidate.serviceAccountId,
      billingYear,
      billingMonth
    );

    if (existingInvoice === undefined) {
      accountsToBill++;
      totalAmountCentavos += candidate.monthlyRateCentavos;
    } else {
      accountsAlreadyBilled++;
    }
  }

  return {
    billingPeriodYear: billingYear,
    billingPeriodMonth: billingMonth,
    accountsToBill,
    accountsAlreadyBilled,
    totalAmountCentavos,
  };
}

/**
 * Posts every draft invoice for a period, creating one ledger debit each.
 *
 * The whole batch is ONE transaction: either every draft posts, or none does, so a
 * failure part way through can never leave a period half posted. The posting guard
 * still rejects anything that is not a draft, so an invoice voided between the
 * read and the write is never resurrected.
 */
export async function postAllDraftInvoices(
  billingYear: number,
  billingMonth: number,
  postedByUserId: string
): Promise<number> {
  return db.transaction(async (tx) => {
    const draftInvoices = await tx
      .select({ id: invoices.id })
      .from(invoices)
      .where(
        and(
          eq(invoices.status, "draft"),
          eq(invoices.billingPeriodYear, billingYear),
          eq(invoices.billingPeriodMonth, billingMonth)
        )
      );

    let posted = 0;
    for (const draftInvoice of draftInvoices) {
      await postInvoiceInTransaction(tx, draftInvoice.id, postedByUserId);
      posted++;
    }

    return posted;
  });
}

/** The billing run history, newest first. */
export async function listBillingRuns(): Promise<(typeof billingRuns.$inferSelect)[]> {
  return db.select().from(billingRuns).orderBy(desc(billingRuns.ranAt));
}
