// Real-PostgreSQL integration test for the billing engine (WP2 — S2-1…S2-6, S8-2).
//
// The unit suite pins the arithmetic; this one proves what the DATABASE actually
// does, which is where the risky parts live:
//
//   • two concurrent invoice-number allocations for one period never collide
//     (the advisory lock that replaced max()+1 — AT-09)
//   • the monthly billing run is atomic and idempotent per period (AT-11)
//   • an invoice fully settled by advance credit becomes CREDITED (S2-2)
//   • a discount and an installation fee are first-class, posted line items with
//     the documented integer-centavo rounding (S2-3)
//
// The suite skips itself when no database answers, so `pnpm test` still passes on
// a machine without PostgreSQL.

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db, closeDatabaseConnection, pool } from "../src/db/connection";
import { billingRuns, invoices } from "../src/db/schema/billing";
import { LEGACY_ROLE_TO_SYSTEM_ROLE } from "@bcis/shared";
import { allocateNextInvoiceNumber } from "../src/modules/billing/invoice-number.service";
import {
  applyDiscountToDraftInvoice,
  createInstallationFeeInvoice,
  postInvoiceForId,
} from "../src/modules/billing/invoices.service";
import { voidInvoice } from "../src/modules/billing/void-invoice.service";
import { postPayment } from "../src/modules/payments/post-payment.service";
import { runMonthlyBilling } from "../src/modules/billing/monthly-billing.service";
import { deleteAuditLogsForUsers } from "./support/audit-cleanup";
import { deleteLedgerEntriesForServiceAccounts } from "./support/ledger-cleanup";

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

