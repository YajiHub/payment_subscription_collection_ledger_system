// Tests for the seven reporting defects (D1–D7) and the outstanding-by-collector
// column mislabel (O7).
//
// Each case fails against the code BEFORE the fix and passes after it, so the
// suite is the regression proof the fixes are judged on:
//
//   D1  a non-existent calendar date is a 400, not a 500 or a shifted date;
//   D2  the audit-log report states the TRUE match count and truncation;
//   D3  user activity states the true total and declares truncation;
//   D4  a known-but-unnamed actor is not reported as "system";
//   D5  a printed time is the office's wall-clock time, not UTC;
//   D6  a statement period subsets by the local calendar day;
//   D7  the snapshot reports refuse a date range they cannot apply;
//   O7  the outstanding-by-collector columns reconcile to the total.
//
// The date/time cases build their fixtures from LOCAL calendar fields, exactly as
// `shared/date.ts` reads them, so the assertion holds in any office timezone.

import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  annualCollectionReportQuerySchema,
  arAgingReportQuerySchema,
  collectorAssignmentReportQuerySchema,
  dailyCollectionReportQuerySchema,
  reportExportBodySchema,
  weeklyCollectionReportQuerySchema,
} from "@bcis/shared";
import {
  buildAuditLogReport,
  buildUserActivityReport,
  SYSTEM_ACTOR_USERNAME,
  type AuditReportRow,
} from "../src/modules/reports/audit-reports.service";
import { buildDailyCollectionReport, type DailyCollectionPaymentRow } from "../src/modules/reports/daily-collection.service";
import {
  buildOutstandingByCollector,
  type OutstandingInvoiceWithCollectorRow,
} from "../src/modules/reports/outstanding-by-collector.service";
import {
  auditLogReportTable,
  dailyCollectionReportTable,
  outstandingByCollectorReportTable,
  userActivityReportTable,
} from "../src/modules/reports/report-tables";
import { formatOfficeDateTime, formatTimeOfDay, endOfLocalDay, startOfLocalDay } from "../src/shared/date";

/** A payment row for the daily-collection table/time cases. */
function paymentRow(overrides: Partial<DailyCollectionPaymentRow> = {}): DailyCollectionPaymentRow {
  return {
    receiptNumber: "OR-2026-000001",
    // 10:35:33 local, so a local render reads "10:35:33" and a UTC render does not.
    postedAt: new Date(2026, 9, 9, 10, 35, 33),
    subscriberFirstName: "Maria",
    subscriberLastName: "Santos",
    serviceAccountNumber: "SA-20260101-00001",
    paymentMethod: "cash",
    status: "posted",
    amountCentavos: 50000,
    postedByName: "Ana Cruz",
    ...overrides,
  };
}

/** An audit row for the audit-report cases. */
function auditRow(overrides: Partial<AuditReportRow> = {}): AuditReportRow {
  return {
    performedAt: new Date(2026, 9, 9, 12, 25, 0),
    performedBy: "user-1",
    performedByUsername: "demo.cashier",
    action: "payment.posted",
    entityType: "payment",
    entityId: "payment-1",
    description: "Payment posted",
    clientIpAddress: "10.0.0.5",
    ...overrides,
  };
}

/** An outstanding invoice row for the outstanding-by-collector cases. */
function outstandingRow(
  overrides: Partial<OutstandingInvoiceWithCollectorRow> = {}
): OutstandingInvoiceWithCollectorRow {
  return {
    invoiceId: randomUUID(),
    serviceAccountId: randomUUID(),
    remainingBalanceCentavos: 1000,
    dueDate: "2026-01-01",
    subscriberId: randomUUID(),
    subscriberFirstName: "Maria",
    subscriberLastName: "Santos",
    serviceAccountNumber: "SA-20260101-00001",
    planName: "Fiber",
    collectorId: null,
    collectorName: null,
    ...overrides,
  };
}

// ─── D1 — a non-existent calendar date is refused ────────────────────────────

describe("D1 — date-only schemas reject a date the calendar does not contain", () => {
  it("refuses 30 February on the daily-collection query", () => {
    const result = dailyCollectionReportQuerySchema.safeParse({ date: "2026-02-30" });
    expect(result.success).toBe(false);
  });

  it("refuses 31 February on the weekly-collection range", () => {
    const result = weeklyCollectionReportQuerySchema.safeParse({
      fromDate: "2026-02-31",
      toDate: "2026-03-05",
    });
    expect(result.success).toBe(false);
  });

  it("refuses 31/45 February on the AR-aging as-of day", () => {
    expect(arAgingReportQuerySchema.safeParse({ asOf: "2026-13-45" }).success).toBe(false);
    expect(arAgingReportQuerySchema.safeParse({ asOf: "2026-02-31" }).success).toBe(false);
  });

  it("refuses a non-existent date in an export body", () => {
    const result = reportExportBodySchema.safeParse({
      reportType: "ar_aging",
      params: { asOf: "2026-13-45" },
    });
    expect(result.success).toBe(false);
  });

  it("still accepts a real leap day and a normal date", () => {
    expect(dailyCollectionReportQuerySchema.safeParse({ date: "2024-02-29" }).success).toBe(true);
    expect(dailyCollectionReportQuerySchema.safeParse({ date: "2026-10-09" }).success).toBe(true);
  });
});

