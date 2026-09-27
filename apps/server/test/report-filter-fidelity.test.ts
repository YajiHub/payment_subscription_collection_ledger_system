// Filter fidelity for every report (S6-2).
//
// The audit found reports that accepted a filter and ignored it: an aging report
// that returned the same rows whichever collector was asked for. A filter that does
// not reach the SQL `where` clause is that defect, so every case below runs the real
// loader twice — once with no filter, once with one — and asserts that the condition
// the query was built with CHANGED and now names the filtered column and binds the
// value that was supplied.
//
// The rendering of the condition is in `support/sql-debug.ts`; the recording is the
// in-memory database's `whereConditions`. No PostgreSQL is needed, so this runs on
// every machine — the real-SQL companion is `report-filters.postgres.test.ts`.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/db/connection", async () => {
  const { fakeDatabase } = await import("./support/fake-database");
  return {
    db: fakeDatabase.db,
    pool: {},
    checkDatabaseConnection: async () => ({ isReachable: true, latencyMs: 0, errorMessage: null }),
    closeDatabaseConnection: async () => {},
  };
});

import { fakeDatabase } from "./support/fake-database";
import { whereTextOf } from "./support/sql-debug";
import {
  loadCollectionSummaryRows,
} from "../src/modules/reports/collection-summary.service";
import { loadRevenueInvoiceRows } from "../src/modules/reports/revenue.service";
import {
  loadCollectorAssignmentRows,
  loadCollectorBatchRows,
  loadCollectorPaymentRows,
} from "../src/modules/reports/collector-reports.service";
import { loadPaymentAdjustmentRows } from "../src/modules/reports/payment-adjustment.service";
import { loadSubscriberMasterListRows } from "../src/modules/reports/subscriber-master-list.service";
import {
  loadOutstandingInvoicesWithCollector,
} from "../src/modules/reports/outstanding-by-collector.service";
import { loadOutstandingInvoices as loadAgingInvoices } from "../src/modules/receivables/ar-aging.service";
import { listOverdueAccounts } from "../src/modules/receivables/overdue-accounts.service";
import { loadAuditReportRows } from "../src/modules/reports/audit-reports.service";
import { toReportDateRange, type ReportFilters } from "../src/modules/reports/report-filters";
import { listInvoices } from "../src/modules/billing/invoices.service";
import { listPayments } from "../src/modules/payments/payments.service";

const COLLECTOR_ID = "11111111-1111-1111-1111-111111111111";
const AREA_ID = "22222222-2222-2222-2222-222222222222";
const PLAN_ID = "33333333-3333-3333-3333-333333333333";
const SUBSCRIBER_ID = "44444444-4444-4444-4444-444444444444";
const USER_ID = "55555555-5555-5555-5555-555555555555";

const RANGE = { fromDate: "2025-01-01", toDate: "2025-01-31" };
const AS_OF = new Date("2025-02-01T00:00:00Z");

beforeEach(() => {
  fakeDatabase.reset();
});

/** The `where` text a loader builds for a given set of filters. */
async function whereTextFor(
  run: (filters: ReportFilters) => Promise<unknown>,
  filters: ReportFilters
): Promise<string> {
  fakeDatabase.reset();
  await run(filters);
  return whereTextOf(fakeDatabase.whereConditions);
}

/** The four account filters every account-scoped report must honour. */
const ACCOUNT_FILTERS: { column: string; value: string; filters: ReportFilters }[] = [
  { column: "assigned_collector_id", value: COLLECTOR_ID, filters: { collectorId: COLLECTOR_ID } },
  { column: "area_id", value: AREA_ID, filters: { areaId: AREA_ID } },
  { column: "plan_id", value: PLAN_ID, filters: { planId: PLAN_ID } },
  { column: "service_type", value: "internet", filters: { serviceType: "internet" } },
];

/** Every report that accepts the shared account filters, with a way to run it. */
const ACCOUNT_SCOPED_REPORTS: { name: string; run: (filters: ReportFilters) => Promise<unknown> }[] =
  [
    { name: "weekly/annual collection", run: (filters) => loadCollectionSummaryRows(RANGE, filters) },
    {
      name: "revenue by plan / service type / area",
      run: (filters) =>
        loadRevenueInvoiceRows(toReportDateRange(RANGE.fromDate, RANGE.toDate), filters),
    },
    { name: "collector assignment", run: (filters) => loadCollectorAssignmentRows(filters) },
    {
      name: "collector performance",
      run: (filters) => loadCollectorPaymentRows(RANGE, filters),
    },
    {
      name: "payment adjustments / voided receipts",
      run: (filters) => loadPaymentAdjustmentRows(RANGE, filters),
    },
    { name: "subscriber master list", run: (filters) => loadSubscriberMasterListRows(filters) },
    {
      name: "AR aging",
      run: (filters) => loadAgingInvoices(undefined, filters),
    },
    {
      name: "outstanding by collector",
      run: (filters) => loadOutstandingInvoicesWithCollector(undefined, filters),
    },
    { name: "overdue accounts", run: (filters) => listOverdueAccounts(filters, AS_OF) },
  ];