describe.skipIf(!databaseIsReachable)("WP2 billing engine against real PostgreSQL", () => {
  let adminId: string;
  let planId: string;
  let planName: string;

  const created = {
    userIds: [] as string[],
    planIds: [] as string[],
    subscriberIds: [] as string[],
    serviceAccountIds: [] as string[],
    paymentIds: [] as string[],
  };

  beforeAll(async () => {
    adminId = randomUUID();
    await pool.query(
      `INSERT INTO users (id, full_name, username, password_hash, role, is_active)
       VALUES ($1, 'WP2 Billing Admin', $2, $3, 'admin', true)`,
      [adminId, `wp2.admin.${adminId.slice(0, 8)}`, DUMMY_PASSWORD_HASH]
    );
    created.userIds.push(adminId);

    // Keep the role-model invariant wp1-schema asserts for every stored user: a
    // user must have a row in user_roles mapped from their legacy role.
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT $1, r.id FROM roles r WHERE r.code = $2`,
      [adminId, LEGACY_ROLE_TO_SYSTEM_ROLE.admin]
    );

    planId = randomUUID();
    planName = `WP2 Fiber ${planId.slice(0, 8)}`;
    await pool.query(
      `INSERT INTO subscription_plans
         (id, name, service_type, speed_mbps, monthly_rate_centavos, reconnection_fee_centavos, is_active, created_by)
       VALUES ($1, $2, 'internet', 25, 99900, 50000, true, $3)`,
      [planId, planName, adminId]
    );
    created.planIds.push(planId);
  });

  afterAll(async () => {
    await deleteLedgerEntriesForServiceAccounts(created.serviceAccountIds);
    await pool.query(
      "DELETE FROM payment_allocations WHERE payment_id = ANY($1::uuid[])",
      [created.paymentIds]
    );
    await pool.query("DELETE FROM payments WHERE id = ANY($1::uuid[])", [created.paymentIds]);
    await pool.query(
      "DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE service_account_id = ANY($1::uuid[]))",
      [created.serviceAccountIds]
    );
    await pool.query("DELETE FROM invoices WHERE service_account_id = ANY($1::uuid[])", [
      created.serviceAccountIds,
    ]);
    await pool.query("DELETE FROM billing_runs WHERE ran_by = $1", [adminId]);

    // A monthly billing run bills EVERY active service account in the database, so
    // it also creates drafts for accounts this suite does not own (in this shared
    // test database, leftovers from another suite). Those drafts are the only rows
    // tying a foreign account to this suite's user, and the user could not be
    // deleted while they exist, so the run's own output is removed here.
    await pool.query(
      `DELETE FROM invoice_line_items
        WHERE invoice_id IN (SELECT id FROM invoices WHERE created_by = ANY($1::uuid[]))`,
      [created.userIds]
    );
    await pool.query("DELETE FROM invoices WHERE created_by = ANY($1::uuid[])", [created.userIds]);
    await pool.query("DELETE FROM service_accounts WHERE id = ANY($1::uuid[])", [
      created.serviceAccountIds,
    ]);
    await pool.query("DELETE FROM subscribers WHERE id = ANY($1::uuid[])", [
      created.subscriberIds,
    ]);
    await pool.query("DELETE FROM subscription_plans WHERE id = ANY($1::uuid[])", [
      created.planIds,
    ]);
    await deleteAuditLogsForUsers(pool, created.userIds);
    await pool.query("DELETE FROM user_roles WHERE user_id = ANY($1::uuid[])", [created.userIds]);
    await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [created.userIds]);
    await closeDatabaseConnection();
  });

  /** Creates a fresh active subscriber + service account, tracked for cleanup. */
  async function createActiveServiceAccount(firstName: string): Promise<string> {
    const subscriberId = randomUUID();
    await pool.query(
      `INSERT INTO subscribers
         (id, account_number, first_name, last_name, primary_phone, service_address,
          service_barangay, service_municipality, service_province, created_by)
       VALUES ($1, $2, $3, 'WP2', '09170000000', '1 WP2 Street',
               'Poblacion', 'Testville', 'Testprovince', $4)`,
      [subscriberId, `SUB-${randomUUID().slice(0, 8)}`, firstName, adminId]
    );
    created.subscriberIds.push(subscriberId);

    const serviceAccountId = randomUUID();
    await pool.query(
      `INSERT INTO service_accounts
         (id, service_account_number, subscriber_id, plan_id, status, activation_date, created_by)
       VALUES ($1, $2, $3, $4, 'active', '2025-01-01', $5)`,
      [serviceAccountId, `SA-${randomUUID().slice(0, 8)}`, subscriberId, planId, adminId]
    );
    created.serviceAccountIds.push(serviceAccountId);

    return serviceAccountId;
  }

  // Every debit entry type, spelled out here so the invariant proof below does not
  // depend on the code it is checking. It must match DEBIT_ENTRY_TYPES in the
  // shared package (the same list phase9-invariants uses). It is bound as a
  // parameter, never interpolated into SQL.
  const DEBIT_TYPES = [
    "invoice_posted",
    "late_fee",
    "manual_debit",
    "payment_reversal",
    "advance_credit_applied",
  ];

  /** The account's ledger balance, recomputed from every entry (debits − credits). */
  async function accountLedgerBalanceCentavos(serviceAccountId: string): Promise<number> {
    const result = await pool.query(
      `SELECT coalesce(sum(CASE WHEN entry_type::text = ANY($2::text[])
                                THEN amount_centavos ELSE -amount_centavos END), 0)::int AS balance_centavos
         FROM ledger_entries
        WHERE service_account_id = $1`,
      [serviceAccountId, DEBIT_TYPES]
    );
    return result.rows[0]?.balance_centavos ?? 0;
  }

  /** One invoice's own debits − credits: zero for an invoice that no longer owes. */
  async function invoiceNetCentavos(invoiceId: string): Promise<number> {
    const result = await pool.query(
      `SELECT coalesce(sum(CASE WHEN entry_type::text = ANY($2::text[])
                                THEN amount_centavos ELSE -amount_centavos END), 0)::int AS net_centavos
         FROM ledger_entries
        WHERE invoice_id = $1`,
      [invoiceId, DEBIT_TYPES]
    );
    return result.rows[0]?.net_centavos ?? 0;
  }

  /** Gives a service account an unapplied advance credit via one posted payment. */
  async function giveAdvanceCredit(
    serviceAccountId: string,
    amountCentavos: number
  ): Promise<void> {
    const paymentId = randomUUID();
    await pool.query(
      `INSERT INTO payments
         (id, receipt_number, service_account_id, payment_method, amount_centavos, payment_date, posted_by, status)
       VALUES ($1, $2, $3, 'cash', $4, '2031-06-01', $5, 'posted')`,
      [paymentId, `OR-WP2-${randomUUID().slice(0, 8)}`, serviceAccountId, amountCentavos, adminId]
    );
    created.paymentIds.push(paymentId);

    // A manual ledger insert is allowed: the append-only trigger guards UPDATE,
    // DELETE and now TRUNCATE, not INSERT.
    await pool.query(
      `INSERT INTO ledger_entries
         (service_account_id, entry_type, amount_centavos, sequence_number, running_balance_centavos,
          description, payment_id, created_by)
       VALUES ($1, 'advance_credit', $2, 1, $3, 'Advance Credit — WP2 fixture', $4, $5)`,
      [serviceAccountId, amountCentavos, -amountCentavos, paymentId, adminId]
    );
  }

  it("allocates distinct invoice numbers for two concurrent allocations in one period", async () => {
    const firstAccount = await createActiveServiceAccount("ConcurrentA");
    const secondAccount = await createActiveServiceAccount("ConcurrentB");
    const year = 2031;
    const month = 3;

    // Two independent transactions, both reading and inserting for the same
    // period. With the old max()+1 (no lock) both would read the same maximum and
    // the second insert would die on invoices_invoice_number_unique.
    const insertOne = (serviceAccountId: string): Promise<string> =>
      db.transaction(async (tx) => {
        const invoiceNumber = await allocateNextInvoiceNumber(tx, year, month);
        await tx.insert(invoices).values({
          invoiceNumber,
          serviceAccountId,
          invoiceType: "monthly_subscription",
          status: "draft",
          billingPeriodYear: year,
          billingPeriodMonth: month,
          invoiceDate: "2031-03-01",
          dueDate: "2031-03-15",
          subtotalCentavos: 99900,
          lateFeesCentavos: 0,
          totalAmountCentavos: 99900,
          remainingBalanceCentavos: 99900,
          createdBy: adminId,
        });
        return invoiceNumber;
      });

    const [firstNumber, secondNumber] = await Promise.all([
      insertOne(firstAccount),
      insertOne(secondAccount),
    ]);

    expect(firstNumber).toMatch(/^INV-2031-03-\d{6}$/);
    expect(secondNumber).toMatch(/^INV-2031-03-\d{6}$/);
    expect(firstNumber).not.toBe(secondNumber);

    const rows = await pool.query(
      `SELECT invoice_number FROM invoices WHERE billing_period_year = $1 AND billing_period_month = $2`,
      [year, month]
    );
    expect(rows.rowCount).toBe(2);
    expect(new Set(rows.rows.map((row) => row.invoice_number)).size).toBe(2);
  });

  it("runs monthly billing atomically and idempotently for a period", async () => {
    const serviceAccountId = await createActiveServiceAccount("Idempotent");
    const year = 2031;
    const month = 11;

    const firstRun = await runMonthlyBilling(year, month, adminId);
    expect(firstRun.totalInvoicesGenerated).toBeGreaterThanOrEqual(1);

    const accountInvoices = await pool.query(
      `SELECT id FROM invoices WHERE service_account_id = $1 AND billing_period_year = $2 AND billing_period_month = $3`,
      [serviceAccountId, year, month]
    );
    expect(accountInvoices.rowCount).toBe(1);

    // A re-run for the same period returns the recorded outcome and generates
    // nothing again.
    const secondRun = await runMonthlyBilling(year, month, adminId);
    expect(secondRun).toEqual(firstRun);

    const invoicesAfter = await pool.query(
      `SELECT id FROM invoices WHERE service_account_id = $1 AND billing_period_year = $2 AND billing_period_month = $3`,
      [serviceAccountId, year, month]
    );
    expect(invoicesAfter.rowCount).toBe(1);

    const runs = await db
      .select({ id: billingRuns.id })
      .from(billingRuns)
      .where(eq(billingRuns.billingPeriodYear, year));
    // Exactly one run record exists for the period: the idempotent re-run added none.
    expect(runs.length).toBeGreaterThanOrEqual(1);
    const runCount = await pool.query(
      `SELECT count(*)::int AS count FROM billing_runs WHERE billing_period_year = $1 AND billing_period_month = $2`,
      [year, month]
    );
    expect(runCount.rows[0]?.count).toBe(1);
  });

  it("marks an invoice CREDITED when advance credit fully settles it", async () => {
    const serviceAccountId = await createActiveServiceAccount("Credited");
    await giveAdvanceCredit(serviceAccountId, 80000);

    // The installation fee (60.00) is smaller than the 800.00 credit, so the
    // invoice is fully covered while it is still a draft.
    const createdInstallation = await createInstallationFeeInvoice(
      serviceAccountId,
      60000,
      "WP2 credited fixture",
      adminId
    );
    expect(createdInstallation.invoice.remainingBalanceCentavos).toBe(0);

    const posted = await postInvoiceForId(createdInstallation.invoice.id, adminId);
    expect(posted.status).toBe("credited");
    expect(posted.remainingBalanceCentavos).toBe(0);

    // No invoice_posted debit was written: the advance_credit_applied debit already
    // recorded what was owed, so posting a CREDITED invoice adds no new debt.
    const ledgerRows = await pool.query(
      `SELECT entry_type FROM ledger_entries WHERE invoice_id = $1`,
      [createdInstallation.invoice.id]
    );
    const entryTypes = ledgerRows.rows.map((row) => row.entry_type);
    expect(entryTypes).toContain("advance_credit_applied");
    expect(entryTypes).not.toContain("invoice_posted");
  });

  it("posts a discount and an installation fee as first-class line items", async () => {
    const serviceAccountId = await createActiveServiceAccount("Discount");

    const createdInstallation = await createInstallationFeeInvoice(
      serviceAccountId,
      99999,
      "WP2 discount fixture",
      adminId
    );
    expect(createdInstallation.amountCentavos).toBe(99999);

    // 3.33% of 99999 = 3329.9667 centavos → rounds half away from zero to 3330.
    const discounted = await applyDiscountToDraftInvoice(createdInstallation.invoice.id, {
      discountRateBasisPoints: 333,
      reason: "Promotional discount",
    });

    const descriptions = discounted.lineItems.map((line) => line.description);
    expect(descriptions.some((d) => d.startsWith("Installation Fee"))).toBe(true);
    expect(descriptions.some((d) => d.startsWith("Discount"))).toBe(true);
    expect(discounted.totalAmountCentavos).toBe(99999 - 3330);
    expect(discounted.remainingBalanceCentavos).toBe(99999 - 3330);

    // Posting the discounted invoice debits exactly the discounted total, and the
    // line items are immutable afterwards.
    const posted = await postInvoiceForId(createdInstallation.invoice.id, adminId);
    expect(posted.status).toBe("unpaid");

    const ledgerRows = await pool.query(
      `SELECT amount_centavos FROM ledger_entries WHERE invoice_id = $1 AND entry_type = 'invoice_posted'`,
      [createdInstallation.invoice.id]
    );
    expect(ledgerRows.rows[0]?.amount_centavos).toBe(99999 - 3330);

    await expect(
      applyDiscountToDraftInvoice(createdInstallation.invoice.id, {
        discountCentavos: 100,
        reason: "Too late",
      })
    ).rejects.toThrow(/draft/i);

    const lineItemRows = await pool.query(
      `SELECT count(*)::int AS count FROM invoice_line_items WHERE invoice_id = $1`,
      [createdInstallation.invoice.id]
    );
    expect(lineItemRows.rows[0]?.count).toBe(2);
  });

  it("posts an installation fee line item and debits exactly the fee to the ledger", async () => {
    const serviceAccountId = await createActiveServiceAccount("InstallLedger");

    const created = await createInstallationFeeInvoice(serviceAccountId, 77777, "WP2b fixture", adminId);
    expect(created.invoice.invoiceType).toBe("installation_fee");
    expect(created.invoice.status).toBe("draft");
    expect(created.invoice.totalAmountCentavos).toBe(77777);
    expect(created.invoice.lineItems.map((line) => line.description)).toContain(
      `Installation Fee — ${planName}`
    );

    const posted = await postInvoiceForId(created.invoice.id, adminId);
    expect(posted.status).toBe("unpaid");

    // The LEDGER reflects the fee, not just the line item: posting debits exactly
    // the invoice total.
    const ledgerRows = await pool.query(
      `SELECT amount_centavos FROM ledger_entries
        WHERE invoice_id = $1 AND entry_type = 'invoice_posted'`,
      [created.invoice.id]
    );
    expect(ledgerRows.rowCount).toBe(1);
    expect(ledgerRows.rows[0]?.amount_centavos).toBe(77777);
  });

  it("refuses to discount a finalized invoice with a conflict", async () => {
    const serviceAccountId = await createActiveServiceAccount("Finalized");

    for (const status of ["unpaid", "paid", "credited"] as const) {
      const created = await createInstallationFeeInvoice(
        serviceAccountId,
        50000,
        `WP2b ${status} fixture`,
        adminId
      );
      // Force the terminal status directly: the point of this test is the guard,
      // not the workflow that reaches each state.
      await pool.query(`UPDATE invoices SET status = $2 WHERE id = $1`, [created.invoice.id, status]);

      await expect(
        applyDiscountToDraftInvoice(created.invoice.id, {
          discountCentavos: 100,
          reason: "Too late",
        })
      ).rejects.toThrow(/draft/i);

      // Nothing moved: the total and the remaining balance are unchanged.
      const row = await pool.query(
        `SELECT total_amount_centavos, remaining_balance_centavos FROM invoices WHERE id = $1`,
        [created.invoice.id]
      );
      expect(row.rows[0]?.total_amount_centavos).toBe(50000);
      expect(row.rows[0]?.remaining_balance_centavos).toBe(50000);
    }
  });

  it("discounts an invoice exactly to zero and refuses one centavo more", async () => {
    const serviceAccountId = await createActiveServiceAccount("ZeroFloor");

    const toZero = await createInstallationFeeInvoice(serviceAccountId, 60000, "WP2b zero", adminId);
    const zeroed = await applyDiscountToDraftInvoice(toZero.invoice.id, {
      discountCentavos: 60000,
      reason: "Full waiver",
    });
    expect(zeroed.subtotalCentavos).toBe(0);
    expect(zeroed.totalAmountCentavos).toBe(0);
    expect(zeroed.remainingBalanceCentavos).toBe(0);
    expect(zeroed.lineItems.map((line) => line.description)).toContain("Discount — Full waiver");

    const overFloor = await createInstallationFeeInvoice(serviceAccountId, 60000, "WP2b negative", adminId);
    await expect(
      applyDiscountToDraftInvoice(overFloor.invoice.id, {
        discountCentavos: 60001,
        reason: "One centavo too many",
      })
    ).rejects.toThrow(/discount/i);

    const unchanged = await pool.query(
      `SELECT total_amount_centavos, remaining_balance_centavos FROM invoices WHERE id = $1`,
      [overFloor.invoice.id]
    );
    expect(unchanged.rows[0]?.total_amount_centavos).toBe(60000);
    expect(unchanged.rows[0]?.remaining_balance_centavos).toBe(60000);
  });

  it("rounds a percentage discount half away from zero, once, in integer centavos", async () => {
    const serviceAccountId = await createActiveServiceAccount("Rounding");

    // Hand-computed: 25% of 20002 centavos is exactly 5000.5 centavos, and the
    // rule rounds half AWAY FROM ZERO, so the discount is 5001 and the total 15001.
    const created = await createInstallationFeeInvoice(serviceAccountId, 20002, "WP2b rounding", adminId);
    const discounted = await applyDiscountToDraftInvoice(created.invoice.id, {
      discountRateBasisPoints: 2500,
      reason: "Quarter-off promo",
    });

    const discountLine = discounted.lineItems.find((line) => line.description.startsWith("Discount"));
    expect(discountLine?.totalAmountCentavos).toBe(-5001);
    expect(Number.isInteger(discounted.totalAmountCentavos)).toBe(true);
    expect(discounted.totalAmountCentavos).toBe(15001);
    expect(discounted.remainingBalanceCentavos).toBe(15001);

    const stored = await pool.query(
      `SELECT total_amount_centavos FROM invoices WHERE id = $1`,
      [created.invoice.id]
    );
    expect(stored.rows[0]?.total_amount_centavos).toBe(15001);
  });

  it("voids a plain draft WITHOUT writing a ledger entry, because it never debited one", async () => {
    const serviceAccountId = await createActiveServiceAccount("DraftVoid");

    // A draft the operator abandons before it is posted: nothing has reached the
    // ledger for it, so there is no debit for a void to reverse.
    const created = await createInstallationFeeInvoice(
      serviceAccountId,
      99900,
      "WP2b draft-void fixture",
      adminId
    );
    expect(created.invoice.status).toBe("draft");
    expect(created.invoice.paidAmountCentavos).toBe(0);

    const balanceBeforeVoid = await accountLedgerBalanceCentavos(serviceAccountId);
    expect(balanceBeforeVoid).toBe(0);

    const voided = await voidInvoice(created.invoice.id, "Duplicate draft", adminId);
    expect(voided.previousStatus).toBe("draft");
    expect(voided.invoice.status).toBe("void");

    // The proof is the LEDGER, read back with SQL — not the service's return value.
    const entries = await pool.query(
      `SELECT entry_type, amount_centavos FROM ledger_entries WHERE invoice_id = $1`,
      [created.invoice.id]
    );
    expect(entries.rowCount).toBe(0);

    const balanceAfterVoid = await accountLedgerBalanceCentavos(serviceAccountId);
    expect(balanceAfterVoid).toBe(balanceBeforeVoid);
    expect(await invoiceNetCentavos(created.invoice.id)).toBe(0);
  });

  it("voids a draft an advance credit already settled, crediting exactly what was debited", async () => {
    const serviceAccountId = await createActiveServiceAccount("DraftCreditVoid");
    await giveAdvanceCredit(serviceAccountId, 60000);

    const balanceBeforeTheDraft = await accountLedgerBalanceCentavos(serviceAccountId);
    expect(balanceBeforeTheDraft).toBe(-60000);

    // The advance credit pays 600.00 of the 999.99 fee while the invoice is still a
    // DRAFT: the invoice is not posted, but the credit consumed for it IS debited.
    const created = await createInstallationFeeInvoice(
      serviceAccountId,
      99999,
      "WP2b draft-credit-void fixture",
      adminId
    );
    expect(created.invoice.status).toBe("draft");
    expect(created.invoice.paidAmountCentavos).toBe(60000);
    expect(created.invoice.remainingBalanceCentavos).toBe(39999);
    expect(await invoiceNetCentavos(created.invoice.id)).toBe(60000);

    const voided = await voidInvoice(created.invoice.id, "Billed the wrong period", adminId);
    expect(voided.invoice.status).toBe("void");

    // Exactly the 600.00 that was debited is credited back — never the 999.99 total
    // the invoice never owed.
    const credits = await pool.query(
      `SELECT entry_type, amount_centavos FROM ledger_entries
        WHERE invoice_id = $1 AND entry_type = 'invoice_void'`,
      [created.invoice.id]
    );
    expect(credits.rowCount).toBe(1);
    expect(credits.rows[0]?.amount_centavos).toBe(60000);

    // Whole-invoice reconciliation: the voided invoice no longer owes anything, and
    // the account is back to the balance it held before the draft existed.
    expect(await invoiceNetCentavos(created.invoice.id)).toBe(0);
    expect(await accountLedgerBalanceCentavos(serviceAccountId)).toBe(balanceBeforeTheDraft);
  });

  it("voids a posted unpaid invoice, restoring the account balance it had before the invoice", async () => {
    const serviceAccountId = await createActiveServiceAccount("PostedVoid");

    const balanceBeforeTheInvoice = await accountLedgerBalanceCentavos(serviceAccountId);
    const created = await createInstallationFeeInvoice(
      serviceAccountId,
      99900,
      "WP2b posted-void fixture",
      adminId
    );
    const posted = await postInvoiceForId(created.invoice.id, adminId);
    expect(posted.status).toBe("unpaid");
    expect(await accountLedgerBalanceCentavos(serviceAccountId)).toBe(99900);

    const voided = await voidInvoice(created.invoice.id, "Wrong subscriber", adminId);
    expect(voided.previousStatus).toBe("unpaid");
    expect(voided.invoice.status).toBe("void");

    expect(await invoiceNetCentavos(created.invoice.id)).toBe(0);
    expect(await accountLedgerBalanceCentavos(serviceAccountId)).toBe(balanceBeforeTheInvoice);
  });

  it("voids an overdue invoice and credits the late fee it debited too", async () => {
    const serviceAccountId = await createActiveServiceAccount("OverdueVoid");
    const created = await createInstallationFeeInvoice(
      serviceAccountId,
      99900,
      "WP2b overdue-void fixture",
      adminId
    );
    await postInvoiceForId(created.invoice.id, adminId);

    // The late-fee job's writes, applied to this invoice only: a `late_fee` debit
    // plus the matching total/status change. (The job itself scans every overdue
    // invoice in the database, which this suite must not do to other fixtures.)
    const latest = await pool.query(
      `SELECT sequence_number, running_balance_centavos FROM ledger_entries
        WHERE service_account_id = $1 ORDER BY sequence_number DESC LIMIT 1`,
      [serviceAccountId]
    );
    await pool.query(
      `INSERT INTO ledger_entries
         (service_account_id, entry_type, amount_centavos, sequence_number, running_balance_centavos,
          description, invoice_id, created_by)
       VALUES ($1, 'late_fee', 5000, $2, $3, 'Late Fee — WP2b fixture', $4, $5)`,
      [
        serviceAccountId,
        Number(latest.rows[0]?.sequence_number ?? 0) + 1,
        Number(latest.rows[0]?.running_balance_centavos ?? 0) + 5000,
        created.invoice.id,
        adminId,
      ]
    );
    await pool.query(
      `UPDATE invoices
          SET status = 'overdue',
              late_fees_centavos = late_fees_centavos + 5000,
              total_amount_centavos = total_amount_centavos + 5000,
              remaining_balance_centavos = remaining_balance_centavos + 5000
        WHERE id = $1`,
      [created.invoice.id]
    );
    expect(await invoiceNetCentavos(created.invoice.id)).toBe(104900);

    const voided = await voidInvoice(created.invoice.id, "Service was never provisioned", adminId);
    expect(voided.previousStatus).toBe("overdue");
    expect(voided.invoice.status).toBe("void");

    expect(await invoiceNetCentavos(created.invoice.id)).toBe(0);
    expect(await accountLedgerBalanceCentavos(serviceAccountId)).toBe(0);
  });

  it("refuses to void a paid invoice and a credited invoice, writing nothing", async () => {
    // PAID, through the real payment flow: the money is in hand, so the correction
    // is a payment reversal, not a void.
    const paidAccountId = await createActiveServiceAccount("PaidVoid");
    const paidInvoice = await createInstallationFeeInvoice(
      paidAccountId,
      99900,
      "WP2b paid-void fixture",
      adminId
    );
    await postInvoiceForId(paidInvoice.invoice.id, adminId);
    const payment = await postPayment({
      serviceAccountId: paidAccountId,
      paymentMethod: "cash",
      amountCentavos: 99900,
      paymentDate: "2031-06-01",
      postedByUserId: adminId,
    });
    created.paymentIds.push(payment.payment.id);

    const paidRow = await pool.query(`SELECT status FROM invoices WHERE id = $1`, [
      paidInvoice.invoice.id,
    ]);
    expect(paidRow.rows[0]?.status).toBe("paid");
    const paidBalance = await accountLedgerBalanceCentavos(paidAccountId);

    await expect(voidInvoice(paidInvoice.invoice.id, "Erase the debt", adminId)).rejects.toThrow(
      /paid/i
    );
    expect(await accountLedgerBalanceCentavos(paidAccountId)).toBe(paidBalance);
    const paidStatus = await pool.query(`SELECT status FROM invoices WHERE id = $1`, [
      paidInvoice.invoice.id,
    ]);
    expect(paidStatus.rows[0]?.status).toBe("paid");

    // CREDITED, through the real flow: an advance credit settled the invoice while
    // it was a draft, and posting it confirmed that nothing was owed.
    const creditedAccountId = await createActiveServiceAccount("CreditedVoid");
    await giveAdvanceCredit(creditedAccountId, 60000);
    const creditedInvoice = await createInstallationFeeInvoice(
      creditedAccountId,
      60000,
      "WP2b credited-void fixture",
      adminId
    );
    const credited = await postInvoiceForId(creditedInvoice.invoice.id, adminId);
    expect(credited.status).toBe("credited");
    const creditedBalance = await accountLedgerBalanceCentavos(creditedAccountId);

    await expect(
      voidInvoice(creditedInvoice.invoice.id, "Erase the credit", adminId)
    ).rejects.toThrow(/credit/i);
    expect(await accountLedgerBalanceCentavos(creditedAccountId)).toBe(creditedBalance);
    const creditedStatus = await pool.query(`SELECT status FROM invoices WHERE id = $1`, [
      creditedInvoice.invoice.id,
    ]);
    expect(creditedStatus.rows[0]?.status).toBe("credited");
  });

  it("serializes two concurrent monthly billing runs for one period", async () => {
    const serviceAccountId = await createActiveServiceAccount("ConcurrentRun");
    const year = 2032;
    const month = 4;

    // Two servers billing the same period at the same moment. The period advisory
    // lock serializes them; the second finds the completed run and generates
    // nothing, so the period is billed exactly once.
    const [firstRun, secondRun] = await Promise.all([
      runMonthlyBilling(year, month, adminId),
      runMonthlyBilling(year, month, adminId),
    ]);

    expect(firstRun).toEqual(secondRun);

    const accountInvoices = await pool.query(
      `SELECT count(*)::int AS count FROM invoices
        WHERE service_account_id = $1 AND billing_period_year = $2 AND billing_period_month = $3`,
      [serviceAccountId, year, month]
    );
    expect(accountInvoices.rows[0]?.count).toBe(1);

    const runs = await pool.query(
      `SELECT count(*)::int AS count FROM billing_runs
        WHERE billing_period_year = $1 AND billing_period_month = $2`,
      [year, month]
    );
    expect(runs.rows[0]?.count).toBe(1);
  });

  it("never discounts an invoice below the amount still unpaid", async () => {
    const serviceAccountId = await createActiveServiceAccount("PaidDown");
    await giveAdvanceCredit(serviceAccountId, 60000);

    // The advance credit pays the 600.00 fee down to nothing while it is still a
    // draft, so the invoice's unpaid amount is zero and any discount would push
    // its remaining balance below zero.
    const fullyCovered = await createInstallationFeeInvoice(
      serviceAccountId,
      60000,
      "WP2b paid-down fixture",
      adminId
    );
    expect(fullyCovered.invoice.status).toBe("draft");
    expect(fullyCovered.invoice.paidAmountCentavos).toBe(60000);
    expect(fullyCovered.invoice.remainingBalanceCentavos).toBe(0);

    await expect(
      applyDiscountToDraftInvoice(fullyCovered.invoice.id, {
        discountCentavos: 10000,
        reason: "Would go negative",
      })
    ).rejects.toThrow(/unpaid/i);

    const row = await pool.query(
      `SELECT total_amount_centavos, paid_amount_centavos, remaining_balance_centavos
         FROM invoices WHERE id = $1`,
      [fullyCovered.invoice.id]
    );
    expect(row.rows[0]?.total_amount_centavos).toBe(60000);
    expect(row.rows[0]?.remaining_balance_centavos).toBe(0);
  });
});
