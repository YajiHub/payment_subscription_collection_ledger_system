// Overdue accounts: the service accounts that owe money past the due date, with
// how many consecutive months they have been overdue, what they owe, who collects
// them, and when they last paid.
//
// The summarising logic is a pure function so the filters ("no payment in N days",
// "at least N consecutive overdue months") can be tested without a database.
//
// All amounts are integer centavos.

import { and, eq, gt, inArray, lt } from "drizzle-orm";

import { db, type DbExecutor } from "../../db/connection";
import { invoices } from "../../db/schema/billing";
import { payments } from "../../db/schema/payments";
import { serviceAccounts, subscribers, subscriptionPlans } from "../../db/schema/subscribers";
import { users } from "../../db/schema/users";

const OUTSTANDING_INVOICE_STATUSES = ["posted", "partially_paid", "overdue"] as const;
const MILLISECONDS_PER_DAY = 1000 * 60 * 60 * 24;

/** One overdue invoice as the query returns it. */
export interface OverdueInvoiceRow {
  serviceAccountId: string;
  remainingBalanceCentavos: number;
  billingPeriodYear: number | null;
  billingPeriodMonth: number | null;
  dueDate: string;
  serviceAccountNumber: string;
  subscriberId: string;
  subscriberFirstName: string;
  subscriberLastName: string;
  planName: string;
  storedConsecutiveOverdueMonths: number;
  collectorId: string | null;
  collectorName: string | null;
}

/** The most recent payment date for one service account, or null when never paid. */
export interface LastPaymentRow {
  serviceAccountId: string;
  paymentDate: string;
}

/** One overdue account as the list screen shows it. */
export interface OverdueAccount {
  serviceAccountId: string;
  serviceAccountNumber: string;
  subscriberId: string;
  subscriberName: string;
  planName: string;
  consecutiveOverdueMonths: number;
  totalOverdueCentavos: number;
  collectorId: string | null;
  collectorName: string | null;
  lastPaymentDate: string | null;
}

export interface ListOverdueAccountsFilters {
  /** Only accounts whose last payment is older than this many days (or has never paid). */
  noPaymentInDays?: number;
  /** Only accounts overdue for at least this many consecutive months. */
  minConsecutiveOverdueMonths?: number;
}

/**
 * Counts the consecutive months a subscriber has been overdue, ending at the most
 * recent overdue billing period.
 *
 * A subscriber overdue for November, December, and January is 3 months overdue; a
 * gap (November, then January) breaks the run at January and reports 1.
 */
export function countConsecutiveOverdueMonths(
  periods: readonly { year: number; month: number }[]
): number {
  const encodedPeriods = [
    ...new Set(periods.map((period) => period.year * 12 + (period.month - 1))),
  ].sort((left, right) => right - left);

  if (encodedPeriods.length === 0) {
    return 0;
  }

  let consecutiveMonths = 1;
  for (let index = 1; index < encodedPeriods.length; index += 1) {
    const previous = encodedPeriods[index - 1];
    const current = encodedPeriods[index];

    if (previous !== undefined && current !== undefined && previous - current === 1) {
      consecutiveMonths += 1;
      continue;
    }
    break;
  }

  return consecutiveMonths;
}

/** Whole days between a calendar date and an instant, never negative. */
function daysSince(dateOnly: string, asOfDate: Date): number {
  const elapsed = Math.floor((asOfDate.getTime() - new Date(`${dateOnly}T00:00:00Z`).getTime()) / MILLISECONDS_PER_DAY);
  return elapsed < 0 ? 0 : elapsed;
}

/**
 * Turns overdue invoice rows and payment rows into the overdue account list.
 *
 * Pure: it applies the filters and the consecutive-month calculation without
 * touching the database.
 */
export function summarizeOverdueAccounts(
  invoiceRows: readonly OverdueInvoiceRow[],
  lastPayments: readonly LastPaymentRow[],
  filters: ListOverdueAccountsFilters,
  asOfDate: Date
): OverdueAccount[] {
  const lastPaymentByAccount = new Map(
    lastPayments.map((payment) => [payment.serviceAccountId, payment.paymentDate])
  );

  const accounts = new Map<string, OverdueAccount>();
  const periodsByAccount = new Map<string, { year: number; month: number }[]>();

  for (const invoice of invoiceRows) {
    const running = accounts.get(invoice.serviceAccountId) ?? {
      serviceAccountId: invoice.serviceAccountId,
      serviceAccountNumber: invoice.serviceAccountNumber,
      subscriberId: invoice.subscriberId,
      subscriberName: `${invoice.subscriberLastName}, ${invoice.subscriberFirstName}`,
      planName: invoice.planName,
      consecutiveOverdueMonths: 0,
      totalOverdueCentavos: 0,
      collectorId: invoice.collectorId,
      collectorName: invoice.collectorName,
      lastPaymentDate: lastPaymentByAccount.get(invoice.serviceAccountId) ?? null,
    };

    running.totalOverdueCentavos += invoice.remainingBalanceCentavos;
    accounts.set(invoice.serviceAccountId, running);

    if (invoice.billingPeriodYear !== null && invoice.billingPeriodMonth !== null) {
      const periods = periodsByAccount.get(invoice.serviceAccountId) ?? [];
      periods.push({ year: invoice.billingPeriodYear, month: invoice.billingPeriodMonth });
      periodsByAccount.set(invoice.serviceAccountId, periods);
    }

    // Keep the greatest stored fallback for accounts whose overdue invoices are one-off.
    if (invoice.storedConsecutiveOverdueMonths > running.consecutiveOverdueMonths) {
      running.consecutiveOverdueMonths = invoice.storedConsecutiveOverdueMonths;
    }
  }

  const results = [...accounts.values()].map((account) => {
    // The real count comes from the invoice periods; the stored column is only a
    // fallback when there is no monthly period to count.
    const computedMonths = countConsecutiveOverdueMonths(
      periodsByAccount.get(account.serviceAccountId) ?? []
    );

    return {
      ...account,
      consecutiveOverdueMonths:
        computedMonths > 0 ? computedMonths : account.consecutiveOverdueMonths,
    };
  });

  return results.filter((account) => {
    if (
      filters.minConsecutiveOverdueMonths !== undefined &&
      account.consecutiveOverdueMonths < filters.minConsecutiveOverdueMonths
    ) {
      return false;
    }

    if (filters.noPaymentInDays !== undefined) {
      if (account.lastPaymentDate === null) {
        return true; // never paid — always qualifies
      }
      return daysSince(account.lastPaymentDate, asOfDate) > filters.noPaymentInDays;
    }

    return true;
  });
}

