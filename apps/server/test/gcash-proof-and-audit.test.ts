// The four payments/GCash defects: proof-image access, the 5 MB screenshot cap,
// and the two missing audit rows.
//
// What is pinned down here:
//   • a proof screenshot is customer evidence — only a caller who may act on the
//     claim (verify/reject) or who recorded it may download it; a Technician,
//     Read-only Viewer or Accounting Auditor gets a 403, and the old
//     `payments:read` gate would have handed them the image;
//   • the documented 5 MB cap is REACHABLE: an upload at the cap is accepted and
//     one byte over is refused by the size check (not by a 413 body limit);
//   • recording a PENDING GCash claim writes an audit row that cannot be mistaken
//     for money received;
//   • uploading the proof writes an attributable audit row.

import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

import { GCASH_SCREENSHOT_MAX_BYTES, type UserRole } from "@bcis/shared";

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
import { config } from "../src/config";
import { auditLogs } from "../src/db/schema/audit";
import { fakeDatabase } from "./support/fake-database";
import { authorizationHeader, signTestToken } from "./support/tokens";

const RECORDER_ID = randomUUID();
const CASHIER_ID = randomUUID();
const SERVICE_ACCOUNT_ID = randomUUID();
const PAYMENT_ID = randomUUID();
const REFERENCE = "GCASH-PROOF-0001";

/** A PNG whose declared bytes are `sizeBytes` long (the first 8 are the magic). */
function pngOfSize(sizeBytes: number): Buffer {
  const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const buffer = Buffer.alloc(sizeBytes);
  pngMagic.copy(buffer, 0);
  return buffer;
}

function paymentSummaryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYMENT_ID,
    receiptNumber: "OR-2025-000007",
    serviceAccountId: SERVICE_ACCOUNT_ID,
    serviceAccountNumber: "SA-20250101-00001",
    subscriberId: randomUUID(),
    subscriberFirstName: "Maria",
    subscriberLastName: "Santos",
    paymentMethod: "gcash",
    status: "pending_verification",
    amountCentavos: 50000,
    allocatedCentavos: 0,
    advanceCreditCentavos: 0,
    paymentDate: "2025-03-01",
    notes: null,
    gcashReferenceNumber: REFERENCE,
    postedAt: new Date("2025-03-01T09:00:00Z"),
    postedById: RECORDER_ID,
    postedByName: "Cashier User",
    reversedAt: null,
    reversedById: null,
    ...overrides,
  };
}

function gcashDetailRow(overrides: Record<string, unknown> = {}) {
  return {
    referenceNumber: REFERENCE,
    senderGcashNumber: "09171234567",
    senderName: "Maria Santos",
    screenshotFilePath: null,
    verifiedAt: null,
    verifiedById: null,
    rejectedAt: null,
    rejectedById: null,
    rejectionReason: null,
    ...overrides,
  };
}

function auditWrites(): Array<Record<string, unknown>> {
  return fakeDatabase.insertedRows
    .filter((row) => row.table === auditLogs)
    .map((row) => row.values as Record<string, unknown>);
}

/** Every file the upload route wrote, so the test can remove it afterwards. */
const uploadedFiles: string[] = [];

