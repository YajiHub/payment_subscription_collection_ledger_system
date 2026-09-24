// The Monthly Billing Summary (report R2).
//
// It answers: what did the billing job bill for this period, how much of it has
// been paid, and how much is still owed? Management reads it after a billing run.
//
// Invoices are selected by BILLING PERIOD, not by invoice date, so the report lines
// up exactly with the billing run it reviews — including a reconnection fee invoice
// generated later within the same run.
//
// A VOIDED invoice is listed (its status is part of the audit trail) but is excluded
// from the totals: a voided invoice no longer represents revenue, and counting it
// would inflate "Total Invoiced" above what the billing run billed.
//
// `summarizeInvoices` is also what the management dashboard uses for "invoiced this
// month", so the two figures can never disagree.

import { and, asc, eq, gte, lt } from "drizzle-orm";

import type { InvoiceStatus } from "@bcis/shared";
import { db, type DbExecutor } from "../../db/connection";
import { invoices } from "../../db/schema/billing";
import { serviceAccounts, subscribers, subscriptionPlans } from "../../db/schema/subscribers";
import { getMonthYearLabel } from "@bcis/shared";

/** One invoice as the report query returns it. */
export interface MonthlyBillingInvoiceRow {
  invoiceNumber: string;
  subscriberFirstName: string;
  subscriberLastName: string;
  serviceAccountNumber: string;
  planName: string;
  invoiceDate: string;
  dueDate: string;
  totalAmountCentavos: number;
  paidAmountCentavos: number;
  remainingBalanceCentavos: number;
  status: InvoiceStatus;
}

/** One line of the report. */
export interface MonthlyBillingItem {
  invoiceNumber: string;
  subscriberName: string;
  serviceAccountNumber: string;
  planName: string;
  invoiceDate: string;
  dueDate: string;
  totalAmountCentavos: number;
  paidAmountCentavos: number;
  remainingBalanceCentavos: number;
  status: InvoiceStatus;
}

export interface InvoiceTotals {
  invoiceCount: number;
  totalInvoicedCentavos: number;
  totalPaidCentavos: number;
  totalOutstandingCentavos: number;
}

export interface MonthlyBillingReport {
  year: number;
  month: number;
  periodLabel: string;
  items: MonthlyBillingItem[];
  totals: InvoiceTotals;
}

/** The fields the totals rule reads — kept minimal so it can be reused anywhere. */
export interface SummableInvoice {
  status: InvoiceStatus;
  totalAmountCentavos: number;
  paidAmountCentavos: number;
  remainingBalanceCentavos: number;
}

/**
 * Adds up a set of invoices, skipping voided ones.
 *
 * `totalOutstanding` is the sum of the remaining balances rather than
 * `totalInvoiced - totalPaid`, because the remaining balance is the value the
 * database actually stores. Computing it two ways is how two screens start
 * reporting different numbers.
 */
export function summarizeInvoices(invoicesToSum: readonly SummableInvoice[]): InvoiceTotals {
  const totals: InvoiceTotals = {
    invoiceCount: 0,
    totalInvoicedCentavos: 0,
    totalPaidCentavos: 0,
    totalOutstandingCentavos: 0,
  };

  for (const invoice of invoicesToSum) {
    if (invoice.status === "void") {
      continue;
    }

    totals.invoiceCount += 1;
    totals.totalInvoicedCentavos += invoice.totalAmountCentavos;
    totals.totalPaidCentavos += invoice.paidAmountCentavos;
    totals.totalOutstandingCentavos += invoice.remainingBalanceCentavos;
  }

  return totals;
}

/** Builds the report for one billing period from that period's invoice rows. */
export function buildMonthlyBillingReport(
  invoiceRows: readonly MonthlyBillingInvoiceRow[],
  year: number,
  month: number
): MonthlyBillingReport {
  const items: MonthlyBillingItem[] = invoiceRows.map((invoice) => ({
    invoiceNumber: invoice.invoiceNumber,
    subscriberName: `${invoice.subscriberLastName}, ${invoice.subscriberFirstName}`,
    serviceAccountNumber: invoice.serviceAccountNumber,
    planName: invoice.planName,
    invoiceDate: invoice.invoiceDate,
    dueDate: invoice.dueDate,
    totalAmountCentavos: invoice.totalAmountCentavos,
    paidAmountCentavos: invoice.paidAmountCentavos,
    remainingBalanceCentavos: invoice.remainingBalanceCentavos,
    status: invoice.status,
  }));

  return {
    year,
    month,
    periodLabel: getMonthYearLabel(month, year),
    items,
    totals: summarizeInvoices(invoiceRows),
  };
}

/** The invoice columns every monthly-billing query selects. */
const monthlyBillingColumns = {
  invoiceNumber: invoices.invoiceNumber,
  subscriberFirstName: subscribers.firstName,
  subscriberLastName: subscribers.lastName,
  serviceAccountNumber: serviceAccounts.serviceAccountNumber,
  planName: subscriptionPlans.name,
  invoiceDate: invoices.invoiceDate,
  dueDate: invoices.dueDate,
  totalAmountCentavos: invoices.totalAmountCentavos,
  paidAmountCentavos: invoices.paidAmountCentavos,
  remainingBalanceCentavos: invoices.remainingBalanceCentavos,
  status: invoices.status,
} as const;

/** Every invoice generated for a billing period, newest invoice number last. */
export async function loadInvoicesForPeriod(
  year: number,
  month: number,
  executor: DbExecutor = db
): Promise<MonthlyBillingInvoiceRow[]> {
  return executor
    .select(monthlyBillingColumns)
    .from(invoices)
    .innerJoin(serviceAccounts, eq(invoices.serviceAccountId, serviceAccounts.id))
    .innerJoin(subscribers, eq(serviceAccounts.subscriberId, subscribers.id))
    .innerJoin(subscriptionPlans, eq(serviceAccounts.planId, subscriptionPlans.id))
    .where(and(eq(invoices.billingPeriodYear, year), eq(invoices.billingPeriodMonth, month)))
    .orderBy(asc(invoices.invoiceNumber));
}

/**
 * Every invoice dated in the day range [dateFrom, dateToExclusive).
 *
 * Used by the dashboard for "invoiced this month", where the invoice DATE (not the
 * billing period) is what falls inside the calendar month.
 */
export async function loadInvoicesBetween(
  dateFrom: string,
  dateToExclusive: string,
  executor: DbExecutor = db
): Promise<MonthlyBillingInvoiceRow[]> {
  return executor
    .select(monthlyBillingColumns)
    .from(invoices)
    .innerJoin(serviceAccounts, eq(invoices.serviceAccountId, serviceAccounts.id))
    .innerJoin(subscribers, eq(serviceAccounts.subscriberId, subscribers.id))
    .innerJoin(subscriptionPlans, eq(serviceAccounts.planId, subscriptionPlans.id))
    .where(and(gte(invoices.invoiceDate, dateFrom), lt(invoices.invoiceDate, dateToExclusive)))
    .orderBy(asc(invoices.invoiceNumber));
}
