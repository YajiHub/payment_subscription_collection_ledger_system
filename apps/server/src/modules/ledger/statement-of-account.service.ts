// The Statement of Account: one service account's full financial history.
//
// It is used both for the on-screen ledger page and for the printable statement.
// Everything it shows comes from the ledger — the running balances, the debit and
// credit columns, and the totals. The reconciliation it must always satisfy is:
//
//     opening balance + total debits − total credits === closing balance
//
// All arithmetic is on integer centavos, so it can never drift.

import { and, asc, eq, gte, lte } from "drizzle-orm";

import {
  isDebitLedgerEntryType,
  type InvoiceStatus,
  type LedgerEntryType,
  type ServiceAccountStatus,
  type ServiceType,
} from "@bcis/shared";
import { db, type DbExecutor } from "../../db/connection";
import { invoices } from "../../db/schema/billing";
import { ledgerEntries } from "../../db/schema/ledger";
import { payments } from "../../db/schema/payments";
import { serviceAccounts, subscribers, subscriptionPlans } from "../../db/schema/subscribers";
import { NotFoundError } from "../../shared/errors";
import { endOfLocalDay, formatDateOnly, startOfLocalDay } from "../../shared/date";
import { getBalanceBeforeCentavos } from "./ledger.service";

/** The service account a statement belongs to. */
export interface StatementServiceAccount {
  id: string;
  serviceAccountNumber: string;
  planName: string;
  serviceType: ServiceType;
  monthlyRateCentavos: number;
  status: ServiceAccountStatus;
}

/** The person the statement is addressed to. */
export interface StatementSubscriber {
  id: string;
  accountNumber: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
  serviceAddress: string;
  serviceBarangay: string;
  serviceMunicipality: string;
  serviceProvince: string;
}

/** One row of the statement: a single ledger entry, split into debit and credit. */
export interface StatementOfAccountLine {
  id: string;
  sequenceNumber: number;
  /** The calendar day of the entry, as YYYY-MM-DD. */
  date: string;
  description: string;
  /** The amount when this is a debit entry, otherwise 0. */
  debitCentavos: number;
  /** The amount when this is a credit entry, otherwise 0. */
  creditCentavos: number;
  /** The running balance after this line. */
  balanceCentavos: number;
  /** The invoice or receipt number this entry came from, or "" for a manual entry. */
  referenceNumber: string;
  /** The status of the invoice this line came from, or null for a payment entry. */
  invoiceStatus: InvoiceStatus | null;
  entryType: LedgerEntryType;
}

export interface StatementOfAccount {
  serviceAccount: StatementServiceAccount;
  subscriber: StatementSubscriber;
  generatedAt: Date;
  /** The inclusive start of the period, or null for "from the beginning". */
  periodFrom: string | null;
  /** The inclusive end of the period, or null for "up to now". */
  periodTo: string | null;
  /** The certification date printed as "As of ...". */
  asOfDate: string;
  lines: StatementOfAccountLine[];
  openingBalanceCentavos: number;
  closingBalanceCentavos: number;
  totalDebitsCentavos: number;
  totalCreditsCentavos: number;
}

/**
 * The office-local calendar day of an instant, as YYYY-MM-DD.
 *
 * The statement's period boundaries are the local day too (D6): a ledger row at
 * 17:30 UTC on the 9th is 01:30 local on the 10th, so filtering on 10 October
 * includes it and the opening balance excludes it. The UTC instants this
 * replaces put the row on the wrong side of both.
 */
function toCalendarDate(instant: Date): string {
  return formatDateOnly(instant);
}

/**
 * Builds the statement of account for one service account.
 *
 * With no period the statement covers the entire ledger; with a period it covers
 * the inclusive range and the opening balance is whatever had accumulated before
 * it, so the running balances stay meaningful rather than restarting at zero.
 */
