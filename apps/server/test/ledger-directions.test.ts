// Debit/credit direction tests for the ledger write path.
//
// The direction is tested per entry type, one function at a time, rather than
// through a net total. A wrong direction that happens to cancel out in a sum is a
// silent bug; asserting that a payment credits −X and a reversal debits +X catches
// it even when the net is zero.
//
// The same suite proves the write path is append-only: every ledger change is an
// INSERT, and nothing ever updates or deletes a ledger row.

import { randomUUID } from "node:crypto";

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

import { ledgerEntries } from "../src/db/schema/ledger";
import { fakeDatabase, type RecordedInsert } from "./support/fake-database";
import {
  recordAdvanceCreditApplied,
  recordInvoicePosted,
  recordInvoiceVoided,
  recordLateFeeApplied,
  recordManualEntry,
  recordPaymentPosted,
  recordPaymentReversed,
} from "../src/modules/ledger/ledger.service";

const SERVICE_ACCOUNT_ID = randomUUID();
const USER_ID = randomUUID();

/** Every ledger insert, flattened from one or more insert calls. */
function ledgerWrites(): Array<Record<string, unknown>> {
  return fakeDatabase.insertedRows
    .filter((row): row is RecordedInsert => row.table === ledgerEntries)
    .flatMap((row) =>
      Array.isArray(row.values)
        ? (row.values as Array<Record<string, unknown>>)
        : [row.values as Record<string, unknown>]
    );
}

/** The single ledger entry a call wrote. */
function onlyLedgerWrite(): Record<string, unknown> {
  const writes = ledgerWrites();
  expect(writes).toHaveLength(1);
  return writes[0]!;
}

/** Queues the previous balance/sequence the write path reads, then the insert. */
function queuePreviousEntry(balanceCentavos: number, sequenceNumber: number): void {
  fakeDatabase.queueSelectRows([{ balanceCentavos, sequenceNumber }]);
}

/**
 * Queues what the ledger already debited for the invoice being voided.
 *
 * The void credits exactly that much, so this read comes before the balance read.
 */
function queueInvoiceDebits(debitedCentavos: number): void {
  fakeDatabase.queueSelectRows([{ debitedCentavos }]);
}

