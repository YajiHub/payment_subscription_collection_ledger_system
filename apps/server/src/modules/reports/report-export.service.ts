// Builds the document a report export hands back: the table plus the file name stem.
//
// One dispatcher for every report type, so the PDF route and the XLSX route share
// the SAME data assembly. An export can therefore never disagree with the report
// the screen shows — both come from the services the on-screen endpoints call.
//
// Every path here is READ-ONLY: it loads reports, it never writes. A test pins that
// by asserting no INSERT, UPDATE, or DELETE reaches the database during an export.
//
// Every export is CAPPED (S6-6): the table is assembled, then at most
// MAX_REPORT_EXPORT_ROWS data rows are kept. A report that had more says so in its
// own subtitle and in the response headers, so a partial file is never passed off as
// a complete one.

import {
  REPORT_EXPORT_FORMAT_EXTENSIONS,
  type AnyReportType,
  type ReportExportFormat,
  type ServiceAccountStatus,
} from "@bcis/shared";
import { addDaysToDay, formatDateOnly, utcMidnightOfDay } from "../../shared/date";
import type { ReportTable } from "../../shared/reports/report-table";
import type { BatchActor } from "../collections/collector-batches.service";
import { getCollectorBatchDetail } from "../collections/collector-batches.service";
import { getStatementOfAccount } from "../ledger/statement-of-account.service";
import { computeArAging } from "../receivables/ar-aging.service";
import {
  buildAuditLogReport,
  buildUserActivityReport,
  defaultAuditReportRange,
  loadAuditReportRows,
  resolveAuditReportRange,
  type AuditReportFilters,
} from "./audit-reports.service";
import {
  buildAnnualCollectionReport,
  buildWeeklyCollectionReport,
  loadCollectionSummaryRows,
  resolveMonthlyRange,
  resolveWeeklyRange,
} from "./collection-summary.service";
import { buildCollectorRemittanceReport } from "./collector-remittance.service";
import {
  buildCollectorAssignmentReport,
  buildCollectorPerformanceReport,
  loadAssignedAccountCounts,
  loadCollectorAssignmentRows,
  loadCollectorBatchRows,
  loadCollectorPaymentRows,
  withAssignedAccountCounts,
} from "./collector-reports.service";
import { buildDailyCollectionReport, loadPaymentsBetween } from "./daily-collection.service";
import { buildMonthlyBillingReport, loadInvoicesForPeriod } from "./monthly-billing.service";
import {
  buildOutstandingByCollector,
  loadOutstandingInvoicesWithCollector,
} from "./outstanding-by-collector.service";
import {
  buildPaymentAdjustmentReport,
  buildVoidedReceiptReport,
  loadPaymentAdjustmentRows,
} from "./payment-adjustment.service";
import {
  buildSubscriberMasterListReport,
  loadSubscriberMasterListRows,
} from "./subscriber-master-list.service";
import { buildRevenueReport, loadRevenueInvoiceRows, type RevenueDimension } from "./revenue.service";
import { MAX_REPORT_EXPORT_ROWS, capReportRows, truncationNotice } from "./report-limits";
import type { ReportFilters } from "./report-filters";
import {
  arAgingReportTable,
  annualCollectionReportTable,
  auditLogReportTable,
  collectorAssignmentReportTable,
  collectorPerformanceReportTable,
  collectorRemittanceReportTable,
  dailyCollectionReportTable,
  monthlyBillingReportTable,
  outstandingByCollectorReportTable,
  paymentAdjustmentReportTable,
  revenueReportTable,
  subscriberMasterListReportTable,
  subscriberStatementReportTable,
  userActivityReportTable,
  voidedReceiptReportTable,
  weeklyCollectionReportTable,
} from "./report-tables";

/** The filters an export request may carry. Only the chosen report reads them. */
export interface ReportExportParameters extends ReportFilters {
  date?: string;
  year?: number;
  month?: number;
  asOf?: string;
  batchId?: string;
  serviceAccountId?: string;
  serviceStatus?: ServiceAccountStatus;
  performedBy?: string;
  action?: string;
  entityType?: string;
}

export interface ReportExportDocument {
  table: ReportTable;
  /** Without an extension: "daily-collection-2025-01-24". */
  fileNameStem: string;
  /** The number of data rows the report had, before the export cap. */
  totalRows: number;
  /** The number of data rows actually rendered. */
  renderedRows: number;
  /** True when the cap dropped rows. */
  isTruncated: boolean;
  /** The cap in force, so the response header can state it. */
  rowLimit: number;
}

/** The office's business day, used whenever a report is asked for without a date. */
function businessDay(now: Date): string {
  return formatDateOnly(now);
}

/** Two-digit month, so a file name sorts and reads correctly. */
function twoDigitMonth(month: number): string {
  return String(month).padStart(2, "0");
}

