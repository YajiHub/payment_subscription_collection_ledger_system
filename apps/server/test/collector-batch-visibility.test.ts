// Batch VISIBILITY — the rule that a batch must never be created into a state its
// creator cannot see, and the answer to "which batches does each role see?".
//
// The reproduced defect: `demo.collector.one` (legacy role `collector`, stored role
// `collection_supervisor`) created a batch for `collector.two` and was refused the
// read back with "Collector batch not found", because reads were scoped by the
// legacy JWT role while permission checks used the resolved grants. The batch was
// genuinely created and genuinely invisible to the person who made it.
//
// These tests exercise BOTH authorities: the compiled fallback (which the other
// HTTP suites run under) and the database-resolved grants, where the two disagree.

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
import { batchAssignments, collectorBatches } from "../src/db/schema/collections";
import { createCollectorBatch, getCollectorBatchDetail } from "../src/modules/collections/collector-batches.service";
import {
  invalidatePermissionCache,
  refreshPermissionCache,
} from "../src/shared/rbac/permission-resolver";
import { setPermissionSourcePreferenceForTests } from "../src/shared/rbac/permission-source";
import { fakeDatabase, type RecordedInsert } from "./support/fake-database";
import { whereTextOf } from "./support/sql-debug";
import { authorizationHeader, signTestToken } from "./support/tokens";

const COLLECTOR_A_ID = randomUUID();
const COLLECTOR_B_ID = randomUUID();
const BILLING_CLERK_ID = randomUUID();
const SERVICE_ACCOUNT_A = randomUUID();
const BATCH_ID = randomUUID();
const BATCH_NUMBER = "CB-20250124-0001";
const COLLECTION_DATE = "2025-01-24";

/** A collector user row as the create-batch validation selects it. */
function collectorRow(overrides: Record<string, unknown> = {}) {
  return {
    id: COLLECTOR_A_ID,
    fullName: "Rico Reyes",
    role: "collector",
    isActive: true,
    ...overrides,
  };
}

/** A collector batch row with sensible defaults. */
function batchRow(overrides: Record<string, unknown> = {}) {
  return {
    id: BATCH_ID,
    batchNumber: BATCH_NUMBER,
    collectorId: COLLECTOR_A_ID,
    status: "open",
    collectionDate: COLLECTION_DATE,
    expectedRemittanceCentavos: 0,
    actualRemittanceCentavos: null,
    varianceCentavos: null,
    varianceNotes: null,
    createdBy: COLLECTOR_A_ID,
    createdAt: new Date("2025-01-24T08:00:00Z"),
    submittedAt: null,
    reconciledAt: null,
    closedAt: null,
    cancelledAt: null,
    cancelledBy: null,
    cancelReason: null,
    closedBy: null,
    ...overrides,
  };
}

function insertedInto(table: unknown): RecordedInsert[] {
  return fakeDatabase.insertedRows.filter((row) => row.table === table);
}