describe("ledger write path — direction and running balance", () => {
  beforeEach(() => {
    fakeDatabase.reset();
  });

  it("posts an invoice as a DEBIT that increases what is owed", async () => {
    queuePreviousEntry(100000, 4);
    fakeDatabase.queueInsertRows([{ id: randomUUID() }]);

    await recordInvoicePosted(
      fakeDatabase.db as never,
      {
        id: randomUUID(),
        invoiceNumber: "INV-2025-01-000001",
        serviceAccountId: SERVICE_ACCOUNT_ID,
        totalAmountCentavos: 99900,
        remainingBalanceCentavos: 99900,
        billingPeriodYear: 2025,
        billingPeriodMonth: 1,
      },
      USER_ID
    );

    expect(onlyLedgerWrite()).toMatchObject({
      entryType: "invoice_posted",
      amountCentavos: 99900,
      runningBalanceCentavos: 199900,
      sequenceNumber: 5,
    });
  });

  it("posts a payment as a CREDIT that decreases what is owed", async () => {
    queuePreviousEntry(199900, 5);

    await recordPaymentPosted(
      fakeDatabase.db as never,
      {
        id: randomUUID(),
        receiptNumber: "OR-2025-000001",
        serviceAccountId: SERVICE_ACCOUNT_ID,
        amountCentavos: 50000,
        allocatedCentavos: 50000,
        advanceCreditCentavos: 0,
      },
      USER_ID
    );

    const entries = ledgerWrites();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      entryType: "payment_received",
      amountCentavos: 50000,
      runningBalanceCentavos: 149900,
      sequenceNumber: 6,
    });
  });

  it("splits a payment into a CREDIT for what was applied and a CREDIT for the overpayment", async () => {
    queuePreviousEntry(30000, 1);

    await recordPaymentPosted(
      fakeDatabase.db as never,
      {
        id: randomUUID(),
        receiptNumber: "OR-2025-000002",
        serviceAccountId: SERVICE_ACCOUNT_ID,
        amountCentavos: 50000,
        allocatedCentavos: 30000,
        advanceCreditCentavos: 20000,
      },
      USER_ID
    );

    const entries = ledgerWrites();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      entryType: "payment_received",
      amountCentavos: 30000,
      runningBalanceCentavos: 0,
      sequenceNumber: 2,
    });
    expect(entries[1]).toMatchObject({
      entryType: "advance_credit",
      amountCentavos: 20000,
      runningBalanceCentavos: -20000,
      sequenceNumber: 3,
    });
  });

  it("voids an invoice as a CREDIT that removes the debt", async () => {
    queueInvoiceDebits(99900);
    queuePreviousEntry(199900, 5);
    fakeDatabase.queueInsertRows([{ id: randomUUID() }]);

    await recordInvoiceVoided(
      fakeDatabase.db as never,
      {
        id: randomUUID(),
        invoiceNumber: "INV-2025-01-000001",
        serviceAccountId: SERVICE_ACCOUNT_ID,
        totalAmountCentavos: 99900,
        remainingBalanceCentavos: 99900,
        billingPeriodYear: 2025,
        billingPeriodMonth: 1,
      },
      "Entered incorrectly",
      USER_ID
    );

    expect(onlyLedgerWrite()).toMatchObject({
      entryType: "invoice_void",
      amountCentavos: 99900,
      runningBalanceCentavos: 100000,
    });
  });

  it("voids an invoice that debited nothing without writing any ledger row", async () => {
    // A draft that was never posted and never paid down by an advance credit has no
    // debt to remove, so the void must not credit the account for anything.
    fakeDatabase.queueSelectRows([{ debitedCentavos: 0 }]);

    const entryId = await recordInvoiceVoided(
      fakeDatabase.db as never,
      {
        id: randomUUID(),
        invoiceNumber: "INV-2025-01-000002",
        serviceAccountId: SERVICE_ACCOUNT_ID,
        totalAmountCentavos: 99900,
        remainingBalanceCentavos: 99900,
        billingPeriodYear: 2025,
        billingPeriodMonth: 1,
      },
      "Duplicate draft",
      USER_ID
    );

    expect(entryId).toBe("");
    expect(ledgerWrites()).toHaveLength(0);
  });

  it("reverses a payment as a DEBIT that restores the debt", async () => {
    queuePreviousEntry(149900, 6);

    await recordPaymentReversed(
      fakeDatabase.db as never,
      {
        id: randomUUID(),
        receiptNumber: "OR-2025-000001",
        serviceAccountId: SERVICE_ACCOUNT_ID,
        amountCentavos: 50000,
        allocatedCentavos: 50000,
        advanceCreditCentavos: 0,
      },
      "Posted to the wrong account",
      USER_ID
    );

    expect(onlyLedgerWrite()).toMatchObject({
      entryType: "payment_reversal",
      amountCentavos: 50000,
      runningBalanceCentavos: 199900,
    });
  });

  it("applies a late fee as a DEBIT", async () => {
    queuePreviousEntry(100000, 2);
    fakeDatabase.queueInsertRows([{ id: randomUUID() }]);

    await recordLateFeeApplied(
      fakeDatabase.db as never,
      {
        id: randomUUID(),
        invoiceNumber: "INV-2025-01-000001",
        serviceAccountId: SERVICE_ACCOUNT_ID,
        totalAmountCentavos: 99900,
        remainingBalanceCentavos: 99900,
        billingPeriodYear: 2025,
        billingPeriodMonth: 1,
      },
      5000,
      USER_ID
    );

    expect(onlyLedgerWrite()).toMatchObject({
      entryType: "late_fee",
      amountCentavos: 5000,
      runningBalanceCentavos: 105000,
    });
  });

  it("consumes an advance credit with a DEBIT", async () => {
    queuePreviousEntry(-20000, 3);

    await recordAdvanceCreditApplied(fakeDatabase.db as never, {
      serviceAccountId: SERVICE_ACCOUNT_ID,
      invoiceId: randomUUID(),
      invoiceNumber: "INV-2025-02-000001",
      amountCentavos: 20000,
      createdByUserId: USER_ID,
    });

    expect(onlyLedgerWrite()).toMatchObject({
      entryType: "advance_credit_applied",
      amountCentavos: 20000,
      runningBalanceCentavos: 0,
    });
  });

  it("records a manual debit as a DEBIT and a manual credit as a CREDIT", async () => {
    queuePreviousEntry(0, 0);
    fakeDatabase.queueInsertRows([{ id: randomUUID() }]);

    await recordManualEntry(fakeDatabase.db as never, {
      serviceAccountId: SERVICE_ACCOUNT_ID,
      entryType: "manual_debit",
      amountCentavos: 12500,
      reason: "Installation materials charge",
      createdByUserId: USER_ID,
    });

    fakeDatabase.queueSelectRows([{ balanceCentavos: 12500, sequenceNumber: 1 }]);
    fakeDatabase.queueInsertRows([{ id: randomUUID() }]);

    await recordManualEntry(fakeDatabase.db as never, {
      serviceAccountId: SERVICE_ACCOUNT_ID,
      entryType: "manual_credit",
      amountCentavos: 12500,
      reason: "Goodwill credit for downtime",
      createdByUserId: USER_ID,
    });

    const entries = ledgerWrites();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      entryType: "manual_debit",
      runningBalanceCentavos: 12500,
      description: "Manual Debit — Installation materials charge",
      sequenceNumber: 1,
    });
    expect(entries[1]).toMatchObject({
      entryType: "manual_credit",
      runningBalanceCentavos: 0,
      description: "Manual Credit — Goodwill credit for downtime",
      sequenceNumber: 2,
    });
  });

  it("never updates or deletes a ledger row — every change is an insert", async () => {
    queueInvoiceDebits(99900);
    queuePreviousEntry(99900, 1);
    fakeDatabase.queueInsertRows([{ id: randomUUID() }]);
    await recordInvoiceVoided(
      fakeDatabase.db as never,
      {
        id: randomUUID(),
        invoiceNumber: "INV-2025-01-000001",
        serviceAccountId: SERVICE_ACCOUNT_ID,
        totalAmountCentavos: 99900,
        remainingBalanceCentavos: 99900,
        billingPeriodYear: 2025,
        billingPeriodMonth: 1,
      },
      "Entered incorrectly",
      USER_ID
    );

    queuePreviousEntry(0, 2);
    await recordPaymentReversed(
      fakeDatabase.db as never,
      {
        id: randomUUID(),
        receiptNumber: "OR-2025-000001",
        serviceAccountId: SERVICE_ACCOUNT_ID,
        amountCentavos: 99900,
        allocatedCentavos: 99900,
        advanceCreditCentavos: 0,
      },
      "Posted to the wrong account",
      USER_ID
    );

    // Both corrections appended a row; neither touched an existing one.
    expect(ledgerWrites()).toHaveLength(2);
    expect(fakeDatabase.updatedRows.filter((row) => row.table === ledgerEntries)).toHaveLength(0);
  });
});
