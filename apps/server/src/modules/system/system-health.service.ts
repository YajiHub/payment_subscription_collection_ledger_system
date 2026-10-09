// The extended health check shown to the Administrator.
//
// It answers the operational questions a support call needs: is the database
// answering, how long has this process been up, and how much data is in each
// table? It deliberately reports NO secrets: no connection string, no password,
// no key. The one configuration fact it DOES report is the database name and host
// (`databaseTarget`), because an operator must be able to tell which database
// answered; neither is a credential.

import { count } from "drizzle-orm";

import { db, checkDatabaseConnection, type DatabaseHealthResult } from "../../db/connection";
import { auditLogs } from "../../db/schema/audit";
import { invoices } from "../../db/schema/billing";
import { payments } from "../../db/schema/payments";
import { serviceAccounts, subscribers } from "../../db/schema/subscribers";
import { users } from "../../db/schema/users";
import { SERVICE_VERSION, DATABASE_TARGET, type DatabaseTarget } from "../../config";

export interface TableCounts {
  users: number;
  subscribers: number;
  serviceAccounts: number;
  invoices: number;
  payments: number;
  auditLogs: number;
}

export interface ExtendedHealth {
  service: {
    version: string;
    environment: string;
    uptimeSeconds: number;
    nodeVersion: string;
  };
  database: DatabaseHealthResult;
  /** The database name and host this process is pointed at. Not a credential. */
  databaseTarget: DatabaseTarget;
  counts: TableCounts;
}

const EMPTY_COUNTS: TableCounts = {
  users: 0,
  subscribers: 0,
  serviceAccounts: 0,
  invoices: 0,
  payments: 0,
  auditLogs: 0,
};

/** Counts the rows in each table the extended health check reports. */
async function loadTableCounts(): Promise<TableCounts> {
  const [usersCount, subscribersCount, serviceAccountsCount, invoicesCount, paymentsCount, auditCount] =
    await Promise.all([
      db
        .select({ value: count() })
        .from(users)
        .then((rows) => rows[0]?.value ?? 0),
      db
        .select({ value: count() })
        .from(subscribers)
        .then((rows) => rows[0]?.value ?? 0),
      db
        .select({ value: count() })
        .from(serviceAccounts)
        .then((rows) => rows[0]?.value ?? 0),
      db
        .select({ value: count() })
        .from(invoices)
        .then((rows) => rows[0]?.value ?? 0),
      db
        .select({ value: count() })
        .from(payments)
        .then((rows) => rows[0]?.value ?? 0),
      db
        .select({ value: count() })
        .from(auditLogs)
        .then((rows) => rows[0]?.value ?? 0),
    ]);

  return {
    users: usersCount,
    subscribers: subscribersCount,
    serviceAccounts: serviceAccountsCount,
    invoices: invoicesCount,
    payments: paymentsCount,
    auditLogs: auditCount,
  };
}

/** Gathers the extended health report. Reports zero counts when the database is down. */
export async function getExtendedHealth(): Promise<ExtendedHealth> {
  const database = await checkDatabaseConnection();
  const counts = database.isReachable ? await loadTableCounts() : EMPTY_COUNTS;

  return {
    service: {
      version: SERVICE_VERSION,
      environment: process.env.NODE_ENV ?? "unknown",
      uptimeSeconds: Math.round(process.uptime()),
      nodeVersion: process.version,
    },
    database,
    databaseTarget: DATABASE_TARGET,
    counts,
  };
}
