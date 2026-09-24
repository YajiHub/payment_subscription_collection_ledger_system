// Database operations for subscribers.
// Route handlers never touch the database directly — they call these functions.
//
// A subscriber is a person or household. Their service accounts are the units that
// billing and payments attach to, so every read here returns the accounts too.

import { and, count, desc, eq, ilike, inArray, like, or, type SQL } from "drizzle-orm";

import { db, type DbExecutor } from "../../db/connection";
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
import { getCurrentBalanceCentavos } from "../ledger/ledger.service";
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
  /** Matched against name, account number, and phone number. */
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
 * Translates the list filters into a WHERE clause.
 *
 * Search is intentionally generous: a clerk may type part of a name, the account
 * number from a receipt, or the phone number from a text message.
 */
function buildSubscriberConditions(filters: ListSubscribersFilters): SQL | undefined {
  const conditions: SQL[] = [];

  if (filters.search !== undefined && filters.search.trim() !== "") {
    const pattern = `%${filters.search.trim()}%`;
    const searchCondition = or(
      ilike(subscribers.firstName, pattern),
      ilike(subscribers.lastName, pattern),
      ilike(subscribers.middleName, pattern),
      ilike(subscribers.accountNumber, pattern),
      ilike(subscribers.primaryPhone, pattern),
      ilike(subscribers.secondaryPhone, pattern)
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
export async function createSubscriber(input: CreateSubscriberInput): Promise<SubscriberSummary> {
  // The subscriber and its first service account are written in one transaction.
  // A household must never exist with no service to bill: if the account insert
  // fails, the subscriber insert rolls back with it.
  return db.transaction(async (tx) => {
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
  });
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
  /** The current balance, computed from the ledger (negative = advance credit). */
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
    const balanceCentavos = await getCurrentBalanceCentavos(db, account.id);
    serviceAccountsWithBalances.push({ ...account, balanceCentavos });
    if (balanceCentavos > 0) {
      totalOutstandingCentavos += balanceCentavos;
    }
  }

  return {
    subscriber,
    generatedAt: new Date(),
    serviceAccounts: serviceAccountsWithBalances,
    totalOutstandingCentavos,
  };
}

/** Free-text search by name, account number, or phone number. */
export async function searchSubscribers(
  query: string,
  page: number,
  pageSize: number
): Promise<PaginatedSubscribers> {
  return listSubscribers({ page, pageSize, search: query });
}
