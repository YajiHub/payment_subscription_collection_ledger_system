// Read side of the ledger: the paginated entry list, the current balance, and the
// header shown above the ledger table.
//
// Balances are always computed from the entries. A positive balance means the
// subscriber owes money, zero means current, and a negative balance is an advance
// credit. There is no balance column to read instead.

import { and, asc, count, desc, eq, gte, lte } from "drizzle-orm";

import {
  isDebitLedgerEntryType,
  type LedgerEntryDirection,
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

/** One ledger entry as the ledger table shows it. */
export interface LedgerEntrySummary {
  id: string;
  sequenceNumber: number;
  entryDate: Date;
  entryType: LedgerEntryType;
  direction: LedgerEntryDirection;
  amountCentavos: number;
  debitCentavos: number;
  creditCentavos: number;
  runningBalanceCentavos: number;
  description: string;
  invoiceId: string | null;
  paymentId: string | null;
  referenceNumber: string;
  createdBy: string;
}

export interface PaginatedLedgerEntries {
  items: LedgerEntrySummary[];
  page: number;
  pageSize: number;
  total: number;
}

/** The account facts shown above the ledger table, plus its current balance. */
export interface LedgerHeader {
  serviceAccountId: string;
  serviceAccountNumber: string;
  subscriberId: string;
  subscriberName: string;
  planName: string;
  serviceType: ServiceType;
  monthlyRateCentavos: number;
  status: ServiceAccountStatus;
  balanceCentavos: number;
  entryCount: number;
  lastEntryAt: Date | null;
}

/** The current balance, read from the latest entry, with a little context. */
export interface ServiceAccountBalance {
  serviceAccountId: string;
  balanceCentavos: number;
  entryCount: number;
  lastEntryAt: Date | null;
}

/** The calendar-day bounds a filter covers, or undefined for "all time". */
function dayBounds(fromDate?: string, toDate?: string): { after?: Date; before?: Date } {
  return {
    after: fromDate === undefined ? undefined : new Date(`${fromDate}T00:00:00.000Z`),
    before: toDate === undefined ? undefined : new Date(`${toDate}T23:59:59.999Z`),
  };
}

/** Lists one page of a service account's ledger entries, oldest first. */
export async function listLedgerEntries(
  serviceAccountId: string,
  filters: { fromDate?: string; toDate?: string; page: number; pageSize: number },
  executor: DbExecutor = db
): Promise<PaginatedLedgerEntries> {
  const { after, before } = dayBounds(filters.fromDate, filters.toDate);

  const conditions = [
    eq(ledgerEntries.serviceAccountId, serviceAccountId),
    after === undefined ? undefined : gte(ledgerEntries.entryDate, after),
    before === undefined ? undefined : lte(ledgerEntries.entryDate, before),
  ];

  const rows = await executor
    .select({
      id: ledgerEntries.id,
      sequenceNumber: ledgerEntries.sequenceNumber,
      entryDate: ledgerEntries.entryDate,
      entryType: ledgerEntries.entryType,
      amountCentavos: ledgerEntries.amountCentavos,
      runningBalanceCentavos: ledgerEntries.runningBalanceCentavos,
      description: ledgerEntries.description,
      invoiceId: ledgerEntries.invoiceId,
      paymentId: ledgerEntries.paymentId,
      createdBy: ledgerEntries.createdBy,
      invoiceNumber: invoices.invoiceNumber,
      receiptNumber: payments.receiptNumber,
    })
    .from(ledgerEntries)
    .leftJoin(invoices, eq(ledgerEntries.invoiceId, invoices.id))
    .leftJoin(payments, eq(ledgerEntries.paymentId, payments.id))
    .where(and(...conditions))
    .orderBy(asc(ledgerEntries.sequenceNumber), asc(ledgerEntries.id))
    .limit(filters.pageSize)
    .offset((filters.page - 1) * filters.pageSize);

  const totalRows = await executor
    .select({ total: count() })
    .from(ledgerEntries)
    .where(and(...conditions));

  const items: LedgerEntrySummary[] = rows.map((row) => {
    const isDebit = isDebitLedgerEntryType(row.entryType);
    return {
      id: row.id,
      sequenceNumber: row.sequenceNumber,
      entryDate: row.entryDate,
      entryType: row.entryType,
      direction: isDebit ? "debit" : "credit",
      amountCentavos: row.amountCentavos,
      debitCentavos: isDebit ? row.amountCentavos : 0,
      creditCentavos: isDebit ? 0 : row.amountCentavos,
      runningBalanceCentavos: row.runningBalanceCentavos,
      description: row.description,
      invoiceId: row.invoiceId,
      paymentId: row.paymentId,
      referenceNumber: row.invoiceNumber ?? row.receiptNumber ?? "",
      createdBy: row.createdBy,
    };
  });

  return {
    items,
    page: filters.page,
    pageSize: filters.pageSize,
    total: Number(totalRows[0]?.total ?? 0),
  };
}

/** The current balance of a service account and how many entries produced it. */
export async function getServiceAccountBalance(
  serviceAccountId: string,
  executor: DbExecutor = db
): Promise<ServiceAccountBalance> {
  const latestRows = await executor
    .select({
      balanceCentavos: ledgerEntries.runningBalanceCentavos,
      entryDate: ledgerEntries.entryDate,
    })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.serviceAccountId, serviceAccountId))
    .orderBy(desc(ledgerEntries.sequenceNumber), desc(ledgerEntries.id))
    .limit(1);
  const latestEntry = latestRows[0];

  const countRows = await executor
    .select({ total: count() })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.serviceAccountId, serviceAccountId));

  return {
    serviceAccountId,
    balanceCentavos: Number(latestEntry?.balanceCentavos ?? 0),
    entryCount: Number(countRows[0]?.total ?? 0),
    lastEntryAt: latestEntry?.entryDate ?? null,
  };
}

/** The account header shown above the ledger table, with its current balance. */
export async function getLedgerHeader(
  serviceAccountId: string,
  executor: DbExecutor = db
): Promise<LedgerHeader> {
  const rows = await executor
    .select({
      serviceAccountId: serviceAccounts.id,
      serviceAccountNumber: serviceAccounts.serviceAccountNumber,
      status: serviceAccounts.status,
      planName: subscriptionPlans.name,
      serviceType: subscriptionPlans.serviceType,
      monthlyRateCentavos: subscriptionPlans.monthlyRateCentavos,
      subscriberId: subscribers.id,
      subscriberFirstName: subscribers.firstName,
      subscriberLastName: subscribers.lastName,
    })
    .from(serviceAccounts)
    .innerJoin(subscribers, eq(serviceAccounts.subscriberId, subscribers.id))
    .innerJoin(subscriptionPlans, eq(serviceAccounts.planId, subscriptionPlans.id))
    .where(eq(serviceAccounts.id, serviceAccountId))
    .limit(1);
  const row = rows[0];

  if (row === undefined) {
    throw new NotFoundError("Service account not found");
  }

  const balance = await getServiceAccountBalance(serviceAccountId, executor);

  return {
    serviceAccountId: row.serviceAccountId,
    serviceAccountNumber: row.serviceAccountNumber,
    subscriberId: row.subscriberId,
    subscriberName: `${row.subscriberLastName}, ${row.subscriberFirstName}`,
    planName: row.planName,
    serviceType: row.serviceType,
    monthlyRateCentavos: row.monthlyRateCentavos,
    status: row.status,
    balanceCentavos: balance.balanceCentavos,
    entryCount: balance.entryCount,
    lastEntryAt: balance.lastEntryAt,
  };
}
