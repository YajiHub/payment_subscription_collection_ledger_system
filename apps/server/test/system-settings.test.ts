// Tests for the system settings: the seeded defaults, the read endpoint, and the
// Admin-only update rules.

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

vi.mock("../src/db/connection", async () => {
  const { fakeDatabase } = await import("./support/fake-database");
  return {
    db: fakeDatabase.db,
    pool: {},
    checkDatabaseConnection: async () => ({ isReachable: true, latencyMs: 3, errorMessage: null }),
    closeDatabaseConnection: async () => {},
  };
});

import { DEFAULT_SYSTEM_SETTINGS, SYSTEM_SETTING_KEYS, parseIntSetting } from "@bcis/shared";
import { buildServer } from "../src/index.ts";
import { systemSettings } from "../src/db/schema/system";
import { fakeDatabase } from "./support/fake-database";
import { authorizationHeader, signTestToken } from "./support/tokens";

const ADMIN_ID = randomUUID();

const SETTINGS_ROWS = [
  {
    key: "late_fee_centavos",
    value: "5000",
    description: "Late fee",
    updatedAt: new Date(),
    updatedBy: null,
  },
  {
    key: "company_name",
    value: "My ISP",
    description: "Company name",
    updatedAt: new Date(),
    updatedBy: null,
  },
];

describe("system setting defaults", () => {
  it("seeds the documented default values", () => {
    const byKey = new Map(DEFAULT_SYSTEM_SETTINGS.map((setting) => [setting.key, setting.value]));

    expect(byKey.get(SYSTEM_SETTING_KEYS.lateFeeCentavos)).toBe("5000");
    expect(byKey.get(SYSTEM_SETTING_KEYS.invoiceDueDayOfMonth)).toBe("15");
    expect(byKey.get(SYSTEM_SETTING_KEYS.suspensionAfterDays)).toBe("30");
    expect(byKey.get(SYSTEM_SETTING_KEYS.companyName)).toBe("My ISP");
    expect(byKey.get(SYSTEM_SETTING_KEYS.receiptFooterText)).toBe("Thank you for your payment!");
  });

  it("parses an integer setting and falls back on a malformed value", () => {
    expect(parseIntSetting("5000", 1)).toBe(5000);
    expect(parseIntSetting("not-a-number", 42)).toBe(42);
    expect(parseIntSetting("12.5", 42)).toBe(42);
    expect(parseIntSetting(undefined, 7)).toBe(7);
  });
});

describe("system settings endpoints", () => {
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

  it("reads the settings for any authenticated user", async () => {
    const { token } = signTestToken({ role: "collector" });
    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows(SETTINGS_ROWS);

    const response = await server.inject({
      method: "GET",
      url: "/api/system/settings",
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.items).toHaveLength(2);
  });

  it("lets an administrator update a setting", async () => {
    const { token } = signTestToken({ role: "admin", sub: ADMIN_ID });
    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows(SETTINGS_ROWS); // the list returned after the update

    const response = await server.inject({
      method: "PUT",
      url: "/api/system/settings",
      headers: authorizationHeader(token),
      payload: { settings: [{ key: "late_fee_centavos", value: "7500" }] },
    });

    expect(response.statusCode).toBe(200);
    const update = fakeDatabase.updatedRows.find((row) => row.table === systemSettings);
    expect(update?.values).toMatchObject({ value: "7500", updatedBy: ADMIN_ID });
  });

  it("denies a Cashier changing a setting with 403", async () => {
    const { token } = signTestToken({ role: "cashier" });
    fakeDatabase.queueSelectRows([]);

    const response = await server.inject({
      method: "PUT",
      url: "/api/system/settings",
      headers: authorizationHeader(token),
      payload: { settings: [{ key: "late_fee_centavos", value: "7500" }] },
    });

    expect(response.statusCode).toBe(403);
    expect(fakeDatabase.updatedRows).toHaveLength(0);
  });

  it("rejects an unknown setting key", async () => {
    const { token } = signTestToken({ role: "admin" });
    fakeDatabase.queueSelectRows([]);

    const response = await server.inject({
      method: "PUT",
      url: "/api/system/settings",
      headers: authorizationHeader(token),
      payload: { settings: [{ key: "totally_made_up", value: "1" }] },
    });

    expect(response.statusCode).toBe(400);
  });

  it("rejects a late fee that is not a positive whole number of centavos", async () => {
    const { token } = signTestToken({ role: "admin" });
    fakeDatabase.queueSelectRows([]);

    for (const badValue of ["0", "-500", "12.5", "free"]) {
      fakeDatabase.queueSelectRows([]); // authenticate for the next attempt
      const response = await server.inject({
        method: "PUT",
        url: "/api/system/settings",
        headers: authorizationHeader(token),
        payload: { settings: [{ key: "late_fee_centavos", value: badValue }] },
      });
      expect(response.statusCode, `value ${badValue}`).toBe(400);
    }
  });

  it("rejects a due day that not every month has", async () => {
    const { token } = signTestToken({ role: "admin" });
    fakeDatabase.queueSelectRows([]);

    const response = await server.inject({
      method: "PUT",
      url: "/api/system/settings",
      headers: authorizationHeader(token),
      payload: { settings: [{ key: "invoice_due_day_of_month", value: "31" }] },
    });

    expect(response.statusCode).toBe(400);
  });

  it("rejects an empty update body", async () => {
    const { token } = signTestToken({ role: "admin" });
    fakeDatabase.queueSelectRows([]);

    const response = await server.inject({
      method: "PUT",
      url: "/api/system/settings",
      headers: authorizationHeader(token),
      payload: { settings: [] },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe("extended health endpoint", () => {
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

  it("reports database health and table counts to an administrator", async () => {
    const { token } = signTestToken({ role: "admin" });
    fakeDatabase.queueSelectRows([]); // authenticate
    // One count select per table: users, subscribers, service accounts, invoices,
    // payments, audit logs.
    fakeDatabase.queueSelectRows([{ value: 3 }]);
    fakeDatabase.queueSelectRows([{ value: 4 }]);
    fakeDatabase.queueSelectRows([{ value: 5 }]);
    fakeDatabase.queueSelectRows([{ value: 6 }]);
    fakeDatabase.queueSelectRows([{ value: 7 }]);
    fakeDatabase.queueSelectRows([{ value: 8 }]);

    const response = await server.inject({
      method: "GET",
      url: "/api/system/health/extended",
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(200);
    const data = response.json().data;
    expect(data.database.isReachable).toBe(true);
    expect(data.counts).toEqual({
      users: 3,
      subscribers: 4,
      serviceAccounts: 5,
      invoices: 6,
      payments: 7,
      auditLogs: 8,
    });
  });

  it("denies a Manager the extended health check", async () => {
    const { token } = signTestToken({ role: "manager" });
    fakeDatabase.queueSelectRows([]);

    const response = await server.inject({
      method: "GET",
      url: "/api/system/health/extended",
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(403);
  });
});
