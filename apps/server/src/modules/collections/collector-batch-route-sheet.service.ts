// The printable route sheet for a collector batch (S4-3, section 3.8).
//
// The audit found no route sheet at all: a batch detail listed an account number and
// an outstanding balance but no address and no split between the current bill and
// arrears, and there was no print or export path for it. A collector is handed a
// sheet of paper naming who to visit, where, and how much to ask for, so this module
// builds exactly that, per assigned account:
//
//   account number · subscriber name · address · current bill · arrears ·
//   total due · collector · area
//
// "Current bill" is the outstanding balance of invoices not yet past due; "arrears"
// is the outstanding balance of invoices already past due. The boundary follows the
// AR aging classifier exactly (an invoice due TODAY is current, not overdue), so the
// two reports can never disagree. All amounts are integer centavos.
//
// The JSON the screen reads and the PDF/XLSX the office prints are built from ONE
// table, so a printed sheet and an exported one cannot show different numbers.

import { and, asc, eq, gt, inArray } from "drizzle-orm";

import { OUTSTANDING_INVOICE_STATUSES } from "@bcis/shared";
import { db, type DbExecutor } from "../../db/connection";
import { invoices } from "../../db/schema/billing";
import { collectionAreas } from "../../db/schema/areas";
import { batchAssignments, collectorBatches } from "../../db/schema/collections";
import {
  serviceAccounts,
  subscriberAddresses,
  subscribers,
  subscriptionPlans,
} from "../../db/schema/subscribers";
import { users } from "../../db/schema/users";
import { formatDateOnly } from "../../shared/date";
import { NotFoundError } from "../../shared/errors";
import type { ReportTable } from "../../shared/reports/report-table";
import type { BatchActor } from "./collector-batches.service";

/** One assigned account as the route sheet query returns it. */
export interface RouteSheetAccountRow {
  serviceAccountId: string;
  serviceAccountNumber: string;
  subscriberId: string;
  subscriberFirstName: string;
  subscriberLastName: string;
  /** The installation address when one is recorded, otherwise the service address. */
  addressLine: string;
  barangay: string | null;
  areaName: string | null;
  collectorName: string;
  planName: string;
}

/** One outstanding invoice of an assigned account. */
export interface RouteSheetInvoiceRow {
  serviceAccountId: string;
  remainingBalanceCentavos: number;
  dueDate: string;
}

/** One line of the printed sheet. */
export interface RouteSheetRow {
  serviceAccountId: string;
  serviceAccountNumber: string;
  subscriberId: string;
  subscriberName: string;
  address: string;
  currentBillCentavos: number;
  arrearsCentavos: number;
  totalDueCentavos: number;
  collectorName: string;
  areaName: string;
}

export interface RouteSheetTotals {
  accountCount: number;
  currentBillCentavos: number;
  arrearsCentavos: number;
  totalDueCentavos: number;
}

export interface RouteSheet {
  batchId: string;
  batchNumber: string;
  collectorName: string;
  collectionDate: string;
  areaName: string | null;
  rows: RouteSheetRow[];
  totals: RouteSheetTotals;
}

/** The address printed for one account, or "" when none is recorded. */
function formatAddress(line: string, barangay: string | null): string {
  const trimmedLine = line.trim();
  const trimmedBarangay = barangay?.trim() ?? "";
  if (trimmedLine.length === 0) {
    return trimmedBarangay;
  }
  if (trimmedBarangay.length === 0) {
    return trimmedLine;
  }
  return `${trimmedLine}, ${trimmedBarangay}`;
}

/**
 * Builds the sheet's rows from the assigned accounts and their outstanding invoices.
 *
 * Pure and database-free so the current-versus-arrears split and its boundary can be
 * tested against hand-computed values.
 */
export function buildRouteSheetRows(
  accounts: readonly RouteSheetAccountRow[],
  invoiceRows: readonly RouteSheetInvoiceRow[],
  asOfDay: string
): RouteSheetRow[] {
  const splitByAccount = new Map<string, { current: number; arrears: number }>();

  for (const invoice of invoiceRows) {
    const running = splitByAccount.get(invoice.serviceAccountId) ?? { current: 0, arrears: 0 };
    if (invoice.dueDate >= asOfDay) {
      running.current += invoice.remainingBalanceCentavos;
    } else {
      running.arrears += invoice.remainingBalanceCentavos;
    }
    splitByAccount.set(invoice.serviceAccountId, running);
  }

  return accounts.map((account) => {
    const split = splitByAccount.get(account.serviceAccountId) ?? { current: 0, arrears: 0 };

    return {
      serviceAccountId: account.serviceAccountId,
      serviceAccountNumber: account.serviceAccountNumber,
      subscriberId: account.subscriberId,
      subscriberName: `${account.subscriberLastName}, ${account.subscriberFirstName}`,
      address: formatAddress(account.addressLine, account.barangay),
      currentBillCentavos: split.current,
      arrearsCentavos: split.arrears,
      totalDueCentavos: split.current + split.arrears,
      collectorName: account.collectorName,
      areaName: account.areaName ?? "",
    };
  });
}

/** Totals a built sheet. */
export function summarizeRouteSheet(rows: readonly RouteSheetRow[]): RouteSheetTotals {
  return rows.reduce<RouteSheetTotals>(
    (running, row) => ({
      accountCount: running.accountCount + 1,
      currentBillCentavos: running.currentBillCentavos + row.currentBillCentavos,
      arrearsCentavos: running.arrearsCentavos + row.arrearsCentavos,
      totalDueCentavos: running.totalDueCentavos + row.totalDueCentavos,
    }),
    {
      accountCount: 0,
      currentBillCentavos: 0,
      arrearsCentavos: 0,
      totalDueCentavos: 0,
    }
  );
}

