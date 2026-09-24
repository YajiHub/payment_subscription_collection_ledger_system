// The Daily Collection Summary (report R1).
//
// It answers one operational question: what did the office take in on this day?
// That is the end-of-day cash count, so the report lists every POSTED payment and
// shows the cash total, the GCash total, and the grand total.
//
// A REVERSED payment is not money in the drawer, so it is not listed and not
// counted. The row is still in the database — it is simply not a collection.
//
// The summing rule lives in `summarizePayments`, which the management dashboard
// also calls for "collected this month". One rule, two reports: a daily figure and
// the month-to-date figure can never disagree about the same payment.
//
// All arithmetic is on integer centavos.

import { and, asc, eq, gte, lt } from "drizzle-orm";

import type { PaymentMethod, PaymentStatus } from "@bcis/shared";
import { db, type DbExecutor } from "../../db/connection";
import { payments } from "../../db/schema/payments";
import { serviceAccounts, subscribers } from "../../db/schema/subscribers";
import { users } from "../../db/schema/users";

/** One payment as the report query returns it. */
export interface DailyCollectionPaymentRow {
  receiptNumber: string;
  postedAt: Date;
  subscriberFirstName: string;
  subscriberLastName: string;
  serviceAccountNumber: string;
  paymentMethod: PaymentMethod;
  status: PaymentStatus;
  amountCentavos: number;
  postedByName: string;
}

/** One line of the report. */
export interface DailyCollectionItem {
  receiptNumber: string;
  postedAt: Date;
  subscriberName: string;
  serviceAccountNumber: string;
  paymentMethod: PaymentMethod;
  amountCentavos: number;
  postedByName: string;
}

export interface PaymentTotals {
  paymentCount: number;
  cashTotalCentavos: number;
  gcashTotalCentavos: number;
  grandTotalCentavos: number;
}

export interface DailyCollectionReport {
  date: string;
  items: DailyCollectionItem[];
  totals: PaymentTotals;
}

/** The fields the totals rule reads — kept minimal so it can be reused anywhere. */
export interface SummablePayment {
  status: PaymentStatus;
  paymentMethod: PaymentMethod;
  amountCentavos: number;
}

/**
 * Adds up a set of payments.
 *
 * Only POSTED payments count: a reversed payment is no longer money received. The
 * grand total is the sum of every posted payment; the cash and GCash totals are
 * the two drawers a cashier actually counts.
 */
export function summarizePayments(paymentsToSum: readonly SummablePayment[]): PaymentTotals {
  const totals: PaymentTotals = {
    paymentCount: 0,
    cashTotalCentavos: 0,
    gcashTotalCentavos: 0,
    grandTotalCentavos: 0,
  };

  for (const payment of paymentsToSum) {
    if (payment.status !== "posted") {
      continue;
    }

    totals.paymentCount += 1;
    totals.grandTotalCentavos += payment.amountCentavos;

    if (payment.paymentMethod === "cash") {
      totals.cashTotalCentavos += payment.amountCentavos;
    } else if (payment.paymentMethod === "gcash") {
      totals.gcashTotalCentavos += payment.amountCentavos;
    }
  }

  return totals;
}

/**
 * Builds the report for one day from the day's payment rows.
 *
 * Pure and database-free, so the totals rule is tested directly: the grand total
 * must equal the sum of the listed amounts, and reversed payments must not appear.
 */
export function buildDailyCollectionReport(
  paymentRows: readonly DailyCollectionPaymentRow[],
  date: string
): DailyCollectionReport {
  const items: DailyCollectionItem[] = paymentRows
    .filter((payment) => payment.status === "posted")
    .map((payment) => ({
      receiptNumber: payment.receiptNumber,
      postedAt: payment.postedAt,
      subscriberName: `${payment.subscriberLastName}, ${payment.subscriberFirstName}`,
      serviceAccountNumber: payment.serviceAccountNumber,
      paymentMethod: payment.paymentMethod,
      amountCentavos: payment.amountCentavos,
      postedByName: payment.postedByName,
    }));

  return { date, items, totals: summarizePayments(paymentRows) };
}

/**
 * The payments posted in the day range [dateFrom, dateToExclusive).
 *
 * An exclusive end day is used because an inclusive one is where off-by-one bugs
 * live; a single day is simply [day, nextDay).
 */
export async function loadPaymentsBetween(
  dateFrom: string,
  dateToExclusive: string,
  executor: DbExecutor = db
): Promise<DailyCollectionPaymentRow[]> {
  return executor
    .select({
      receiptNumber: payments.receiptNumber,
      postedAt: payments.postedAt,
      subscriberFirstName: subscribers.firstName,
      subscriberLastName: subscribers.lastName,
      serviceAccountNumber: serviceAccounts.serviceAccountNumber,
      paymentMethod: payments.paymentMethod,
      status: payments.status,
      amountCentavos: payments.amountCentavos,
      postedByName: users.fullName,
    })
    .from(payments)
    .innerJoin(serviceAccounts, eq(payments.serviceAccountId, serviceAccounts.id))
    .innerJoin(subscribers, eq(serviceAccounts.subscriberId, subscribers.id))
    .innerJoin(users, eq(payments.postedBy, users.id))
    .where(and(gte(payments.paymentDate, dateFrom), lt(payments.paymentDate, dateToExclusive)))
    .orderBy(asc(payments.postedAt), asc(payments.receiptNumber));
}
