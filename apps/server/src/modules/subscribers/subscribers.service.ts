// Database operations for subscribers.
// Route handlers never touch the database directly — they call these functions.
//
// A subscriber is a person or household. Their service accounts are the units that
// billing and payments attach to, so every read here returns the accounts too.

import { and, count, desc, eq, exists, ilike, inArray, like, or, sql, type SQL } from "drizzle-orm";

import { db, type DbExecutor } from "../../db/connection";
import { invoices } from "../../db/schema/billing";
import { gcashPayments, payments } from "../../db/schema/payments";
import { serviceAccounts, subscribers } from "../../db/schema/subscribers";
import { NotFoundError } from "../../shared/errors";
import {
  formatDateSegment,
  generateSubscriberAccountNumber,
  nextSequenceNumber,
} from "./account-number.service";
import {
  insertServiceAccount,
  loadServiceAccountsForSubscribers,
  type CreateServiceAccountInput,
  type ServiceAccountSummary,
} from "../service-accounts/service-accounts.service";
import type {
  CreateSubscriberFields,
  ServiceAccountStatus,
  UpdateSubscriberFields,
} from "@bcis/shared";

export interface SubscriberSummary {
  id: string;
  accountNumber: string;
  firstName: string;
  lastName: string;
  middleName: string | null;
  primaryPhone: string;
  secondaryPhone: string | null;
  emailAddress: string | null;
  serviceAddress: string;
  serviceBarangay: string;
  serviceMunicipality: string;
  serviceProvince: string;
  internalNotes: string | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
  updatedBy: string | null;
  serviceAccounts: ServiceAccountSummary[];
}

const subscriberColumns = {
  id: subscribers.id,
  accountNumber: subscribers.accountNumber,
  firstName: subscribers.firstName,
  lastName: subscribers.lastName,
  middleName: subscribers.middleName,
  primaryPhone: subscribers.primaryPhone,
  secondaryPhone: subscribers.secondaryPhone,
  emailAddress: subscribers.emailAddress,
  serviceAddress: subscribers.serviceAddress,
  serviceBarangay: subscribers.serviceBarangay,
  serviceMunicipality: subscribers.serviceMunicipality,
  serviceProvince: subscribers.serviceProvince,
  internalNotes: subscribers.internalNotes,
  createdAt: subscribers.createdAt,
  updatedAt: subscribers.updatedAt,
  createdBy: subscribers.createdBy,
  updatedBy: subscribers.updatedBy,
};

export interface ListSubscribersFilters {
  page: number;
  pageSize: number;
  /**
   * Matched against the subscriber's name, account number, phone numbers and
   * address, and against the receipt, invoice and GCash reference numbers held by
   * their service accounts (see `buildSubscriberConditions`).
   */
  search?: string;
  /** Keeps subscribers that have at least one service account in this state. */
  status?: ServiceAccountStatus;
  municipality?: string;
}

export interface PaginatedSubscribers {
  items: SubscriberSummary[];
  page: number;
  pageSize: number;
  total: number;
}

/**
 * An EXISTS subquery returning the subscriber when any of their service accounts
 * has a matching payment receipt number.
 *
 * EXISTS rather than a join on purpose: a subscriber with three accounts and two
 * matching receipts must appear ONCE. A join would multiply the subscriber row by
 * every match and inflate the page count; EXISTS short-circuits on the first match.
 */
function subscriberHasReceiptMatching(pattern: string): SQL {
  const subscriberAccountIds = db
    .select({ id: serviceAccounts.id })
    .from(serviceAccounts)
    .where(eq(serviceAccounts.subscriberId, subscribers.id));

  return exists(
    db
      .select({ one: sql`1` })
      .from(payments)
      .where(
        and(
          inArray(payments.serviceAccountId, subscriberAccountIds),
          ilike(payments.receiptNumber, pattern)
        )
      )
  );
}

/** As above, for the invoice number printed on a bill. */
function subscriberHasInvoiceMatching(pattern: string): SQL {
  const subscriberAccountIds = db
    .select({ id: serviceAccounts.id })
    .from(serviceAccounts)
    .where(eq(serviceAccounts.subscriberId, subscribers.id));

  return exists(
    db
      .select({ one: sql`1` })
      .from(invoices)
      .where(
        and(
          inArray(invoices.serviceAccountId, subscriberAccountIds),
          ilike(invoices.invoiceNumber, pattern)
        )
      )
  );
}

/** As above, for the GCash reference number, which reaches the subscriber through
 * its payment. */
function subscriberHasGcashReferenceMatching(pattern: string): SQL {
  const subscriberAccountIds = db
    .select({ id: serviceAccounts.id })
    .from(serviceAccounts)
    .where(eq(serviceAccounts.subscriberId, subscribers.id));

  const subscriberPaymentIds = db
    .select({ id: payments.id })
    .from(payments)
    .where(inArray(payments.serviceAccountId, subscriberAccountIds));

  return exists(
    db
      .select({ one: sql`1` })
      .from(gcashPayments)
      .where(
        and(
          inArray(gcashPayments.paymentId, subscriberPaymentIds),
          ilike(gcashPayments.gcashReferenceNumber, pattern)
        )
      )
  );
}