/** The account filters a request carries, in the shape the loaders expect. */
function filtersOf(parameters: ReportExportParameters): ReportFilters {
  return {
    fromDate: parameters.fromDate,
    toDate: parameters.toDate,
    collectorId: parameters.collectorId,
    areaId: parameters.areaId,
    planId: parameters.planId,
    serviceType: parameters.serviceType,
  };
}

/** The audit filters a request carries, in the shape the audit loader expects. */
function auditFiltersOf(parameters: ReportExportParameters): AuditReportFilters {
  return {
    fromDate: parameters.fromDate,
    toDate: parameters.toDate,
    performedBy: parameters.performedBy,
    action: parameters.action,
    entityType: parameters.entityType,
  };
}

/**
 * Applies the export cap to an assembled table.
 *
 * When rows are dropped the table's own subtitle says so, which is what stops a
 * capped spreadsheet from being read as the whole report.
 */
function capExportTable(table: ReportTable): {
  table: ReportTable;
  totalRows: number;
  renderedRows: number;
  isTruncated: boolean;
} {
  const capped = capReportRows(table.rows, MAX_REPORT_EXPORT_ROWS);
  if (!capped.isTruncated) {
    return {
      table,
      totalRows: capped.totalRows,
      renderedRows: capped.totalRows,
      isTruncated: false,
    };
  }

  const notice = truncationNotice(capped.rows.length, capped.totalRows);
  return {
    table: {
      ...table,
      subtitle: table.subtitle === null ? notice : `${table.subtitle} — ${notice}`,
      rows: capped.rows,
    },
    totalRows: capped.totalRows,
    renderedRows: capped.rows.length,
    isTruncated: true,
  };
}

/** The revenue report's dimension and table for one of its three report types. */
function revenueDimensionOf(
  reportType: "revenue_by_plan" | "revenue_by_service_type" | "revenue_by_area"
): RevenueDimension {
  switch (reportType) {
    case "revenue_by_plan":
      return "plan";
    case "revenue_by_service_type":
      return "service_type";
    case "revenue_by_area":
      return "area";
  }
}

/**
 * Assembles the report the caller asked for.
 *
 * A Collector can only export their own remittance report: the batch service
 * enforces that, and it is the same rule the on-screen batch detail obeys.
 */
