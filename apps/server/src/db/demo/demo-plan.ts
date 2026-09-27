// The demo dataset plan: a pure, deterministic description of everything the
// generator is going to do.
//
// Nothing here touches a database. `buildDemoDatasetPlan` turns a seed into the
// complete script — the users, areas, plans, subscribers and service accounts, and
// then the ordered list of domain-service calls that produce the financial history.
// The apply step (`demo-dataset.ts`) only executes that script.
//
// Splitting the two is what makes S9-2 provable rather than asserted: the same seed
// builds a byte-identical plan, and the plan is where every amount and every count
// is decided. `Math.random()` is never called (see `prng.ts`).

import {
  type CollectionResult,
  type PaymentMethod,
  type ServiceType,
  type SystemRole,
  type UserRole,
} from "@bcis/shared";

import { formatDateOnly } from "../../shared/date";
import { createSeededRandom } from "./prng";
import {
  DEMO_AREAS,
  DEMO_COLLECTOR_USERNAMES,
  DEMO_FIRST_NAMES,
  DEMO_LAST_NAMES,
  DEMO_MARKER,
  DEMO_MIDDLE_NAMES,
  DEMO_PLANS,
  DEMO_PLAN_INDEXES_BY_SERVICE_TYPE,
  DEMO_USERS,
  demoGcashReference,
  demoPhoneNumber,
  demoServiceAddress,
  type DemoAreaDefinition,
  type DemoPlanDefinition,
  type DemoUserDefinition,
} from "./synthetic-catalog";

/** The seed used when the operator does not choose one. */
export const DEFAULT_DEMO_SEED = 20250115;

/** Section 8 asks for 50 subscribers. */
export const DEMO_SUBSCRIBER_COUNT = 50;

/** The first N subscribers hold two services, taking the service-account total past 60. */
export const DEMO_SUBSCRIBERS_WITH_SECOND_ACCOUNT = 12;

/** How many months of billing history to generate, newest last. */
export const DEMO_BILLING_MONTHS = 5;

/** The three service types cycle in this order, so all three are always present. */
const SERVICE_TYPE_CYCLE: readonly ServiceType[] = ["internet", "cable_tv", "bundle"];

/**
 * What happens to one service account's money.
 *
 * The cycle is a fixed list rather than a random draw, so every seed produces the
 * full spread the specification asks for: an exact payment, a partial payment, a
 * verified GCash payment, an advance credit, unpaid accounts, a pending GCash
 * claim and a mixed cash-then-GCash account.
 */
export const DEMO_ACCOUNT_SCENARIOS = [
  "paid_up_cash",
  "partial_cash",
  "gcash_verified",
  "advance_credit",
  "unpaid",
  "delinquent",
  "gcash_pending",
  "cash_partial_then_gcash",
] as const;

export type DemoAccountScenario = (typeof DEMO_ACCOUNT_SCENARIOS)[number];

export interface DemoBillingPeriod {
  year: number;
  month: number;
}

export interface DemoSubscriberPlan {
  index: number;
  firstName: string;
  lastName: string;
  middleName: string;
  primaryPhone: string;
  secondaryPhone: string;
  serviceAddress: string;
  serviceBarangay: string;
  serviceMunicipality: string;
  serviceProvince: string;
  internalNotes: string;
  areaIndex: number;
}

export interface DemoServiceAccountPlan {
  subscriberIndex: number;
  planIndex: number;
  serviceType: ServiceType;
  activationDate: string;
  assignedCollectorIndex: number | null;
  areaIndex: number;
  scenario: DemoAccountScenario;
}

// ─── Steps ────────────────────────────────────────────────────────────────────
//
// A step is a domain call with every argument already decided. Amounts that can
// only be known once earlier steps have run are expressed relatively
// (`outstanding`, `half_outstanding`, …) and resolved from the real database at
// apply time, so the plan can never disagree with the ledger.

export type DemoPaymentAmount =
  | "outstanding"
  | "half_outstanding"
  | "outstanding_plus_one_month";

export type GcashDisposition = "verified" | "pending" | "rejected";

export interface DemoBatchStop {
  accountIndex: number;
  result: CollectionResult;
  /** For `collected`/`partial`: how much of the outstanding balance was taken. */
  fractionOfOutstanding?: number;
  gcashReference?: string;
}

