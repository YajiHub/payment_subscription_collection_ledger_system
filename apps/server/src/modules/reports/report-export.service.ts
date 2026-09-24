// Builds the document a report export hands back: the table plus the file name stem.
//
// One dispatcher for every report type, so the PDF route and the XLSX route share
// the SAME data assembly. An export can therefore never disagree with the report
// the screen shows — both come from the services the on-screen endpoints call.
//
// Every path here is READ-ONLY: it loads reports, it never writes. A test pins that
// by asserting no INSERT, UPDATE, or DELETE reaches the database during an export.

import {
  REPORT_EXPORT_FORMAT_EXTENSIONS,
  type ReportExportFormat,
  type ReportType,
} from "@bcis/shared";
import { addDaysToDay, formatDateOnly, utcMidnightOfDay } from "../../shared/date";
import type { ReportTable } from "../../shared/reports/report-table";
import type { BatchActor } from "../collections/collector-batches.service";
import { getCollectorBatchDetail } from "../collections/collector-batches.service";
import { getStatementOfAccount } from "../ledger/statement-of-account.service";
import { computeArAging } from "../receivables/ar-aging.service";
import { buildCollectorRemittanceReport } from "./collector-remittance.service";
import { buildDailyCollectionReport, loadPaymentsBetween } from "./daily-collection.service";
import { buildMonthlyBillingReport, loadInvoicesForPeriod } from "./monthly-billing.service";
import {
  buildOutstandingByCollector,
  loadOutstandingInvoicesWithCollector,
} from "./outstanding-by-collector.service";
import {
  arAgingReportTable,
  collectorRemittanceReportTable,
  dailyCollectionReportTable,
  monthlyBillingReportTable,
  outstandingByCollectorReportTable,
  subscriberStatementReportTable,
} from "./report-tables";

/** The filters an export request may carry. Only the chosen report reads them. */
export interface ReportExportParameters {
  date?: string;
  year?: number;
  month?: number;
  asOf?: string;
  batchId?: string;
  serviceAccountId?: string;
  fromDate?: string;
  toDate?: string;
}

export interface ReportExportDocument {
  table: ReportTable;
  /** Without an extension: "daily-collection-2025-01-24". */
  fileNameStem: string;
}

/** The office's business day, used whenever a report is asked for without a date. */
function businessDay(now: Date): string {
  return formatDateOnly(now);
}

/** Two-digit month, so a file name sorts and reads correctly. */
function twoDigitMonth(month: number): string {
  return String(month).padStart(2, "0");
}

/**
 * Assembles the report the caller asked for.
 *
 * A Collector can only export their own remittance report: the batch service
 * enforces that, and it is the same rule the on-screen batch detail obeys.
 */
export async function buildReportExportDocument(
  reportType: ReportType,
  parameters: ReportExportParameters,
  actor: BatchActor,
  now: Date = new Date()
): Promise<ReportExportDocument> {
  const today = businessDay(now);

  switch (reportType) {
    case "daily_collection": {
      const date = parameters.date ?? today;
      const paymentRows = await loadPaymentsBetween(date, addDaysToDay(date, 1));
      return {
        table: dailyCollectionReportTable(buildDailyCollectionReport(paymentRows, date)),
        fileNameStem: `daily-collection-${date}`,
      };
    }

    case "monthly_billing": {
      const year = parameters.year ?? Number.parseInt(today.slice(0, 4), 10);
      const month = parameters.month ?? Number.parseInt(today.slice(5, 7), 10);
      const invoiceRows = await loadInvoicesForPeriod(year, month);
      return {
        table: monthlyBillingReportTable(buildMonthlyBillingReport(invoiceRows, year, month)),
        fileNameStem: `monthly-billing-${year}-${twoDigitMonth(month)}`,
      };
    }

    case "ar_aging": {
      const asOf = parameters.asOf ?? today;
      const report = await computeArAging(utcMidnightOfDay(asOf));
      return {
        table: arAgingReportTable(report),
        fileNameStem: `AR-aging-${report.asOfDate}`,
      };
    }

    case "subscriber_soa": {
      const serviceAccountId = parameters.serviceAccountId ?? "";
      const statement = await getStatementOfAccount(serviceAccountId, {
        fromDate: parameters.fromDate,
        toDate: parameters.toDate,
      });
      return {
        table: subscriberStatementReportTable(statement),
        fileNameStem: `statement-of-account-${statement.serviceAccount.serviceAccountNumber}`,
      };
    }

    case "collector_remittance": {
      const batch = await getCollectorBatchDetail(parameters.batchId ?? "", actor);
      return {
        table: collectorRemittanceReportTable(buildCollectorRemittanceReport(batch)),
        fileNameStem: `collector-remittance-${batch.batchNumber}`,
      };
    }

    case "outstanding_by_collector": {
      const asOf = parameters.asOf ?? today;
      const report = buildOutstandingByCollector(
        await loadOutstandingInvoicesWithCollector(),
        utcMidnightOfDay(asOf)
      );
      return {
        table: outstandingByCollectorReportTable(report),
        fileNameStem: `outstanding-by-collector-${report.asOfDate}`,
      };
    }
  }
}

/** The download file name for an assembled report: stem plus the export extension. */
export function reportExportFileName(stem: string, format: ReportExportFormat): string {
  return `${stem}.${REPORT_EXPORT_FORMAT_EXTENSIONS[format]}`;
}