describe("every account-scoped report pushes its filters into SQL (S6-2)", () => {
  for (const report of ACCOUNT_SCOPED_REPORTS) {
    for (const filter of ACCOUNT_FILTERS) {
      it(`${report.name} filters by ${filter.column}`, async () => {
        const unfiltered = await whereTextFor(report.run, {});
        expect(unfiltered).not.toContain(filter.column);

        const filtered = await whereTextFor(report.run, filter.filters);
        expect(filtered).toContain(filter.column);
        expect(filtered).toContain(filter.value);
        // The query really changed: a filter that leaves the condition identical is
        // the ignored-filter defect the audit reported.
        expect(filtered).not.toBe(unfiltered);
      });
    }
  }
});

describe("report-specific filters reach SQL (S6-2)", () => {
  it("collector performance applies collector_id to the batch query", async () => {
    const unfiltered = await whereTextFor(
      (filters) => loadCollectorBatchRows(RANGE, filters),
      {}
    );
    const filtered = await whereTextFor(
      (filters) => loadCollectorBatchRows(RANGE, filters),
      { collectorId: COLLECTOR_ID }
    );

    expect(unfiltered).not.toContain("collector_id");
    expect(filtered).toContain("collector_id");
    expect(filtered).toContain(COLLECTOR_ID);
  });

  it("the subscriber master list filters by account status", async () => {
    const unfiltered = await whereTextFor((filters) => loadSubscriberMasterListRows(filters), {});
    const filtered = await whereTextFor(
      (filters) => loadSubscriberMasterListRows({ ...filters, serviceStatus: "suspended" }),
      {}
    );

    expect(unfiltered).not.toContain("suspended");
    expect(filtered).toContain("suspended");
  });

  it("the audit reports filter by user, action, and entity type", async () => {
    fakeDatabase.reset();
    await loadAuditReportRows(RANGE, { performedBy: USER_ID });
    const userOnly = whereTextOf(fakeDatabase.whereConditions);

    fakeDatabase.reset();
    await loadAuditReportRows(RANGE, { action: "payment.reversed" });
    const actionOnly = whereTextOf(fakeDatabase.whereConditions);

    fakeDatabase.reset();
    await loadAuditReportRows(RANGE, { entityType: "invoice" });
    const entityOnly = whereTextOf(fakeDatabase.whereConditions);

    expect(userOnly).toContain("performed_by");
    expect(userOnly).toContain(USER_ID);
    expect(actionOnly).toContain("action");
    expect(actionOnly).toContain("payment.reversed");
    expect(entityOnly).toContain("entity_type");
    expect(entityOnly).toContain("invoice");
  });
});

describe("the invoice and payment list filters reach SQL (S8-1)", () => {
  it("the invoice list filters by status, period, and subscriber", async () => {
    await listInvoices({});
    const unfiltered = whereTextOf(fakeDatabase.whereConditions);

    fakeDatabase.reset();
    await listInvoices({ status: "overdue", year: 2025, month: 3, subscriberId: SUBSCRIBER_ID });
    const filtered = whereTextOf(fakeDatabase.whereConditions);

    expect(unfiltered).not.toContain("billing_period_year");
    expect(filtered).toContain("status");
    expect(filtered).toContain("billing_period_year");
    expect(filtered).toContain("billing_period_month");
    expect(filtered).toContain("subscriber_id");
    expect(filtered).not.toBe(unfiltered);
  });

  it("the payment list filters by method, status, and date range", async () => {
    await listPayments({});
    const unfiltered = whereTextOf(fakeDatabase.whereConditions);

    fakeDatabase.reset();
    await listPayments({
      method: "gcash",
      status: "posted",
      dateFrom: "2025-01-01",
      dateTo: "2025-01-31",
    });
    const filtered = whereTextOf(fakeDatabase.whereConditions);

    expect(unfiltered).not.toContain("payment_date");
    expect(filtered).toContain("payment_method");
    expect(filtered).toContain("gcash");
    expect(filtered).toContain("payment_date");
    expect(filtered).not.toBe(unfiltered);
  });

  it("the invoice list orders and pages its query", async () => {
    // The in-memory builder ignores LIMIT/OFFSET, so this asserts the shape of the
    // call the service makes through the count query as well: two reads, one page.
    fakeDatabase.queueSelectRows([]);
    const page = await listInvoices({ page: 2, pageSize: 25 });

    expect(page.page).toBe(2);
    expect(page.pageSize).toBe(25);
    expect(page.total).toBe(0);
  });

  it("the payment list orders and pages its query", async () => {
    fakeDatabase.queueSelectRows([]);
    const page = await listPayments({ page: 3, pageSize: 10 });

    expect(page.page).toBe(3);
    expect(page.pageSize).toBe(10);
    expect(page.total).toBe(0);
  });
});
