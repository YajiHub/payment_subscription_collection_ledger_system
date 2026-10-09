// WP11a — the service account list and search (S3.2, S8-1 style paging).
//
// Two gaps this closes:
//   • there was no way to list or search service accounts at all;
//   • the subscriber search covered six fields, not the address and the three
//     document references the activity names.
//
// This file runs against the in-memory database so it needs no PostgreSQL. It
// proves the paging contract, that each filter reaches the SQL `where` clause
// (using the same `whereTextOf` helper the report filter tests use), that the
// search reaches the account number, and that the reference searches are built as
// EXISTS subqueries. The real-SQL semantics are proven in
// `service-account-search.postgres.test.ts`.

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
import { listServiceAccounts } from "../src/modules/service-accounts/service-accounts.service";
import { listSubscribers } from "../src/modules/subscribers/subscribers.service";
import { fakeDatabase } from "./support/fake-database";
import { whereTextOf } from "./support/sql-debug";
import { authorizationHeader, signTestToken } from "./support/tokens";

const ADMIN_ID = randomUUID();
const CLERK_ID = randomUUID();
const SUBSCRIBER_ID = randomUUID();
const SERVICE_ACCOUNT_ID = randomUUID();
const PLAN_ID = randomUUID();
const AREA_ID = randomUUID();
const COLLECTOR_ID = randomUUID();

/** A joined service-account row, as the list query selects it. */
function serviceAccountListRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SERVICE_ACCOUNT_ID,
    serviceAccountNumber: "SA-20250124-00001",
    subscriberId: SUBSCRIBER_ID,
    subscriberAccountNumber: "SUB-20250124-00001",
    subscriberFirstName: "Maria",
    subscriberLastName: "Santos",
    planId: PLAN_ID,
    planName: "Fiber 25Mbps",
    serviceType: "internet",
    status: "active",
    areaId: AREA_ID,
    assignedCollectorId: COLLECTOR_ID,
    activationDate: "2025-01-24",
    suspensionDate: null,
    terminationDate: null,
    consecutiveOverdueMonths: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/** A stored subscriber row, as the search query selects it. */
function subscriberRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SUBSCRIBER_ID,
    accountNumber: "SUB-20250124-00001",
    firstName: "Maria",
    lastName: "Santos",
    middleName: null,
    primaryPhone: "09171234567",
    secondaryPhone: null,
    emailAddress: null,
    serviceAddress: "12 Mabini Street",
    serviceBarangay: "Poblacion",
    serviceMunicipality: "Cabuyao",
    serviceProvince: "Laguna",
    internalNotes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    createdBy: ADMIN_ID,
    updatedBy: null,
    ...overrides,
  };
}

/** The `where` text the service account list builds for a set of filters. */
async function serviceAccountWhereText(filters: Record<string, unknown>): Promise<string> {
  fakeDatabase.reset();
  await listServiceAccounts({ page: 1, pageSize: 20, ...filters });
  return whereTextOf(fakeDatabase.whereConditions);
}

/** The `where` text the subscriber search builds for a query. */
async function subscriberWhereText(search: string): Promise<string> {
  fakeDatabase.reset();
  await listSubscribers({ page: 1, pageSize: 20, search });
  return whereTextOf(fakeDatabase.whereConditions);
}

