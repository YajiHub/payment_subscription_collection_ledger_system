// Route table for the reports module.
// Only paths, preHandlers, and their handlers live here.
//
// Viewing a report and exporting a report are DIFFERENT permissions, and the reports
// themselves are split in two (Phase 8 §9):
//
//   • the operational reports — the daily collection summary and the collector
//     remittance — need only `reports:view`, which every role holds, so the Cashier's
//     end-of-day cash count and the Collector's own batch keep working;
//   • the management reports — monthly billing, AR aging, and outstanding by
//     collector — need `reports:management_view`, held only by the Administrator,
//     Billing Clerk, and Manager, because they expose the business's whole ledger;
//   • only the Administrator and the Manager hold `reports:export`, because taking a
//     file of the company's receivables out of the building is a management action.
//
// The export routes are POST because they carry the report's parameters in a body,
// but they perform no write: the handler only reads and renders (pinned by a test).

import type { FastifyInstance } from "fastify";

import { authenticate } from "../../shared/middleware/authenticate";
import { authorize } from "../../shared/middleware/authorize";
import {
  getArAgingReportHandler,
  getCollectorRemittanceReportHandler,
  getDailyCollectionReportHandler,
  getMonthlyBillingReportHandler,
  getOutstandingByCollectorHandler,
  postExportPdfHandler,
  postExportXlsxHandler,
} from "./reports.handler";

export async function registerReportRoutes(server: FastifyInstance): Promise<void> {
  const view = { preHandler: [authenticate, authorize("reports:view")] };
  const viewManagement = {
    preHandler: [authenticate, authorize("reports:management_view")],
  };
  const exportReport = { preHandler: [authenticate, authorize("reports:export")] };

  server.get("/api/reports/daily-collection", view, getDailyCollectionReportHandler);
  server.get("/api/reports/monthly-billing", viewManagement, getMonthlyBillingReportHandler);
  server.get("/api/reports/ar-aging", viewManagement, getArAgingReportHandler);
  server.get("/api/reports/collector-remittance", view, getCollectorRemittanceReportHandler);
  server.get(
    "/api/reports/outstanding-by-collector",
    viewManagement,
    getOutstandingByCollectorHandler
  );

  server.post("/api/reports/export-pdf", exportReport, postExportPdfHandler);
  server.post("/api/reports/export-xlsx", exportReport, postExportXlsxHandler);
}
