// Suspension at the configured threshold (S4-7, section 3.10).
//
// `suspension_after_days` has been a system setting since migration 0008 but nothing
// read it, so no account was ever suspended automatically however overdue it became.
// This module turns that setting into an enforced rule:
//
//   • `findSuspensionCandidates` reports the accounts that QUALIFY — active accounts
//     whose oldest unpaid invoice is at least the threshold's worth of days past due.
//     An operator can look at that list before anything happens.
//   • `suspendQualifyingAccounts` performs the suspensions explicitly, so nothing is
//     cut off merely because a background job happened to run.
//
// The grace period IS the threshold: `suspension_after_days` is the number of whole
// days past due an account may sit before it qualifies. The day boundary is exact —
// an account one day short does NOT qualify, and one exactly at the threshold does.

import { and, eq, gt, inArray } from "drizzle-orm";

import { OUTSTANDING_INVOICE_STATUSES, SYSTEM_SETTING_KEYS, parseIntSetting } from "@bcis/shared";
import { db, type DbExecutor } from "../../db/connection";
import { invoices } from "../../db/schema/billing";
import { serviceAccounts, subscribers } from "../../db/schema/subscribers";
import { formatDateOnly, utcMidnightOfDay } from "../../shared/date";
import { ValidationError } from "../../shared/errors";
import { getSystemSettingsMap } from "../system/system-settings.service";
import { suspendServiceAccount } from "./service-accounts.service";

/** The seeded fallback when the setting is missing or malformed. */
export const DEFAULT_SUSPENSION_AFTER_DAYS = 30;

/**
 * True when an account `daysPastDue` overdue has reached the threshold.
 *
 * The comparison is inclusive on the threshold day: 29 days does not qualify at a
 * 30-day threshold, 30 does. Kept as its own function so the boundary is pinned by
 * a test rather than buried in a query.
 */
export function qualifiesForSuspension(daysPastDue: number, thresholdDays: number): boolean {
  return daysPastDue >= thresholdDays;
}

/** One account that qualifies for suspension, as the preview lists it. */
export interface SuspensionCandidate {
  serviceAccountId: string;
  serviceAccountNumber: string;
  subscriberId: string;
  subscriberName: string;
  /** The due date of the oldest unpaid invoice. */
  oldestDueDate: string;
  /** Whole days that oldest invoice is past due, as of the run day. */
  daysPastDue: number;
  totalOverdueCentavos: number;
}

/** One outstanding invoice as the candidate query returns it. */
export interface SuspensionInvoiceRow {
  serviceAccountId: string;
  serviceAccountNumber: string;
  subscriberId: string;
  subscriberFirstName: string;
  subscriberLastName: string;
  remainingBalanceCentavos: number;
  dueDate: string;
}

/** Whole days between two calendar days, never negative. */
function daysBetween(fromDay: string, toDay: string): number {
  const elapsed = Math.floor(
    (utcMidnightOfDay(toDay).getTime() - utcMidnightOfDay(fromDay).getTime()) /
      (1000 * 60 * 60 * 24)
  );
  return elapsed < 0 ? 0 : elapsed;
}

/**
 * Collapses overdue invoice rows into one candidate per account.
 *
 * An account qualifies on its OLDEST unpaid invoice, so a single very old debt is
 * enough however many newer invoices it also has. Pure, so the threshold boundary
 * is testable without a database.
 */
export function summarizeSuspensionCandidates(
  invoiceRows: readonly SuspensionInvoiceRow[],
  asOfDay: string,
  thresholdDays: number
): SuspensionCandidate[] {
  const byAccount = new Map<string, SuspensionCandidate>();

  for (const invoice of invoiceRows) {
    const existing = byAccount.get(invoice.serviceAccountId);

    if (existing === undefined) {
      byAccount.set(invoice.serviceAccountId, {
        serviceAccountId: invoice.serviceAccountId,
        serviceAccountNumber: invoice.serviceAccountNumber,
        subscriberId: invoice.subscriberId,
        subscriberName: `${invoice.subscriberLastName}, ${invoice.subscriberFirstName}`,
        oldestDueDate: invoice.dueDate,
        daysPastDue: daysBetween(invoice.dueDate, asOfDay),
        totalOverdueCentavos: invoice.remainingBalanceCentavos,
      });
      continue;
    }

    existing.totalOverdueCentavos += invoice.remainingBalanceCentavos;
    if (invoice.dueDate < existing.oldestDueDate) {
      existing.oldestDueDate = invoice.dueDate;
      existing.daysPastDue = daysBetween(invoice.dueDate, asOfDay);
    }
  }

  return [...byAccount.values()]
    .filter((candidate) => qualifiesForSuspension(candidate.daysPastDue, thresholdDays))
    .sort((left, right) => right.daysPastDue - left.daysPastDue);
}