describe("service account list route", () => {
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

  it("returns a bounded page with the items/page/pageSize/total contract", async () => {
    const { token } = signTestToken({ role: "billing_clerk", sub: CLERK_ID });

    fakeDatabase.queueSelectRows([]); // authenticate: token revocation lookup
    fakeDatabase.queueSelectRows([
      serviceAccountListRow(),
      serviceAccountListRow({ id: randomUUID(), serviceAccountNumber: "SA-20250124-00002" }),
    ]); // list rows
    fakeDatabase.queueSelectRows([{ value: 2 }]); // count
    fakeDatabase.queueSelectRows([{ balanceCentavos: 50000 }]); // balance of account 1
    fakeDatabase.queueSelectRows([{ balanceCentavos: 0 }]); // balance of account 2

    const response = await server.inject({
      method: "GET",
      url: "/api/service-accounts?page=2&pageSize=25",
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json().data;
    expect(body.page).toBe(2);
    expect(body.pageSize).toBe(25);
    expect(body.total).toBe(2);
    expect(body.items).toHaveLength(2);
    expect(body.items[0].serviceAccountNumber).toBe("SA-20250124-00001");
    expect(body.items[0].subscriberName).toBe("Santos, Maria");
    expect(body.items[0].balanceCentavos).toBe(50000);

    // AC: the page is bounded — page 2 of 25 rows starts at offset 25.
    expect(fakeDatabase.limitValues).toContain(25);
    expect(fakeDatabase.offsetValues).toContain(25);
  });

  it("caps the page size at the schema maximum", async () => {
    const { token } = signTestToken({ role: "billing_clerk", sub: CLERK_ID });
    fakeDatabase.queueSelectRows([]); // authenticate

    const response = await server.inject({
      method: "GET",
      url: "/api/service-accounts?pageSize=100000",
      headers: authorizationHeader(token),
    });

    // AC: a caller cannot ask for the whole table; the request is rejected.
    expect(response.statusCode).toBe(400);
  });

  it("finds the account when the clerk types the service account number", async () => {
    const { token } = signTestToken({ role: "billing_clerk", sub: CLERK_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([serviceAccountListRow()]); // list rows
    fakeDatabase.queueSelectRows([{ value: 1 }]); // count
    fakeDatabase.queueSelectRows([{ balanceCentavos: 50000 }]); // balance

    const response = await server.inject({
      method: "GET",
      url: "/api/service-accounts?search=SA-20250124-00001",
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.items[0].serviceAccountNumber).toBe("SA-20250124-00001");

    const where = whereTextOf(fakeDatabase.whereConditions);
    expect(where).toContain("service_account_number");
    expect(where).toContain("SA-20250124-00001");
    // The search is generous: the owning subscriber's name and number are searched too.
    expect(where).toContain("account_number");
    expect(where).toContain("first_name");
    expect(where).toContain("last_name");
  });

  it("refuses a caller whose role does not hold subscribers:read", async () => {
    const { token } = signTestToken({ role: "ghost_role" as never, sub: CLERK_ID });
    fakeDatabase.queueSelectRows([]); // authenticate

    const response = await server.inject({
      method: "GET",
      url: "/api/service-accounts",
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("FORBIDDEN");
  });
});

describe("service account list filters", () => {
  beforeEach(() => {
    fakeDatabase.reset();
  });

  it("puts every filter into the SQL where clause", async () => {
    const unfiltered = await serviceAccountWhereText({});

    const cases: { column: string; value: string; filters: Record<string, unknown> }[] = [
      { column: "status", value: "suspended", filters: { status: "suspended" } },
      { column: "service_type", value: "internet", filters: { serviceType: "internet" } },
      { column: "plan_id", value: PLAN_ID, filters: { planId: PLAN_ID } },
      { column: "area_id", value: AREA_ID, filters: { areaId: AREA_ID } },
      {
        column: "assigned_collector_id",
        value: COLLECTOR_ID,
        filters: { collectorId: COLLECTOR_ID },
      },
    ];

    for (const filterCase of cases) {
      const where = await serviceAccountWhereText(filterCase.filters);

      // AC: the filter CHANGED the condition and names the filtered column with the
      // value that was supplied — it was not accepted and ignored.
      expect(where, filterCase.column).not.toBe(unfiltered);
      expect(where, filterCase.column).toContain(filterCase.column);
      expect(where, filterCase.column).toContain(filterCase.value);
    }
  });
});

describe("subscriber search fields", () => {
  beforeEach(() => {
    fakeDatabase.reset();
  });

  it("searches the address, barangay and municipality", async () => {
    const where = await subscriberWhereText("Mabini");

    expect(where).toContain("service_address");
    expect(where).toContain("service_barangay");
    expect(where).toContain("service_municipality");
    expect(where).toContain("Mabini");
  });

  it("searches the receipt, invoice and GCash reference through EXISTS subqueries", async () => {
    const where = await subscriberWhereText("OR-2025-000123");

    // AC: the three references are searched. Each is an EXISTS subquery against the
    // subscriber's service accounts, not a join that would multiply rows.
    expect(where).toContain("exists");
    expect(where).toContain("receipt_number");
    expect(where).toContain("invoice_number");
    expect(where).toContain("gcash_reference_number");
    expect(where).toContain("OR-2025-000123");
  });

  it("still returns the subscriber row shape unchanged for a plain name search", async () => {
    fakeDatabase.queueSelectRows([subscriberRow()]); // rows
    fakeDatabase.queueSelectRows([{ value: 1 }]); // count
    fakeDatabase.queueSelectRows([]); // loadServiceAccountsForSubscribers

    const page = await listSubscribers({ page: 1, pageSize: 20, search: "Maria" });

    expect(page.items).toHaveLength(1);
    expect(page.items[0].firstName).toBe("Maria");
  });
});
