// Acceptance tests for Phase 8 — the management dashboard and the reports.
//
// They run against the real Fastify app via `app.inject()` with the database
// swapped for the in-memory stand-in, so no PostgreSQL is required. What is being
// pinned down is the money arithmetic and the authorization boundary:
//
//   • every total in a reply equals the sum of the rows that reply contains;
//   • a voided invoice, a reversed payment, and a voided collection count for
//     nothing;
//   • an empty database answers with zeros and a valid export file, not a crash;
//   • `reports:view`, `reports:management_view`, and `reports:export` are distinct:
//     a Cashier may read the operational reports but not the management ones and may
//     not take a file, and an unknown role is denied outright;
//   • the report routes perform NO insert, update, or delete;
//   • a Collector is still restricted to their own batches on the remittance report.

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

import type { UserRole } from "@bcis/shared";
import { buildServer } from "../src/index.ts";
import { refreshPermissionCache } from "../src/shared/rbac/permission-resolver";
import { fakeDatabase } from "./support/fake-database";
import { authorizationHeader, signTestToken } from "./support/tokens";

const ADMIN_ID = randomUUID();
const COLLECTOR_A_ID = randomUUID();
const COLLECTOR_B_ID = randomUUID();
const BATCH_ID = randomUUID();
const SERVICE_ACCOUNT_ID = randomUUID();

/** Today as the office's calendar day, matching the report handler's default. */
function todayDateOnly(): string {
  const today = new Date();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  return `${today.getFullYear()}-${month}-${day}`;
}

/**
 * The calendar day `days` before a given day.
 *
 * Anchored to UTC midnight of the local day, exactly as the server anchors it, so a
 * "31 days past due" fixture is 31 days past due in every timezone.
 */
function daysBefore(day: string, days: number): string {
  return new Date(new Date(`${day}T00:00:00.000Z`).getTime() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

/** The Nth day of the current month, so the dashboard's month window contains it. */
function thisMonthDay(day: number): string {
  return `${todayDateOnly().slice(0, 7)}-${String(day).padStart(2, "0")}`;
}

// ─── Row factories, one per shape a report query selects ─────────────────────

/** A payment row as the daily collection report selects it. */
function dailyPaymentRow(overrides: Record<string, unknown> = {}) {
  return {
    receiptNumber: "OR-2025-000001",
    postedAt: new Date("2025-01-24T09:15:00Z"),
    subscriberFirstName: "Maria",
    subscriberLastName: "Santos",
    serviceAccountNumber: "SA-20250101-00001",
    paymentMethod: "cash",
    status: "posted",
    amountCentavos: 10000,
    postedByName: "Ana Cruz",
    ...overrides,
  };
}

/** An invoice row as the monthly billing report selects it. */
function billingInvoiceRow(overrides: Record<string, unknown> = {}) {
  return {
    invoiceNumber: "INV-2025-01-000001",
    subscriberFirstName: "Maria",
    subscriberLastName: "Santos",
    serviceAccountNumber: "SA-20250101-00001",
    planName: "Fiber 25Mbps",
    invoiceDate: "2025-01-05",
    dueDate: "2025-01-15",
    totalAmountCentavos: 99900,
    paidAmountCentavos: 0,
    remainingBalanceCentavos: 99900,
    status: "posted",
    ...overrides,
  };
}

/** An outstanding invoice row as the AR aging query selects it. */
function outstandingInvoiceRow(overrides: Record<string, unknown> = {}) {
  return {
    invoiceId: randomUUID(),
    serviceAccountId: randomUUID(),
    remainingBalanceCentavos: 100000,
    dueDate: "2025-03-01", // 31 days before 2025-04-01: the 31-60 bucket
    subscriberId: randomUUID(),
    subscriberFirstName: "Maria",
    subscriberLastName: "Santos",
    serviceAccountNumber: "SA-20250101-00001",
    planName: "Fiber 25Mbps",
    ...overrides,
  };
}

/** A service account row as the dashboard's subscriber metrics select it. */
function serviceAccountRow(overrides: Record<string, unknown> = {}) {
  // Created this month by default, because the dashboard reads the CURRENT month
  // and a fixed historical date would make the account fall outside it.
  const now = new Date();
  return {
    status: "active",
    createdAt: new Date(now.getFullYear(), now.getMonth(), 10, 9, 0),
    ...overrides,
  };
}

/** A service account created in the previous calendar month. */
function lastMonthServiceAccountRow(overrides: Record<string, unknown> = {}) {
  const now = new Date();
  return serviceAccountRow({
    createdAt: new Date(now.getFullYear(), now.getMonth() - 1, 15, 9, 0),
    ...overrides,
  });
}

/** A payment row as the dashboard's month selector returns it. */
function dashboardPaymentRow(overrides: Record<string, unknown> = {}) {
  return {
    status: "posted",
    paymentDate: thisMonthDay(5),
    paymentMethod: "cash",
    amountCentavos: 50000,
    ...overrides,
  };
}

/** A stored collector batch row. */
function batchRow(overrides: Record<string, unknown> = {}) {
  return {
    id: BATCH_ID,
    batchNumber: "CB-20250124-0001",
    collectorId: COLLECTOR_A_ID,
    status: "submitted",
    collectionDate: "2025-01-24",
    expectedRemittanceCentavos: 700000,
    actualRemittanceCentavos: 650000,
    varianceCentavos: -50000,
    varianceNotes: "Short by PHP 500",
    createdAt: new Date("2025-01-24T08:00:00Z"),
    submittedAt: new Date("2025-01-24T17:00:00Z"),
    reconciledAt: null,
    cancelledAt: null,
    createdBy: ADMIN_ID,
    reconciledBy: null,
    cancelledBy: null,
    cancelReason: null,
    ...overrides,
  };
}

/** A batch assignment row as the batch detail query selects it. */
function assignmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    serviceAccountId: SERVICE_ACCOUNT_ID,
    serviceAccountNumber: "SA-20250101-00001",
    subscriberId: randomUUID(),
    subscriberFirstName: "Maria",
    subscriberLastName: "Santos",
    planName: "Fiber 25Mbps",
    outstandingBalanceCentavos: 99900,
    collectionResult: "collected",
    collectedAmountCentavos: 700000,
    collectedMethod: "cash",
    paymentId: randomUUID(),
    collectorNotes: null,
    voidedAt: null,
    voidReason: null,
    ...overrides,
  };
}