describe("GCash proof-image access", () => {
  let server: FastifyInstance;

  // A real proof file, so the authorised download can actually stream bytes.
  const proofRelativePath = path.join("gcash-proofs", "2025", "03", `proof-${randomUUID()}.png`);
  const proofAbsolutePath = path.resolve(config.UPLOADS_DIR, proofRelativePath);
  const proofBytes = pngOfSize(256);

  beforeAll(async () => {
    server = buildServer();
    await server.ready();
    await mkdir(path.dirname(proofAbsolutePath), { recursive: true });
    await writeFile(proofAbsolutePath, proofBytes);
  });

  afterAll(async () => {
    await server.close();
    await rm(proofAbsolutePath, { force: true });
    for (const file of uploadedFiles) {
      await rm(path.resolve(config.UPLOADS_DIR, file), { force: true });
    }
  });

  beforeEach(() => {
    fakeDatabase.reset();
  });

  it("refuses a caller with no authority over the claim with 403", async () => {
    // `manager` and `billing_clerk` hold `payments:read` (which the old route
    // accepted) but not verify/reject authority, so under the old route they would
    // have been handed the image. `technician`, `read_only_viewer` and
    // `accounting_auditor` are the stored-role names the defect named.
    for (const role of [
      "manager",
      "billing_clerk",
      "technician",
      "read_only_viewer",
      "accounting_auditor",
    ] as const) {
      fakeDatabase.reset();
      fakeDatabase.queueSelectRows([]); // authenticate
      // The recorder lookup finds nothing, so the refusal does not depend on the
      // payment existing.

      const { token } = signTestToken({ sub: randomUUID(), role: role as unknown as UserRole });
      const response = await server.inject({
        method: "GET",
        url: `/api/payments/gcash/screenshot/${PAYMENT_ID}`,
        headers: authorizationHeader(token),
      });

      expect(response.statusCode, `${role} must be refused`).toBe(403);
      expect(response.json().error.code).toBe("FORBIDDEN");
      expect(response.json().error.message).toContain("verify or reject");
    }
  });

  it("serves the image to a verifier who may act on the claim", async () => {
    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([paymentSummaryRow()]); // payment summary
    fakeDatabase.queueSelectRows([]); // allocations
    fakeDatabase.queueSelectRows([gcashDetailRow({ screenshotFilePath: proofRelativePath })]); // gcash

    const { token } = signTestToken({ role: "cashier", sub: CASHIER_ID });
    const response = await server.inject({
      method: "GET",
      url: `/api/payments/gcash/screenshot/${PAYMENT_ID}`,
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/png");
    expect(response.rawPayload.equals(proofBytes)).toBe(true);
  });

  it("serves the image to the user who recorded the claim, even without verify authority", async () => {
    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([{ postedBy: RECORDER_ID }]); // recorder lookup
    fakeDatabase.queueSelectRows([paymentSummaryRow()]); // payment summary
    fakeDatabase.queueSelectRows([]); // allocations
    fakeDatabase.queueSelectRows([gcashDetailRow({ screenshotFilePath: proofRelativePath })]); // gcash

    // `collector` has neither verify nor reject permission; only the recorder clause
    // lets this caller in.
    const { token } = signTestToken({ role: "collector", sub: RECORDER_ID });
    const response = await server.inject({
      method: "GET",
      url: `/api/payments/gcash/screenshot/${PAYMENT_ID}`,
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(200);
    expect(response.rawPayload.equals(proofBytes)).toBe(true);
  });
});

describe("GCash screenshot size cap", () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = buildServer();
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    for (const file of uploadedFiles) {
      await rm(path.resolve(config.UPLOADS_DIR, file), { force: true });
    }
  });

  beforeEach(() => {
    fakeDatabase.reset();
  });

  it("accepts an upload at the documented 5 MB cap", async () => {
    const { token } = signTestToken({ role: "admin", sub: CASHIER_ID });
    fakeDatabase.queueSelectRows([]); // authenticate

    const response = await server.inject({
      method: "POST",
      url: "/api/payments/gcash/upload-screenshot",
      headers: authorizationHeader(token),
      payload: {
        fileName: "proof.png",
        contentType: "image/png",
        dataBase64: pngOfSize(GCASH_SCREENSHOT_MAX_BYTES).toString("base64"),
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().data.sizeBytes).toBe(GCASH_SCREENSHOT_MAX_BYTES);
    uploadedFiles.push(response.json().data.filePath as string);
  });

  it("refuses a screenshot one byte over the cap with the size message, not a 413", async () => {
    const { token } = signTestToken({ role: "admin", sub: CASHIER_ID });
    fakeDatabase.queueSelectRows([]); // authenticate

    const response = await server.inject({
      method: "POST",
      url: "/api/payments/gcash/upload-screenshot",
      headers: authorizationHeader(token),
      payload: {
        fileName: "proof.png",
        contentType: "image/png",
        dataBase64: pngOfSize(GCASH_SCREENSHOT_MAX_BYTES + 1).toString("base64"),
      },
    });

    // A 413 here would mean the body limit, not the size rule, refused it.
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("5 MB or smaller");
  });
});

describe("GCash audit rows", () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = buildServer();
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    for (const file of uploadedFiles) {
      await rm(path.resolve(config.UPLOADS_DIR, file), { force: true });
    }
  });

  beforeEach(() => {
    fakeDatabase.reset();
  });

  it("records a PENDING GCash claim with its actor, never as a posted payment", async () => {
    const { token } = signTestToken({ role: "cashier", sub: CASHIER_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([{ id: SERVICE_ACCOUNT_ID }]); // account exists
    fakeDatabase.queueSelectRows([]); // reference unused
    fakeDatabase.queueSelectRows([]); // receipt numbers
    fakeDatabase.queueInsertRows([paymentSummaryRow({ status: "pending_verification" })]);
    fakeDatabase.queueInsertRows([{ id: randomUUID(), paymentId: PAYMENT_ID }]);

    const response = await server.inject({
      method: "POST",
      url: "/api/payments",
      headers: authorizationHeader(token),
      payload: {
        serviceAccountId: SERVICE_ACCOUNT_ID,
        paymentMethod: "gcash",
        amountCentavos: 50000,
        paymentDate: "2025-03-01",
        gcash: { referenceNumber: REFERENCE, senderName: "Maria Santos" },
      },
    });

    expect(response.statusCode).toBe(201);

    const claimRows = auditWrites().filter((row) => row.action === "payment.gcash_claim_recorded");
    expect(claimRows).toHaveLength(1);
    expect(claimRows[0]).toMatchObject({
      entityType: "payment",
      entityId: PAYMENT_ID,
      performedBy: CASHIER_ID,
      previousState: null,
    });
    // The snapshot names the PENDING status: an auditor must never read this row as
    // money received.
    expect(claimRows[0]?.newState).toMatchObject({ status: "pending_verification" });
    expect(String(claimRows[0]?.description)).toContain("no money received");

    // A pending claim is not a posted payment.
    expect(auditWrites().filter((row) => row.action === "payment.posted")).toHaveLength(0);
  });

  it("records the screenshot upload with the real actor", async () => {
    const { token } = signTestToken({ role: "admin", sub: CASHIER_ID });
    fakeDatabase.queueSelectRows([]); // authenticate

    const response = await server.inject({
      method: "POST",
      url: "/api/payments/gcash/upload-screenshot",
      headers: authorizationHeader(token),
      payload: {
        fileName: "proof.png",
        contentType: "image/png",
        dataBase64: pngOfSize(64).toString("base64"),
      },
    });

    expect(response.statusCode).toBe(201);
    uploadedFiles.push(response.json().data.filePath as string);

    const uploadRows = auditWrites().filter(
      (row) => row.action === "payment.gcash_screenshot_uploaded"
    );
    expect(uploadRows).toHaveLength(1);
    expect(uploadRows[0]).toMatchObject({
      entityType: "payment",
      performedBy: CASHIER_ID,
    });
    expect(uploadRows[0]?.newState).toMatchObject({
      filePath: response.json().data.filePath,
      contentType: "image/png",
    });
  });
});