// ─── D2 — the audit-log report states the true match count ───────────────────

describe("D2 — the audit-log report counts every matching row", () => {
  it("reports the true total and truncation when more rows matched than the cap", () => {
    const rendered = Array.from({ length: 5000 }, (_value, index) =>
      auditRow({ entityId: `payment-${index}` })
    );

    const report = buildAuditLogReport(
      rendered,
      { fromDate: "2026-10-01", toDate: "2026-10-31" },
      5000,
      5162
    );

    expect(report.rows).toHaveLength(5000);
    expect(report.totalRows).toBe(5162);
    expect(report.isTruncated).toBe(true);
    // The subtitle must say 5,162, not the 5,001 the old cap-plus-one read produced.
    expect(auditLogReportTable(report).subtitle).toContain("5,162");
  });

  it("does not claim truncation when the whole match fits", () => {
    const report = buildAuditLogReport(
      [auditRow()],
      { fromDate: "2026-10-01", toDate: "2026-10-31" },
      5000,
      1
    );
    expect(report.totalRows).toBe(1);
    expect(report.isTruncated).toBe(false);
  });
});

// ─── D3 — user activity declares its truncation ──────────────────────────────

describe("D3 — user activity states the true total and truncation", () => {
  it("reports the true match count, the rendered count, and truncation", () => {
    const rendered = Array.from({ length: 5000 }, (_value, index) =>
      auditRow({ performedAt: new Date(2026, 9, 9, 0, 0, index % 60) })
    );

    const report = buildUserActivityReport(
      rendered,
      { fromDate: "2026-10-01", toDate: "2026-10-31" },
      5000,
      5100
    );

    expect(report.totalRows).toBe(5100);
    expect(report.renderedRows).toBe(5000);
    expect(report.isTruncated).toBe(true);
    // The summary's own total is the TRUE match, so it cannot pass itself off as
    // complete — the old report said 5,001 and declared nothing.
    expect(report.totals.entryCount).toBe(5100);
    expect(userActivityReportTable(report).subtitle).toContain("5,100");
  });

  it("is not truncated when the whole match was rendered", () => {
    const report = buildUserActivityReport(
      [auditRow()],
      { fromDate: "2026-10-01", toDate: "2026-10-31" },
      5000,
      1
    );
    expect(report.isTruncated).toBe(false);
    expect(report.totals.entryCount).toBe(1);
  });
});

// ─── D4 — a known-but-unnamed actor is not "system" ──────────────────────────

describe("D4 — a known but unnamed actor is reported honestly", () => {
  it("does not label a row with a real user id as 'system'", () => {
    const report = buildUserActivityReport(
      [auditRow({ performedBy: "user-42", performedByUsername: null })],
      { fromDate: "2026-10-01", toDate: "2026-10-31" }
    );

    expect(report.groups).toHaveLength(1);
    expect(report.groups[0]?.username).not.toBe(SYSTEM_ACTOR_USERNAME);
    expect(report.groups[0]?.username).toContain("unknown user");
    expect(report.groups[0]?.username).toContain("user-42");
  });

  it("keeps the genuine system actor (no user at all) as 'system'", () => {
    const report = buildUserActivityReport(
      [auditRow({ performedBy: null, performedByUsername: null, action: "billing.run" })],
      { fromDate: "2026-10-01", toDate: "2026-10-31" }
    );

    expect(report.groups.map((group) => group.username)).toContain(SYSTEM_ACTOR_USERNAME);
  });

  it("names the actor in the audit export's User cell", () => {
    const report = buildAuditLogReport(
      [auditRow({ performedBy: "user-42", performedByUsername: null })],
      { fromDate: "2026-10-01", toDate: "2026-10-31" },
      5000,
      1
    );
    const userCell = auditLogReportTable(report).rows[0]?.[1];
    expect(userCell).not.toBe("");
    expect(userCell).toContain("user-42");
  });
});

// ─── D5 — printed times are the office's wall-clock time ─────────────────────

