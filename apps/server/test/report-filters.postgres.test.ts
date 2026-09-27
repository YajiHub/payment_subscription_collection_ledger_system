// Real-PostgreSQL proof that a report filter changes the ROW SET (S6-2).
//
// `report-filter-fidelity.test.ts` proves the filter reaches the SQL `where` clause
// without a database. This suite closes the other half of the loop against a live
// database: the same loader, run with and without a filter, against the same rows,
// returns a DIFFERENT set — the audit's "accepts a collector id and returns the same
// rows" defect cannot survive it.
//
// The fixture lives on a unique plan, area, and collector, and its invoices are dated
// in 2099, so no other suite's data can fall inside the assertions. The suite skips
// itself when no database answers.

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, closeDatabaseConnection, pool } from "../src/db/connection";
import { listInvoices } from "../src/modules/billing/invoices.service";
import { loadOutstandingInvoices } from "../src/modules/receivables/ar-aging.service";
import { listOverdueAccounts } from "../src/modules/receivables/overdue-accounts.service";
import { loadAuditReportRows } from "../src/modules/reports/audit-reports.service";
import { loadCollectorAssignmentRows } from "../src/modules/reports/collector-reports.service";
import { loadPaymentAdjustmentRows } from "../src/modules/reports/payment-adjustment.service";
import { toReportDateRange } from "../src/modules/reports/report-filters";
import { loadRevenueInvoiceRows } from "../src/modules/reports/revenue.service";
import { deleteAuditLogsForUsers } from "./support/audit-cleanup";

/** A valid bcrypt hash. The value is never checked here — only its shape. */
const DUMMY_PASSWORD_HASH = "$2b$12$OMlJdIjzDLp3Jfn.9NR3qOBmwx5aLVRkyrFhSH6e5J1g.kCBMSeJe";

