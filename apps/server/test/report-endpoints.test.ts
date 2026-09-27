// Endpoint acceptance tests for the reports added by S6-1, the audit export (S6-5),
// the bounded export (S6-6), and the list pagination (S8-1).
//
// The arithmetic of each report is proven in `report-families.test.ts`, and the
// filter wiring in `report-filter-fidelity.test.ts`. This file proves the REST of
// the contract: the routes exist, they answer with the right status for the right
// role, a filter supplied on the query string reaches the query, an export is
// bounded and says so, and the list endpoints page.

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

vi.mock("../src/db/connection", async () => {
  const { fakeDatabase } = await import("./support/fake-database");
  return {
    db: fakeDatabase.db,
    pool: {},
    checkDatabaseConnection: async () => ({ isReachable: true, latencyMs: 0, errorMessage: null }),
    closeDatabaseConnection: async () => {},
  };
});

import { buildServer } from "../src/index.ts";
import { refreshPermissionCache } from "../src/shared/rbac/permission-resolver";
import { fakeDatabase } from "./support/fake-database";
import { whereTextOf } from "./support/sql-debug";
import { authorizationHeader, signTestToken } from "./support/tokens";
import { buildReportExportDocument } from "../src/modules/reports/report-export.service";
import { MAX_REPORT_EXPORT_ROWS } from "../src/modules/reports/report-limits";

const COLLECTOR_ID = randomUUID();

let app: FastifyInstance;
let adminToken: string;
let managerToken: string;
let cashierToken: string;

beforeAll(async () => {
  app = buildServer();
  await app.ready();

  // These tests exercise the report contract, not RBAC resolution — that has its own
  // suite. The server resolves permissions from the RBAC tables when it can, so the
  // cache is warmed ONCE here with the documented rollback switch off, which selects
  // the compiled matrix. It is warmed before any test queues rows of its own, so the
  // warm-up read cannot consume a test's queued result sets.
  fakeDatabase.queueSelectRows([{ value: "false" }]);
  await refreshPermissionCache({ force: true });
  fakeDatabase.reset();

  adminToken = signTestToken({ role: "admin" }).token;
  managerToken = signTestToken({ role: "manager" }).token;
  cashierToken = signTestToken({ role: "cashier" }).token;
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  fakeDatabase.reset();
});

/** The two reports whose view needs `audit:read` (S6-5). */
const AUDIT_REPORTS = ["/api/reports/user-activity", "/api/reports/audit-log"] as const;

/** The management reports added by S6-1, which a Cashier may not open. */
const MANAGEMENT_REPORTS = [
  "/api/reports/annual-collection",
  "/api/reports/revenue-by-plan",
  "/api/reports/revenue-by-service-type",
  "/api/reports/revenue-by-area",
  "/api/reports/collector-assignment",
  "/api/reports/collector-performance",
  "/api/reports/payment-adjustments",
  "/api/reports/voided-receipts",
  "/api/reports/subscriber-master-list",
] as const;

/** GET a report as a role and return the status code. */
async function getReport(url: string, token: string): Promise<number> {
  const response = await app.inject({ method: "GET", url, headers: authorizationHeader(token) });
  return response.statusCode;
}