let app: FastifyInstance;
let adminToken: string;
let cashierToken: string;
let collectorAToken: string;
let collectorBToken: string;
let billingClerkToken: string;
let managerToken: string;

/** A token for a role the permission matrix does not know, as an older build might mint. */
const UNKNOWN_ROLE_TOKEN = (): string => signTestToken({ role: "auditor" as UserRole }).token;

beforeAll(async () => {
  app = buildServer();
  await app.ready();

  // These tests exercise the report routes, not RBAC resolution — that has its own
  // suite. The server resolves permissions from the RBAC tables when it can, so the
  // cache is warmed ONCE here with the documented rollback switch off, which selects
  // the compiled matrix. Warming it before any test queues rows keeps the warm-up
  // read from consuming a test's queued result sets.
  fakeDatabase.queueSelectRows([{ value: "false" }]);
  await refreshPermissionCache({ force: true });
  fakeDatabase.reset();

  adminToken = signTestToken({ sub: ADMIN_ID, role: "admin" }).token;
  cashierToken = signTestToken({ role: "cashier" }).token;
  collectorAToken = signTestToken({ sub: COLLECTOR_A_ID, role: "collector" }).token;
  collectorBToken = signTestToken({ sub: COLLECTOR_B_ID, role: "collector" }).token;
  billingClerkToken = signTestToken({ role: "billing_clerk" }).token;
  managerToken = signTestToken({ role: "manager" }).token;
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  fakeDatabase.reset();
});

/** Every write the fake database saw, so a test can prove a route wrote nothing. */
function recordedWrites(): number {
  return fakeDatabase.insertedRows.length + fakeDatabase.updatedRows.length;
}

/**
 * Queues the result sets an authenticated report request reads.
 *
 * The first entry is always the token-revocation lookup the auth middleware runs
 * before the route, so a test that queues report rows and nothing else would feed
 * those rows to the permission check instead.
 */