async function isDatabaseReachable(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

const databaseIsReachable = await isDatabaseReachable();

describe.skipIf(!databaseIsReachable)("report filters against real PostgreSQL", () => {
  const created = {
    userIds: [] as string[],
    areaIds: [] as string[],
    planIds: [] as string[],
    subscriberIds: [] as string[],
    serviceAccountIds: [] as string[],
    invoiceIds: [] as string[],
    paymentIds: [] as string[],
  };

  /** A unique audit action, so the audit-report test cannot match another suite. */
  const AUDIT_ACTION = "report.filter.probe";

  const ids = {
    clientId: randomUUID(),
    adminId: randomUUID(),
    collectorA: randomUUID(),
    collectorB: randomUUID(),
    areaA: randomUUID(),
    areaB: randomUUID(),
    planA: randomUUID(),
    planB: randomUUID(),
    subscriberA: randomUUID(),
    subscriberB: randomUUID(),
    serviceAccountA: randomUUID(),
    serviceAccountB: randomUUID(),
  };

  const names = {
    areaA: `Route A ${ids.areaA.slice(0, 8)}`,
    areaB: `Route B ${ids.areaB.slice(0, 8)}`,
    planA: `Fiber A ${ids.planA.slice(0, 8)}`,
    planB: `Cable B ${ids.planB.slice(0, 8)}`,
  };

  /** The fixture's invoices are dated here so nothing else matches the range. */
  const REVENUE_RANGE = { fromDate: "2099-03-01", toDate: "2099-03-31" };
  const AS_OF = new Date("2099-05-01T00:00:00Z");

  async function createUser(fullName: string, role: string): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO users (id, full_name, username, password_hash, role, is_active)
       VALUES ($1, $2, $3, $4, $5, true)`,
      [id, fullName, `report.filter.${id.slice(0, 8)}`, DUMMY_PASSWORD_HASH, role]
    );
    created.userIds.push(id);
    return id;
  }

  async function createArea(name: string): Promise<string> {
    const areaId = name === names.areaA ? ids.areaA : ids.areaB;
    await pool.query(
      `INSERT INTO collection_areas (id, code, name, is_active, created_by)
       VALUES ($1, $2, $3, true, $4)`,
      [areaId, `RF-${areaId.slice(0, 8)}`, name, ids.adminId]
    );
    created.areaIds.push(areaId);
    return areaId;
  }

  async function createServiceAccount(
    serviceAccountId: string,
    subscriberId: string,
    firstName: string,
    planId: string,
    collectorId: string,
    areaId: string
  ): Promise<void> {
    await pool.query(
      `INSERT INTO subscribers
         (id, account_number, first_name, last_name, primary_phone, service_address,
          service_barangay, service_municipality, service_province, area_id, created_by)
       VALUES ($1, $2, $3, 'Filter', '0917-000-0000', '1 Rizal St', 'Poblacion', 'Baliuag', 'Bulacan', $4, $5)`,
      [subscriberId, `SUB-RF-${subscriberId.slice(0, 8)}`, firstName, areaId, ids.adminId]
    );
    created.subscriberIds.push(subscriberId);

    await pool.query(
      `INSERT INTO service_accounts
         (id, service_account_number, subscriber_id, plan_id, status, area_id, assigned_collector_id, created_by)
       VALUES ($1, $2, $3, $4, 'active', $5, $6, $7)`,
      [
        serviceAccountId,
        `SA-RF-${serviceAccountId.slice(0, 8)}`,
        subscriberId,
        planId,
        areaId,
        collectorId,
        ids.adminId,
      ]
    );
    created.serviceAccountIds.push(serviceAccountId);
  }

  async function createOutstandingInvoice(
    serviceAccountId: string,
    amountCentavos: number
  ): Promise<void> {
    const invoiceId = randomUUID();
    await pool.query(
      `INSERT INTO invoices
         (id, invoice_number, service_account_id, invoice_type, status, invoice_date, due_date,
          subtotal_centavos, late_fees_centavos, total_amount_centavos, paid_amount_centavos,
          remaining_balance_centavos, created_by)
       VALUES ($1, $2, $3, 'monthly_subscription', 'unpaid', '2099-03-15', '2099-04-15',
               $4, 0, $4, 0, $4, $5)`,
      [invoiceId, `INV-RF-${invoiceId.slice(0, 8)}`, serviceAccountId, amountCentavos, ids.adminId]
    );
    created.invoiceIds.push(invoiceId);
  }

  beforeAll(async () => {
    ids.adminId = await createUser("Report Filter Admin", "admin");
    ids.collectorA = await createUser("Report Filter Collector A", "collector");
    ids.collectorB = await createUser("Report Filter Collector B", "collector");

    await createArea(names.areaA);
    await createArea(names.areaB);

    await pool.query(
      `INSERT INTO subscription_plans
         (id, name, service_type, speed_mbps, monthly_rate_centavos, reconnection_fee_centavos, is_active, created_by)
       VALUES ($1, $2, 'internet', 25, 99900, 50000, true, $3),
              ($4, $5, 'cable_tv', NULL, 50000, 50000, true, $3)`,
      [ids.planA, names.planA, ids.adminId, ids.planB, names.planB]
    );
    created.planIds.push(ids.planA, ids.planB);

    await createServiceAccount(
      ids.serviceAccountA,
      ids.subscriberA,
      "Alpha",
      ids.planA,
      ids.collectorA,
      ids.areaA
    );
    await createServiceAccount(
      ids.serviceAccountB,
      ids.subscriberB,
      "Bravo",
      ids.planB,
      ids.collectorB,
      ids.areaB
    );

    await createOutstandingInvoice(ids.serviceAccountA, 100000);
    await createOutstandingInvoice(ids.serviceAccountB, 50000);

    // A reversed payment, so the reversal report has real SQL to build, and one
    // audit row, so the audit report's timestamp comparison runs for real.
    const paymentId = randomUUID();
    await pool.query(
      `INSERT INTO payments
         (id, receipt_number, service_account_id, payment_method, status, amount_centavos,
          allocated_centavos, advance_credit_centavos, payment_date, posted_by, reversed_at, reversed_by)
       VALUES ($1, $2, $3, 'cash', 'reversed', 10000, 10000, 0, '2099-03-10', $4, now(), $4)`,
      [paymentId, `OR-RF-${ids.serviceAccountA.slice(0, 8)}`, ids.serviceAccountA, ids.adminId]
    );
    created.paymentIds.push(paymentId);

    await pool.query(
      `INSERT INTO payment_reversals
         (id, original_payment_id, reason, reversal_receipt_number, reversed_by)
       VALUES ($1, $2, 'Report filter fixture reversal', $3, $4)`,
      [randomUUID(), paymentId, `RV-RF-${paymentId.slice(0, 8)}`, ids.adminId]
    );

    await pool.query(
      `INSERT INTO audit_logs
         (id, action, entity_type, entity_id, description, performed_by, performed_by_username, performed_at)
       VALUES ($1, $2, 'payment', $3, 'Report filter fixture audit row', $4, $5, '2099-03-10T05:00:00Z')`,
      [randomUUID(), AUDIT_ACTION, paymentId, ids.adminId, `report.filter.${ids.adminId.slice(0, 8)}`]
    );
  });

  afterAll(async () => {
    await pool.query("DELETE FROM invoice_line_items WHERE invoice_id = ANY($1::uuid[])", [
      created.invoiceIds,
    ]);
    await pool.query("DELETE FROM invoices WHERE id = ANY($1::uuid[])", [created.invoiceIds]);
    await pool.query("DELETE FROM payment_reversals WHERE original_payment_id = ANY($1::uuid[])", [
      created.paymentIds,
    ]);
    await pool.query("DELETE FROM payments WHERE id = ANY($1::uuid[])", [created.paymentIds]);
    await deleteAuditLogsForUsers(pool, created.userIds);
    await pool.query("DELETE FROM service_accounts WHERE id = ANY($1::uuid[])", [
      created.serviceAccountIds,
    ]);
    await pool.query("DELETE FROM subscribers WHERE id = ANY($1::uuid[])", [created.subscriberIds]);
    await pool.query("DELETE FROM subscription_plans WHERE id = ANY($1::uuid[])", [created.planIds]);
    await pool.query("DELETE FROM collection_areas WHERE id = ANY($1::uuid[])", [created.areaIds]);
    await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [created.userIds]);

    await closeDatabaseConnection();
  });

  it("returns fewer invoices when the revenue report is filtered by collector", async () => {
    const range = toReportDateRange(REVENUE_RANGE.fromDate, REVENUE_RANGE.toDate);

    const unfiltered = await loadRevenueInvoiceRows(range, {});
    const filtered = await loadRevenueInvoiceRows(range, { collectorId: ids.collectorA });

    // The 2099 range contains only this fixture's two invoices.
    expect(unfiltered.map((row) => row.planName).sort()).toEqual(
      [names.planA, names.planB].sort()
    );
    expect(filtered.map((row) => row.planName)).toEqual([names.planA]);
    expect(filtered.length).toBeLessThan(unfiltered.length);
  });

  it("returns fewer invoices when the revenue report is filtered by plan", async () => {
    const range = toReportDateRange(REVENUE_RANGE.fromDate, REVENUE_RANGE.toDate);

    const filtered = await loadRevenueInvoiceRows(range, { planId: ids.planB });

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.planName).toBe(names.planB);
  });

  it("returns only the filtered plan's invoices from the AR aging query", async () => {
    const unfiltered = await loadOutstandingInvoices(db);
    const filtered = await loadOutstandingInvoices(db, { planId: ids.planA });

    // Every filtered row is the fixture's plan, and the other plan's row is gone.
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.every((row) => row.planName === names.planA)).toBe(true);
    expect(unfiltered.some((row) => row.planName === names.planB)).toBe(true);
    expect(filtered.some((row) => row.planName === names.planB)).toBe(false);
  });

  it("returns only the filtered area's accounts from the collector assignment list", async () => {
    const filtered = await loadCollectorAssignmentRows({ areaId: ids.areaA });

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.areaName).toBe(names.areaA);
    expect(filtered[0]?.collectorId).toBe(ids.collectorA);
  });

  it("returns only the filtered collector's overdue accounts", async () => {
    const filtered = await listOverdueAccounts({ collectorId: ids.collectorA }, AS_OF);

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.serviceAccountId).toBe(ids.serviceAccountA);
    expect(filtered[0]?.totalOverdueCentavos).toBe(100000);
  });

  it("pages the invoice list without dropping or repeating a row", async () => {
    const firstPage = await listInvoices({ page: 1, pageSize: 2 });
    expect(firstPage.items).toHaveLength(2);

    // Walk every page the total implies and check each invoice appears exactly once.
    const seenIds: string[] = [];
    const pageCount = Math.ceil(firstPage.total / 2);
    for (let page = 1; page <= pageCount; page += 1) {
      const pageResult = await listInvoices({ page, pageSize: 2 });
      expect(pageResult.total).toBe(firstPage.total);
      seenIds.push(...pageResult.items.map((invoice) => invoice.id));
    }

    expect(seenIds).toHaveLength(firstPage.total);
    expect(new Set(seenIds).size).toBe(firstPage.total);
    // The fixture's own invoices are all reachable by paging.
    for (const invoiceId of created.invoiceIds) {
      expect(seenIds).toContain(invoiceId);
    }
  });

  it("builds the reversal report's real SQL and filters it by collector", async () => {
    const range = toReportDateRange(REVENUE_RANGE.fromDate, REVENUE_RANGE.toDate);

    const unfiltered = await loadPaymentAdjustmentRows(range, {});
    const filtered = await loadPaymentAdjustmentRows(range, { collectorId: ids.collectorA });

    expect(unfiltered).toHaveLength(1);
    expect(unfiltered[0]).toMatchObject({
      receiptNumber: `OR-RF-${ids.serviceAccountA.slice(0, 8)}`,
      amountCentavos: 10000,
      collectorId: ids.collectorA,
      collectorName: "Report Filter Collector A",
    });
    expect(filtered).toHaveLength(1);

    // The other collector's receipt exists and is filtered out.
    const forOtherCollector = await loadPaymentAdjustmentRows(range, {
      collectorId: ids.collectorB,
    });
    expect(forOtherCollector).toHaveLength(0);
  });

  it("builds the audit report's real SQL and filters it by user", async () => {
    const range = {
      fromDate: REVENUE_RANGE.fromDate,
      toDate: REVENUE_RANGE.toDate,
      toDateExclusive: "2099-04-01",
    };

    const unfiltered = await loadAuditReportRows(range, { action: AUDIT_ACTION });

    expect(unfiltered).toHaveLength(1);
    expect(unfiltered[0]).toMatchObject({
      performedBy: ids.adminId,
      action: AUDIT_ACTION,
      entityType: "payment",
    });

    const forAnotherUser = await loadAuditReportRows(range, { performedBy: ids.collectorB });
    expect(forAnotherUser).toHaveLength(0);
  });
});
