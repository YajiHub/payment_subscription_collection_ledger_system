// Which office actions a collector batch offers, and who may take them.
//
// One table, so the screen can never show an action the state machine would
// reject, nor hide one it would allow (S4-1, S4-2). The server is still the
// authority: this table mirrors `collector-batches.routes.ts` and
// `COLLECTOR_BATCH_TRANSITIONS` in `@bcis/shared`, and every request is re-checked
// on the server. It exists so the UI answers the same state-machine question the
// service does, rather than each screen inventing its own `status === "..."` test.

import {
  roleHasPermission,
  type CollectorBatchStatus,
  type Permission,
} from "@bcis/shared";

/** An action an operator can take on a batch. */
export type CollectorBatchAction =
  | "add_accounts"
  | "record_collection"
  | "void_collection"
  | "submit"
  | "remit"
  | "reconcile"
  | "close"
  | "cancel";

/**
 * The actions legal from each lifecycle state, in the order the screen shows them.
 *
 * The lifecycle is open → in_progress → submitted → remitted → reconciled →
 * closed, or cancelled from open. `record_collection`/`void_collection` act on a
 * single assignment (their buttons live on the row), not on the whole batch, but
 * they belong to the same state machine and are listed here so the UI has one
 * answer to "what is possible now?".
 *
 * Cancelling is only reachable from `open`: the server refuses it once anything
 * has been collected, which is why `in_progress` deliberately does not list it.
 */
export const COLLECTOR_BATCH_ACTIONS: Record<
  CollectorBatchStatus,
  readonly CollectorBatchAction[]
> = {
  open: ["add_accounts", "record_collection", "submit", "cancel"],
  in_progress: ["record_collection", "void_collection", "submit"],
  submitted: ["remit"],
  remitted: ["remit", "reconcile"],
  reconciled: ["close"],
  closed: [],
  cancelled: [],
};

/** The permission each action requires, matching the route table on the server. */
export const COLLECTOR_BATCH_ACTION_PERMISSIONS: Record<CollectorBatchAction, Permission> = {
  add_accounts: "collector_batches:create",
  record_collection: "collector_batches:remit",
  void_collection: "collector_batches:reconcile",
  submit: "collector_batches:remit",
  remit: "collector_batches:remit",
  reconcile: "collector_batches:reconcile",
  close: "collector_batches:reconcile",
  cancel: "collector_batches:create",
};

/** The label on the control that offers each action. */
export const COLLECTOR_BATCH_ACTION_LABELS: Record<CollectorBatchAction, string> = {
  add_accounts: "Add accounts",
  record_collection: "Record Collection",
  void_collection: "Void",
  submit: "Submit run",
  remit: "Record remittance",
  reconcile: "Reconcile",
  close: "Close batch",
  cancel: "Cancel batch",
};

/** The actions legal from a state, before the viewer's permissions are applied. */
export function collectorBatchActionsFor(
  status: CollectorBatchStatus
): readonly CollectorBatchAction[] {
  return COLLECTOR_BATCH_ACTIONS[status];
}

/** True when the state machine allows the action from this state. */
export function isCollectorBatchActionAllowed(
  status: CollectorBatchStatus,
  action: CollectorBatchAction
): boolean {
  return COLLECTOR_BATCH_ACTIONS[status].includes(action);
}

/** True when the role holds the permission the action's route requires. */
export function roleMayTakeCollectorBatchAction(
  role: string,
  action: CollectorBatchAction
): boolean {
  return roleHasPermission(role, COLLECTOR_BATCH_ACTION_PERMISSIONS[action]);
}

/** The actions the state machine allows AND the role may take. */
export function permittedCollectorBatchActions(
  status: CollectorBatchStatus,
  role: string
): CollectorBatchAction[] {
  return COLLECTOR_BATCH_ACTIONS[status].filter((action) =>
    roleMayTakeCollectorBatchAction(role, action)
  );
}

/** The actions whose control is a button in the Actions card itself. */
export const BATCH_LEVEL_ACTIONS = [
  "add_accounts",
  "submit",
  "remit",
  "reconcile",
  "close",
  "cancel",
] as const satisfies readonly CollectorBatchAction[];

/**
 * The actions that act on ONE assigned account. Their button lives on that
 * account's row, never on the batch card, so a permitted action of this kind does
 * not give the card anything to draw.
 */
