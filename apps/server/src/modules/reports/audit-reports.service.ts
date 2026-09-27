// User Activity (R16) and the Audit Trail Report (R18, S6-5).
//
// The audit trail was a filtered screen and nothing else. These two reports make it
// exportable through the same report path as everything else:
//
//   • R16 aggregates the trail — how many actions each user performed, per action,
//     and when they last acted. It is the "who has been doing what" summary.
//   • R18 lists the trail itself — one line per auditable action, with the entity it
//     touched and the client it came from.
//
// Both read the append-only audit table and never write to it. Both are capped: the
// trail grows without limit, so an export of it is exactly the unbounded read S6-6
// forbids. The loader asks for one row more than the cap so the report can state
// truthfully whether anything was dropped.
//
// Audit rows record an INSTANT (`performed_at` is a timestamp with time zone), so a
// day range is compared as an inclusive start and an exclusive next day. The rows
// themselves are declared above the audit row in the file so a reader sees the
// purpose before the SQL.

import { and, desc, eq, gte, lt } from "drizzle-orm";

import { db, type DbExecutor } from "../../db/connection";
import { auditLogs } from "../../db/schema/audit";
import { MAX_REPORT_EXPORT_ROWS } from "./report-limits";
import { addDaysToDay, utcMidnightOfDay } from "../../shared/date";

/** The default reporting window for an audit report: the current calendar month. */
export interface AuditReportRange {
  fromDate: string;
  toDate: string;
  /** The day after `toDate`, so the timestamp comparison can never include it. */
  toDateExclusive: string;
}

/** What an audit report may narrow on. A person, an action, or an entity type. */
export interface AuditReportFilters {
  fromDate?: string;
  toDate?: string;
  performedBy?: string;
  action?: string;
  entityType?: string;
}

/** One audit row, as both reports read it. */
export interface AuditReportRow {
  performedAt: Date;
  performedBy: string | null;
  performedByUsername: string | null;
  action: string;
  entityType: string;
  entityId: string;
  description: string;
  clientIpAddress: string | null;
}

/** The instant the report starts and ends on, derived from its two days. */
export function resolveAuditReportRange(
  filters: AuditReportFilters,
  fallback: AuditReportRange
): AuditReportRange {
  if (filters.fromDate !== undefined && filters.toDate !== undefined) {
    return {
      fromDate: filters.fromDate,
      toDate: filters.toDate,
      toDateExclusive: addDaysToDay(filters.toDate, 1),
    };
  }
  return fallback;
}

/**
 * The audit trail's default window: the calendar month containing the given day.
 *
 * Adding 32 days to the first of a month always lands in the following month, so
 * `slice(0, 7)` names it without a month-length table.
 */
export function defaultAuditReportRange(day: string): AuditReportRange {
  const nextMonthStart = `${addDaysToDay(`${day.slice(0, 7)}-01`, 32).slice(0, 7)}-01`;
  return {
    fromDate: `${day.slice(0, 7)}-01`,
    toDate: addDaysToDay(nextMonthStart, -1),
    toDateExclusive: nextMonthStart,
  };
}

// ─── R16 — User Activity ─────────────────────────────────────────────────────

export interface UserActivityGroup {
  /** The username, as denormalized onto the audit row, so a rename cannot hide it. */
  username: string;
  action: string;
  actionCount: number;
  lastPerformedAt: Date;
}

export interface UserActivityReport {
  fromDate: string;
  toDate: string;
  groups: UserActivityGroup[];
  totals: {
    entryCount: number;
    userCount: number;
    distinctActionCount: number;
  };
}

/** The label a system-generated action (no user) is grouped under. */
export const SYSTEM_ACTOR_USERNAME = "system";

/**
 * Counts the auditable actions per user per action.
 *
 * Pure and database-free: two runs over the same rows produce the same groups, and
 * the group counts add up to the entry total.
 */
