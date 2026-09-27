// The Payment Adjustment / Reversal Report (R14) and the Voided Receipt Report (R15).
//
// Both read the same rows — a payment reversal is what voids a receipt — and answer
// two different questions about them:
//
//   • R14 is the correction log. It shows the reversal document, who signed it, why,
//     and how much money the correction moved, so a period's adjustments total.
//   • R15 is the cashier's receipt book. It shows the Official Receipt numbers that
//     no longer stand, by method, so the printed book can be brought into line.
//
// The date range selects the reversed receipt's PAYMENT DATE, a plain calendar day,
// so no timezone conversion can move a receipt into the wrong period. Each line also
// carries the day the reversal was recorded, so both dates are always visible.
//
// A payment is never deleted or edited: the original row keeps its amount and gains
// a reversal record beside it, which is exactly why both reports can be produced
// from stored data at any time.
//
// All arithmetic is on integer centavos.

import { asc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { PaymentMethod } from "@bcis/shared";
import { db, type DbExecutor } from "../../db/connection";
import { payments, paymentReversals } from "../../db/schema/payments";
import { serviceAccounts, subscribers, subscriptionPlans } from "../../db/schema/subscribers";
import { users } from "../../db/schema/users";
import {
  accountFilterConditions,
  combineConditions,
  dateWithinRange,
  toReportDateRange,
  type ReportFilters,
} from "./report-filters";

/** One reversal together with everything both reports show about it. */
export interface PaymentAdjustmentRow {
  receiptNumber: string;
  reversalReceiptNumber: string;
  paymentDate: string;
  reversedAt: Date;
  reason: string;
  reversedByName: string;
  paymentMethod: PaymentMethod;
  amountCentavos: number;
  subscriberName: string;
  serviceAccountNumber: string;
  collectorId: string | null;
  collectorName: string | null;
}

export interface PaymentAdjustmentReport {
  fromDate: string;
  toDate: string;
  lines: PaymentAdjustmentRow[];
  totals: {
    reversalCount: number;
    totalReversedCentavos: number;
    cashReversedCentavos: number;
    /** Bank transfer, cheque, GCash and anything else — the money outside the drawer. */
    nonCashReversedCentavos: number;
  };
}

export interface VoidedReceiptReport {
  fromDate: string;
  toDate: string;
  lines: PaymentAdjustmentRow[];
  totals: {
    receiptCount: number;
    totalVoidedCentavos: number;
    cashVoidedCentavos: number;
    gcashVoidedCentavos: number;
  };
}

/** Sorts so two runs of the same report never disagree: newest receipt first. */
function newestReceiptFirst(rows: readonly PaymentAdjustmentRow[]): PaymentAdjustmentRow[] {
  return [...rows].sort((left, right) => right.paymentDate.localeCompare(left.paymentDate));
}

/**
 * R14 — every reversal in the range, with its money impact.
 *
 * Pure and database-free. The non-cash total is `total - cash`, so the cash and
 * non-cash columns always add up to the total by construction.
 */
export function buildPaymentAdjustmentReport(
  rows: readonly PaymentAdjustmentRow[],
  range: { fromDate: string; toDate: string }
): PaymentAdjustmentReport {
  const lines = newestReceiptFirst(rows);

  const totalReversedCentavos = lines.reduce((sum, line) => sum + line.amountCentavos, 0);
  const cashReversedCentavos = lines
    .filter((line) => line.paymentMethod === "cash")
    .reduce((sum, line) => sum + line.amountCentavos, 0);

  return {
    fromDate: range.fromDate,
    toDate: range.toDate,
    lines,
    totals: {
      reversalCount: lines.length,
      totalReversedCentavos,
      cashReversedCentavos,
      nonCashReversedCentavos: totalReversedCentavos - cashReversedCentavos,
    },
  };
}

/**
 * R15 — every receipt the range's reversals voided, with the cash and GCash split.
 *
 * Pure and database-free. GCash is split out because it is the one non-cash method
 * the office posts across the counter; every other method only appears in the total.
 */
export function buildVoidedReceiptReport(
  rows: readonly PaymentAdjustmentRow[],
  range: { fromDate: string; toDate: string }
): VoidedReceiptReport {
  const lines = newestReceiptFirst(rows);

  const sumByMethod = (method: PaymentMethod): number =>
    lines
      .filter((line) => line.paymentMethod === method)
      .reduce((sum, line) => sum + line.amountCentavos, 0);

  return {
    fromDate: range.fromDate,
    toDate: range.toDate,
    lines,
    totals: {
      receiptCount: lines.length,
      totalVoidedCentavos: lines.reduce((sum, line) => sum + line.amountCentavos, 0),
      cashVoidedCentavos: sumByMethod("cash"),
      gcashVoidedCentavos: sumByMethod("gcash"),
    },
  };
}

/**
 * The reversals of receipts dated in a range, narrowed by the account filters.
 *
 * Two different users are joined — the collector assigned to the account and the
 * person who signed the reversal — so the user table is aliased once per role.
 */
export async function loadPaymentAdjustmentRows(
  range: { fromDate: string; toDate: string },
  filters: ReportFilters,
  executor: DbExecutor = db
): Promise<PaymentAdjustmentRow[]> {
  const collectorUser = alias(users, "collector_user");
  const reversingUser = alias(users, "reversing_user");

  const rows = await executor
    .select({
      receiptNumber: payments.receiptNumber,
      reversalReceiptNumber: paymentReversals.reversalReceiptNumber,
      paymentDate: payments.paymentDate,
      reversedAt: paymentReversals.reversedAt,
      reason: paymentReversals.reason,
      reversedByName: reversingUser.fullName,
      paymentMethod: payments.paymentMethod,
      amountCentavos: payments.amountCentavos,
      subscriberFirstName: subscribers.firstName,
      subscriberLastName: subscribers.lastName,
      serviceAccountNumber: serviceAccounts.serviceAccountNumber,
      collectorId: serviceAccounts.assignedCollectorId,
      collectorName: collectorUser.fullName,
    })
    .from(paymentReversals)
    .innerJoin(payments, eq(paymentReversals.originalPaymentId, payments.id))
    .innerJoin(serviceAccounts, eq(payments.serviceAccountId, serviceAccounts.id))
    .innerJoin(subscribers, eq(serviceAccounts.subscriberId, subscribers.id))
    .innerJoin(subscriptionPlans, eq(serviceAccounts.planId, subscriptionPlans.id))
    .leftJoin(reversingUser, eq(paymentReversals.reversedBy, reversingUser.id))
    .leftJoin(collectorUser, eq(serviceAccounts.assignedCollectorId, collectorUser.id))
    .where(
      combineConditions([
        // A reversal row only exists for a reversed payment; the status check keeps
        // the two reports consistent even if a stray row is ever inserted.
        eq(payments.status, "reversed"),
        dateWithinRange(payments.paymentDate, toReportDateRange(range.fromDate, range.toDate)),
        ...accountFilterConditions(filters),
      ])
    )
    .orderBy(asc(payments.paymentDate));

  return rows.map((row) => ({
    receiptNumber: row.receiptNumber,
    reversalReceiptNumber: row.reversalReceiptNumber,
    paymentDate: row.paymentDate,
    reversedAt: row.reversedAt,
    reason: row.reason,
    reversedByName: row.reversedByName ?? "System",
    paymentMethod: row.paymentMethod,
    amountCentavos: row.amountCentavos,
    subscriberName: `${row.subscriberLastName}, ${row.subscriberFirstName}`,
    serviceAccountNumber: row.serviceAccountNumber,
    collectorId: row.collectorId,
    collectorName: row.collectorName,
  }));
}
