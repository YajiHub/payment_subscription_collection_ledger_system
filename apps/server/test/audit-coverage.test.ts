// S5-6 — audit coverage for the operations the audit found unaudited.
//
// Two things are proved:
//   • each new audit helper records actor, action, entity, old/new values and a
//     reason where the action warrants one, straight into the append-only trail;
//   • the helpers are actually wired into the handlers (settings change and plan
//     creation are driven over HTTP), and an operation writes exactly one row so
//     nothing is duplicated.

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
import { auditLogs } from "../src/db/schema/audit";
import { audit, type AuditActor } from "../src/shared/audit/audit-logger";
import { fakeDatabase } from "./support/fake-database";
import { authorizationHeader, signTestToken } from "./support/tokens";

const ACTOR: AuditActor = { userId: randomUUID(), username: "tester", clientIpAddress: "10.0.0.9" };

function auditRows(): Array<Record<string, unknown>> {
  return fakeDatabase.insertedRows
    .filter((row) => row.table === auditLogs)
    .map((row) => row.values as Record<string, unknown>);
}

describe("audit helpers for the previously unaudited operations", () => {
  beforeEach(() => {
    fakeDatabase.reset();
  });

  it("records a collector batch submission with the real prior status and the variance", async () => {
    await audit.collectorBatchSubmitted(
      { batchId: "b1", expectedRemittanceCentavos: 50000, actualRemittanceCentavos: 49000, varianceCentavos: -1000 },
      "in_progress",
      ACTOR
    );

    expect(auditRows()[0]).toMatchObject({
      action: "collector_batch.submitted",
      entityType: "collector_batch",
      entityId: "b1",
      performedBy: ACTOR.userId,
      // Submitting is reached from `open` or `in_progress`, so the trail must name
      // the status the batch really held, not a guess.
      previousState: { status: "in_progress" },
      newState: { status: "submitted" },
    });
    expect(String(auditRows()[0]?.description)).toContain("-1000");
  });

  it("records a collector batch remittance as submitted/remitted to remitted, never open/submitted", async () => {
    // A remittance happens AFTER submission. The old code wrote
    // previous=open, new=submitted, which is the SUBMIT transition, so every
    // remittance row named a change that never happened at that moment.
    for (const previousStatus of ["submitted", "remitted"] as const) {
      fakeDatabase.reset();

      await audit.collectorBatchRemitted(
        { batchId: "b-remit", expectedRemittanceCentavos: 50000, actualRemittanceCentavos: 50000, varianceCentavos: 0 },
        previousStatus,
        ACTOR
      );

      const row = auditRows()[0];
      expect(row).toMatchObject({
        action: "collector_batch.remitted",
        entityType: "collector_batch",
        entityId: "b-remit",
        previousState: { status: previousStatus },
        newState: { status: "remitted" },
      });
    }
  });

  it("records a collector batch reconciliation as remitted to reconciled", async () => {
    await audit.collectorBatchReconciled(
      { batchId: "b2", expectedRemittanceCentavos: 50000, actualRemittanceCentavos: 49000, varianceCentavos: -1000 },
      "remitted",
      "short by 10 pesos",
      ACTOR
    );

    const row = auditRows()[0];
    expect(row).toMatchObject({
      action: "collector_batch.reconciled",
      entityType: "collector_batch",
      previousState: { status: "remitted" },
      newState: { status: "reconciled" },
    });
    expect(String(row?.description)).toContain("short by 10 pesos");
  });

  it("records a collector batch close as reconciled to closed", async () => {
    await audit.collectorBatchClosed(
      { batchId: "b4", batchNumber: "CB-20250101-0004" },
      "reconciled",
      ACTOR
    );

    const row = auditRows()[0];
    expect(row).toMatchObject({
      action: "collector_batch.closed",
      entityType: "collector_batch",
      entityId: "b4",
      previousState: { status: "reconciled" },
      newState: { status: "closed" },
    });
  });

  it("records a collector batch cancellation with its reason", async () => {
    await audit.collectorBatchCancelled(
      { id: "b3", batchNumber: "CB-20250101-0001" },
      "collector unavailable",
      ACTOR
    );

    const row = auditRows()[0];
    expect(row).toMatchObject({ action: "collector_batch.cancelled", entityType: "collector_batch" });
    expect(String(row?.description)).toContain("collector unavailable");
  });

  it("records a manual ledger entry with its reason and amount", async () => {
    await audit.manualLedgerEntryPosted(
      { entryId: "l1", serviceAccountId: "sa1", entryType: "debit_adjustment", amountCentavos: 12345 },
      "goodwill credit correction",
      ACTOR
    );

    const row = auditRows()[0];
    expect(row).toMatchObject({
      action: "ledger.manual_entry_posted",
      entityType: "ledger_entry",
      entityId: "l1",
    });
    expect(String(row?.description)).toContain("goodwill credit correction");
  });

  it("records a plan update with old and new values", async () => {
    await audit.planUpdated(
      { id: "p1", name: "Fiber 50", speedMbps: 50 },
      { id: "p1", name: "Fiber 50", speedMbps: 25 },
      ACTOR
    );

    const row = auditRows()[0];
    expect(row).toMatchObject({ action: "plan.updated", entityType: "plan" });
    expect(row?.previousState).toMatchObject({ speedMbps: 25 });
    expect(row?.newState).toMatchObject({ speedMbps: 50 });
  });

  it("records a system setting change with the old value", async () => {
    await audit.systemSettingUpdated("late_fee_centavos", "5000", "7500", ACTOR);

    const row = auditRows()[0];
    expect(row).toMatchObject({ action: "system_setting.updated", entityType: "system_setting" });
    expect(row?.previousState).toMatchObject({ key: "late_fee_centavos", value: "5000" });
    expect(row?.newState).toMatchObject({ key: "late_fee_centavos", value: "7500" });
  });

  // S5-6: GCash verify and reject are wired by the payments package (S3-2). These
  // pin the helper contract the handlers call; the handler wiring itself is proved in
  // gcash-verification.test.ts.
  it("records a GCash verification with the verifier identity and the real prior status", async () => {
    await audit.gcashPaymentVerified("pay-1", "GC-123", "pending_verification", ACTOR);

    expect(auditRows()[0]).toMatchObject({
      action: "payment.gcash_verified",
      entityType: "payment",
      entityId: "pay-1",
      performedBy: ACTOR.userId,
      previousState: { status: "pending_verification" },
      newState: { status: "posted" },
    });
  });

  it("records a GCash rejection with the verifier identity, the real prior status and the reason", async () => {
    await audit.gcashPaymentRejected("pay-2", "GC-999", "pending_verification", "Reference not found", ACTOR);

    expect(auditRows()[0]).toMatchObject({
      action: "payment.gcash_rejected",
      entityType: "payment",
      entityId: "pay-2",
      performedBy: ACTOR.userId,
      previousState: { status: "pending_verification" },
      newState: { status: "rejected" },
    });
    expect(String(auditRows()[0]?.description)).toContain("Reference not found");
  });

  it("records a payment reversal as posted to reversed, with the real prior status", async () => {
    await audit.paymentReversed("pay-rev", "OR-2025-000001", "posted", "wrong amount", ACTOR);

    expect(auditRows()[0]).toMatchObject({
      action: "payment.reversed",
      entityType: "payment",
      entityId: "pay-rev",
      previousState: { id: "pay-rev", receiptNumber: "OR-2025-000001", status: "posted" },
      newState: { id: "pay-rev", receiptNumber: "OR-2025-000001", status: "reversed" },
    });
  });

  it("records the plan's real prior active flag on a retire, not a hardcoded true", async () => {
    for (const previousIsActive of [true, false]) {
      fakeDatabase.reset();

      await audit.planRetired({ id: "p-r", name: "Fiber 50" }, previousIsActive, ACTOR);

      const row = auditRows()[0];
      expect(row).toMatchObject({
        action: "plan.retired",
        previousState: { id: "p-r", name: "Fiber 50", isActive: previousIsActive },
        newState: { id: "p-r", name: "Fiber 50", isActive: false },
      });
    }
  });

  it("records backup creation, verification and restore", async () => {
    await audit.backupCreated({ id: "bk1", filename: "bcis_backup_x.sql.gz", sizeBytes: 1234 }, ACTOR);
    await audit.backupVerified({ id: "bk1", filename: "bcis_backup_x.sql.gz" }, ACTOR);
    await audit.backupRestored({ id: "bk1", filename: "bcis_backup_x.sql.gz" }, ACTOR);

    expect(auditRows().map((row) => row.action)).toEqual([
      "backup.created",
      "backup.verified",
      "backup.restored",
    ]);
  });
});