describe("collector batch visibility", () => {
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
    invalidatePermissionCache();
    // The global test setup installs "compiled"; the database-resolved test below
    // opts back into "auto" for itself.
    setPermissionSourcePreferenceForTests("compiled");
  });

  /**
   * Installs the resolved grants for a user — the "what may this user DO"
   * authority that visibility must follow.
   */
  async function installDatabaseGrants(userId: string, codes: readonly string[]): Promise<void> {
    setPermissionSourcePreferenceForTests("auto");
    fakeDatabase.queueSelectRows([{ value: "true" }]); // the RBAC source switch
    fakeDatabase.queueSelectRows(codes.map((code) => ({ userId, code })));
    await refreshPermissionCache({ force: true });
  }

  /**
   * The defect itself, live: the creator's own token must read back what it made.
   *
   * The token's legacy role is `collector` while the stored grants are a
   * supervisor's, exactly as the demo data has it.
   */
  it("lets the creator read back a batch they created for another collector", async () => {
    await installDatabaseGrants(COLLECTOR_A_ID, [
      "collector_batches:create",
      "collector_batches:read",
      "collector_batches:remit",
    ]);
    const { token } = signTestToken({ role: "collector", sub: COLLECTOR_A_ID });

    fakeDatabase.queueSelectRows([]); // authenticate: no revoked token
    fakeDatabase.queueSelectRows([collectorRow({ id: COLLECTOR_B_ID })]); // the collector exists
    fakeDatabase.queueSelectRows([{ id: SERVICE_ACCOUNT_A }]); // the accounts exist
    fakeDatabase.queueSelectRows([]); // the account is not in another open batch
    fakeDatabase.queueSelectRows([]); // existing batch numbers for the date
    fakeDatabase.queueSelectRows([]); // outstanding balances
    fakeDatabase.queueInsertRows([batchRow({ collectorId: COLLECTOR_B_ID })]);

    const created = await server.inject({
      method: "POST",
      url: "/api/collector-batches",
      headers: authorizationHeader(token),
      payload: {
        collectorId: COLLECTOR_B_ID,
        collectionDate: COLLECTION_DATE,
        serviceAccountIds: [SERVICE_ACCOUNT_A],
      },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json().data.collectorId).toBe(COLLECTOR_B_ID);

    fakeDatabase.queueSelectRows([]); // authenticate: no revoked token
    fakeDatabase.queueSelectRows([
      { batch: batchRow({ collectorId: COLLECTOR_B_ID }), collectorName: "Nena Cruz" },
    ]);
    fakeDatabase.queueSelectRows([]); // assignments

    const readBack = await server.inject({
      method: "GET",
      url: `/api/collector-batches/${BATCH_ID}`,
      headers: authorizationHeader(token),
    });

    expect(readBack.statusCode).toBe(200);
    expect(readBack.json().data.collectorId).toBe(COLLECTOR_B_ID);
  });

  /**
   * The domain guarantee, independent of who is calling: a scoped caller cannot
   * ask for a batch on someone else's behalf and lose sight of it. The route guard
   * normally refuses this first; the service states it anyway so an internal caller
   * (the demo seed, a future job) cannot create an invisible batch either.
   */
  it("refuses to create a batch for another collector when the caller is scoped to their own", async () => {
    await expect(
      createCollectorBatch(
        {
          collectorId: COLLECTOR_B_ID,
          collectionDate: COLLECTION_DATE,
          serviceAccountIds: [SERVICE_ACCOUNT_A],
        },
        { id: COLLECTOR_A_ID, seesEveryCollectorBatch: false }
      )
    ).rejects.toThrow(/only create a batch for yourself/i);

    expect(insertedInto(collectorBatches)).toHaveLength(0);
  });

  /** And the same scoped caller creating for themselves can always read it back. */
  it("lets a scoped collector read back the batch they created for themselves", async () => {
    const actor = { id: COLLECTOR_A_ID, seesEveryCollectorBatch: false };

    fakeDatabase.queueSelectRows([collectorRow({ id: COLLECTOR_A_ID })]);
    fakeDatabase.queueSelectRows([{ id: SERVICE_ACCOUNT_A }]);
    fakeDatabase.queueSelectRows([]); // not in an open batch
    fakeDatabase.queueSelectRows([]); // batch numbers
    fakeDatabase.queueSelectRows([]); // balances
    fakeDatabase.queueInsertRows([batchRow({ collectorId: COLLECTOR_A_ID })]);

    const created = await createCollectorBatch(
      {
        collectorId: COLLECTOR_A_ID,
        collectionDate: COLLECTION_DATE,
        serviceAccountIds: [SERVICE_ACCOUNT_A],
      },
      actor
    );

    fakeDatabase.queueSelectRows([
      { batch: batchRow({ collectorId: COLLECTOR_A_ID }), collectorName: "Rico Reyes" },
    ]);
    fakeDatabase.queueSelectRows([]); // assignments

    const readBack = await getCollectorBatchDetail(created.id, actor);

    expect(readBack.collectorId).toBe(COLLECTOR_A_ID);
    expect(insertedInto(batchAssignments)).toHaveLength(1);
  });

  /**
   * The picker and the guard must agree: a caller who cannot see another
   * collector's batches must not be OFFERED one either.
   */
  it("offers a scoped collector nobody but themselves in the collector picker", async () => {
    const { token } = signTestToken({ role: "collector", sub: COLLECTOR_A_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([{ id: COLLECTOR_A_ID, fullName: "Rico Reyes", isActive: true }]);

    const response = await server.inject({
      method: "GET",
      url: "/api/collector-batches/collectors",
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.items).toEqual([
      { id: COLLECTOR_A_ID, fullName: "Rico Reyes", isActive: true },
    ]);
    // The scope is enforced in SQL, not by filtering the answer afterwards.
    expect(whereTextOf(fakeDatabase.whereConditions)).toContain(COLLECTOR_A_ID);
  });

  /** An office caller who may batch for anyone is offered everyone. */
  it("offers every active collector to a caller who may create batches for anyone", async () => {
    const { token } = signTestToken({ role: "billing_clerk", sub: BILLING_CLERK_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([
      { id: COLLECTOR_A_ID, fullName: "Rico Reyes", isActive: true },
      { id: COLLECTOR_B_ID, fullName: "Nena Cruz", isActive: true },
    ]);

    const response = await server.inject({
      method: "GET",
      url: "/api/collector-batches/collectors",
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.items).toHaveLength(2);
  });

  /**
   * Which batches each role sees. The answer comes from the resolved grants, so it
   * is the same authority that decides what the role may DO.
   */
  const VISIBILITY_BY_ROLE = [
    { role: "admin", seesEveryCollectorBatch: true },
    { role: "billing_clerk", seesEveryCollectorBatch: true },
    { role: "cashier", seesEveryCollectorBatch: true },
    { role: "manager", seesEveryCollectorBatch: true },
    { role: "collector", seesEveryCollectorBatch: false },
  ] as const;

  it.each(VISIBILITY_BY_ROLE)(
    "scopes the batch list for $role when the caller sees every batch is $seesEveryCollectorBatch",
    async ({ role, seesEveryCollectorBatch }) => {
      const { token } = signTestToken({ role, sub: COLLECTOR_A_ID });

      fakeDatabase.queueSelectRows([]); // authenticate
      fakeDatabase.queueSelectRows([
        { batch: batchRow(), collectorName: "Rico Reyes" },
      ]);
      fakeDatabase.queueSelectRows([]); // assignment counts

      const response = await server.inject({
        method: "GET",
        url: "/api/collector-batches",
        headers: authorizationHeader(token),
      });

      expect(response.statusCode).toBe(200);

      // A scoped caller has their own id forced into the SQL filter; everyone else
      // is free to ask for a particular collector. The forced filter is present
      // exactly when the caller does NOT see every batch.
      const where = whereTextOf(fakeDatabase.whereConditions);
      expect(where.includes(COLLECTOR_A_ID)).toBe(!seesEveryCollectorBatch);
    }
  );

  /** A hand-crafted filter cannot widen a scoped collector's list. */
  it("ignores a requested collectorId when the caller is scoped to their own batches", async () => {
    const { token } = signTestToken({ role: "collector", sub: COLLECTOR_A_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([]); // no rows for the other collector
    fakeDatabase.queueSelectRows([]); // assignment counts

    const response = await server.inject({
      method: "GET",
      url: `/api/collector-batches?collectorId=${COLLECTOR_B_ID}`,
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.items).toEqual([]);

    const where = whereTextOf(fakeDatabase.whereConditions);
    expect(where).toContain(COLLECTOR_A_ID);
    expect(where).not.toContain(COLLECTOR_B_ID);
  });

  /** The office caller's own filter is honoured, not replaced. */
  it("honours a requested collectorId for a caller who sees every batch", async () => {
    const { token } = signTestToken({ role: "cashier", sub: randomUUID() });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([{ batch: batchRow({ collectorId: COLLECTOR_B_ID }), collectorName: "Nena Cruz" }]);
    fakeDatabase.queueSelectRows([]); // assignment counts

    const response = await server.inject({
      method: "GET",
      url: `/api/collector-batches?collectorId=${COLLECTOR_B_ID}`,
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(200);
    expect(whereTextOf(fakeDatabase.whereConditions)).toContain(COLLECTOR_B_ID);
  });
});
