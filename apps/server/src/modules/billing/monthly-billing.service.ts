// The monthly billing job — the most financially critical code in the system.
//
// It must be correct and idempotent: running it twice for the same month produces
// exactly ONE invoice per active service account. The duplicate check and the
// insert happen inside one transaction that locks the service account, so two
// concurrent runs cannot both insert for the same period.
//
// Invoices are generated as DRAFT: an admin or billing clerk can review the batch
// before it affects subscriber balances, then post it in one action.

import { and, desc, eq, ne } from "drizzle-orm";

import { db, type DbExecutor } from "../../db/connection";
import { billingRuns, invoiceLineItems, invoices } from "../../db/schema/billing";
import { serviceAccounts, subscriptionPlans } from "../../db/schema/subscribers";
import { formatDateOnly } from "../../shared/date";
import { MONTHLY_INVOICE_DUE_DAY } from "@bcis/shared";
import { buildMonthlyInvoiceDraft } from "./invoice-calculations";
import { allocateNextInvoiceNumber } from "./invoice-number.service";
import { postInvoiceForId } from "./invoices.service";

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
 * exists. Runs inside the caller's transaction.
 *
 * Returns true when a new invoice was created, false when the account was skipped.
 */
async function generateInvoiceForCandidate(
  candidate: BillingCandidate,
  year: number,
  month: number,
  initiatedByUserId: string
): Promise<boolean> {
  return db.transaction(async (tx) => {
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

    const insertedInvoice = await tx
      .insert(invoices)
      .values({
        invoiceNumber: await allocateNextInvoiceNumber(tx, year, month),
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

    return true;
  });
}

/**
 * Generates one draft invoice per active service account for a billing period.
 *
 * Safe to re-run: a period that has already been billed is skipped, not duplicated.
 */
export async function runMonthlyBilling(
  billingYear: number,
  billingMonth: number,
  initiatedByUserId: string
): Promise<BillingRunResult> {
  const candidates = await loadActiveBillingCandidates(db);

  let generated = 0;
  let skipped = 0;
  let totalAmountBilledCentavos = 0;

  try {
    for (const candidate of candidates) {
      const wasGenerated = await generateInvoiceForCandidate(
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
  } catch (error) {
    // Record the failed run before rethrowing, so the audit trail shows the attempt.
    await db.insert(billingRuns).values({
      billingPeriodYear: billingYear,
      billingPeriodMonth: billingMonth,
      totalServiceAccountsProcessed: candidates.length,
      totalInvoicesGenerated: generated,
      totalInvoicesSkipped: skipped,
      totalAmountBilledCentavos,
      status: "failed",
      errorDetails: error instanceof Error ? error.message : "Unknown billing error",
      ranBy: initiatedByUserId,
    });

    throw error;
  }

  await db.insert(billingRuns).values({
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
 * Returns how many invoices were posted.
 */
export async function postAllDraftInvoices(
  billingYear: number,
  billingMonth: number,
  postedByUserId: string
): Promise<number> {
  const draftInvoices = await db
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
    await postInvoiceForId(draftInvoice.id, postedByUserId);
    posted++;
  }

  return posted;
}

/** The billing run history, newest first. */
export async function listBillingRuns(): Promise<(typeof billingRuns.$inferSelect)[]> {
  return db.select().from(billingRuns).orderBy(desc(billingRuns.ranAt));
}
