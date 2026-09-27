// Route table for the reports module.
// Only paths, preHandlers, and their handlers live here.
//
// Viewing a report and exporting a report are DIFFERENT permissions, and the reports
// themselves are split in three (Phase 8 §9, extended by S6-1):
//
//   • the operational reports — the daily and weekly collection summaries, the
//     collector remittance, and the subscriber statement — need only `reports:view`,
//     which every role holds, so the Cashier's cash count and the Collector's own
//     batch keep working;
//   • the management reports — monthly billing, AR aging, outstanding by collector,
//     annual collection, the three revenue decompositions, collector assignment and
//     performance, payment adjustments, voided receipts, and the subscriber master
//     list — need `reports:management_view`, held only by the Administrator, Billing
//     Clerk, and Manager, because they expose the business's whole ledger;
//   • the audit reports — user activity and the audit trail — need `audit:read`,
//     exactly as the audit screen does.
//   • only the Administrator and the Manager hold `reports:export`, because taking a
//     file of the company's receivables out of the building is a management action.
//     An audit report needs `audit:read` on top of it, checked in the handler.
//
// The export routes are POST because they carry the report's parameters in a body,
// but they perform no write: the handler only reads and renders (pinned by a test).

import type { FastifyInstance } from "fastify";

import { authenticate } from "../../shared/middleware/authenticate";
import { authorize } from "../../shared/middleware/authorize";
import {
  getAnnualCollectionReportHandler,
  getArAgingReportHandler,
  getAuditLogReportHandler,
  getCollectorAssignmentReportHandler,
  getCollectorPerformanceReportHandler,
  getCollectorRemittanceReportHandler,
  getDailyCollectionReportHandler,
  getMonthlyBillingReportHandler,
  getOutstandingByCollectorHandler,
  getPaymentAdjustmentReportHandler,
  getRevenueByAreaHandler,
  getRevenueByPlanHandler,
  getRevenueByServiceTypeHandler,
  getSubscriberMasterListReportHandler,
  getUserActivityReportHandler,
  getVoidedReceiptReportHandler,
  getWeeklyCollectionReportHandler,
  postExportPdfHandler,
  postExportXlsxHandler,
} from "./reports.handler";

export async function registerReportRoutes(server: FastifyInstance): Promise<void> {
  const view = { preHandler: [authenticate, authorize("reports:view")] };
  const viewManagement = {
    preHandler: [authenticate, authorize("reports:management_view")],
  };
  const viewAudit = { preHandler: [authenticate, authorize("audit:read")] };
  const exportReport = { preHandler: [authenticate, authorize("reports:export")] };

  server.get("/api/reports/daily-collection", view, getDailyCollectionReportHandler);
  server.get("/api/reports/weekly-collection", view, getWeeklyCollectionReportHandler);
  server.get("/api/reports/monthly-billing", viewManagement, getMonthlyBillingReportHandler);
  server.get("/api/reports/annual-collection", viewManagement, getAnnualCollectionReportHandler);
  server.get("/api/reports/ar-aging", viewManagement, getArAgingReportHandler);
  server.get("/api/reports/collector-remittance", view, getCollectorRemittanceReportHandler);
  server.get(
    "/api/reports/outstanding-by-collector",
    viewManagement,
    getOutstandingByCollectorHandler
  );
  server.get("/api/reports/revenue-by-plan", viewManagement, getRevenueByPlanHandler);
  server.get(
    "/api/reports/revenue-by-service-type",
    viewManagement,
    getRevenueByServiceTypeHandler
  );
  server.get("/api/reports/revenue-by-area", viewManagement, getRevenueByAreaHandler);
  server.get(
    "/api/reports/collector-assignment",
    viewManagement,
    getCollectorAssignmentReportHandler
  );
  server.get(
    "/api/reports/collector-performance",
    viewManagement,
    getCollectorPerformanceReportHandler
  );
  server.get(
    "/api/reports/payment-adjustments",
    viewManagement,
    getPaymentAdjustmentReportHandler
  );
  server.get("/api/reports/voided-receipts", viewManagement, getVoidedReceiptReportHandler);
  server.get(
    "/api/reports/subscriber-master-list",
    viewManagement,
    getSubscriberMasterListReportHandler
  );
  server.get("/api/reports/user-activity", viewAudit, getUserActivityReportHandler);
  server.get("/api/reports/audit-log", viewAudit, getAuditLogReportHandler);

  server.post("/api/reports/export-pdf", exportReport, postExportPdfHandler);
  server.post("/api/reports/export-xlsx", exportReport, postExportXlsxHandler);
}