function queueReportRows(...resultSets: unknown[][]): void {
  fakeDatabase.queueSelectRows([]); // authenticate: the token has not been revoked
  fakeDatabase.queueSelectRows(...resultSets);
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

describe("GET /api/dashboard/kpis", () => {
  it("answers with zeros on an empty database", async () => {
    // The loaders run in a fixed order: accounts, invoices, payments, outstanding
    // invoices, batches, then the latest billing run.
    queueReportRows([], [], [], [], [], []);

    const response = await app.inject({
      method: "GET",
      url: "/api/dashboard/kpis",
      headers: authorizationHeader(adminToken),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({
      totalActiveServiceAccounts: 0,
      newServiceAccountsThisMonth: 0,
      suspendedAccounts: 0,
      terminatedAccounts: 0,
      totalInvoicedThisMonthCentavos: 0,
      totalCollectedThisMonthCentavos: 0,
      collectionRatePercent: 0,
      totalOutstandingArCentavos: 0,
      overdueOver30DaysCentavos: 0,
      overdueOver90DaysCentavos: 0,
      openCollectorBatches: 0,
      submittedBatchesPendingReconciliation: 0,
      lastBillingRunDate: null,
      lastBillingRunAccountsCount: null,
    });
    expect(recordedWrites()).toBe(0);
  });

  it("counts exactly the rows it was given, and excludes void or reversed records", async () => {
    const today = todayDateOnly();

    queueReportRows(
      [
        serviceAccountRow({ status: "active" }),
        serviceAccountRow({ status: "active" }),
        serviceAccountRow({ status: "suspended" }),
        serviceAccountRow({ status: "terminated" }),
        lastMonthServiceAccountRow(), // created last month, so not "new this month"
      ],
      [
        {
          status: "posted",
          invoiceDate: thisMonthDay(5),
          totalAmountCentavos: 300000,
          paidAmountCentavos: 0,
          remainingBalanceCentavos: 300000,
        },
        {
          status: "void",
          invoiceDate: thisMonthDay(6),
          totalAmountCentavos: 900000,
          paidAmountCentavos: 0,
          remainingBalanceCentavos: 900000,
        },
      ],
      [
        dashboardPaymentRow({ amountCentavos: 100000 }),
        dashboardPaymentRow({ amountCentavos: 500000, status: "reversed" }),
      ],
      [
        // Exactly 31 days past due: the 31-60 bucket, so it counts as "over 30 days".
        outstandingInvoiceRow({ remainingBalanceCentavos: 100000, dueDate: daysBefore(today, 31) }),
        // Exactly 91 days past due: the 90+ bucket.
        outstandingInvoiceRow({ remainingBalanceCentavos: 40000, dueDate: daysBefore(today, 91) }),
      ],
      [{ status: "open" }, { status: "submitted" }],
      [{ ranAt: new Date(2025, 3, 2, 9, 30), totalServiceAccountsProcessed: 17 }]
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/dashboard/kpis",
      headers: authorizationHeader(managerToken),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      totalActiveServiceAccounts: 3,
      newServiceAccountsThisMonth: 4,
      suspendedAccounts: 1,
      terminatedAccounts: 1,
      totalInvoicedThisMonthCentavos: 300000,
      totalCollectedThisMonthCentavos: 100000,
      collectionRatePercent: 33.33,
      totalOutstandingArCentavos: 140000,
      overdueOver30DaysCentavos: 140000,
      overdueOver90DaysCentavos: 40000,
      openCollectorBatches: 1,
      submittedBatchesPendingReconciliation: 1,
      lastBillingRunDate: "2025-04-02",
      lastBillingRunAccountsCount: 17,
    });
    expect(recordedWrites()).toBe(0);
  });

  it("requires a token", async () => {
    const response = await app.inject({ method: "GET", url: "/api/dashboard/kpis" });

    expect(response.statusCode).toBe(401);
  });

  it("denies the Cashier and the Collector the dashboard, a management view", async () => {
    for (const token of [cashierToken, collectorAToken]) {
      const response = await app.inject({
        method: "GET",
        url: "/api/dashboard/kpis",
        headers: authorizationHeader(token),
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("FORBIDDEN");
    }
  });
});

// ─── Daily collection summary ─────────────────────────────────────────────────

describe("GET /api/reports/daily-collection", () => {
  it("totals exactly the payments it lists", async () => {
    queueReportRows([
      dailyPaymentRow({ receiptNumber: "OR-2025-000001", amountCentavos: 10000 }),
      dailyPaymentRow({
        receiptNumber: "OR-2025-000002",
        amountCentavos: 25000,
        paymentMethod: "gcash",
      }),
    ]);

    const response = await app.inject({
      method: "GET",
      url: "/api/reports/daily-collection?date=2025-01-24",
      headers: authorizationHeader(cashierToken),
    });

    const body = response.json().data;
    const listedTotal = body.items.reduce(
      (runningTotal: number, item: { amountCentavos: number }) =>
        runningTotal + item.amountCentavos,
      0
    );

    expect(response.statusCode).toBe(200);
    expect(body.date).toBe("2025-01-24");
    expect(body.totals).toEqual({
      paymentCount: 2,
      cashTotalCentavos: 10000,
      gcashTotalCentavos: 25000,
      grandTotalCentavos: 35000,
    });
    expect(body.totals.grandTotalCentavos).toBe(listedTotal);
    expect(recordedWrites()).toBe(0);
  });

  it("counts a reversed payment for nothing", async () => {
    queueReportRows([
      dailyPaymentRow({ receiptNumber: "OR-2025-000001", amountCentavos: 10000 }),
      dailyPaymentRow({
        receiptNumber: "OR-2025-000002",
        amountCentavos: 990000,
        status: "reversed",
      }),
    ]);

    const response = await app.inject({
      method: "GET",
      url: "/api/reports/daily-collection?date=2025-01-24",
      headers: authorizationHeader(cashierToken),
    });

    const body = response.json().data;
    expect(body.items).toHaveLength(1);
    expect(body.totals.grandTotalCentavos).toBe(10000);
  });

  it("defaults to today's office day when no date is given", async () => {
    queueReportRows([]);

    const response = await app.inject({
      method: "GET",
      url: "/api/reports/daily-collection",
      headers: authorizationHeader(adminToken),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.date).toBe(todayDateOnly());
    expect(response.json().data.totals.grandTotalCentavos).toBe(0);
  });

  it("rejects a malformed date with a readable 400", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/reports/daily-collection?date=24-01-2025",
      headers: authorizationHeader(adminToken),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("lets the Cashier read it — that is the end-of-day cash count", async () => {
    queueReportRows([]);

    const response = await app.inject({
      method: "GET",
      url: "/api/reports/daily-collection?date=2025-01-24",
      headers: authorizationHeader(cashierToken),
    });

    expect(response.statusCode).toBe(200);
  });
});

// ─── Monthly billing summary ──────────────────────────────────────────────────

describe("GET /api/reports/monthly-billing", () => {
  it("lists every invoice and totals only the live ones", async () => {
    queueReportRows([
      billingInvoiceRow(),
      billingInvoiceRow({
        invoiceNumber: "INV-2025-01-000002",
        totalAmountCentavos: 50000,
        paidAmountCentavos: 50000,
        remainingBalanceCentavos: 0,
        status: "paid",
      }),
      billingInvoiceRow({
        invoiceNumber: "INV-2025-01-000003",
        totalAmountCentavos: 777700,
        remainingBalanceCentavos: 777700,
        status: "void",
      }),
    ]);

    const response = await app.inject({
      method: "GET",
      url: "/api/reports/monthly-billing?year=2025&month=1",
      headers: authorizationHeader(managerToken),
    });

    const body = response.json().data;
    expect(response.statusCode).toBe(200);
    expect(body.periodLabel).toBe("January 2025");
    expect(body.items).toHaveLength(3);
    expect(body.totals).toEqual({
      invoiceCount: 2,
      totalInvoicedCentavos: 149900,
      totalPaidCentavos: 50000,
      totalOutstandingCentavos: 99900,
    });
    expect(recordedWrites()).toBe(0);
  });

  it("requires a period", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/reports/monthly-billing?year=2025",
      headers: authorizationHeader(managerToken),
    });

    expect(response.statusCode).toBe(400);
  });
});

// ─── AR aging ─────────────────────────────────────────────────────────────────

describe("GET /api/reports/ar-aging", () => {
  it("totals the outstanding balances and separates the buckets exactly", async () => {
    queueReportRows([
      outstandingInvoiceRow({ remainingBalanceCentavos: 100000, dueDate: "2025-03-01" }), // 31 days
      outstandingInvoiceRow({ remainingBalanceCentavos: 250000, dueDate: "2024-12-31" }), // 91 days
    ]);

    const response = await app.inject({
      method: "GET",
      url: "/api/reports/ar-aging?asOf=2025-04-01",
      headers: authorizationHeader(managerToken),
    });

    const body = response.json().data;
    expect(response.statusCode).toBe(200);
    expect(body.totals.bucket_31_60).toBe(100000);
    expect(body.totals.over_90).toBe(250000);
    expect(body.totals.grandTotal).toBe(350000);
    expect(recordedWrites()).toBe(0);
  });

  it("answers with zeros and an empty list when nothing is outstanding", async () => {
    queueReportRows([]);

    const response = await app.inject({
      method: "GET",
      url: "/api/reports/ar-aging",
      headers: authorizationHeader(adminToken),
    });

    const body = response.json().data;
    expect(response.statusCode).toBe(200);
    expect(body.entries).toEqual([]);
    expect(body.totals.grandTotal).toBe(0);
  });
});

// ─── Collector remittance ─────────────────────────────────────────────────────

describe("GET /api/reports/collector-remittance", () => {
  it("reports the batch's expected remittance, actual remittance, and variance", async () => {
    queueReportRows(
      [{ batch: batchRow(), collectorName: "Rico Reyes" }],
      [assignmentRow({ collectedAmountCentavos: 650000 })]
    );

    const response = await app.inject({
      method: "GET",
      url: `/api/reports/collector-remittance?batchId=${BATCH_ID}`,
      headers: authorizationHeader(managerToken),
    });

    const body = response.json().data;
    expect(response.statusCode).toBe(200);
    expect(body.batchNumber).toBe("CB-20250124-0001");
    expect(body.collectorName).toBe("Rico Reyes");
    expect(body.expectedRemittanceCentavos).toBe(650000);
    expect(body.actualRemittanceCentavos).toBe(650000);
    expect(body.varianceCentavos).toBe(-50000);
    expect(body.hasVariance).toBe(true);
    expect(recordedWrites()).toBe(0);
  });

  it("still restricts a Collector to their own batches", async () => {
    queueReportRows([{ batch: batchRow(), collectorName: "Rico Reyes" }]);

    const response = await app.inject({
      method: "GET",
      url: `/api/reports/collector-remittance?batchId=${BATCH_ID}`,
      headers: authorizationHeader(collectorBToken),
    });

    expect(response.statusCode).toBe(404);
  });

  it("lets the owning Collector read their own batch report", async () => {
    queueReportRows([{ batch: batchRow(), collectorName: "Rico Reyes" }], [assignmentRow()]);

    const response = await app.inject({
      method: "GET",
      url: `/api/reports/collector-remittance?batchId=${BATCH_ID}`,
      headers: authorizationHeader(collectorAToken),
    });

    expect(response.statusCode).toBe(200);
  });
});

// ─── Outstanding receivables by collector ─────────────────────────────────────

describe("GET /api/reports/outstanding-by-collector", () => {
  it("groups by collector and reconciles with the aging grand total", async () => {
    queueReportRows([
      outstandingInvoiceRow({
        collectorId: COLLECTOR_A_ID,
        collectorName: "Rico Reyes",
        remainingBalanceCentavos: 100000,
        dueDate: "2025-03-01", // 31 days: the 30-60 column
      }),
      outstandingInvoiceRow({
        collectorId: COLLECTOR_B_ID,
        collectorName: "Lito Bautista",
        remainingBalanceCentavos: 250000,
        dueDate: "2024-12-31", // 91 days: the 90+ column
      }),
    ]);

    const agingResponse = await app.inject({
      method: "GET",
      url: "/api/reports/ar-aging?asOf=2025-04-01",
      headers: authorizationHeader(managerToken),
    });

    queueReportRows([
      outstandingInvoiceRow({
        collectorId: COLLECTOR_A_ID,
        collectorName: "Rico Reyes",
        remainingBalanceCentavos: 100000,
        dueDate: "2025-03-01",
      }),
      outstandingInvoiceRow({
        collectorId: COLLECTOR_B_ID,
        collectorName: "Lito Bautista",
        remainingBalanceCentavos: 250000,
        dueDate: "2024-12-31",
      }),
    ]);

    const response = await app.inject({
      method: "GET",
      url: "/api/reports/outstanding-by-collector?asOf=2025-04-01",
      headers: authorizationHeader(managerToken),
    });

    const body = response.json().data;
    expect(response.statusCode).toBe(200);
    expect(body.groups).toHaveLength(2);
    expect(body.totals.totalOutstandingCentavos).toBe(agingResponse.json().data.totals.grandTotal);
    expect(body.totals.bucket_30_60_centavos).toBe(100000);
    expect(body.totals.over_90_centavos).toBe(250000);
    expect(recordedWrites()).toBe(0);
  });

  it("answers with an empty report when nobody owes anything", async () => {
    queueReportRows([]);

    const response = await app.inject({
      method: "GET",
      url: "/api/reports/outstanding-by-collector",
      headers: authorizationHeader(adminToken),
    });

    const body = response.json().data;
    expect(response.statusCode).toBe(200);
    expect(body.groups).toEqual([]);
    expect(body.totals.totalOutstandingCentavos).toBe(0);
  });
});

// ─── Exports ──────────────────────────────────────────────────────────────────

describe("POST /api/reports/export-pdf", () => {
  it("returns a real PDF that a reader can load", async () => {
    queueReportRows([
      outstandingInvoiceRow({ remainingBalanceCentavos: 100000, dueDate: "2025-03-01" }),
    ]);

    const response = await app.inject({
      method: "POST",
      url: "/api/reports/export-pdf",
      headers: authorizationHeader(managerToken),
      payload: { reportType: "ar_aging", params: { asOf: "2025-04-01" } },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/pdf");
    expect(response.headers["content-disposition"]).toContain("AR-aging-2025-04-01.pdf");
    expect(response.rawPayload.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(response.rawPayload.subarray(-6).toString("latin1").trim()).toBe("%%EOF");
    expect(recordedWrites()).toBe(0);
  });

  it("still produces a valid document when there is no data", async () => {
    queueReportRows([]);

    const response = await app.inject({
      method: "POST",
      url: "/api/reports/export-pdf",
      headers: authorizationHeader(adminToken),
      payload: { reportType: "daily_collection", params: { date: "2025-01-24" } },
    });

    expect(response.statusCode).toBe(200);
    expect(response.rawPayload.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(response.headers["content-disposition"]).toContain("daily-collection-2025-01-24.pdf");
  });

  it("exports the collector remittance report the same way the screen shows it", async () => {
    queueReportRows([{ batch: batchRow(), collectorName: "Rico Reyes" }], [assignmentRow()]);

    const response = await app.inject({
      method: "POST",
      url: "/api/reports/export-pdf",
      headers: authorizationHeader(managerToken),
      payload: { reportType: "collector_remittance", params: { batchId: BATCH_ID } },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-disposition"]).toContain(
      "collector-remittance-CB-20250124-0001.pdf"
    );
  });

  it("rejects a report asked for without the parameters it reads", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/reports/export-pdf",
      headers: authorizationHeader(managerToken),
      payload: { reportType: "monthly_billing", params: {} },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toBe("A year is required");
  });

  it("rejects a report type that does not exist", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/reports/export-pdf",
      headers: authorizationHeader(managerToken),
      payload: { reportType: "profit_and_loss", params: {} },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe("POST /api/reports/export-xlsx", () => {
  it("returns a real spreadsheet workbook", async () => {
    queueReportRows([billingInvoiceRow()]);

    const response = await app.inject({
      method: "POST",
      url: "/api/reports/export-xlsx",
      headers: authorizationHeader(managerToken),
      payload: { reportType: "monthly_billing", params: { year: 2025, month: 1 } },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("spreadsheetml.sheet");
    expect(response.headers["content-disposition"]).toContain("monthly-billing-2025-01.xlsx");
    expect(response.rawPayload.subarray(0, 2).toString("latin1")).toBe("PK");
    expect(recordedWrites()).toBe(0);
  });
});

// ─── Authorization ────────────────────────────────────────────────────────────

describe("report permissions", () => {
  it("lets a Cashier view the daily collection report but not export a file", async () => {
    queueReportRows([]);

    const viewResponse = await app.inject({
      method: "GET",
      url: "/api/reports/daily-collection?date=2025-01-24",
      headers: authorizationHeader(cashierToken),
    });

    const exportResponse = await app.inject({
      method: "POST",
      url: "/api/reports/export-xlsx",
      headers: authorizationHeader(cashierToken),
      payload: { reportType: "daily_collection", params: { date: "2025-01-24" } },
    });

    expect(viewResponse.statusCode).toBe(200);
    expect(exportResponse.statusCode).toBe(403);
    expect(exportResponse.json().error.code).toBe("FORBIDDEN");
    expect(recordedWrites()).toBe(0);
  });

  it("denies a Cashier the management reports but allows the operational ones", async () => {
    // Phase 8 §9: "Cashier role can view Daily Collection but not all management
    // reports." The management reports expose the whole ledger, so the server must
    // refuse them for a Cashier — not merely hide them in the UI.
    const managementUrls = [
      "/api/reports/monthly-billing?year=2025&month=1",
      "/api/reports/ar-aging?asOf=2025-04-01",
      "/api/reports/outstanding-by-collector?asOf=2025-04-01",
    ];

    for (const url of managementUrls) {
      const response = await app.inject({
        method: "GET",
        url,
        headers: authorizationHeader(cashierToken),
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("FORBIDDEN");
    }

    queueReportRows([]);
    const operational = await app.inject({
      method: "GET",
      url: "/api/reports/daily-collection?date=2025-01-24",
      headers: authorizationHeader(cashierToken),
    });

    expect(operational.statusCode).toBe(200);
    expect(recordedWrites()).toBe(0);
  });

  it("lets the Billing Clerk view the management reports", async () => {
    const managementUrls = [
      "/api/reports/monthly-billing?year=2025&month=1",
      "/api/reports/ar-aging?asOf=2025-04-01",
      "/api/reports/outstanding-by-collector?asOf=2025-04-01",
    ];

    for (const url of managementUrls) {
      queueReportRows([]);
      const response = await app.inject({
        method: "GET",
        url,
        headers: authorizationHeader(billingClerkToken),
      });

      expect(response.statusCode).toBe(200);
    }

    expect(recordedWrites()).toBe(0);
  });

  it("denies every export to a role that cannot export, including the Collector", async () => {
    for (const token of [cashierToken, collectorAToken, billingClerkToken]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/reports/export-pdf",
        headers: authorizationHeader(token),
        payload: { reportType: "daily_collection", params: { date: "2025-01-24" } },
      });

      expect(response.statusCode).toBe(403);
    }
  });

  it("lets the Manager view and export every report", async () => {
    const viewUrls = [
      "/api/reports/daily-collection?date=2025-01-24",
      "/api/reports/monthly-billing?year=2025&month=1",
      "/api/reports/ar-aging?asOf=2025-04-01",
      "/api/reports/outstanding-by-collector?asOf=2025-04-01",
    ];

    for (const url of viewUrls) {
      queueReportRows([]);
      const response = await app.inject({
        method: "GET",
        url,
        headers: authorizationHeader(managerToken),
      });
      expect(response.statusCode).toBe(200);
    }

    expect(recordedWrites()).toBe(0);
  });

  it("denies a role the permission matrix does not know", async () => {
    queueReportRows([]);

    const response = await app.inject({
      method: "GET",
      url: "/api/reports/daily-collection?date=2025-01-24",
      headers: authorizationHeader(UNKNOWN_ROLE_TOKEN()),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("FORBIDDEN");
  });

  it("requires a token on every report route", async () => {
    const routes = [
      { method: "GET" as const, url: "/api/reports/daily-collection" },
      { method: "GET" as const, url: "/api/reports/monthly-billing?year=2025&month=1" },
      { method: "GET" as const, url: "/api/reports/ar-aging" },
      { method: "GET" as const, url: `/api/reports/collector-remittance?batchId=${BATCH_ID}` },
      { method: "GET" as const, url: "/api/reports/outstanding-by-collector" },
      { method: "POST" as const, url: "/api/reports/export-pdf", payload: {} },
      { method: "POST" as const, url: "/api/reports/export-xlsx", payload: {} },
    ];

    for (const route of routes) {
      const response = await app.inject(route);
      expect(response.statusCode).toBe(401);
    }
  });
});
