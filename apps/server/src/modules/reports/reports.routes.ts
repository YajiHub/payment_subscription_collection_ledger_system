// Route table for the reports module.
// Only paths, preHandlers, and their handlers live here.
//
// Viewing a report and exporting a report are DIFFERENT permissions:
//
//   • every role that does office or field work holds `reports:view`, so the AR
//     aging and collection screens keep working for the Cashier and the Collector;
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
  const exportReport = { preHandler: [authenticate, authorize("reports:export")] };

  server.get("/api/reports/daily-collection", view, getDailyCollectionReportHandler);
  server.get("/api/reports/monthly-billing", view, getMonthlyBillingReportHandler);
  server.get("/api/reports/ar-aging", view, getArAgingReportHandler);
  server.get("/api/reports/collector-remittance", view, getCollectorRemittanceReportHandler);
  server.get("/api/reports/outstanding-by-collector", view, getOutstandingByCollectorHandler);

  server.post("/api/reports/export-pdf", exportReport, postExportPdfHandler);
  server.post("/api/reports/export-xlsx", exportReport, postExportXlsxHandler);
}
