// WP11a — real-PostgreSQL proof for the account list and the extended subscriber
// search (S3.2).
//
// The in-memory suite (`service-accounts-list.routes.test.ts`) proves the paging
// contract and that each filter reaches the SQL. This suite proves the SEMANTICS
// that only a real database can:
//
//   • the list returns the seeded accounts, a page at a time, and each filter
//     really narrows the result;
//   • a search by service account number finds the account;
//   • a subscriber search by receipt, invoice and GCash reference each finds the
//     right subscriber EXACTLY ONCE even when several of their accounts match —
//     the EXISTS subqueries must not multiply the row.
//
// It skips itself when no database answers, so `pnpm test` still passes on a
// machine without PostgreSQL.

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildServer } from "../src/index.ts";
import { closeDatabaseConnection, pool } from "../src/db/connection";
import { authorizationHeader, signTestToken } from "./support/tokens";
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

// Ids created by this suite, so cleanup removes exactly what it added.
const created = {
  userIds: [] as string[],
  planIds: [] as string[],
  areaIds: [] as string[],
  subscriberIds: [] as string[],
  serviceAccountIds: [] as string[],
  invoiceIds: [] as string[],
  paymentIds: [] as string[],
};

describe.skipIf(!databaseIsReachable)("service account list and search against real PostgreSQL", () => {
  let server: FastifyInstance;
  let clerkId: string;
  let internetPlanId: string;
  let cablePlanId: string;
  let areaOneId: string;
  let areaTwoId: string;
  let collectorId: string;

  // Subscriber A holds two accounts; subscriber B holds one. Both A's accounts will
  // match the reference searches, so the search must still return A once.
  let subscriberAId: string;
  let subscriberBId: string;
  let accountA1Id: string;
  let accountA2Id: string;
  let accountB1Id: string;
  let accountA1Number: string;

  const unique = randomUUID().slice(0, 8);

  beforeAll(async () => {
    server = buildServer();
    await server.ready();

    clerkId = randomUUID();
    collectorId = randomUUID();
    await pool.query(
      `INSERT INTO users (id, full_name, username, password_hash, role, is_active)
       VALUES ($1, $2, $3, $4, 'billing_clerk', true),
              ($5, $6, $7, $8, 'collector', true)`,
      [
        clerkId,
        "WP11a Clerk",
        `wp11a.clerk.${unique}`,
        DUMMY_PASSWORD_HASH,
        collectorId,
        "WP11a Collector",
        `wp11a.collector.${unique}`,
        DUMMY_PASSWORD_HASH,
      ]
    );
    created.userIds.push(clerkId, collectorId);

    internetPlanId = randomUUID();
    cablePlanId = randomUUID();
    await pool.query(
      `INSERT INTO subscription_plans
         (id, name, service_type, monthly_rate_centavos, reconnection_fee_centavos, is_active, created_by)
       VALUES ($1, $2, 'internet', 99900, 50000, true, $5),
              ($3, $4, 'cable_tv', 49900, 0, true, $5)`,
      [
        internetPlanId,
        `WP11a Fiber ${unique}`,
        cablePlanId,
        `WP11a Cable ${unique}`,
        clerkId,
      ]
    );
    created.planIds.push(internetPlanId, cablePlanId);

    areaOneId = randomUUID();
    areaTwoId = randomUUID();
    await pool.query(
      `INSERT INTO collection_areas (id, code, name, is_active, created_by)
       VALUES ($1, $2, $3, true, $7), ($4, $5, $6, true, $7)`,
      [
        areaOneId,
        `WP11A-A-${unique}`,
        `WP11a Area One ${unique}`,
        areaTwoId,
        `WP11A-B-${unique}`,
        `WP11a Area Two ${unique}`,
        clerkId,
      ]
    );
    created.areaIds.push(areaOneId, areaTwoId);

    subscriberAId = randomUUID();
    subscriberBId = randomUUID();
    await pool.query(
      `INSERT INTO subscribers
         (id, account_number, first_name, last_name, primary_phone, service_address,
          service_barangay, service_municipality, service_province, area_id, created_by)
       VALUES ($1, $2, 'Ana', $3, '09171110001', '1 WP11a Road', 'Poblacion', 'Cabuyao', 'Laguna', $7, $8),
              ($4, $5, 'Ben', $6, '09171110002', '2 WP11a Road', 'Poblacion', 'Cabuyao', 'Laguna', $7, $8)`,
      [
        subscriberAId,
        `SUB-WP11A-A-${unique}`,
        `Reyes-${unique}`,
        subscriberBId,
        `SUB-WP11A-B-${unique}`,
        `Cruz-${unique}`,
        areaOneId,
        clerkId,
      ]
    );
    created.subscriberIds.push(subscriberAId, subscriberBId);

    accountA1Id = randomUUID();
    accountA2Id = randomUUID();
    accountB1Id = randomUUID();
    accountA1Number = `SA-WP11A-A1-${unique}`;
    await pool.query(
      `INSERT INTO service_accounts
         (id, service_account_number, subscriber_id, plan_id, status, assigned_collector_id, area_id, created_by)
       VALUES ($1, $2, $3, $4, 'active', $5, $6, $7),
              ($8, $9, $3, $10, 'suspended', NULL, $11, $7),
              ($12, $13, $14, $4, 'active', NULL, $6, $7)`,
      [
        accountA1Id,
        accountA1Number,
        subscriberAId,
        internetPlanId,
        collectorId,
        areaOneId,
        clerkId,
        accountA2Id,
        `SA-WP11A-A2-${unique}`,
        cablePlanId,
        areaTwoId,
        accountB1Id,
        `SA-WP11A-B1-${unique}`,
        subscriberBId,
      ]
    );
    created.serviceAccountIds.push(accountA1Id, accountA2Id, accountB1Id);

    // Reference rows. The tokens are unique so the three searches cannot collide.
    const receiptToken = `RCPTAA${unique}`;
    const invoiceToken = `INVBB${unique}`;
    const gcashToken = `GCSHCC${unique}`;

    const paymentRows: { id: string; receipt: string; account: string; method: string }[] = [
      { id: randomUUID(), receipt: `OR-2025-${receiptToken}-1`, account: accountA1Id, method: "cash" },
      { id: randomUUID(), receipt: `OR-2025-${receiptToken}-2`, account: accountA2Id, method: "cash" },
      { id: randomUUID(), receipt: `OR-2025-GC1-${unique}`, account: accountA1Id, method: "gcash" },
      { id: randomUUID(), receipt: `OR-2025-GC2-${unique}`, account: accountA2Id, method: "gcash" },
    ];

    for (const payment of paymentRows) {
      await pool.query(
        `INSERT INTO payments
           (id, receipt_number, service_account_id, payment_method, status, amount_centavos, payment_date, posted_by)
         VALUES ($1, $2, $3, $4, 'posted', 10000, '2025-01-15', $5)`,
        [payment.id, payment.receipt, payment.account, payment.method, clerkId]
      );
      created.paymentIds.push(payment.id);
    }

    await pool.query(
      `INSERT INTO gcash_payments (id, payment_id, gcash_reference_number)
       VALUES ($1, $2, $3), ($4, $5, $6)`,
      [
        randomUUID(),
        paymentRows[2]?.id,
        `GC-2025-${gcashToken}-1`,
        randomUUID(),
        paymentRows[3]?.id,
        `GC-2025-${gcashToken}-2`,
      ]
    );

    const invoiceRows: { id: string; number: string; account: string }[] = [
      { id: randomUUID(), number: `INV-2025-${invoiceToken}-1`, account: accountA1Id },
      { id: randomUUID(), number: `INV-2025-${invoiceToken}-2`, account: accountA2Id },
    ];

    for (const invoice of invoiceRows) {
      await pool.query(
        `INSERT INTO invoices
           (id, invoice_number, service_account_id, invoice_type, status, invoice_date, due_date,
            subtotal_centavos, total_amount_centavos, remaining_balance_centavos, created_by)
         VALUES ($1, $2, $3, 'monthly_subscription', 'unpaid', '2025-01-01', '2025-01-15', 99900, 99900, 99900, $4)`,
        [invoice.id, invoice.number, invoice.account, clerkId]
      );
      created.invoiceIds.push(invoice.id);
    }
  });

  afterAll(async () => {
    // Remove this suite's rows in foreign-key order. Nothing else is touched.
    await pool.query("DELETE FROM gcash_payments WHERE payment_id = ANY($1::uuid[])", [
      created.paymentIds,
    ]);
    await pool.query("DELETE FROM payments WHERE id = ANY($1::uuid[])", [created.paymentIds]);
    await pool.query("DELETE FROM invoices WHERE id = ANY($1::uuid[])", [created.invoiceIds]);
    await pool.query("DELETE FROM service_accounts WHERE id = ANY($1::uuid[])", [
      created.serviceAccountIds,
    ]);
    await pool.query("DELETE FROM subscribers WHERE id = ANY($1::uuid[])", [
      created.subscriberIds,
    ]);
    await pool.query("DELETE FROM subscription_plans WHERE id = ANY($1::uuid[])", [
      created.planIds,
    ]);
    await pool.query("DELETE FROM collection_areas WHERE id = ANY($1::uuid[])", [created.areaIds]);
    await deleteAuditLogsForUsers(pool, created.userIds);
    await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [created.userIds]);

    await server.close();
    await closeDatabaseConnection();
  });

  function clerkHeaders() {
    const { token } = signTestToken({ role: "billing_clerk", sub: clerkId });
    return authorizationHeader(token);
  }

  async function listAccounts(query: string) {
    const response = await server.inject({
      method: "GET",
      url: `/api/service-accounts${query}`,
      headers: clerkHeaders(),
    });
    expect(response.statusCode).toBe(200);
    return response.json().data as {
      items: { id: string; serviceAccountNumber: string; status: string }[];
      page: number;
      pageSize: number;
      total: number;
    };
  }

  it("lists the seeded accounts one page at a time with the paging contract", async () => {
    // A generous page so this suite's three accounts are all on it.
    const page = await listAccounts("?pageSize=100");

    const ids = page.items.map((item) => item.id);
    expect(ids).toContain(accountA1Id);
    expect(ids).toContain(accountA2Id);
    expect(ids).toContain(accountB1Id);

    expect(page.page).toBe(1);
    expect(page.pageSize).toBe(100);
    expect(page.total).toBeGreaterThanOrEqual(3);

    // AC: a small page is bounded and the second page does not repeat the first.
    const firstPage = await listAccounts("?page=1&pageSize=1");
    const secondPage = await listAccounts("?page=2&pageSize=1");
    expect(firstPage.items).toHaveLength(1);
    expect(secondPage.items).toHaveLength(1);
    expect(firstPage.items[0]?.id).not.toBe(secondPage.items[0]?.id);
  });

  it("narrows the result with each filter", async () => {
    const byStatus = await listAccounts("?status=suspended&pageSize=100");
    expect(byStatus.items.map((item) => item.id)).toContain(accountA2Id);
    expect(byStatus.items.map((item) => item.id)).not.toContain(accountA1Id);

    const byServiceType = await listAccounts("?serviceType=cable_tv&pageSize=100");
    expect(byServiceType.items.map((item) => item.id)).toContain(accountA2Id);
    expect(byServiceType.items.map((item) => item.id)).not.toContain(accountA1Id);

    const byPlan = await listAccounts(`?planId=${cablePlanId}&pageSize=100`);
    expect(byPlan.items.map((item) => item.id)).toContain(accountA2Id);
    expect(byPlan.items.map((item) => item.id)).not.toContain(accountA1Id);

    const byArea = await listAccounts(`?areaId=${areaTwoId}&pageSize=100`);
    expect(byArea.items.map((item) => item.id)).toEqual([accountA2Id]);

    const byCollector = await listAccounts(`?collectorId=${collectorId}&pageSize=100`);
    expect(byCollector.items.map((item) => item.id)).toEqual([accountA1Id]);
  });

  it("finds the account by its service account number", async () => {
    const page = await listAccounts(`?search=${encodeURIComponent(accountA1Number)}`);

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.id).toBe(accountA1Id);
    expect(page.items[0]?.serviceAccountNumber).toBe(accountA1Number);
  });

  it("finds the subscriber by receipt, invoice and GCash reference — once per match set", async () => {
    const receiptToken = `RCPTAA${unique}`;
    const invoiceToken = `INVBB${unique}`;
    const gcashToken = `GCSHCC${unique}`;

    for (const token of [receiptToken, invoiceToken, gcashToken]) {
      const response = await server.inject({
        method: "GET",
        url: `/api/subscribers/search?q=${encodeURIComponent(token)}`,
        headers: clerkHeaders(),
      });

      expect(response.statusCode).toBe(200);
      const page = response.json().data as {
        items: { id: string }[];
        total: number;
      };

      // AC: two of subscriber A's accounts match each reference, but A appears
      // ONCE — the EXISTS subquery does not multiply the row.
      expect(page.items, `search for "${token}"`).toHaveLength(1);
      expect(page.items[0]?.id, `search for "${token}"`).toBe(subscriberAId);
      expect(page.total, `search for "${token}" total`).toBe(1);
    }
  });
});
