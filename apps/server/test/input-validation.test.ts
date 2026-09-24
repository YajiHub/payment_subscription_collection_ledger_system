// Phase 9 input-validation sweep.
//
// Every route that accepts input is sent a deliberately invalid request as the
// Administrator (so authorization is never the reason for the rejection). Each
// one must answer 400 with the standard error envelope, and NOT A SINGLE row may
// be written — proving validation runs before the database is touched.

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
import { fakeDatabase } from "./support/fake-database";
import { authorizationHeader, signTestToken } from "./support/tokens";

type HttpMethod = "GET" | "POST" | "PUT";

interface InvalidRequest {
  method: HttpMethod;
  url: string;
  payload?: unknown;
}

const SOME_UUID = randomUUID();

const INVALID_REQUESTS: InvalidRequest[] = [
  // ── Query parameters ───────────────────────────────────────────────────────
  { method: "GET", url: "/api/users?page=0" },
  { method: "GET", url: "/api/plans?serviceType=bogus" },
  { method: "GET", url: "/api/plans?includeInactive=maybe" },
  { method: "GET", url: "/api/subscribers?page=0" },
  { method: "GET", url: "/api/subscribers/search" },
  { method: "GET", url: "/api/invoices?status=bogus" },
  { method: "GET", url: "/api/payments?page=0" },
  { method: "GET", url: "/api/payments?dateFrom=not-a-date" },
  { method: "GET", url: "/api/receivables/ar-aging?asOfDate=not-a-date" },
  { method: "GET", url: "/api/receivables/overdue?noPaymentInDays=-1" },
  { method: "GET", url: "/api/reports/daily-collection?date=not-a-date" },
  { method: "GET", url: "/api/reports/monthly-billing" },
  { method: "GET", url: "/api/reports/ar-aging?asOf=not-a-date" },
  { method: "GET", url: "/api/reports/collector-remittance" },
  { method: "GET", url: "/api/audit-logs?page=0" },

  // ── Path parameters ────────────────────────────────────────────────────────
  { method: "GET", url: "/api/users/not-a-uuid" },
  { method: "GET", url: "/api/plans/not-a-uuid" },
  { method: "GET", url: "/api/subscribers/not-a-uuid" },
  { method: "GET", url: "/api/subscribers/not-a-uuid/statement" },
  { method: "GET", url: "/api/service-accounts/not-a-uuid" },
  { method: "GET", url: "/api/service-accounts/not-a-uuid/ledger" },
  { method: "GET", url: "/api/service-accounts/not-a-uuid/balance" },
  { method: "GET", url: "/api/service-accounts/not-a-uuid/statement" },
  { method: "GET", url: "/api/service-accounts/not-a-uuid/payments" },
  { method: "GET", url: "/api/invoices/not-a-uuid" },
  { method: "GET", url: "/api/payments/not-a-uuid" },
  { method: "GET", url: "/api/ledger/verify/not-a-uuid" },
  { method: "GET", url: "/api/collector-batches/not-a-uuid" },
  { method: "POST", url: "/api/invoices/not-a-uuid/post" },
  { method: "POST", url: "/api/collector-batches/not-a-uuid/submit" },

  // ── Request bodies ─────────────────────────────────────────────────────────
  { method: "POST", url: "/api/users", payload: {} },
  { method: "POST", url: "/api/plans", payload: {} },
  { method: "POST", url: "/api/subscribers", payload: {} },
  { method: "POST", url: "/api/billing/run", payload: {} },
  { method: "POST", url: "/api/billing/post-all-draft", payload: {} },
  { method: "POST", url: "/api/billing/apply-late-fees", payload: { lateFeeCentavos: -1 } },
  { method: "POST", url: "/api/invoices/reconnection-fee", payload: {} },
  { method: "POST", url: `/api/invoices/${SOME_UUID}/void`, payload: {} },
  { method: "POST", url: "/api/payments", payload: {} },
  { method: "POST", url: `/api/payments/${SOME_UUID}/reverse`, payload: {} },
  { method: "POST", url: "/api/payments/gcash/upload-screenshot", payload: {} },
  { method: "POST", url: "/api/ledger/manual-entry", payload: {} },
  { method: "POST", url: "/api/collector-batches", payload: {} },
  { method: "POST", url: `/api/collector-batches/${SOME_UUID}/assignments`, payload: {} },
  { method: "POST", url: "/api/receivables/overdue/suspend", payload: {} },
  { method: "POST", url: "/api/reports/export-pdf", payload: {} },
  { method: "POST", url: "/api/reports/export-xlsx", payload: {} },
  { method: "PUT", url: `/api/users/${SOME_UUID}`, payload: {} },
  { method: "PUT", url: `/api/users/${SOME_UUID}/password`, payload: {} },
  { method: "PUT", url: `/api/users/${SOME_UUID}/deactivate`, payload: {} },
  { method: "PUT", url: `/api/subscribers/${SOME_UUID}`, payload: {} },
  { method: "PUT", url: `/api/service-accounts/${SOME_UUID}/suspend`, payload: {} },
  { method: "PUT", url: `/api/service-accounts/${SOME_UUID}/reconnect`, payload: { reason: "x" } },
  { method: "PUT", url: `/api/service-accounts/${SOME_UUID}/terminate`, payload: {} },
  { method: "PUT", url: `/api/service-accounts/${SOME_UUID}/plan`, payload: {} },
  { method: "PUT", url: "/api/system/settings", payload: {} },
];

describe("input validation sweep", () => {
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

  it("answers 400 to every invalid request and writes nothing", async () => {
    const { token } = signTestToken({ role: "admin" });
    const failures: string[] = [];

    for (const request of INVALID_REQUESTS) {
      fakeDatabase.queueSelectRows([]); // authenticate

      const response = await server.inject({
        method: request.method,
        url: request.url,
        headers: authorizationHeader(token),
        ...(request.payload === undefined ? {} : { payload: request.payload }),
      });

      if (response.statusCode !== 400) {
        failures.push(
          `${request.method} ${request.url} → ${response.statusCode} (expected 400): ${response.body.slice(0, 120)}`
        );
      }
    }

    expect(failures).toEqual([]);
    // Validation ran before any handler, so the database was never touched.
    expect(fakeDatabase.insertedRows).toHaveLength(0);
    expect(fakeDatabase.updatedRows).toHaveLength(0);
  });

  it("labels a rejected input with the standard validation error code", async () => {
    const { token } = signTestToken({ role: "admin" });
    fakeDatabase.queueSelectRows([]);

    const response = await server.inject({
      method: "POST",
      url: "/api/payments",
      headers: authorizationHeader(token),
      payload: { amountCentavos: 10.5 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
  });
});