export function buildUserActivityReport(
  rows: readonly AuditReportRow[],
  range: { fromDate: string; toDate: string }
): UserActivityReport {
  const groupsByKey = new Map<string, UserActivityGroup>();

  for (const row of rows) {
    const username = row.performedByUsername ?? SYSTEM_ACTOR_USERNAME;
    const groupKey = `${username}\u0000${row.action}`;
    const existing = groupsByKey.get(groupKey) ?? {
      username,
      action: row.action,
      actionCount: 0,
      lastPerformedAt: row.performedAt,
    };

    existing.actionCount += 1;
    if (row.performedAt > existing.lastPerformedAt) {
      existing.lastPerformedAt = row.performedAt;
    }
    groupsByKey.set(groupKey, existing);
  }

  const groups = [...groupsByKey.values()].sort((left, right) => {
    if (right.actionCount !== left.actionCount) {
      return right.actionCount - left.actionCount;
    }
    const byUsername = left.username.localeCompare(right.username);
    return byUsername !== 0 ? byUsername : left.action.localeCompare(right.action);
  });

  return {
    fromDate: range.fromDate,
    toDate: range.toDate,
    groups,
    totals: {
      entryCount: rows.length,
      userCount: new Set(rows.map((row) => row.performedByUsername ?? SYSTEM_ACTOR_USERNAME)).size,
      distinctActionCount: new Set(rows.map((row) => row.action)).size,
    },
  };
}

// ─── R18 — Audit Trail Report ────────────────────────────────────────────────

export interface AuditLogReport {
  fromDate: string;
  toDate: string;
  rows: AuditReportRow[];
  /** The number of rows the query matched, before the export cap was applied. */
  totalRows: number;
  /** True when the cap dropped rows, so the reader is never shown a silent subset. */
  isTruncated: boolean;
  rowLimit: number;
}

/**
 * R18 — the audit trail itself, newest first, capped and honest about the cap.
 *
 * Pure and database-free: it sorts and caps a row set the loader already fetched.
 */
export function buildAuditLogReport(
  rows: readonly AuditReportRow[],
  range: { fromDate: string; toDate: string },
  rowLimit: number = MAX_REPORT_EXPORT_ROWS
): AuditLogReport {
  const sorted = [...rows].sort(
    (left, right) => right.performedAt.getTime() - left.performedAt.getTime()
  );

  return {
    fromDate: range.fromDate,
    toDate: range.toDate,
    rows: sorted.slice(0, rowLimit),
    totalRows: sorted.length,
    isTruncated: sorted.length > rowLimit,
    rowLimit,
  };
}

/**
 * The audit rows in the range, narrowed by the audit filters.
 *
 * The loader asks for one row more than the cap so `buildAuditLogReport` can tell
 * "exactly at the cap" from "more than the cap". Every other caller asks for the
 * cap exactly, because it only renders.
 */
export async function loadAuditReportRows(
  range: AuditReportRange,
  filters: AuditReportFilters,
  rowLimit: number = MAX_REPORT_EXPORT_ROWS + 1,
  executor: DbExecutor = db
): Promise<AuditReportRow[]> {
  const conditions = [
    // The day boundary is anchored to UTC midnight, the same anchor the aging
    // bucket arithmetic uses, so a report's window is reproducible on any machine.
    gte(auditLogs.performedAt, utcMidnightOfDay(range.fromDate)),
    lt(auditLogs.performedAt, utcMidnightOfDay(range.toDateExclusive)),
  ];

  if (filters.performedBy !== undefined) {
    conditions.push(eq(auditLogs.performedBy, filters.performedBy));
  }
  if (filters.action !== undefined) {
    conditions.push(eq(auditLogs.action, filters.action));
  }
  if (filters.entityType !== undefined) {
    conditions.push(eq(auditLogs.entityType, filters.entityType));
  }

  return executor
    .select({
      performedAt: auditLogs.performedAt,
      performedBy: auditLogs.performedBy,
      performedByUsername: auditLogs.performedByUsername,
      action: auditLogs.action,
      entityType: auditLogs.entityType,
      entityId: auditLogs.entityId,
      description: auditLogs.description,
      clientIpAddress: auditLogs.clientIpAddress,
    })
    .from(auditLogs)
    .where(and(...conditions))
    .orderBy(desc(auditLogs.performedAt))
    .limit(rowLimit);
}