/**
 * The configured threshold in days.
 *
 * An explicit override wins (an on-demand run may ask "what if we cut at 15 days?")
 * and the stored setting is used otherwise, falling back to the seeded default when
 * the value is missing or not a whole number.
 */
export async function resolveSuspensionThresholdDays(override?: number): Promise<number> {
  if (override !== undefined) {
    if (!Number.isInteger(override) || override < 1) {
      throw new ValidationError("suspension threshold must be a whole number of days (at least 1)");
    }
    return override;
  }

  const settings = await getSystemSettingsMap();
  return parseIntSetting(
    settings[SYSTEM_SETTING_KEYS.suspensionAfterDays],
    DEFAULT_SUSPENSION_AFTER_DAYS
  );
}

/**
 * The active accounts that qualify for suspension as of a day.
 *
 * Only ACTIVE accounts are considered: a suspended one is already cut off, a pending
 * one has no service to cut, and a terminated one is gone.
 */
export async function findSuspensionCandidates(
  thresholdDays: number,
  asOfDate: Date = new Date(),
  executor: DbExecutor = db
): Promise<SuspensionCandidate[]> {
  const asOfDay = formatDateOnly(asOfDate);

  const rows: SuspensionInvoiceRow[] = await executor
    .select({
      serviceAccountId: invoices.serviceAccountId,
      serviceAccountNumber: serviceAccounts.serviceAccountNumber,
      subscriberId: subscribers.id,
      subscriberFirstName: subscribers.firstName,
      subscriberLastName: subscribers.lastName,
      remainingBalanceCentavos: invoices.remainingBalanceCentavos,
      dueDate: invoices.dueDate,
    })
    .from(invoices)
    .innerJoin(serviceAccounts, eq(invoices.serviceAccountId, serviceAccounts.id))
    .innerJoin(subscribers, eq(serviceAccounts.subscriberId, subscribers.id))
    .where(
      and(
        inArray(invoices.status, [...OUTSTANDING_INVOICE_STATUSES]),
        gt(invoices.remainingBalanceCentavos, 0),
        eq(serviceAccounts.status, "active")
      )
    );

  return summarizeSuspensionCandidates(rows, asOfDay, thresholdDays);
}

export interface SuspensionRunResult {
  thresholdDays: number;
  asOfDate: string;
  suspended: SuspensionCandidate[];
  failed: { serviceAccountId: string; message: string }[];
}

/** The reason recorded on every automatic suspension. */
export function automaticSuspensionReason(daysPastDue: number, thresholdDays: number): string {
  return `Automated suspension: oldest unpaid invoice ${daysPastDue} days past due (threshold ${thresholdDays} days)`;
}

/**
 * Suspends every account that qualifies, one at a time.
 *
 * One account that cannot be suspended (it changed state between the preview and the
 * run) is reported in `failed` rather than aborting the whole run, because an
 * operator asked for the whole list to be processed. Each suspension writes its
 * `suspension_records` row and its status history inside its own transaction.
 */
export async function suspendQualifyingAccounts(
  thresholdDays: number,
  actorId: string,
  asOfDate: Date = new Date()
): Promise<SuspensionRunResult> {
  const candidates = await findSuspensionCandidates(thresholdDays, asOfDate);
  const effectiveDate = formatDateOnly(asOfDate);

  const suspended: SuspensionCandidate[] = [];
  const failed: { serviceAccountId: string; message: string }[] = [];

  for (const candidate of candidates) {
    try {
      await suspendServiceAccount(
        candidate.serviceAccountId,
        automaticSuspensionReason(candidate.daysPastDue, thresholdDays),
        actorId,
        {
          effectiveDate,
          notes: `${candidate.totalOverdueCentavos} centavos outstanding; oldest invoice due ${candidate.oldestDueDate}`,
        }
      );
      suspended.push(candidate);
    } catch (error) {
      failed.push({
        serviceAccountId: candidate.serviceAccountId,
        message: error instanceof Error ? error.message : "Account could not be suspended",
      });
    }
  }

  return { thresholdDays, asOfDate: effectiveDate, suspended, failed };
}
