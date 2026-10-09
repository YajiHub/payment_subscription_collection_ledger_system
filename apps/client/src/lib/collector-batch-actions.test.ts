import { describe, expect, it } from "vitest";

import {
  BATCH_LEVEL_ACTIONS,
  COLLECTOR_BATCH_ACTIONS,
  ROW_LEVEL_ACTIONS,
  assessBatchRemittance,
  collectorBatchActionsCard,
  collectorBatchActionsFor,
  isCollectorBatchActionAllowed,
  permittedCollectorBatchActions,
  roleMayTakeCollectorBatchAction,
  type CollectorBatchAction,
} from "./collector-batch-actions";
import {
  COLLECTOR_BATCH_STATUSES,
  SYSTEM_ROLES,
  USER_ROLES,
  type CollectorBatchStatus,
} from "@bcis/shared";

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
 * The Actions card must never be silently empty.
 *
 * A Cashier on an `in_progress` batch was the failing combination: the state machine
 * and the role between them permit `void_collection`, so the "nothing left to do"
 * sentence was skipped — but `Void` is a button on the account row, so the card drew
 * a heading over an empty body. These tests walk EVERY status and role, and the
 * specific combination that failed, so a future action cannot fall into the same gap.
 */
describe("collector batch Actions card", () => {
  const EVERY_ROLE = [...USER_ROLES, ...SYSTEM_ROLES];

  it("classifies every action as batch-level or row-level, never both", () => {
    const everyAction = [
      ...new Set(COLLECTOR_BATCH_STATUSES.flatMap((status) => COLLECTOR_BATCH_ACTIONS[status])),
    ];

    for (const action of everyAction) {
      const isBatchLevel = (BATCH_LEVEL_ACTIONS as readonly CollectorBatchAction[]).includes(action);
      const isRowLevel = (ROW_LEVEL_ACTIONS as readonly CollectorBatchAction[]).includes(action);
      expect(isBatchLevel !== isRowLevel, `${action} must be classified exactly once`).toBe(true);
    }
  });

  it.each(
    COLLECTOR_BATCH_STATUSES.flatMap((status) => EVERY_ROLE.map((role) => ({ status, role })))
  )("renders something for $role on $status", ({ status, role }) => {
    const permitted = permittedCollectorBatchActions(status, role);
    const card = collectorBatchActionsCard(status, role);

    if (permitted.length === 0) {
      expect(card.kind).toBe("nothing-to-do");
      return;
    }

    expect(card.kind).not.toBe("nothing-to-do");
    expect(card.batchActions.length + card.rowActions.length).toBe(permitted.length);

    if (card.kind === "buttons") {
      expect(card.batchActions.length).toBeGreaterThan(0);
    }
    if (card.kind === "row-level-only") {
      // Nothing to draw as a button, but the card still has something to say and a
      // row control to point at.
      expect(card.batchActions).toEqual([]);
      expect(card.rowActions.length).toBeGreaterThan(0);
    }
  });

  it("points a cashier on an in_progress batch at the row control", () => {
    expect(permittedCollectorBatchActions("in_progress", "cashier")).toEqual(["void_collection"]);
    expect(collectorBatchActionsCard("in_progress", "cashier")).toMatchObject({
      kind: "row-level-only",
      batchActions: [],
      rowActions: ["void_collection"],
    });
  });

  it("still draws buttons when the viewer has a batch-level action", () => {
    const card = collectorBatchActionsCard("remitted", "cashier");

    expect(card.kind).toBe("buttons");
    expect(card.batchActions).toEqual(["reconcile"]);
  });

  it("reports nothing to do exactly when no action is permitted at all", () => {
    for (const status of COLLECTOR_BATCH_STATUSES) {
      for (const role of EVERY_ROLE) {
        const permitted = permittedCollectorBatchActions(status, role);
        const kind = collectorBatchActionsCard(status, role).kind;
        const reportsNothingToDo = kind === "nothing-to-do";

        expect(reportsNothingToDo, `${role} on ${status}`).toBe(permitted.length === 0);
      }
    }
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