export type DemoStep =
  | { kind: "run_monthly_billing"; year: number; month: number }
  | { kind: "post_issued_invoices"; year: number; month: number }
  | {
      kind: "post_payment";
      accountIndex: number;
      method: PaymentMethod;
      amount: DemoPaymentAmount;
      label: string;
    }
  | {
      kind: "record_gcash";
      accountIndex: number;
      disposition: GcashDisposition;
      reference: string;
    }
  | { kind: "reverse_payment"; accountIndex: number; reason: string }
  | {
      kind: "suspend_and_reconnect";
      accountIndex: number;
      suspendReason: string;
      reconnectReason: string;
      requestDate: string;
      completionDate: string;
      useTechnician: boolean;
    }
  | {
      kind: "collector_batch";
      collectorIndex: number;
      collectionDate: string;
      through: "closed" | "remitted";
      stops: DemoBatchStop[];
    };

export interface DemoDatasetPlan {
  seed: number;
  referenceDate: string;
  billingPeriods: DemoBillingPeriod[];
  users: DemoUserDefinition[];
  areas: DemoAreaDefinition[];
  plans: DemoPlanDefinition[];
  subscribers: DemoSubscriberPlan[];
  accounts: DemoServiceAccountPlan[];
  steps: DemoStep[];
}

export interface DemoDatasetOptions {
  seed?: number;
  /** The day the dataset is anchored to, as YYYY-MM-DD. Defaults to today. */
  referenceDate?: string;
}

/** Moves a calendar month by `offset` months, wrapping the year correctly. */
export function shiftMonth(
  year: number,
  month: number,
  offset: number
): DemoBillingPeriod {
  const zeroBased = month - 1 + offset;
  const shiftedYear = year + Math.floor(zeroBased / 12);
  const shiftedMonth = ((zeroBased % 12) + 12) % 12 + 1;
  return { year: shiftedYear, month: shiftedMonth };
}

/** Splits "YYYY-MM-DD" into its numeric year and month without a timezone conversion. */
function splitYearMonth(referenceDate: string): { year: number; month: number } {
  return {
    year: Number.parseInt(referenceDate.slice(0, 4), 10),
    month: Number.parseInt(referenceDate.slice(5, 7), 10),
  };
}

/** How many service accounts a subscriber holds: the first twelve hold two. */
function accountCountForSubscriber(subscriberIndex: number): number {
  return subscriberIndex < DEMO_SUBSCRIBERS_WITH_SECOND_ACCOUNT ? 2 : 1;
}

/** Builds the whole plan for a seed. The same seed always builds the same plan. */
export function buildDemoDatasetPlan(options: DemoDatasetOptions = {}): DemoDatasetPlan {
  const seed = options.seed ?? DEFAULT_DEMO_SEED;
  const referenceDate = options.referenceDate ?? formatDateOnly(new Date());
  const random = createSeededRandom(seed);

  const { year, month } = splitYearMonth(referenceDate);

  // Offsets are oldest first, so the first period billed is the oldest month.
  const billingPeriods: DemoBillingPeriod[] = [];
  for (let offset = DEMO_BILLING_MONTHS - 1; offset >= 0; offset -= 1) {
    billingPeriods.push(shiftMonth(year, month, -offset));
  }

  const oldestPeriod = billingPeriods[0] as DemoBillingPeriod;
  const activationDate = `${oldestPeriod.year}-${String(oldestPeriod.month).padStart(2, "0")}-01`;

  const subscribers: DemoSubscriberPlan[] = [];
  for (let index = 0; index < DEMO_SUBSCRIBER_COUNT; index += 1) {
    const areaIndex = index % DEMO_AREAS.length;
    const barangay = `Barangay Sample-${(index % 6) + 1}`;

    subscribers.push({
      index,
      firstName: random.pick(DEMO_FIRST_NAMES),
      lastName: random.pick(DEMO_LAST_NAMES),
      middleName: random.pick(DEMO_MIDDLE_NAMES),
      primaryPhone: demoPhoneNumber(index),
      secondaryPhone: demoPhoneNumber(index + 5000),
      serviceAddress: demoServiceAddress(index),
      serviceBarangay: barangay,
      serviceMunicipality: "Synthetic City",
      serviceProvince: "Demo Province",
      internalNotes: `${DEMO_MARKER} — synthetic subscriber ${index + 1} of ${DEMO_SUBSCRIBER_COUNT} (seed ${seed}). Not a real person.`,
      areaIndex,
    });
  }

  const accounts: DemoServiceAccountPlan[] = [];
  for (const subscriber of subscribers) {
    const accountCount = accountCountForSubscriber(subscriber.index);

    for (let position = 0; position < accountCount; position += 1) {
      const accountIndex = accounts.length;
      const serviceType = SERVICE_TYPE_CYCLE[accountIndex % SERVICE_TYPE_CYCLE.length] as ServiceType;
      const planIndex = random.pick(DEMO_PLAN_INDEXES_BY_SERVICE_TYPE[serviceType]);
      const scenario = DEMO_ACCOUNT_SCENARIOS[
        accountIndex % DEMO_ACCOUNT_SCENARIOS.length
      ] as DemoAccountScenario;

      accounts.push({
        subscriberIndex: subscriber.index,
        planIndex,
        serviceType,
        activationDate,
        assignedCollectorIndex: accountIndex % DEMO_COLLECTOR_USERNAMES.length,
        areaIndex: subscriber.areaIndex,
        scenario,
      });
    }
  }

  return {
    seed,
    referenceDate,
    billingPeriods,
    users: [...DEMO_USERS],
    areas: [...DEMO_AREAS],
    plans: [...DEMO_PLANS],
    subscribers,
    accounts,
    steps: buildSteps(accounts, billingPeriods, referenceDate),
  };
}

