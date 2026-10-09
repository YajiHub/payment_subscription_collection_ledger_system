// Tests for the audit trail: the endpoint, the logger, and the guarantees that
// matter — a failed audit write must not break the operation, and a credential
// must never be written to the trail.

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
import { audit, logAuditEntry } from "../src/shared/audit/audit-logger";
import { fakeDatabase } from "./support/fake-database";
import { authorizationHeader, signTestToken } from "./support/tokens";

const ADMIN_ID = randomUUID();

function insertedAuditRows(): Record<string, unknown>[] {
  return fakeDatabase.insertedRows
    .filter((row) => row.table === auditLogs)
    .map((row) => row.values as Record<string, unknown>);
}

describe("GET /api/audit-logs", () => {
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

  it("returns a page of audit entries to an administrator", async () => {
    const { token } = signTestToken({ role: "admin" });
    const entryId = randomUUID();

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([
      {
        id: entryId,
        action: "payment.posted",
        entityType: "payment",
        entityId: randomUUID(),
        previousState: null,
        newState: { receiptNumber: "OR-2025-000001" },
        description: "Payment OR-2025-000001 posted (10000 centavos)",
        performedBy: ADMIN_ID,
        performedByUsername: "admin",
        clientIpAddress: "127.0.0.1",
        performedAt: new Date("2025-01-15T09:00:00Z"),
      },
    ]); // items
    fakeDatabase.queueSelectRows([{ value: 1 }]); // total

    const response = await server.inject({
      method: "GET",
      url: "/api/audit-logs?page=1&pageSize=20",
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json().data;
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ action: "payment.posted", entityType: "payment" });
    expect(body.total).toBe(1);
  });

  it("accepts the documented filters", async () => {
    const { token } = signTestToken({ role: "admin" });
    const entityId = randomUUID();

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([]); // items
    fakeDatabase.queueSelectRows([{ value: 0 }]); // total

    const response = await server.inject({
      method: "GET",
      url: `/api/audit-logs?entityType=invoice&entityId=${entityId}&action=invoice.voided&performedBy=${randomUUID()}`,
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(200);
  });

  it("rejects a non-uuid entityId with 400", async () => {
    const { token } = signTestToken({ role: "admin" });
    fakeDatabase.queueSelectRows([]); // authenticate

    const response = await server.inject({
      method: "GET",
      url: "/api/audit-logs?entityId=not-a-uuid",
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("denies a Cashier the audit trail with 403", async () => {
    const { token } = signTestToken({ role: "cashier" });
    fakeDatabase.queueSelectRows([]); // authenticate

    const response = await server.inject({
      method: "GET",
      url: "/api/audit-logs",
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(403);
  });

  it("records the username of the signed-in user who performed the action (D1)", async () => {
    // Before the fix the row named only a user id, so the audit screen showed
    // "system" for every action. The actor's username now travels on the token
    // and lands on the audit row, with the id and client address kept alongside.
    const operatorUsername = "demo.billing";
    const { token } = signTestToken({ role: "admin", sub: ADMIN_ID, username: operatorUsername });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([
      {
        key: "late_fee_centavos",
        value: "5000",
        description: "Late fee",
        updatedAt: new Date(),
        updatedBy: null,
      },
    ]); // getSystemSettingsMap (previous values)

    const response = await server.inject({
      method: "PUT",
      url: "/api/system/settings",
      headers: authorizationHeader(token),
      payload: { settings: [{ key: "late_fee_centavos", value: "7500" }] },
    });

    expect(response.statusCode).toBe(200);
    const auditRow = insertedAuditRows().find((row) => row.action === "system_setting.updated");
    expect(auditRow).toMatchObject({
      performedBy: ADMIN_ID,
      performedByUsername: operatorUsername,
    });
    // The existing actor fields survive the change.
    expect(auditRow?.clientIpAddress).toBeTruthy();
  });
});

describe("audit logger", () => {
  beforeEach(() => {
    fakeDatabase.reset();
  });

  it("writes the expected fields for a named action", async () => {
    await audit.invoiceVoided(
      { id: randomUUID(), invoiceNumber: "INV-2025-01-000042", status: "void" },
      "unpaid",
      "Entered incorrect amount",
      { userId: ADMIN_ID, username: "admin", clientIpAddress: "10.0.0.5" }
    );

    const [row] = insertedAuditRows();
    expect(row).toMatchObject({
      action: "invoice.voided",
      entityType: "invoice",
      performedBy: ADMIN_ID,
      performedByUsername: "admin",
      clientIpAddress: "10.0.0.5",
    });
    expect(String(row?.description)).toContain("INV-2025-01-000042");
    expect(String(row?.description)).toContain("Entered incorrect amount");
  });

  it("records the invoice's real prior status on a void, whichever status it was", async () => {
    // `posted` stopped being a status when migration 0020 renamed it to `unpaid`,
    // so a hardcoded literal would misreport every void. Both the trail's previous
    // and new state must come from the invoice that was actually voided.
    for (const previousStatus of ["unpaid", "overdue"] as const) {
      fakeDatabase.reset();

      await audit.invoiceVoided(
        { id: randomUUID(), invoiceNumber: "INV-2025-01-000042", status: "void" },
        previousStatus,
        "Entered incorrect amount",
        { userId: ADMIN_ID, username: "admin", clientIpAddress: "10.0.0.5" }
      );

      const [row] = insertedAuditRows();
      expect(row?.previousState).toMatchObject({ status: previousStatus });
      expect(row?.newState).toMatchObject({ status: "void" });
    }
  });

  it("does not present the void's own write as the invoice's previous state", async () => {
    // The document handed to the helper has already been voided, so its voidedAt,
    // voidedBy, and notes were written BY the void. Spreading it unchecked would
    // show an auditor an invoice that was already void at the moment it was voided.
    // The reverse transaction id is the ledger entry the void itself created.
    const reverseTransactionId = randomUUID();
    const voidReason = "Verification test: void an unpaid invoice";

    await audit.invoiceVoided(
      {
        id: randomUUID(),
        invoiceNumber: "INV-2025-01-000042",
        status: "void",
        voidedAt: new Date("2026-10-09T00:06:22.791Z"),
        voidedBy: ADMIN_ID,
        voidedByTransactionId: reverseTransactionId,
        notes: voidReason,
      },
      "unpaid",
      voidReason,
      { userId: ADMIN_ID, username: "admin", clientIpAddress: "10.0.0.5" }
    );

    const [row] = insertedAuditRows();
    // The real prior status still survives (the earlier regression this must not break).
    expect(row?.previousState).toMatchObject({ status: "unpaid" });
    // Nothing the void wrote is passed off as the state BEFORE it.
    expect(row?.previousState).not.toHaveProperty("voidedAt");
    expect(row?.previousState).not.toHaveProperty("voidedBy");
    expect(row?.previousState).not.toHaveProperty("voidedByTransactionId");
    expect(row?.previousState).not.toHaveProperty("notes");
    // The NEW state is the voided invoice, so it correctly carries them.
    expect(row?.newState).toMatchObject({
      status: "void",
      voidedAt: new Date("2026-10-09T00:06:22.791Z"),
      voidedByTransactionId: reverseTransactionId,
    });
  });

  it("never writes a password hash into a user password-changed entry", async () => {
    await audit.userPasswordChanged(
      { id: randomUUID(), username: "target.user", passwordHash: "$2b$12$should-not-appear" },
      { userId: ADMIN_ID, clientIpAddress: "10.0.0.5" }
    );

    const [row] = insertedAuditRows();
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain("should-not-appear");
    expect(serialized).not.toContain("passwordHash");
    expect(row).toMatchObject({ action: "user.password_changed", entityType: "user" });
  });

  it("swallows a write failure so the main operation is never broken", async () => {
    fakeDatabase.failNextInsert(new Error("audit table is down"));

    await expect(
      logAuditEntry({
        action: "payment.posted",
        entityType: "payment",
        entityId: randomUUID(),
        description: "does not matter",
      })
    ).resolves.toBeUndefined();
  });

  it("records a failed login with the username and the reason but no credential", async () => {
    await audit.loginFailed("ghost", "10.0.0.9", "invalid credentials");

    const [row] = insertedAuditRows();
    expect(row).toMatchObject({
      action: "auth.login_failed",
      entityType: "session",
      performedByUsername: "ghost",
      performedBy: null,
      clientIpAddress: "10.0.0.9",
    });
    expect(String(row?.description)).toContain("ghost");
  });
});

describe("audit trail through the API", () => {
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

  it("audits a successful login as a security event", async () => {
    const bcrypt = await import("bcrypt");
    const password = "correct-horse-battery";
    const user = {
      id: ADMIN_ID,
      fullName: "Ana",
      username: "ana",
      passwordHash: await bcrypt.hash(password, 4),
      role: "admin",
      isActive: true,
    };
    fakeDatabase.queueSelectRows([user]);

    const response = await server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "ana", password },
    });

    expect(response.statusCode).toBe(200);
    const actions = insertedAuditRows().map((row) => row.action);
    expect(actions).toContain("auth.login_succeeded");
  });

  it("audits a failed login attempt", async () => {
    fakeDatabase.queueSelectRows([]); // no such user

    const response = await server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "ghost", password: "guess" },
    });

    expect(response.statusCode).toBe(401);
    const actions = insertedAuditRows().map((row) => row.action);
    expect(actions).toContain("auth.login_failed");
  });

  it("audits the creation of a user account", async () => {
    const { token } = signTestToken({ role: "admin" });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([]); // username uniqueness check
    fakeDatabase.queueInsertRows([
      {
        id: randomUUID(),
        fullName: "New User",
        username: "new.user",
        role: "cashier",
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const response = await server.inject({
      method: "POST",
      url: "/api/users",
      headers: authorizationHeader(token),
      payload: {
        fullName: "New User",
        username: "new.user",
        password: "brand-new-password",
        role: "cashier",
      },
    });

    expect(response.statusCode).toBe(201);
    const auditRow = insertedAuditRows().find((row) => row.action === "user.created");
    expect(auditRow).toBeDefined();
    expect(JSON.stringify(auditRow)).not.toContain("brand-new-password");
  });

  it("audits a posted payment as a financial event", async () => {
    const { token } = signTestToken({ role: "admin", sub: ADMIN_ID });
    const serviceAccountId = randomUUID();
    const invoiceId = randomUUID();

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([{ id: serviceAccountId }]); // service account exists
    fakeDatabase.queueSelectRows([
      {
        id: invoiceId,
        invoiceNumber: "INV-2025-03-000001",
        totalAmountCentavos: 50000,
        paidAmountCentavos: 0,
        remainingBalanceCentavos: 50000,
      },
    ]); // outstanding invoices
    fakeDatabase.queueSelectRows([]); // existing receipt numbers
    fakeDatabase.queueInsertRows([
      {
        id: randomUUID(),
        receiptNumber: "OR-2025-000001",
        serviceAccountId,
        paymentMethod: "cash",
        amountCentavos: 50000,
        allocatedCentavos: 50000,
        advanceCreditCentavos: 0,
        paymentDate: "2025-03-01",
        status: "posted",
        postedBy: ADMIN_ID,
        notes: null,
        createdAt: new Date(),
        reversedAt: null,
        reversedBy: null,
      },
    ]); // payment row
    fakeDatabase.queueInsertRows([]); // allocation rows
    fakeDatabase.queueSelectRows([{ balanceCentavos: 0, sequenceNumber: 0 }]); // ledger balance
    fakeDatabase.queueInsertRows([]); // ledger entry

    const response = await server.inject({
      method: "POST",
      url: "/api/payments",
      headers: authorizationHeader(token),
      payload: {
        serviceAccountId,
        paymentMethod: "cash",
        amountCentavos: 50000,
        paymentDate: "2025-03-01",
      },
    });

    expect(response.statusCode).toBe(201);
    const auditRow = insertedAuditRows().find((row) => row.action === "payment.posted");
    expect(auditRow).toBeDefined();
    expect(auditRow?.entityType).toBe("payment");
  });

  it("audits a role change with the previous and new roles", async () => {
    const { token } = signTestToken({ role: "admin" });
    const userId = randomUUID();

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([
      { id: userId, fullName: "T", username: "target", role: "cashier", isActive: true },
    ]); // previous role read
    fakeDatabase.queueUpdateRows([
      { id: userId, fullName: "T", username: "target", role: "manager", isActive: true },
    ]);

    const response = await server.inject({
      method: "PUT",
      url: `/api/users/${userId}`,
      headers: authorizationHeader(token),
      payload: { role: "manager" },
    });

    expect(response.statusCode).toBe(200);
    const auditRow = insertedAuditRows().find((row) => row.action === "user.role_changed");
    expect(auditRow).toBeDefined();
    expect(auditRow?.previousState).toMatchObject({ role: "cashier" });
    expect(auditRow?.newState).toMatchObject({ role: "manager" });
  });
});