describe("the new report routes exist and answer (S6-1)", () => {
  it("serves the weekly collection to a Cashier, an operational report", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/reports/weekly-collection",
      headers: authorizationHeader(cashierToken),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json().data;
    // Seven days, each present even when nothing was collected.
    expect(body.periods).toHaveLength(7);
    expect(body.totals.grandTotalCentavos).toBe(0);
    // A report route must never write.
    expect(fakeDatabase.insertedRows).toHaveLength(0);
    expect(fakeDatabase.updatedRows).toHaveLength(0);
  });

  it("serves every management report to a Manager", async () => {
    for (const url of MANAGEMENT_REPORTS) {
      expect(await getReport(url, managerToken)).toBe(200);
    }
    expect(fakeDatabase.insertedRows).toHaveLength(0);
    expect(fakeDatabase.updatedRows).toHaveLength(0);
  });

  it("denies a Cashier every management report", async () => {
    for (const url of MANAGEMENT_REPORTS) {
      const response = await app.inject({
        method: "GET",
        url,
        headers: authorizationHeader(cashierToken),
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("FORBIDDEN");
    }
  });

  it("serves the audit reports only to a role holding audit:read (S6-5)", async () => {
    for (const url of AUDIT_REPORTS) {
      expect(await getReport(url, adminToken)).toBe(200);
      // A Manager holds reports:management_view but not audit:read.
      expect(await getReport(url, managerToken)).toBe(403);
      expect(await getReport(url, cashierToken)).toBe(403);
    }
  });

  it("requires a token on every new report route", async () => {
    for (const url of ["/api/reports/weekly-collection", ...MANAGEMENT_REPORTS, ...AUDIT_REPORTS]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(401);
    }
  });
});

describe("a filter on the query string reaches the SQL where clause (S6-2)", () => {
  it("passes the collector filter into the weekly collection query", async () => {
    fakeDatabase.reset();
    const response = await app.inject({
      method: "GET",
      url: `/api/reports/weekly-collection?collectorId=${COLLECTOR_ID}`,
      headers: authorizationHeader(cashierToken),
    });

    expect(response.statusCode).toBe(200);
    expect(whereTextOf(fakeDatabase.whereConditions)).toContain(COLLECTOR_ID);
    expect(whereTextOf(fakeDatabase.whereConditions)).toContain("assigned_collector_id");
  });

  it("passes the performer filter into the audit report query", async () => {
    const userId = randomUUID();
    fakeDatabase.reset();
    const response = await app.inject({
      method: "GET",
      url: `/api/reports/audit-log?performedBy=${userId}`,
      headers: authorizationHeader(adminToken),
    });

    expect(response.statusCode).toBe(200);
    expect(whereTextOf(fakeDatabase.whereConditions)).toContain("performed_by");
    expect(whereTextOf(fakeDatabase.whereConditions)).toContain(userId);
  });

  it("passes the date range into the revenue query", async () => {
    fakeDatabase.reset();
    const response = await app.inject({
      method: "GET",
      url: "/api/reports/revenue-by-area?fromDate=2025-03-01&toDate=2025-03-31",
      headers: authorizationHeader(managerToken),
    });

    expect(response.statusCode).toBe(200);
    const where = whereTextOf(fakeDatabase.whereConditions);
    expect(where).toContain("invoice_date");
    expect(where).toContain("2025-03-01");
    expect(where).toContain("2025-03-31");
  });

  it("rejects a filter that is not a uuid", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/reports/weekly-collection?collectorId=not-a-uuid",
      headers: authorizationHeader(cashierToken),
    });

    expect(response.statusCode).toBe(400);
  });
});