export async function buildReportExportDocument(
  reportType: AnyReportType,
  parameters: ReportExportParameters,
  actor: BatchActor,
  now: Date = new Date()
): Promise<ReportExportDocument> {
  const today = businessDay(now);
  const filters = filtersOf(parameters);

  /** Wraps a freshly built table in the cap and the response metadata. */
  function document(
    table: ReportTable,
    fileNameStem: string,
    alreadyCapped: { totalRows: number; isTruncated: boolean } | null = null
  ): ReportExportDocument {
    const capped = capExportTable(table);
    return {
      table: capped.table,
      fileNameStem,
      totalRows: alreadyCapped?.totalRows ?? capped.totalRows,
      renderedRows: capped.renderedRows,
      isTruncated: capped.isTruncated || (alreadyCapped?.isTruncated ?? false),
      rowLimit: MAX_REPORT_EXPORT_ROWS,
    };
  }

  switch (reportType) {
    case "daily_collection": {
      const date = parameters.date ?? today;
      const paymentRows = await loadPaymentsBetween(date, addDaysToDay(date, 1));
      return document(
        dailyCollectionReportTable(buildDailyCollectionReport(paymentRows, date)),
        `daily-collection-${date}`
      );
    }

    case "monthly_billing": {
      const year = parameters.year ?? Number.parseInt(today.slice(0, 4), 10);
      const month = parameters.month ?? Number.parseInt(today.slice(5, 7), 10);
      const invoiceRows = await loadInvoicesForPeriod(year, month);
      return document(
        monthlyBillingReportTable(buildMonthlyBillingReport(invoiceRows, year, month)),
        `monthly-billing-${year}-${twoDigitMonth(month)}`
      );
    }

    case "ar_aging": {
      const asOf = parameters.asOf ?? today;
      const report = await computeArAging(utcMidnightOfDay(asOf), undefined, filters);
      return document(arAgingReportTable(report), `AR-aging-${report.asOfDate}`);
    }

    case "subscriber_soa": {
      const serviceAccountId = parameters.serviceAccountId ?? "";
      const statement = await getStatementOfAccount(serviceAccountId, {
        fromDate: parameters.fromDate,
        toDate: parameters.toDate,
      });
      return document(
        subscriberStatementReportTable(statement),
        `statement-of-account-${statement.serviceAccount.serviceAccountNumber}`
      );
    }

    case "collector_remittance": {
      const batch = await getCollectorBatchDetail(parameters.batchId ?? "", actor);
      return document(
        collectorRemittanceReportTable(buildCollectorRemittanceReport(batch)),
        `collector-remittance-${batch.batchNumber}`
      );
    }

    case "outstanding_by_collector": {
      const asOf = parameters.asOf ?? today;
      const report = buildOutstandingByCollector(
        await loadOutstandingInvoicesWithCollector(undefined, filters),
        utcMidnightOfDay(asOf)
      );
      return document(
        outstandingByCollectorReportTable(report),
        `outstanding-by-collector-${report.asOfDate}`
      );
    }

    case "weekly_collection": {
      const range = resolveWeeklyRange(filters, today);
      const rows = await loadCollectionSummaryRows(range, filters);
      return document(
        weeklyCollectionReportTable(buildWeeklyCollectionReport(rows, range)),
        `weekly-collection-${range.fromDate}`
      );
    }

    case "annual_collection": {
      const year = parameters.year ?? Number.parseInt(today.slice(0, 4), 10);
      const rows = await loadCollectionSummaryRows({ fromDate: `${year}-01-01`, toDate: `${year}-12-31` }, filters);
      return document(
        annualCollectionReportTable(buildAnnualCollectionReport(rows, year)),
        `annual-collection-${year}`
      );
    }

    case "revenue_by_plan":
    case "revenue_by_service_type":
    case "revenue_by_area": {
      const dimension = revenueDimensionOf(reportType);
      const range = resolveMonthlyRange(filters, today);
      const rows = await loadRevenueInvoiceRows(range, filters);
      return document(
        revenueReportTable(buildRevenueReport(rows, dimension, range)),
        `${reportType.replace(/_/g, "-")}-${range.fromDate}-to-${range.toDate}`
      );
    }

    case "collector_assignment": {
      const report = buildCollectorAssignmentReport(await loadCollectorAssignmentRows(filters));
      return document(
        collectorAssignmentReportTable(report),
        `collector-assignment-${today}`
      );
    }

    case "collector_performance": {
      const range = resolveMonthlyRange(filters, today);
      const [paymentRows, batchRows, accountCounts] = await Promise.all([
        loadCollectorPaymentRows(range, filters),
        loadCollectorBatchRows(range, filters),
        loadAssignedAccountCounts(),
      ]);
      const report = withAssignedAccountCounts(
        buildCollectorPerformanceReport(paymentRows, batchRows, range),
        accountCounts
      );
      return document(
        collectorPerformanceReportTable(report),
        `collector-performance-${range.fromDate}-to-${range.toDate}`
      );
    }

    case "payment_adjustments": {
      const range = resolveMonthlyRange(filters, today);
      const report = buildPaymentAdjustmentReport(
        await loadPaymentAdjustmentRows(range, filters),
        range
      );
      return document(
        paymentAdjustmentReportTable(report),
        `payment-adjustments-${range.fromDate}-to-${range.toDate}`
      );
    }

    case "voided_receipts": {
      const range = resolveMonthlyRange(filters, today);
      const report = buildVoidedReceiptReport(await loadPaymentAdjustmentRows(range, filters), range);
      return document(
        voidedReceiptReportTable(report),
        `voided-receipts-${range.fromDate}-to-${range.toDate}`
      );
    }

    case "user_activity": {
      const auditRange = resolveAuditReportRange(
        auditFiltersOf(parameters),
        defaultAuditReportRange(today)
      );
      const rows = await loadAuditReportRows(auditRange, auditFiltersOf(parameters), MAX_REPORT_EXPORT_ROWS);
      return document(
        userActivityReportTable(buildUserActivityReport(rows, auditRange)),
        `user-activity-${auditRange.fromDate}-to-${auditRange.toDate}`
      );
    }

    case "subscriber_master_list": {
      const report = buildSubscriberMasterListReport(
        await loadSubscriberMasterListRows({
          ...filters,
          serviceStatus: parameters.serviceStatus,
        })
      );
      return document(subscriberMasterListReportTable(report), `subscriber-master-list-${today}`);
    }

    case "audit_log": {
      const auditRange = resolveAuditReportRange(
        auditFiltersOf(parameters),
        defaultAuditReportRange(today)
      );
      const report = buildAuditLogReport(
        await loadAuditReportRows(auditRange, auditFiltersOf(parameters), MAX_REPORT_EXPORT_ROWS + 1),
        auditRange,
        MAX_REPORT_EXPORT_ROWS
      );
      return document(auditLogReportTable(report), `audit-log-${auditRange.fromDate}-to-${auditRange.toDate}`, {
        totalRows: report.totalRows,
        isTruncated: report.isTruncated,
      });
    }
  }
}

/** The download file name for an assembled report: stem plus the export extension. */
export function reportExportFileName(stem: string, format: ReportExportFormat): string {
  return `${stem}.${REPORT_EXPORT_FORMAT_EXTENSIONS[format]}`;
}