export const ROW_LEVEL_ACTIONS = [
  "record_collection",
  "void_collection",
] as const satisfies readonly CollectorBatchAction[];

/** True when the action's control is a button on the batch card. */
function isBatchLevelAction(action: CollectorBatchAction): boolean {
  return BATCH_LEVEL_ACTIONS.some((batchAction) => batchAction === action);
}

/** True when the action's control lives on an assigned account's row. */
function isRowLevelAction(action: CollectorBatchAction): boolean {
  return ROW_LEVEL_ACTIONS.some((rowAction) => rowAction === action);
}

/**
 * What the Actions card renders for one viewer and one batch.
 *
 *   buttons         — batch-level controls to draw (possibly alongside row actions)
 *   row-level-only  — nothing to draw here; the actions left are on the rows, so
 *                     the card says so rather than rendering an empty body
 *   nothing-to-do   — the batch's state permits nothing for this viewer
 */
export interface CollectorBatchActionsCard {
  kind: "buttons" | "row-level-only" | "nothing-to-do";
  /** Every action this viewer may take in this state, both kinds together. */
  permitted: CollectorBatchAction[];
  /** The batch-level actions to draw as buttons; empty unless `kind` is "buttons". */
  batchActions: CollectorBatchAction[];
  /** The per-account actions this viewer holds, for the row-level-only message. */
  rowActions: CollectorBatchAction[];
}

/**
 * Decides the Actions card's content, so it is never silently empty.
 *
 * A Cashier on an `in_progress` batch is the case that produced an empty card:
 * `permittedCollectorBatchActions` returns `["void_collection"]`, but `Void` is a
 * row control, so the card drew neither a button nor the "nothing left to do"
 * sentence. Every permitted action is classified here, and the card always has
 * something to say about the ones it cannot draw itself.
 */
export function collectorBatchActionsCard(
  status: CollectorBatchStatus,
  role: string
): CollectorBatchActionsCard {
  const permitted = permittedCollectorBatchActions(status, role);
  const batchActions = permitted.filter(isBatchLevelAction);
  const rowActions = permitted.filter(isRowLevelAction);

  if (batchActions.length > 0) {
    return { kind: "buttons", permitted, batchActions, rowActions };
  }
  if (rowActions.length > 0) {
    return { kind: "row-level-only", permitted, batchActions, rowActions };
  }
  return { kind: "nothing-to-do", permitted, batchActions, rowActions };
}

/** How the money stands after a remittance the operator is about to record. */
export interface BatchRemittanceAssessment {
  /** The batch total the remittance would produce. */
  resultingTotalCentavos: number;
  /** `resultingTotal - expected`: negative is a shortage, positive an overage. */
  varianceCentavos: number;
  isBalanced: boolean;
  isShortage: boolean;
  /** Plain-language summary, safe to show beside the amount. */
  message: string;
  /** The tone the message wears: success only when the totals match exactly. */
  tone: "success" | "warning";
}

/**
 * Assesses a remittance before it is recorded: what the batch total becomes and
 * how it compares with what the field run collected.
 *
 * Kept pure so the dialog and its test read the same rule. A shortage stays a
 * shortage: only an exact match reports balanced, so a missing cash amount can
 * never be presented as a tidy batch.
 */
export function assessBatchRemittance(
  expectedCentavos: number,
  alreadyRemittedCentavos: number,
  remittanceCentavos: number
): BatchRemittanceAssessment {
  const resultingTotalCentavos = alreadyRemittedCentavos + remittanceCentavos;
  const varianceCentavos = resultingTotalCentavos - expectedCentavos;

  if (varianceCentavos === 0) {
    return {
      resultingTotalCentavos,
      varianceCentavos,
      isBalanced: true,
      isShortage: false,
      message: "Balanced — the amount handed in matches what the run collected.",
      tone: "success",
    };
  }

  if (varianceCentavos < 0) {
    return {
      resultingTotalCentavos,
      varianceCentavos,
      isBalanced: false,
      isShortage: true,
      message: "Shortage — less cash is being handed in than the run collected. Reconciliation will need an explanation.",
      tone: "warning",
    };
  }

  return {
    resultingTotalCentavos,
    varianceCentavos,
    isBalanced: false,
    isShortage: false,
    message: "Overage — more is being handed in than the run collected.",
    tone: "warning",
  };
}
