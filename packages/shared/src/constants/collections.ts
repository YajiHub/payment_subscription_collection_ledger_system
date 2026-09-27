// Field collection and accounts-receivable vocabulary shared by the client and the
// server. The strings below must match the database enums EXACTLY so no translation
// layer is needed anywhere between the schema, the API, and the UI.
//
// Money is never named here: every amount is an integer number of centavos handled
// by the modules that use these constants.

// The lifecycle of a collector batch (S4-1, section 3.8).
//
//   open        → created, the collector has not started recording
//   in_progress → the collector is in the field recording collections
//   submitted   → the collector returned and declared the run finished
//   remitted    → the cash handed in has been recorded (one or more remittances)
//   reconciled  → the office confirmed the amounts against the ledger
//   closed      → the batch is finally signed off, after reconciliation
//   cancelled   → abandoned before any collection was recorded
//
// The normal path only moves forward: OPEN → IN_PROGRESS → SUBMITTED → REMITTED →
// RECONCILED → CLOSED, with `cancelled` reachable from an open run. Every other
// transition is a conflict, enforced in the service and exercised by the
// state-machine test.
export const COLLECTOR_BATCH_STATUSES = [
  "open",
  "in_progress",
  "submitted",
  "remitted",
  "reconciled",
  "closed",
  "cancelled",
] as const;
export type CollectorBatchStatus = (typeof COLLECTOR_BATCH_STATUSES)[number];

/** Human-readable batch status names, used in badges and filters. */
export const COLLECTOR_BATCH_STATUS_LABELS = {
  open: "Open",
  in_progress: "In Progress",
  submitted: "Submitted",
  remitted: "Remitted",
  reconciled: "Reconciled",
  closed: "Closed",
  cancelled: "Cancelled",
} as const satisfies Record<CollectorBatchStatus, string>;

/**
 * The single step a batch may move to next, or `null` when it is terminal.
 *
 * `cancelled` is deliberately not in the table: it is allowed only from `open` and
 * only when nothing has been collected, which the service checks separately. This
 * table is what the state-machine test walks.
 */
export const COLLECTOR_BATCH_NEXT_STATUS: Record<CollectorBatchStatus, CollectorBatchStatus | null> = {
  open: "in_progress",
  in_progress: "submitted",
  submitted: "remitted",
  remitted: "reconciled",
  reconciled: "closed",
  closed: null,
  cancelled: null,
};

/**
 * The legal transitions, as the state-machine test and the service both read them.
 *
 * `cancelled` is reachable from an open run only (and only while nothing has been
 * collected, which the service checks). Every pair not listed is illegal and is
 * rejected with a conflict.
 */
export const COLLECTOR_BATCH_TRANSITIONS: ReadonlyArray<
  readonly [CollectorBatchStatus, CollectorBatchStatus]
> = [
  ["open", "in_progress"],
  ["open", "submitted"],
  ["open", "cancelled"],
  ["in_progress", "submitted"],
  ["in_progress", "cancelled"],
  ["submitted", "remitted"],
  ["remitted", "reconciled"],
  ["reconciled", "closed"],
];

/** True when a batch may move from `from` to `to`. */
export function isAllowedCollectorBatchTransition(
  from: CollectorBatchStatus,
  to: CollectorBatchStatus
): boolean {
  return COLLECTOR_BATCH_TRANSITIONS.some(([start, end]) => start === from && end === to);
}

// What happened when the collector visited a subscriber.
export const COLLECTION_RESULTS = [
  "collected", // subscriber paid in full
  "partial", // subscriber paid only part of the balance
  "no_response", // nobody answered the door
  "refused", // subscriber declined to pay
  "promise", // subscriber promised to pay later
] as const;
export type CollectionResult = (typeof COLLECTION_RESULTS)[number];

/** Human-readable collection result names, used in tables and filters. */
export const COLLECTION_RESULT_LABELS = {
  collected: "Collected",
  partial: "Partial",
  no_response: "No Response",
  refused: "Refused",
  promise: "Promise to Pay",
} as const satisfies Record<CollectionResult, string>;

/** The results that represent money actually received in the field. */
export const MONEY_COLLECTION_RESULTS = ["collected", "partial"] as const;
export type MoneyCollectionResult = (typeof MONEY_COLLECTION_RESULTS)[number];