describe("audit wiring over the API", () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = buildServer();
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    fakeDatabase.reset();
  });

  it("writes one system_setting.updated row when an administrator changes a setting", async () => {
    const { token } = signTestToken({ role: "admin", sub: ACTOR.userId });
    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([
      { key: "company_name", value: "Old Name", description: "", updatedAt: new Date(), updatedBy: null },
    ]); // the before-snapshot
    fakeDatabase.queueSelectRows([]); // the list returned after the update

    const response = await server.inject({
      method: "PUT",
      url: "/api/system/settings",
      headers: authorizationHeader(token),
      payload: { settings: [{ key: "company_name", value: "New Name" }] },
    });

    expect(response.statusCode).toBe(200);
    const settingAudits = auditRows().filter((row) => row.action === "system_setting.updated");
    expect(settingAudits).toHaveLength(1);
    expect(settingAudits[0]).toMatchObject({
      performedBy: ACTOR.userId,
      previousState: { key: "company_name", value: "Old Name" },
      newState: { key: "company_name", value: "New Name" },
    });
  });

  it("does not write an audit row for an unchanged setting", async () => {
    const { token } = signTestToken({ role: "admin", sub: ACTOR.userId });
    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([
      { key: "company_name", value: "Same", description: "", updatedAt: new Date(), updatedBy: null },
    ]); // the before-snapshot already matches the new value
    fakeDatabase.queueSelectRows([]); // the list returned after the update

    await server.inject({
      method: "PUT",
      url: "/api/system/settings",
      headers: authorizationHeader(token),
      payload: { settings: [{ key: "company_name", value: "Same" }] },
    });

    expect(auditRows().filter((row) => row.action === "system_setting.updated")).toHaveLength(0);
  });

  it("writes exactly one plan.created row when a plan is created", async () => {
    const { token } = signTestToken({ role: "admin", sub: ACTOR.userId });
    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([]); // duplicate-name check
    fakeDatabase.queueInsertRows([
      {
        id: randomUUID(),
        name: "Fiber 50Mbps",
        serviceType: "internet",
        speedMbps: 50,
        cablePackageDescription: null,
        monthlyRateCentavos: 149900,
        reconnectionFeeCentavos: 50000,
        isActive: true,
        createdAt: new Date(),
        createdBy: ACTOR.userId,
      },
    ]);

    const response = await server.inject({
      method: "POST",
      url: "/api/plans",
      headers: authorizationHeader(token),
      payload: {
        name: "Fiber 50Mbps",
        serviceType: "internet",
        speedMbps: 50,
        monthlyRateCentavos: 149900,
        reconnectionFeeCentavos: 50000,
      },
    });

    expect(response.statusCode).toBe(201);
    const planAudits = auditRows().filter((row) => String(row.action).startsWith("plan."));
    expect(planAudits).toHaveLength(1);
    expect(planAudits[0]).toMatchObject({ action: "plan.created", entityType: "plan" });
  });
});