/** As above, for the service account number (e.g. SA-20261008-00001). */
function subscriberHasServiceAccountMatching(pattern: string): SQL {
  return exists(
    db
      .select({ one: sql`1` })
      .from(serviceAccounts)
      .where(
        and(
          eq(serviceAccounts.subscriberId, subscribers.id),
          ilike(serviceAccounts.serviceAccountNumber, pattern)
        )
      )
  );
}

/**
 * Translates the list filters into a WHERE clause.
 *
 * Search is intentionally generous: a clerk may type part of a name, the account
 * number from a receipt, the phone number from a text message, the address from an
 * installation order, or the receipt/invoice/GCash reference printed on a document.
 * The references live in other tables, so each is an EXISTS subquery against the
 * subscriber's service accounts rather than a join that would multiply rows.
 */
function buildSubscriberConditions(filters: ListSubscribersFilters): SQL | undefined {
  const conditions: SQL[] = [];

  if (filters.search !== undefined && filters.search.trim() !== "") {
    const pattern = `%${filters.search.trim()}%`;
    const searchCondition = or(
      ilike(subscribers.firstName, pattern),
      ilike(subscribers.lastName, pattern),
      ilike(subscribers.middleName, pattern),
      ilike(sql`concat(${subscribers.lastName}, ', ', ${subscribers.firstName})`, pattern),
      ilike(sql`concat(${subscribers.firstName}, ' ', ${subscribers.lastName})`, pattern),
      ilike(subscribers.accountNumber, pattern),
      ilike(subscribers.primaryPhone, pattern),
      ilike(subscribers.secondaryPhone, pattern),
      // S3.2: the address is often the only thing a caller has to hand.
      ilike(subscribers.serviceAddress, pattern),
      ilike(subscribers.serviceBarangay, pattern),
      ilike(subscribers.serviceMunicipality, pattern),
      // Service account number (SA-YYYYMMDD-XXXXX)
      subscriberHasServiceAccountMatching(pattern),
      // S3.2: the three document references. Each is a trigram-indexed substring
      // search (migration 0012), evaluated once per subscriber.
      subscriberHasReceiptMatching(pattern),
      subscriberHasInvoiceMatching(pattern),
      subscriberHasGcashReferenceMatching(pattern)
    );

    if (searchCondition !== undefined) {
      conditions.push(searchCondition);
    }
  }

  if (filters.municipality !== undefined && filters.municipality.trim() !== "") {
    conditions.push(ilike(subscribers.serviceMunicipality, `%${filters.municipality.trim()}%`));
  }

  if (filters.status !== undefined) {
    // A subscriber matches a status filter when any of their services is in that state.
    conditions.push(
      inArray(
        subscribers.id,
        db
          .select({ subscriberId: serviceAccounts.subscriberId })
          .from(serviceAccounts)
          .where(eq(serviceAccounts.status, filters.status))
      )
    );
  }

  return conditions.length > 0 ? and(...conditions) : undefined;
}

/** Returns one page of subscribers, each with their service accounts. */
export async function listSubscribers(
  filters: ListSubscribersFilters
): Promise<PaginatedSubscribers> {
  const offset = (filters.page - 1) * filters.pageSize;
  const where = buildSubscriberConditions(filters);

  const rows = await db
    .select(subscriberColumns)
    .from(subscribers)
    .where(where)
    .orderBy(desc(subscribers.createdAt))
    .limit(filters.pageSize)
    .offset(offset);

  const total = await db
    .select({ value: count() })
    .from(subscribers)
    .where(where)
    .then((countRows) => countRows[0]?.value ?? 0);

  const accountsBySubscriber = await loadServiceAccountsForSubscribers(rows.map((row) => row.id));

  return {
    items: rows.map((row) => ({
      ...row,
      serviceAccounts: accountsBySubscriber.get(row.id) ?? [],
    })),
    page: filters.page,
    pageSize: filters.pageSize,
    total,
  };
}

/** Loads one subscriber with every service account, or throws NotFoundError. */
export async function getSubscriberById(subscriberId: string): Promise<SubscriberSummary> {
  const subscriber = await db
    .select(subscriberColumns)
    .from(subscribers)
    .where(eq(subscribers.id, subscriberId))
    .limit(1)
    .then((rows) => rows[0]);

  if (subscriber === undefined) {
    throw new NotFoundError("Subscriber not found");
  }

  const accountsBySubscriber = await loadServiceAccountsForSubscribers([subscriber.id]);

  return {
    ...subscriber,
    serviceAccounts: accountsBySubscriber.get(subscriber.id) ?? [],
  };
}

/** Builds the next subscriber account number for today, e.g. SUB-20250124-00042. */
async function nextSubscriberAccountNumber(
  today: Date,
  executor: DbExecutor = db
): Promise<string> {
  const prefix = `SUB-${formatDateSegment(today)}-`;

  const existingNumbers = await executor
    .select({ accountNumber: subscribers.accountNumber })
    .from(subscribers)
    .where(like(subscribers.accountNumber, `${prefix}%`));

  const sequenceNumber = nextSequenceNumber(
    existingNumbers.map((row) => row.accountNumber),
    prefix
  );

  return generateSubscriberAccountNumber(today, sequenceNumber);
}