describe("bounded exports (S6-6)", () => {
  it("states the row cap in the response headers", async () => {
    fakeDatabase.queueSelectRows([]); // the subscriber master list
    const response = await app.inject({
      method: "POST",
      url: "/api/reports/export-xlsx",
      headers: authorizationHeader(managerToken),
      payload: { reportType: "subscriber_master_list", params: {} },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-report-row-cap"]).toBe(String(MAX_REPORT_EXPORT_ROWS));
    expect(response.headers["x-report-truncated"]).toBe("false");
    expect(response.headers["x-report-total-rows"]).toBe("0");
  });

  it("caps an oversized report and says so in the table and the headers", async () => {
    const oversized = Array.from({ length: MAX_REPORT_EXPORT_ROWS + 1 }, (_value, index) => [
      "Subscriber",
      `SA-${index}`,
      "0917-000-0000",
      "",
      "1 Rizal St",
      "",
      `SA-${index}`,
      "Fiber 25Mbps",
      "Internet",
      "Active",
      "Ana Cruz",
    ]);
    fakeDatabase.queueSelectRows(oversized);

    const document = await buildReportExportDocument(
      "subscriber_master_list",
      {},
      { id: randomUUID(), role: "admin" }
    );

    expect(document.totalRows).toBe(MAX_REPORT_EXPORT_ROWS + 1);
    expect(document.renderedRows).toBe(MAX_REPORT_EXPORT_ROWS);
    expect(document.isTruncated).toBe(true);
    // The file itself carries the notice, so it can never silently truncate.
    expect(document.table.subtitle).toContain("Showing the first 5,000 of 5,001 rows");
    expect(document.table.rows).toHaveLength(MAX_REPORT_EXPORT_ROWS);
  });

  it("needs audit:read to export an audit report, even with reports:export", async () => {
    const denied = await app.inject({
      method: "POST",
      url: "/api/reports/export-xlsx",
      headers: authorizationHeader(managerToken),
      payload: { reportType: "audit_log", params: {} },
    });
    expect(denied.statusCode).toBe(403);

    fakeDatabase.reset();
    fakeDatabase.queueSelectRows([]); // the audit rows
    const allowed = await app.inject({
      method: "POST",
      url: "/api/reports/export-xlsx",
      headers: authorizationHeader(adminToken),
      payload: { reportType: "audit_log", params: {} },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.headers["content-type"]).toContain("spreadsheetml");
  });

  it("exports every new report family without writing to the database", async () => {
    const exportableReports = [
      "weekly_collection",
      "annual_collection",
      "revenue_by_plan",
      "revenue_by_service_type",
      "revenue_by_area",
      "collector_assignment",
      "collector_performance",
      "payment_adjustments",
      "voided_receipts",
      "user_activity",
      "subscriber_master_list",
      "audit_log",
    ] as const;

    for (const reportType of exportableReports) {
      fakeDatabase.reset();
      const response = await app.inject({
        method: "POST",
        url: "/api/reports/export-pdf",
        headers: authorizationHeader(adminToken),
        payload: { reportType, params: {} },
      });

      expect(response.statusCode, `export ${reportType}`).toBe(200);
      expect(fakeDatabase.insertedRows, `export ${reportType}`).toHaveLength(0);
      expect(fakeDatabase.updatedRows, `export ${reportType}`).toHaveLength(0);
    }
  });
});

describe("paginated list endpoints (S8-1)", () => {
  it("applies a bounded page to the invoice list and reports the total", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/invoices?page=2&pageSize=25",
      headers: authorizationHeader(adminToken),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ items: [], page: 2, pageSize: 25, total: 0 });
    expect(fakeDatabase.limitValues).toContain(25);
    expect(fakeDatabase.offsetValues).toContain(25);
  });

  it("defaults the invoice list to the first 50 rows", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/invoices",
      headers: authorizationHeader(adminToken),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ page: 1, pageSize: 50 });
    expect(fakeDatabase.limitValues).toContain(50);
    expect(fakeDatabase.offsetValues).toContain(0);
  });

  it("applies a bounded page to the payment list", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/payments?page=3&pageSize=10",
      headers: authorizationHeader(adminToken),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ page: 3, pageSize: 10, total: 0 });
    expect(fakeDatabase.limitValues).toContain(10);
    expect(fakeDatabase.offsetValues).toContain(20);
  });

  it("refuses a page size above the maximum", async () => {
    for (const url of ["/api/invoices?pageSize=9999", "/api/payments?pageSize=9999"]) {
      const response = await app.inject({ method: "GET", url, headers: authorizationHeader(adminToken) });
      expect(response.statusCode).toBe(400);
    }
  });

  it("refuses a page number below one", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/invoices?page=0",
      headers: authorizationHeader(adminToken),
    });

    expect(response.statusCode).toBe(400);
  });

  it("still filters the list endpoints server-side", async () => {
    fakeDatabase.reset();
    const response = await app.inject({
      method: "GET",
      url: "/api/invoices?status=overdue&year=2025&month=3",
      headers: authorizationHeader(adminToken),
    });

    expect(response.statusCode).toBe(200);
    const where = whereTextOf(fakeDatabase.whereConditions);
    expect(where).toContain("billing_period_year");
    expect(where).toContain("billing_period_month");
  });
});
