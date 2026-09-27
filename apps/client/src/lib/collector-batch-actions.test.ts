import { describe, expect, it } from "vitest";

import {
  COLLECTOR_BATCH_ACTIONS,
  assessBatchRemittance,
  collectorBatchActionsFor,
  isCollectorBatchActionAllowed,
  permittedCollectorBatchActions,
  roleMayTakeCollectorBatchAction,
  type CollectorBatchAction,
} from "./collector-batch-actions";
import { COLLECTOR_BATCH_STATUSES, type CollectorBatchStatus } from "@bcis/shared";

/**
 * The batch action table is the client's half of S4-1/S4-2: the screen must offer
 * an action exactly when the state machine and the route permissions allow it.
 * These tests pin every state so a screen can never show "Reconcile" on a batch
 * that has not been remitted, nor hide "Close" from one that has been reconciled.
 */
describe("collector batch action set", () => {
  it("has an entry for all seven lifecycle states", () => {
    for (const status of COLLECTOR_BATCH_STATUSES) {
      expect(COLLECTOR_BATCH_ACTIONS[status]).toBeDefined();
    }
  });

  const EXPECTED: Record<CollectorBatchStatus, CollectorBatchAction[]> = {
    open: ["add_accounts", "record_collection", "submit", "cancel"],
    in_progress: ["record_collection", "void_collection", "submit"],
    submitted: ["remit"],
    remitted: ["remit", "reconcile"],
    reconciled: ["close"],
    closed: [],
    cancelled: [],
  };

  it.each(COLLECTOR_BATCH_STATUSES)("offers the legal actions from %s", (status) => {
    expect([...collectorBatchActionsFor(status)]).toEqual(EXPECTED[status]);
  });

  it("allows the forward step and rejects the ones the state machine refuses", () => {
    expect(isCollectorBatchActionAllowed("submitted", "remit")).toBe(true);
    expect(isCollectorBatchActionAllowed("submitted", "reconcile")).toBe(false);
    expect(isCollectorBatchActionAllowed("open", "remit")).toBe(false);
    // Cancelling is only legal from an open batch — in_progress has collected
    // money and the server refuses it.
    expect(isCollectorBatchActionAllowed("in_progress", "cancel")).toBe(false);
    expect(isCollectorBatchActionAllowed("closed", "close")).toBe(false);
  });

  it("maps each action to the permission its route requires", () => {
    expect(roleMayTakeCollectorBatchAction("admin", "close")).toBe(true);
    // A collector may remit but not reconcile or close.
    expect(roleMayTakeCollectorBatchAction("collector", "remit")).toBe(true);
    expect(roleMayTakeCollectorBatchAction("collector", "reconcile")).toBe(false);
    expect(roleMayTakeCollectorBatchAction("collector", "close")).toBe(false);
    // The cashier reconciles but may not remit field money.
    expect(roleMayTakeCollectorBatchAction("cashier", "reconcile")).toBe(true);
    expect(roleMayTakeCollectorBatchAction("cashier", "remit")).toBe(false);
  });

  it("intersects the legal state actions with the role's permissions", () => {
    expect(permittedCollectorBatchActions("remitted", "cashier")).toEqual(["reconcile"]);
    expect(permittedCollectorBatchActions("remitted", "collector")).toEqual(["remit"]);
  });
});

/**
 * The remittance assessment is what stops a shortage from looking like a tidy
 * batch: only an exact match reports balanced.
 */
describe("assessBatchRemittance", () => {
  it("reports balanced only when the resulting total matches expected", () => {
    const assessment = assessBatchRemittance(100000, 0, 100000);

    expect(assessment.isBalanced).toBe(true);
    expect(assessment.isShortage).toBe(false);
    expect(assessment.varianceCentavos).toBe(0);
    expect(assessment.tone).toBe("success");
  });

  it("reports a shortage when less is handed in than was collected", () => {
    const assessment = assessBatchRemittance(100000, 0, 60000);

    expect(assessment.isBalanced).toBe(false);
    expect(assessment.isShortage).toBe(true);
    expect(assessment.resultingTotalCentavos).toBe(60000);
    expect(assessment.varianceCentavos).toBe(-40000);
    expect(assessment.tone).toBe("warning");
    expect(assessment.message).toMatch(/shortage/i);
  });

  it("adds an instalment to the amount already remitted before judging", () => {
    const assessment = assessBatchRemittance(100000, 60000, 40000);

    expect(assessment.isBalanced).toBe(true);
    expect(assessment.resultingTotalCentavos).toBe(100000);
  });

  it("treats a negative correction as reducing the running total", () => {
    const assessment = assessBatchRemittance(100000, 120000, -20000);

    expect(assessment.isBalanced).toBe(true);
    expect(assessment.resultingTotalCentavos).toBe(100000);
  });

  it("reports an overage when more is handed in than was collected", () => {
    const assessment = assessBatchRemittance(100000, 0, 120000);

    expect(assessment.isShortage).toBe(false);
    expect(assessment.varianceCentavos).toBe(20000);
    expect(assessment.message).toMatch(/overage/i);
  });
});