export interface CreateSubscriberInput {
  subscriber: CreateSubscriberFields;
  /**
   * The subscriber's first service account. The Add Subscriber screen always sends
   * one — a household with no service has nothing to bill. It is optional at the
   * API level so the two-step flow (create subscriber, then add service accounts)
   * stays possible.
   */
  serviceAccount?: CreateServiceAccountInput;
  createdBy: string;
}

/** Creates a subscriber, and its first service account when one is supplied. */
export async function createSubscriber(
  input: CreateSubscriberInput,
  executor: DbExecutor = db
): Promise<SubscriberSummary> {
  // The subscriber and its first service account are written in one transaction.
  // A household must never exist with no service to bill: if the account insert
  // fails, the subscriber insert rolls back with it. When the caller already holds
  // a transaction, the write JOINS it (a nested transaction would commit on its
  // own and reopen the window the caller closed).
  const createInTransaction = async (tx: DbExecutor): Promise<SubscriberSummary> => {
    const accountNumber = await nextSubscriberAccountNumber(new Date(), tx);

    const created = await tx
      .insert(subscribers)
      .values({
        accountNumber,
        firstName: input.subscriber.firstName,
        lastName: input.subscriber.lastName,
        middleName: input.subscriber.middleName ?? null,
        primaryPhone: input.subscriber.primaryPhone,
        secondaryPhone: input.subscriber.secondaryPhone ?? null,
        emailAddress: input.subscriber.emailAddress ?? null,
        serviceAddress: input.subscriber.serviceAddress,
        serviceBarangay: input.subscriber.serviceBarangay,
        serviceMunicipality: input.subscriber.serviceMunicipality,
        serviceProvince: input.subscriber.serviceProvince,
        internalNotes: input.subscriber.internalNotes ?? null,
        createdBy: input.createdBy,
      })
      .returning(subscriberColumns)
      .then((rows) => rows[0]);

    // `.returning()` always yields the inserted row; the guard keeps types honest.
    if (created === undefined) {
      throw new NotFoundError("Subscriber could not be created");
    }

    const serviceAccountsCreated: ServiceAccountSummary[] = [];

    if (input.serviceAccount !== undefined) {
      const firstAccount = await insertServiceAccount(
        created.id,
        input.serviceAccount,
        input.createdBy,
        tx
      );
      serviceAccountsCreated.push(firstAccount);
    }

    return { ...created, serviceAccounts: serviceAccountsCreated };
  };

  return executor === db ? db.transaction(createInTransaction) : createInTransaction(executor);
}

/** Updates contact and address details. The account number never changes. */
export async function updateSubscriber(
  subscriberId: string,
  input: UpdateSubscriberFields,
  updatedBy: string
): Promise<SubscriberSummary> {
  const updated = await db
    .update(subscribers)
    .set({ ...input, updatedAt: new Date(), updatedBy })
    .where(eq(subscribers.id, subscriberId))
    .returning(subscriberColumns)
    .then((rows) => rows[0]);

  if (updated === undefined) {
    throw new NotFoundError("Subscriber not found");
  }

  const accountsBySubscriber = await loadServiceAccountsForSubscribers([updated.id]);

  return {
    ...updated,
    serviceAccounts: accountsBySubscriber.get(updated.id) ?? [],
  };
}

export interface SubscriberStatementAccount extends Omit<ServiceAccountSummary, "balanceCentavos"> {
  /** The account's current balance, read from its latest ledger entry. */
  balanceCentavos: number;
}

export interface StatementOfAccount {
  subscriber: SubscriberSummary;
  generatedAt: Date;
  serviceAccounts: SubscriberStatementAccount[];
  /** The sum of every account's positive balance; credits do not offset debts. */
  totalOutstandingCentavos: number;
}

/** Statement of account: the subscriber, every service they hold, and each balance. */
export async function getSubscriberStatement(subscriberId: string): Promise<StatementOfAccount> {
  const subscriber = await getSubscriberById(subscriberId);

  const serviceAccountsWithBalances: SubscriberStatementAccount[] = [];
  let totalOutstandingCentavos = 0;

  for (const account of subscriber.serviceAccounts) {
    // The account summary already carries the ledger balance, so a statement and
    // the subscriber profile can never quote two different figures.
    serviceAccountsWithBalances.push(account);
    if (account.balanceCentavos > 0) {
      totalOutstandingCentavos += account.balanceCentavos;
    }
  }

  return {
    subscriber,
    generatedAt: new Date(),
    serviceAccounts: serviceAccountsWithBalances,
    totalOutstandingCentavos,
  };
}

/**
 * Free-text search by name, account number, phone, address, and the receipt,
 * invoice and GCash reference numbers held by the subscriber's service accounts.
 */
export async function searchSubscribers(
  query: string,
  page: number,
  pageSize: number
): Promise<PaginatedSubscribers> {
  return listSubscribers({ page, pageSize, search: query });
}