export async function getStatementOfAccount(
  serviceAccountId: string,
  options: { fromDate?: string; toDate?: string } = {},
  executor: DbExecutor = db
): Promise<StatementOfAccount> {
  const account = await loadStatementHeader(executor, serviceAccountId);

  const periodStart = options.fromDate === undefined ? undefined : startOfLocalDay(options.fromDate);
  const periodEnd = options.toDate === undefined ? undefined : endOfLocalDay(options.toDate);

  const openingBalanceCentavos =
    periodStart === undefined
      ? 0
      : await getBalanceBeforeCentavos(executor, serviceAccountId, periodStart);

  const entries = await executor
    .select({
      id: ledgerEntries.id,
      sequenceNumber: ledgerEntries.sequenceNumber,
      entryDate: ledgerEntries.entryDate,
      entryType: ledgerEntries.entryType,
      amountCentavos: ledgerEntries.amountCentavos,
      runningBalanceCentavos: ledgerEntries.runningBalanceCentavos,
      description: ledgerEntries.description,
      invoiceNumber: invoices.invoiceNumber,
      invoiceStatus: invoices.status,
      receiptNumber: payments.receiptNumber,
    })
    .from(ledgerEntries)
    .leftJoin(invoices, eq(ledgerEntries.invoiceId, invoices.id))
    .leftJoin(payments, eq(ledgerEntries.paymentId, payments.id))
    .where(
      and(
        eq(ledgerEntries.serviceAccountId, serviceAccountId),
        periodStart === undefined ? undefined : gte(ledgerEntries.entryDate, periodStart),
        periodEnd === undefined ? undefined : lte(ledgerEntries.entryDate, periodEnd)
      )
    )
    .orderBy(asc(ledgerEntries.sequenceNumber), asc(ledgerEntries.id));

  const lines: StatementOfAccountLine[] = entries.map((entry) => {
    const isDebit = isDebitLedgerEntryType(entry.entryType);
    return {
      id: entry.id,
      sequenceNumber: entry.sequenceNumber,
      date: toCalendarDate(entry.entryDate),
      description: entry.description,
      debitCentavos: isDebit ? entry.amountCentavos : 0,
      creditCentavos: isDebit ? 0 : entry.amountCentavos,
      balanceCentavos: entry.runningBalanceCentavos,
      referenceNumber: entry.invoiceNumber ?? entry.receiptNumber ?? "",
      invoiceStatus: entry.invoiceStatus ?? null,
      entryType: entry.entryType,
    };
  });

  const totalDebitsCentavos = lines.reduce((sum, line) => sum + line.debitCentavos, 0);
  const totalCreditsCentavos = lines.reduce((sum, line) => sum + line.creditCentavos, 0);
  // Closing is derived by arithmetic, which is exactly what the acceptance test
  // reconciles against the last line's running balance.
  const closingBalanceCentavos =
    openingBalanceCentavos + totalDebitsCentavos - totalCreditsCentavos;

  return {
    serviceAccount: account.serviceAccount,
    subscriber: account.subscriber,
    generatedAt: new Date(),
    periodFrom: options.fromDate ?? null,
    periodTo: options.toDate ?? null,
    asOfDate: options.toDate ?? toCalendarDate(new Date()),
    lines,
    openingBalanceCentavos,
    closingBalanceCentavos,
    totalDebitsCentavos,
    totalCreditsCentavos,
  };
}

/** Loads the service account, its plan, and its subscriber, or throws NotFoundError. */
async function loadStatementHeader(
  executor: DbExecutor,
  serviceAccountId: string
): Promise<{ serviceAccount: StatementServiceAccount; subscriber: StatementSubscriber }> {
  const row = await executor
    .select({
      serviceAccountId: serviceAccounts.id,
      serviceAccountNumber: serviceAccounts.serviceAccountNumber,
      status: serviceAccounts.status,
      planName: subscriptionPlans.name,
      serviceType: subscriptionPlans.serviceType,
      monthlyRateCentavos: subscriptionPlans.monthlyRateCentavos,
      subscriberId: subscribers.id,
      accountNumber: subscribers.accountNumber,
      firstName: subscribers.firstName,
      middleName: subscribers.middleName,
      lastName: subscribers.lastName,
      serviceAddress: subscribers.serviceAddress,
      serviceBarangay: subscribers.serviceBarangay,
      serviceMunicipality: subscribers.serviceMunicipality,
      serviceProvince: subscribers.serviceProvince,
    })
    .from(serviceAccounts)
    .innerJoin(subscribers, eq(serviceAccounts.subscriberId, subscribers.id))
    .innerJoin(subscriptionPlans, eq(serviceAccounts.planId, subscriptionPlans.id))
    .where(eq(serviceAccounts.id, serviceAccountId))
    .limit(1)
    .then((rows) => rows[0]);

  if (row === undefined) {
    throw new NotFoundError("Service account not found");
  }

  return {
    serviceAccount: {
      id: row.serviceAccountId,
      serviceAccountNumber: row.serviceAccountNumber,
      planName: row.planName,
      serviceType: row.serviceType,
      monthlyRateCentavos: row.monthlyRateCentavos,
      status: row.status,
    },
    subscriber: {
      id: row.subscriberId,
      accountNumber: row.accountNumber,
      firstName: row.firstName,
      middleName: row.middleName,
      lastName: row.lastName,
      serviceAddress: row.serviceAddress,
      serviceBarangay: row.serviceBarangay,
      serviceMunicipality: row.serviceMunicipality,
      serviceProvince: row.serviceProvince,
    },
  };
}