/** True when a result means the collector took money from the subscriber. */
export function isMoneyCollectionResult(result: CollectionResult): result is MoneyCollectionResult {
  return (MONEY_COLLECTION_RESULTS as readonly string[]).includes(result);
}

// How the field money was received. A subset of the payment methods: a collector
// never takes a check or a bank transfer at the door.
export const COLLECTED_METHODS = ["cash", "gcash"] as const;
export type CollectedMethod = (typeof COLLECTED_METHODS)[number];

/** Human-readable collection method names. */
export const COLLECTED_METHOD_LABELS = {
  cash: "Cash",
  gcash: "GCash",
} as const satisfies Record<CollectedMethod, string>;

/** The prefix of every collector batch number, e.g. "CB". */
export const COLLECTOR_BATCH_NUMBER_PREFIX = "CB";

/**
 * The YYYYMMDD segment of a batch number, taken straight from the collection date
 * (a calendar day, not an instant), so a batch created for a field date is numbered
 * after that date regardless of the machine's timezone.
 */
export function collectorBatchDateSegment(collectionDate: string): string {
  return collectionDate.slice(0, 10).replace(/-/g, "");
}

/** The prefix shared by every batch number for one collection date. */
export function collectorBatchNumberPrefix(collectionDate: string): string {
  return `${COLLECTOR_BATCH_NUMBER_PREFIX}-${collectorBatchDateSegment(collectionDate)}-`;
}

/** Builds a batch number from its parts: ("2025-01-24", 7) → "CB-20250124-0007". */
export function generateCollectorBatchNumber(
  collectionDate: string,
  sequenceNumber: number
): string {
  const sequenceSegment = String(sequenceNumber).padStart(4, "0");
  return `${collectorBatchNumberPrefix(collectionDate)}${sequenceSegment}`;
}

/**
 * Picks the next sequence number for a collection date from the batch numbers that
 * already exist. Numbers that do not match the expected prefix — or whose tail is
 * not a number — are ignored, so an imported or malformed number can never break
 * generation for the rest of the day.
 */
export function nextCollectorBatchSequenceNumber(
  existingBatchNumbers: readonly string[],
  collectionDate: string
): number {
  const prefix = collectorBatchNumberPrefix(collectionDate);
  let highestSequence = 0;

  for (const batchNumber of existingBatchNumbers) {
    if (!batchNumber.startsWith(prefix)) {
      continue;
    }

    const parsedSequence = Number.parseInt(batchNumber.slice(prefix.length), 10);

    if (Number.isInteger(parsedSequence) && parsedSequence > highestSequence) {
      highestSequence = parsedSequence;
    }
  }

  return highestSequence + 1;
}

// ─── Accounts Receivable aging ────────────────────────────────────────────────
//
// An aging bucket says how long an unpaid invoice has been past its due date.
// "current" invoices are not yet due; the rest count overdue days.
export const AR_AGING_BUCKETS = ["current", "1_to_30", "31_to_60", "61_to_90", "over_90"] as const;
export type AgingBucket = (typeof AR_AGING_BUCKETS)[number];

/** Human-readable bucket names, used as column headers in the aging report. */
export const AR_AGING_BUCKET_LABELS = {
  current: "Current",
  "1_to_30": "1–30 Days",
  "31_to_60": "31–60 Days",
  "61_to_90": "61–90 Days",
  over_90: "90+ Days",
} as const satisfies Record<AgingBucket, string>;

/**
 * Assigns an invoice to an aging bucket from how many whole days it is past due.
 *
 * Day counts are inclusive of the first overdue day: an invoice due yesterday is in
 * "1_to_30", and one due exactly 30 days ago is still in "1_to_30" while 31 days is
 * "31_to_60". A due date today or in the future is "current".
 */
export function classifyInvoiceAge(dueDate: Date, asOfDate: Date): AgingBucket {
  const daysOverdue = Math.floor(
    (asOfDate.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24)
  );

  if (daysOverdue <= 0) {
    return "current";
  }
  if (daysOverdue <= 30) {
    return "1_to_30";
  }
  if (daysOverdue <= 60) {
    return "31_to_60";
  }
  if (daysOverdue <= 90) {
    return "61_to_90";
  }
  return "over_90";
}