/**
 * Loads a batch's route sheet.
 *
 * A Collector may only load their own batch; the same visibility rule the batch
 * detail uses (a 404 rather than a 403) applies here.
 */
export async function loadBatchRouteSheet(
  batchId: string,
  actor: BatchActor,
  asOfDate: Date = new Date(),
  executor: DbExecutor = db
): Promise<RouteSheet> {
  const batchRow = await executor
    .select({
      batch: collectorBatches,
      collectorName: users.fullName,
    })
    .from(collectorBatches)
    .innerJoin(users, eq(collectorBatches.collectorId, users.id))
    .where(eq(collectorBatches.id, batchId))
    .limit(1)
    .then((rows) => rows[0]);

  if (batchRow === undefined) {
    throw new NotFoundError("Collector batch not found");
  }
  if (actor.role === "collector" && batchRow.batch.collectorId !== actor.id) {
    throw new NotFoundError("Collector batch not found");
  }

  const accountRows = await executor
    .select({
      serviceAccountId: serviceAccounts.id,
      serviceAccountNumber: serviceAccounts.serviceAccountNumber,
      subscriberId: subscribers.id,
      subscriberFirstName: subscribers.firstName,
      subscriberLastName: subscribers.lastName,
      serviceAddress: subscribers.serviceAddress,
      installationAddressLine: subscriberAddresses.addressLine,
      barangay: subscribers.serviceBarangay,
      areaName: collectionAreas.name,
      collectorName: users.fullName,
      planName: subscriptionPlans.name,
    })
    .from(batchAssignments)
    .innerJoin(serviceAccounts, eq(batchAssignments.serviceAccountId, serviceAccounts.id))
    .innerJoin(subscribers, eq(serviceAccounts.subscriberId, subscribers.id))
    .innerJoin(subscriptionPlans, eq(serviceAccounts.planId, subscriptionPlans.id))
    .innerJoin(users, eq(serviceAccounts.assignedCollectorId, users.id))
    .leftJoin(collectionAreas, eq(serviceAccounts.areaId, collectionAreas.id))
    .leftJoin(subscriberAddresses, eq(serviceAccounts.installationAddressId, subscriberAddresses.id))
    .where(eq(batchAssignments.batchId, batchId))
    .orderBy(asc(serviceAccounts.serviceAccountNumber));

  // S1-9: the per-account installation address wins when one is recorded; otherwise
  // the subscriber's service address is what the sheet prints.
  const accounts: RouteSheetAccountRow[] = accountRows.map((row) => ({
    serviceAccountId: row.serviceAccountId,
    serviceAccountNumber: row.serviceAccountNumber,
    subscriberId: row.subscriberId,
    subscriberFirstName: row.subscriberFirstName,
    subscriberLastName: row.subscriberLastName,
    addressLine: row.installationAddressLine ?? row.serviceAddress,
    barangay: row.barangay,
    areaName: row.areaName,
    collectorName: row.collectorName,
    planName: row.planName,
  }));

  const accountIds = accounts.map((account) => account.serviceAccountId);
  const asOfDay = formatDateOnly(asOfDate);

  const invoiceRows: RouteSheetInvoiceRow[] =
    accountIds.length === 0
      ? []
      : await executor
          .select({
            serviceAccountId: invoices.serviceAccountId,
            remainingBalanceCentavos: invoices.remainingBalanceCentavos,
            dueDate: invoices.dueDate,
          })
          .from(invoices)
          .where(
            and(
              inArray(invoices.serviceAccountId, accountIds),
              inArray(invoices.status, [...OUTSTANDING_INVOICE_STATUSES]),
              gt(invoices.remainingBalanceCentavos, 0)
            )
          );

  const rows = buildRouteSheetRows(accounts, invoiceRows, asOfDay);
  const areaName = rows.find((row) => row.areaName.length > 0)?.areaName ?? null;

  return {
    batchId,
    batchNumber: batchRow.batch.batchNumber,
    collectorName: batchRow.collectorName,
    collectionDate: batchRow.batch.collectionDate,
    areaName,
    rows,
    totals: summarizeRouteSheet(rows),
  };
}

/**
 * The route sheet as a report table, so it goes through the SAME PDF/XLSX generators
 * every other report uses rather than a bespoke printer.
 */
export function buildRouteSheetTable(sheet: RouteSheet): ReportTable {
  return {
    title: `Route Sheet — ${sheet.batchNumber}`,
    subtitle: `Collector: ${sheet.collectorName} · Field date: ${sheet.collectionDate}${
      sheet.areaName === null ? "" : ` · Area: ${sheet.areaName}`
    }`,
    columns: [
      { header: "Account No.", format: "text" },
      { header: "Subscriber", format: "text" },
      { header: "Address", format: "text" },
      { header: "Current Bill", format: "money" },
      { header: "Arrears", format: "money" },
      { header: "Total Due", format: "money" },
      { header: "Collector", format: "text" },
      { header: "Area", format: "text" },
    ],
    rows: sheet.rows.map((row) => [
      row.serviceAccountNumber,
      row.subscriberName,
      row.address,
      row.currentBillCentavos,
      row.arrearsCentavos,
      row.totalDueCentavos,
      row.collectorName,
      row.areaName,
    ]),
    totalsRows: [
      [
        `TOTAL (${sheet.totals.accountCount} accounts)`,
        "",
        "",
        sheet.totals.currentBillCentavos,
        sheet.totals.arrearsCentavos,
        sheet.totals.totalDueCentavos,
        "",
        "",
      ],
    ],
    orientation: "landscape",
  };
}