/** Loads the overdue invoices and the last payment date for the listed accounts. */
export async function listOverdueAccounts(
  filters: ListOverdueAccountsFilters,
  asOfDate: Date,
  executor: DbExecutor = db
): Promise<OverdueAccount[]> {
  const asOfDateOnly = asOfDate.toISOString().slice(0, 10);

  const invoiceRows: OverdueInvoiceRow[] = await executor
    .select({
      serviceAccountId: invoices.serviceAccountId,
      remainingBalanceCentavos: invoices.remainingBalanceCentavos,
      billingPeriodYear: invoices.billingPeriodYear,
      billingPeriodMonth: invoices.billingPeriodMonth,
      dueDate: invoices.dueDate,
      serviceAccountNumber: serviceAccounts.serviceAccountNumber,
      subscriberId: subscribers.id,
      subscriberFirstName: subscribers.firstName,
      subscriberLastName: subscribers.lastName,
      planName: subscriptionPlans.name,
      storedConsecutiveOverdueMonths: serviceAccounts.consecutiveOverdueMonths,
      collectorId: serviceAccounts.assignedCollectorId,
      collectorName: users.fullName,
    })
    .from(invoices)
    .innerJoin(serviceAccounts, eq(invoices.serviceAccountId, serviceAccounts.id))
    .innerJoin(subscribers, eq(serviceAccounts.subscriberId, subscribers.id))
    .innerJoin(subscriptionPlans, eq(serviceAccounts.planId, subscriptionPlans.id))
    .leftJoin(users, eq(serviceAccounts.assignedCollectorId, users.id))
    .where(
      and(
        inArray(invoices.status, [...OUTSTANDING_INVOICE_STATUSES]),
        gt(invoices.remainingBalanceCentavos, 0),
        lt(invoices.dueDate, asOfDateOnly)
      )
    );

  const accountIds = [...new Set(invoiceRows.map((row) => row.serviceAccountId))];

  const lastPayments: LastPaymentRow[] =
    accountIds.length === 0
      ? []
      : await executor
          .select({
            serviceAccountId: payments.serviceAccountId,
            paymentDate: payments.paymentDate,
          })
          .from(payments)
          .where(
            and(
              inArray(payments.serviceAccountId, accountIds),
              eq(payments.status, "posted")
            )
          );

  const mostRecentByAccount = new Map<string, string>();
  for (const payment of lastPayments) {
    const known = mostRecentByAccount.get(payment.serviceAccountId);
    if (known === undefined || payment.paymentDate > known) {
      mostRecentByAccount.set(payment.serviceAccountId, payment.paymentDate);
    }
  }

  return summarizeOverdueAccounts(
    invoiceRows,
    [...mostRecentByAccount.entries()].map(([serviceAccountId, paymentDate]) => ({
      serviceAccountId,
      paymentDate,
    })),
    filters,
    asOfDate
  );
}

export interface OverdueSummaryBucket {
  bucket: string;
  accountCount: number;
  totalCentavos: number;
}

/** Counts and totals overdue accounts, grouped by how many months they are overdue. */
export function summarizeOverdueBuckets(accounts: readonly OverdueAccount[]): OverdueSummaryBucket[] {
  const buckets = [
    { bucket: "1_month", accountCount: 0, totalCentavos: 0 },
    { bucket: "2_months", accountCount: 0, totalCentavos: 0 },
    { bucket: "3_months_or_more", accountCount: 0, totalCentavos: 0 },
  ];

  for (const account of accounts) {
    let target = buckets[0];
    if (account.consecutiveOverdueMonths >= 3) {
      target = buckets[2];
    } else if (account.consecutiveOverdueMonths === 2) {
      target = buckets[1];
    }

    if (target !== undefined) {
      target.accountCount += 1;
      target.totalCentavos += account.totalOverdueCentavos;
    }
  }

  return buckets;
}