/** The account indexes that never pay, in plan order. */
function unpaidAccountIndexes(accounts: readonly DemoServiceAccountPlan[]): number[] {
  const indexes: number[] = [];
  for (const [index, account] of accounts.entries()) {
    if (account.scenario === "unpaid" || account.scenario === "delinquent") {
      indexes.push(index);
    }
  }
  return indexes;
}

/** The ordered script of domain calls that produces the financial history. */
function buildSteps(
  accounts: readonly DemoServiceAccountPlan[],
  billingPeriods: readonly DemoBillingPeriod[],
  referenceDate: string
): DemoStep[] {
  const steps: DemoStep[] = [];

  const priorPeriods = billingPeriods.slice(0, -1);
  const currentPeriod = billingPeriods[billingPeriods.length - 1] as DemoBillingPeriod;

  // 1. Bill and post the older months first.
  for (const period of priorPeriods) {
    steps.push({ kind: "run_monthly_billing", year: period.year, month: period.month });
    steps.push({ kind: "post_issued_invoices", year: period.year, month: period.month });
  }

  // 2. Advance payments happen BEFORE the newest month is billed, so the credit
  //    they create is consumed by that month's invoice — which is what makes the
  //    invoice settle as CREDITED rather than leaving an unused credit behind.
  for (const [index, account] of accounts.entries()) {
    if (account.scenario === "advance_credit") {
      steps.push({
        kind: "post_payment",
        accountIndex: index,
        method: "cash",
        amount: "outstanding_plus_one_month",
        label: "advance payment covering the next month",
      });
    }
  }

  // 3. Bill and post the newest month.
  steps.push({
    kind: "run_monthly_billing",
    year: currentPeriod.year,
    month: currentPeriod.month,
  });
  steps.push({
    kind: "post_issued_invoices",
    year: currentPeriod.year,
    month: currentPeriod.month,
  });

  // 4. Settle the accounts according to their scenario.
  let gcashSequence = 0;
  for (const [index, account] of accounts.entries()) {
    switch (account.scenario) {
      case "paid_up_cash":
        steps.push({
          kind: "post_payment",
          accountIndex: index,
          method: "cash",
          amount: "outstanding",
          label: "counter payment in full",
        });
        break;
      case "partial_cash":
        steps.push({
          kind: "post_payment",
          accountIndex: index,
          method: "cash",
          amount: "half_outstanding",
          label: "counter payment, partial",
        });
        break;
      case "gcash_verified":
        gcashSequence += 1;
        steps.push({
          kind: "record_gcash",
          accountIndex: index,
          disposition: "verified",
          reference: demoGcashReference("STORE", gcashSequence),
        });
        break;
      case "gcash_pending":
        gcashSequence += 1;
        steps.push({
          kind: "record_gcash",
          accountIndex: index,
          disposition: "pending",
          reference: demoGcashReference("PENDING", gcashSequence),
        });
        break;
      case "cash_partial_then_gcash":
        steps.push({
          kind: "post_payment",
          accountIndex: index,
          method: "cash",
          amount: "half_outstanding",
          label: "counter payment, first half",
        });
        gcashSequence += 1;
        steps.push({
          kind: "record_gcash",
          accountIndex: index,
          disposition: "verified",
          reference: demoGcashReference("SPLIT", gcashSequence),
        });
        break;
      // `advance_credit` was settled in step 2; the three remaining scenarios are
      // the ones that intentionally keep a balance.
      default:
        break;
    }
  }

  // 5. One rejected GCash claim, so the rejection workflow has a record too. It is
  //    aimed at an account that already owes money, and rejecting it moves nothing.
  const unpaidIndexes = unpaidAccountIndexes(accounts);
  const rejectedGcashAccount = unpaidIndexes[unpaidIndexes.length - 1];
  if (rejectedGcashAccount !== undefined) {
    steps.push({
      kind: "record_gcash",
      accountIndex: rejectedGcashAccount,
      disposition: "rejected",
      reference: demoGcashReference("REJECTED", 1),
    });
  }

  // 6. One approved reversal: a counter payment was posted against the wrong
  //    account and is corrected with a reversal, never an edit.
  steps.push({
    kind: "reverse_payment",
    accountIndex: 0,
    reason: "Demo correction: payment posted to the wrong service account",
  });

  // 7. Two suspension and reconnection scenarios, taken from the accounts that are
  //    still unpaid. Both are suspended and then reconnected, charging the fee.
  const suspensionAccountIndexes = unpaidIndexes.slice(-2);
  for (const [position, accountIndex] of suspensionAccountIndexes.entries()) {
    steps.push({
      kind: "suspend_and_reconnect",
      accountIndex,
      suspendReason:
        "Demo suspension: account is past the configured suspension threshold",
      reconnectReason: "Demo reconnection: subscriber settled the arrangement",
      requestDate: referenceDate,
      completionDate: referenceDate,
      useTechnician: position === 0,
    });
  }

  // 8. Two field-collection batches: one taken all the way to CLOSED, one left
  //    REMITTED so both ends of the lifecycle are visible.
  const batchOneAccounts = unpaidIndexes.slice(0, 6);
  const batchTwoAccounts = unpaidIndexes.slice(6, 10);

  if (batchOneAccounts.length === 6) {
    steps.push({
      kind: "collector_batch",
      collectorIndex: 0,
      collectionDate: referenceDate,
      through: "closed",
      stops: [
        { accountIndex: batchOneAccounts[0] as number, result: "collected" },
        { accountIndex: batchOneAccounts[1] as number, result: "collected" },
        { accountIndex: batchOneAccounts[2] as number, result: "collected" },
        {
          accountIndex: batchOneAccounts[3] as number,
          result: "partial",
          fractionOfOutstanding: 60,
        },
        {
          accountIndex: batchOneAccounts[4] as number,
          result: "collected",
          gcashReference: demoGcashReference("BATCH1", 1),
        },
        { accountIndex: batchOneAccounts[5] as number, result: "refused" },
      ],
    });
  }

  if (batchTwoAccounts.length === 4) {
    steps.push({
      kind: "collector_batch",
      collectorIndex: 1,
      collectionDate: referenceDate,
      through: "remitted",
      stops: [
        { accountIndex: batchTwoAccounts[0] as number, result: "collected" },
        { accountIndex: batchTwoAccounts[1] as number, result: "collected" },
        { accountIndex: batchTwoAccounts[2] as number, result: "collected" },
        { accountIndex: batchTwoAccounts[3] as number, result: "no_response" },
      ],
    });
  }

  return steps;
}

/** The role grants a demo user should end up with, as a sorted list of codes. */
export function sortedSystemRoles(roles: readonly SystemRole[]): SystemRole[] {
  return [...roles].sort();
}

/** The legacy enum role a demo user is created through. */
export function legacyRoleOf(user: DemoUserDefinition): UserRole {
  return user.legacyRole;
}