describe("D5 — report times are rendered in the office timezone", () => {
  it("formats a time from the local calendar fields, not UTC", () => {
    const instant = new Date(2026, 9, 9, 10, 35, 33);
    expect(formatTimeOfDay(instant)).toBe("10:35:33");
    expect(formatOfficeDateTime(instant)).toBe("2026-10-09 10:35:33");
  });

  it("prints a 10:35 local payment as 10:35, not its UTC 02:35", () => {
    const table = dailyCollectionReportTable(
      buildDailyCollectionReport([paymentRow()], "2026-10-09")
    );
    expect(table.rows[0]?.[1]).toBe("10:35:33");
  });

  it("prints a 12:25 local audit time as 12:25 in the export", () => {
    const report = buildAuditLogReport(
      [auditRow({ performedAt: new Date(2026, 9, 9, 12, 25, 0) })],
      { fromDate: "2026-10-01", toDate: "2026-10-31" },
      5000,
      1
    );
    expect(auditLogReportTable(report).rows[0]?.[0]).toBe("2026-10-09 12:25:00");
  });
});

// ─── D6 — the statement period floors at the local calendar day ──────────────

describe("D6 — the statement period is the office's local calendar day", () => {
  it("anchors the period to local midnight, not UTC midnight", () => {
    // 00:00 local is earlier in the day than 00:00 UTC for a +08 office, so the
    // boundary really moves — a UTC anchor is not the local day.
    const localStart = startOfLocalDay("2026-10-10");
    expect(localStart.getFullYear()).toBe(2026);
    expect(localStart.getMonth()).toBe(9);
    expect(localStart.getDate()).toBe(10);
    expect(localStart.getHours()).toBe(0);

    const localEnd = endOfLocalDay("2026-10-10");
    expect(localEnd.getDate()).toBe(10);
    expect(localEnd.getHours()).toBe(23);
    expect(localEnd.getMinutes()).toBe(59);
  });
});

// ─── D7 — snapshot reports refuse a date range they cannot apply ─────────────

describe("D7 — a snapshot report refuses fromDate/toDate", () => {
  it("refuses a date range on ar-aging", () => {
    expect(
      arAgingReportQuerySchema.safeParse({ asOf: "2026-10-09", fromDate: "2020-01-01" }).success
    ).toBe(false);
  });

  it("refuses a date range on collector-assignment", () => {
    expect(
      collectorAssignmentReportQuerySchema.safeParse({ fromDate: "2020-01-01" }).success
    ).toBe(false);
  });

  it("refuses a date range on annual-collection", () => {
    expect(
      annualCollectionReportQuerySchema.safeParse({ year: 2026, toDate: "2026-12-31" }).success
    ).toBe(false);
  });

  it("still accepts the collector filter the snapshot reports DO apply", () => {
    const collectorId = randomUUID();
    expect(collectorAssignmentReportQuerySchema.safeParse({ collectorId }).success).toBe(true);
    expect(arAgingReportQuerySchema.safeParse({ collectorId }).data?.collectorId).toBe(collectorId);
  });

  it("refuses a date range in an export body for a snapshot report", () => {
    const result = reportExportBodySchema.safeParse({
      reportType: "outstanding_by_collector",
      params: { asOf: "2026-10-09", fromDate: "2020-01-01", toDate: "2020-12-31" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown parameter rather than stripping it", () => {
    expect(
      dailyCollectionReportQuerySchema.safeParse({ date: "2026-10-09", nonsense: "1" }).success
    ).toBe(false);
  });
});

// ─── O7 — the outstanding-by-collector columns reconcile ─────────────────────

describe("O7 — outstanding-by-collector labels match the buckets and reconcile", () => {
  it("names the canonical buckets and sums them to the total", () => {
    const asOf = new Date(2026, 9, 9);
    const dueDaysAgo = (days: number): string => {
      const due = new Date(asOf.getTime() - days * 24 * 60 * 60 * 1000);
      return `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, "0")}-${String(due.getDate()).padStart(2, "0")}`;
    };

    const report = buildOutstandingByCollector(
      [
        outstandingRow({ remainingBalanceCentavos: 100, dueDate: dueDaysAgo(-3) }),
        outstandingRow({ remainingBalanceCentavos: 200, dueDate: dueDaysAgo(15) }),
        outstandingRow({ remainingBalanceCentavos: 400, dueDate: dueDaysAgo(45) }),
        outstandingRow({ remainingBalanceCentavos: 800, dueDate: dueDaysAgo(75) }),
        outstandingRow({ remainingBalanceCentavos: 1600, dueDate: dueDaysAgo(120) }),
      ],
      asOf
    );

    const totals = report.totals;
    expect(
      totals.currentCentavos +
        totals.bucket_1_30_centavos +
        totals.bucket_31_60_centavos +
        totals.bucket_61_90_centavos +
        totals.over_90_centavos
    ).toBe(totals.totalOutstandingCentavos);

    const table = outstandingByCollectorReportTable(report);
    expect(table.columns.map((column) => column.header)).toEqual([
      "Collector",
      "Assigned Accounts",
      "Total Outstanding",
      "Current",
      "1-30 Days",
      "31-60 Days",
      "61-90 Days",
      "90+ Days",
    ]);
  });
});
