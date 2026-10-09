// Applies a demo-dataset plan to the database.
//
// The point of this module is that it builds a demo dataset by DRIVING THE REAL
// DOMAIN SERVICES — monthly billing, payment posting, GCash verification and
// rejection, payment reversal, suspension and reconnection, and the collector
// batch lifecycle. Nothing financial is inserted directly. Because every amount
// moves through the same code the application uses, the ledger, the invoice
// states, the receipt numbers, the allocations and the AR aging are consistent by
// construction: a demo dataset built with raw INSERTs could easily contradict the
// ledger, which would undermine exactly the financial correctness the activity
// grades.
//
// The only direct writes are reference data that has no service of its own:
// collection areas (there is no areas service), the subscriber / service-account
// collection-area assignment (`area_id` has no writer anywhere in the application
// yet) and the explicit RBAC grant for the roles the legacy `users.role` enum
// cannot express. Each is marked below.
//
// This module never deletes anything.

import { and, desc, eq, inArray, like, sql } from "drizzle-orm";

import { OUTSTANDING_INVOICE_STATUSES, type PaymentMethod, type SystemRole } from "@bcis/shared";
import { config } from "../../config";
import { db } from "../connection";
import type { DbExecutor } from "../connection";
import { collectionAreas } from "../schema/areas";
import { invoices } from "../schema/billing";
import { collectorBatches } from "../schema/collections";
import { DEBIT_ENTRY_TYPES, ledgerEntries } from "../schema/ledger";
import { gcashPayments, paymentAllocations, payments } from "../schema/payments";
import { roles, userRoles } from "../schema/rbac";
import { reconnectionRecords, suspensionRecords } from "../schema/service-control";
import { serviceAccounts, subscribers, subscriptionPlans } from "../schema/subscribers";
import { users } from "../schema/users";
import { createPlan } from "../../modules/plans/plans.service";
import { createUser } from "../../modules/users/users.service";
import { createSubscriber } from "../../modules/subscribers/subscribers.service";
import { insertServiceAccount } from "../../modules/service-accounts/service-accounts.service";
import {
  createReconnectionFeeInvoice,
  postInvoiceForId,
} from "../../modules/billing/invoices.service";
import {
  postAllDraftInvoices,
  runMonthlyBilling,
} from "../../modules/billing/monthly-billing.service";
import { postPayment } from "../../modules/payments/post-payment.service";
import {
  rejectGcashPayment,
  verifyGcashPayment,
} from "../../modules/payments/verify-gcash-payment.service";
import { reversePayment } from "../../modules/payments/reverse-payment.service";
import {
  closeBatch,
  createCollectorBatch,
  recordBatchRemittance,
  reconcileBatch,
  recordCollection,
  submitBatch,
  type BatchActor,
} from "../../modules/collections/collector-batches.service";
import {
  reconnectServiceAccount,
  recordReconnection,
  suspendServiceAccount,
} from "../../modules/service-accounts/service-accounts.service";
import { seedDatabase } from "../seed";
import {
  buildDemoDatasetPlan,
  type DemoDatasetOptions,
  type DemoDatasetPlan,
  type DemoStep,
} from "./demo-plan";
import { DEMO_MARKER, DEMO_USERNAME_PREFIX, demoPhoneNumber } from "./synthetic-catalog";

/** The target database already holds data the generator refuses to add to. */
export class DemoDatasetConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DemoDatasetConflictError";
  }
}

/** The in-memory ids the script needs after the reference data exists. */
interface DemoReferenceData {
  actorUserId: string;
  ownerId: string;
  cashierId: string;
  /** The username each id was created under, so the demo can name its audit actors (D4). */
  cashierUsername: string;
  ownerUsername: string;
  technicianId: string;
  collectorIds: string[];
  collectorUsernames: string[];
  planIds: string[];
  subscriberIds: string[];
  serviceAccountIds: string[];
  /** The monthly rate of each account, by account index, for advance payments. */
  monthlyRateCentavosByAccountIndex: number[];
}

export interface DemoDatasetCounts {
  users: number;
  areas: number;
  plans: number;
  internetPlans: number;
  cablePlans: number;
  comboPlans: number;
  subscribers: number;
  serviceAccounts: number;
  internetAccounts: number;
  cableAccounts: number;
  comboAccounts: number;
  collectors: number;
  billingMonths: number;
  invoices: number;
  payments: number;
  cashPayments: number;
  gcashPayments: number;
  verifiedGcashPayments: number;
  pendingGcashPayments: number;
  rejectedGcashPayments: number;
  reversedPayments: number;
  partialPayments: number;
  advanceCreditPayments: number;
  overdueAccounts: number;
  suspensionRecords: number;
  reconnectionRecords: number;
  collectorBatches: number;
}

export interface DemoDatasetTotals {
  invoicedCentavos: number;
  collectedCentavos: number;
  outstandingCentavos: number;
  ledgerNetCentavos: number;
}

export interface DemoDatasetSummary {
  seed: number;
  referenceDate: string;
  administratorCreated: boolean;
  counts: DemoDatasetCounts;
  totals: DemoDatasetTotals;
}

export interface GenerateDemoDatasetOptions extends DemoDatasetOptions {
  /** Proceed even when the database already holds non-demo subscribers. */
  confirmed?: boolean;
}

/**
 * Refuses a target database that is not safe to seed.
 *
 * Two rules, both fail-closed:
 *   • a database that already holds a demo dataset is refused outright, because a
 *     second run would duplicate subscribers and make the counts meaningless;
 *   • a database that holds any subscriber which is NOT demo data is refused
 *     unless the caller explicitly confirms — so nobody pollutes (or is tempted to
 *     wipe) a real office database by accident.
 */
export async function assertDemoTargetIsSafe(confirmed: boolean): Promise<void> {
  const [demoCount] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(subscribers)
    .where(like(subscribers.internalNotes, `${DEMO_MARKER}%`));

  const demoSubscriberCount = demoCount?.value ?? 0;

  if (demoSubscriberCount > 0) {
    throw new DemoDatasetConflictError(
      `This database already holds a demo dataset (${demoSubscriberCount} demo subscribers). ` +
        "Refusing to seed a second one. Remove the demo data (or use a fresh database) and run again."
    );
  }

  const [totalCount] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(subscribers);

  const nonDemoSubscriberCount = (totalCount?.value ?? 0) - demoSubscriberCount;

  if (nonDemoSubscriberCount > 0 && !confirmed) {
    throw new DemoDatasetConflictError(
      `This database holds ${nonDemoSubscriberCount} subscriber(s) that are not demo data. ` +
        "Re-run with --confirm if you really want to add the synthetic demo dataset here."
    );
  }
}

/** Builds and applies a full demo dataset, then reports what was written. */
export async function generateDemoDataset(
  options: GenerateDemoDatasetOptions = {}
): Promise<DemoDatasetSummary> {
  const plan = buildDemoDatasetPlan(options);

  // Check before writing anything at all.
  await assertDemoTargetIsSafe(options.confirmed === true);

  // The production bootstrap supplies the system settings and one Administrator,
  // which is the actor every other row is created through.
  const bootstrap = await seedDatabase();

  const referenceData = await createReferenceData(plan);
  await runFinancialScript(plan, referenceData);

  const { counts, totals } = await summarizeDemoDataset();

  return {
    seed: plan.seed,
    referenceDate: plan.referenceDate,
    administratorCreated: bootstrap.administratorCreated,
    counts,
    totals,
  };
}

/** Creates the users, areas, plans, subscribers and service accounts. */
async function createReferenceData(plan: DemoDatasetPlan): Promise<DemoReferenceData> {
  const actorUserId = await requireActorUserId();

  // ── System roles ────────────────────────────────────────────────────────────
  // The seven roles are seeded by migration 0009. Loading them here means a
  // missing role is a loud error rather than a user that silently resolves to no
  // permissions.
  const roleRows = await db.select({ id: roles.id, code: roles.code }).from(roles);
  const roleIdByCode = new Map(roleRows.map((row) => [row.code, row.id]));

  // ── Users ───────────────────────────────────────────────────────────────────
  const userIdByUsername = new Map<string, string>();
  for (const userDefinition of plan.users) {
    // The account, its mapped legacy-role grant, and the exact system-role set
    // commit in ONE transaction per user. A concurrent reader therefore sees
    // either the previous grants or the final ones, never the gap between the
    // `user_roles` DELETE and the INSERTs that caused a flaky zero-grant read.
    const created = await db.transaction(async (tx) => {
      const user = await createUser(
        {
          fullName: userDefinition.fullName,
          username: userDefinition.username,
          password: config.SEED_DEMO_PASSWORD,
          role: userDefinition.legacyRole,
          createdBy: actorUserId,
        },
        tx
      );

      await replaceSystemRoles(tx, user.id, userDefinition.systemRoles, roleIdByCode, actorUserId);
      return user;
    });

    userIdByUsername.set(userDefinition.username, created.id);
  }

  const ownerUsername = `${DEMO_USERNAME_PREFIX}owner`;
  const cashierUsername = `${DEMO_USERNAME_PREFIX}cashier`;
  const ownerId = requireUserId(userIdByUsername, ownerUsername);
  const cashierId = requireUserId(userIdByUsername, cashierUsername);
  const technicianId = requireUserId(userIdByUsername, `${DEMO_USERNAME_PREFIX}technician`);
  const collectorUsers = plan.users.filter((user) => user.legacyRole === "collector");
  const collectorIds = collectorUsers.map((user) => requireUserId(userIdByUsername, user.username));
  const collectorUsernames = collectorUsers.map((user) => user.username);

  // ── Collection areas ────────────────────────────────────────────────────────
  // DIRECT WRITE: there is no areas service in the application yet (S1-5 shipped
  // the table and its readers, not a writer), so the demo creates the routes
  // directly. This is reference data with no financial consequence.
  // The three area rows commit together so a reader never sees a partial route
  // set (e.g. two of the three areas) while the demo is being generated.
  const areaIds = await db.transaction((tx) => insertDemoAreas(plan, ownerId, tx));

  // ── Plans ───────────────────────────────────────────────────────────────────
  const planIds: string[] = [];
  for (const planDefinition of plan.plans) {
    const created = await createPlan({
      name: planDefinition.name,
      serviceType: planDefinition.serviceType,
      speedMbps: planDefinition.speedMbps ?? undefined,
      cablePackageDescription: planDefinition.cablePackageDescription ?? undefined,
      monthlyRateCentavos: planDefinition.monthlyRateCentavos,
      reconnectionFeeCentavos: planDefinition.reconnectionFeeCentavos,
      createdBy: ownerId,
    });
    planIds.push(created.id);
  }

  // ── Subscribers ────────────────────────────────────────────────────────────
  const subscriberIds: string[] = [];
  for (const subscriberPlan of plan.subscribers) {
    // The subscriber and its area assignment commit together, so a reader never
    // sees the household before it is placed on a route (area_id null window).
    const created = await db.transaction(async (tx) => {
      const subscriber = await createSubscriber(
        {
          subscriber: {
            firstName: subscriberPlan.firstName,
            lastName: subscriberPlan.lastName,
            middleName: subscriberPlan.middleName,
            primaryPhone: subscriberPlan.primaryPhone,
            secondaryPhone: subscriberPlan.secondaryPhone,
            serviceAddress: subscriberPlan.serviceAddress,
            serviceBarangay: subscriberPlan.serviceBarangay,
            serviceMunicipality: subscriberPlan.serviceMunicipality,
            serviceProvince: subscriberPlan.serviceProvince,
            internalNotes: subscriberPlan.internalNotes,
          },
          createdBy: ownerId,
        },
        tx
      );

      // DIRECT WRITE: `subscribers.area_id` has no writer in the application yet,
      // so the demo sets it directly. It is an assignment, not a financial row.
      await tx
        .update(subscribers)
        .set({ areaId: areaIds[subscriberPlan.areaIndex] ?? null })
        .where(eq(subscribers.id, subscriber.id));

      return subscriber;
    });

    subscriberIds.push(created.id);
  }

  // ── Service accounts ────────────────────────────────────────────────────────
  const serviceAccountIds: string[] = [];
  const monthlyRateCentavosByAccountIndex: number[] = [];

  for (const accountPlan of plan.accounts) {
    const subscriberId = requireIndex(subscriberIds, accountPlan.subscriberIndex, "subscriber");
    const planId = requireIndex(planIds, accountPlan.planIndex, "plan");

    // The account and its area assignment commit together, matching the
    // subscriber above so a reader never sees an unplaced account.
    const account = await db.transaction(async (tx) => {
      const created = await insertServiceAccount(
        subscriberId,
        {
          planId,
          activationDate: accountPlan.activationDate,
          assignedCollectorId:
            accountPlan.assignedCollectorIndex === null
              ? undefined
              : requireIndex(collectorIds, accountPlan.assignedCollectorIndex, "collector"),
        },
        ownerId,
        tx
      );

      // DIRECT WRITE: `service_accounts.area_id` has no writer in the application
      // yet; see the note on the subscriber above.
      await tx
        .update(serviceAccounts)
        .set({ areaId: areaIds[accountPlan.areaIndex] ?? null })
        .where(eq(serviceAccounts.id, created.id));

      return created;
    });

    serviceAccountIds.push(account.id);
    monthlyRateCentavosByAccountIndex.push(account.monthlyRateCentavos);
  }

  return {
    actorUserId,
    ownerId,
    ownerUsername,
    cashierId,
    cashierUsername,
    technicianId,
    collectorIds,
    collectorUsernames,
    planIds,
    subscriberIds,
    serviceAccountIds,
    monthlyRateCentavosByAccountIndex,
  };
}

/** Inserts the three demo collection areas and returns their ids, in plan order. */
async function insertDemoAreas(
  plan: DemoDatasetPlan,
  createdBy: string,
  executor: DbExecutor = db
): Promise<string[]> {
  const ids: string[] = [];
  for (const area of plan.areas) {
    const inserted = await executor
      .insert(collectionAreas)
      .values({
        code: area.code,
        name: area.name,
        description: area.description,
        createdBy,
      })
      .returning({ id: collectionAreas.id })
      .then((rows) => rows[0]);

    if (inserted === undefined) {
      throw new Error(`Demo area ${area.code} could not be created`);
    }
    ids.push(inserted.id);
  }
  return ids;
}

/**
 * DIRECT WRITE: replaces a demo user's `user_roles` rows with the exact set its
 * definition asks for.
 *
 * `createUser` can only grant the role the legacy `users.role` enum maps onto
 * (admin→administrator, manager→read_only_viewer, …), which cannot express Owner,
 * Accounting/Auditor or Technician. The RBAC tables are still the authority, so
 * the grant is corrected here rather than by inventing a legacy enum value.
 */
async function replaceSystemRoles(
  executor: DbExecutor,
  userId: string,
  systemRoles: readonly SystemRole[],
  roleIdByCode: ReadonlyMap<string, string>,
  assignedBy: string
): Promise<void> {
  // The DELETE and the re-INSERTs run on the caller's executor, so together they
  // are one atomic unit: a concurrent reader sees the previous grant set or the
  // final one, never an empty `user_roles` between the two statements.
  await executor.delete(userRoles).where(eq(userRoles.userId, userId));

  for (const roleCode of systemRoles) {
    const roleId = roleIdByCode.get(roleCode);
    if (roleId === undefined) {
      throw new Error(
        `System role "${roleCode}" is not seeded. Apply the RBAC migration before seeding the demo dataset.`
      );
    }
    await executor.insert(userRoles).values({ userId, roleId, assignedBy });
  }
}

/** The seeded Administrator every demo row is created through. */
async function requireActorUserId(): Promise<string> {
  const administrator = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, config.SEED_ADMIN_USERNAME))
    .limit(1)
    .then((rows) => rows[0]);

  if (administrator === undefined) {
    throw new Error(
      `The bootstrap administrator "${config.SEED_ADMIN_USERNAME}" is missing; the demo generator needs an acting user.`
    );
  }
  return administrator.id;
}

// ─── The financial script ─────────────────────────────────────────────────────

/** Runs every planned domain-service call, in order. */
async function runFinancialScript(
  plan: DemoDatasetPlan,
  reference: DemoReferenceData
): Promise<void> {
  for (const step of plan.steps) {
    await runStep(step, plan, reference);
  }
}

async function runStep(
  step: DemoStep,
  plan: DemoDatasetPlan,
  reference: DemoReferenceData
): Promise<void> {
  switch (step.kind) {
    case "run_monthly_billing":
      await runMonthlyBilling(step.year, step.month, reference.actorUserId);
      return;

    case "post_issued_invoices":
      await postAllDraftInvoices(step.year, step.month, reference.actorUserId);
      return;

    case "post_payment": {
      const serviceAccountId = accountIdAt(reference, step.accountIndex);
      const amountCentavos = await resolvePaymentAmount(reference, step.accountIndex, step.amount);

      if (amountCentavos <= 0) {
        return; // nothing outstanding — nothing to pay
      }

      await postPayment({
        serviceAccountId,
        paymentMethod: step.method,
        amountCentavos,
        paymentDate: plan.referenceDate,
        notes: `Demo dataset — ${step.label}`,
        postedByUserId: reference.cashierId,
        actor: { userId: reference.cashierId, username: reference.cashierUsername },
      });
      return;
    }

    case "record_gcash": {
      const serviceAccountId = accountIdAt(reference, step.accountIndex);
      const outstandingCentavos = await loadOutstandingCentavos(serviceAccountId);
      // A rejected claim never moves money, so any positive amount is realistic;
      // using the outstanding balance keeps the claim looking like a real one.
      const amountCentavos = Math.max(1, outstandingCentavos);

      const recorded = await postPayment({
        serviceAccountId,
        paymentMethod: "gcash",
        amountCentavos,
        paymentDate: plan.referenceDate,
        notes: "Demo dataset — GCash claim",
        postedByUserId: reference.cashierId,
        actor: { userId: reference.cashierId, username: reference.cashierUsername },
        gcash: {
          referenceNumber: step.reference,
          senderName: "Demo GCash Sender",
          senderGcashNumber: demoPhoneNumber(1),
        },
      });

      if (step.disposition === "verified") {
        await verifyGcashPayment({
          paymentId: recorded.payment.id,
          verifiedByUserId: reference.cashierId,
          actor: { userId: reference.cashierId, username: reference.cashierUsername },
        });
      } else if (step.disposition === "rejected") {
        await rejectGcashPayment({
          paymentId: recorded.payment.id,
          reason: "Demo rejection: the deposited amount did not match the claim",
          rejectedByUserId: reference.cashierId,
          actor: { userId: reference.cashierId, username: reference.cashierUsername },
        });
      }
      return;
    }

    case "reverse_payment": {
      const serviceAccountId = accountIdAt(reference, step.accountIndex);
      const postedPayment = await db
        .select({ id: payments.id })
        .from(payments)
        .where(and(eq(payments.serviceAccountId, serviceAccountId), eq(payments.status, "posted")))
        .orderBy(desc(payments.postedAt))
        .limit(1)
        .then((rows) => rows[0]);

      if (postedPayment === undefined) {
        return; // nothing posted to reverse
      }

      await reversePayment(postedPayment.id, step.reason, reference.ownerId, {
        userId: reference.ownerId,
        username: reference.ownerUsername,
      });
      return;
    }

    case "suspend_and_reconnect": {
      const serviceAccountId = accountIdAt(reference, step.accountIndex);
      const technicianId = step.useTechnician ? reference.technicianId : undefined;

      await suspendServiceAccount(serviceAccountId, step.suspendReason, reference.ownerId, {
        technicianId,
        effectiveDate: plan.referenceDate,
        requestDate: step.requestDate,
        completionDate: step.completionDate,
        notes: "Demo suspension",
      });

      await reconnectServiceAccount(serviceAccountId, step.reconnectReason, reference.ownerId);

      const feeInvoice = await createReconnectionFeeInvoice(
        serviceAccountId,
        step.reconnectReason,
        reference.ownerId
      );
      await postInvoiceForId(feeInvoice.invoice.id, reference.ownerId);

      await recordReconnection(
        serviceAccountId,
        step.reconnectReason,
        feeInvoice.amountCentavos,
        reference.ownerId,
        {
          technicianId,
          effectiveDate: plan.referenceDate,
          requestDate: step.requestDate,
          completionDate: step.completionDate,
          invoiceId: feeInvoice.invoice.id,
          notes: "Demo reconnection",
        }
      );
      return;
    }

    case "collector_batch": {
      const collectorId = requireIndex(reference.collectorIds, step.collectorIndex, "collector");
      const collectorUsername = requireIndex(
        reference.collectorUsernames,
        step.collectorIndex,
        "collector"
      );
      const collectorActor: BatchActor = {
        id: collectorId,
        username: collectorUsername,
        seesEveryCollectorBatch: false,
      };
      const officeActor: BatchActor = {
        id: reference.ownerId,
        username: reference.ownerUsername,
        seesEveryCollectorBatch: true,
      };

      const accountIds = step.stops.map((stop) => accountIdAt(reference, stop.accountIndex));

      const batch = await createCollectorBatch(
        { collectorId, collectionDate: step.collectionDate, serviceAccountIds: accountIds },
        collectorActor
      );

      let gcashCollectedCentavos = 0;

      for (const stop of step.stops) {
        const serviceAccountId = accountIdAt(reference, stop.accountIndex);

        if (stop.result === "collected" || stop.result === "partial") {
          const outstandingCentavos = await loadOutstandingCentavos(serviceAccountId);
          const fraction = stop.result === "partial" ? (stop.fractionOfOutstanding ?? 60) : 100;
          const amountCentavos = Math.max(1, Math.floor((outstandingCentavos * fraction) / 100));
          const method: PaymentMethod = stop.gcashReference === undefined ? "cash" : "gcash";

          if (method === "gcash") {
            gcashCollectedCentavos += amountCentavos;
          }

          await recordCollection(
            batch.id,
            serviceAccountId,
            {
              result: stop.result,
              collectedAmountCentavos: amountCentavos,
              collectedMethod: method,
              collectorNotes: "Demo field collection",
              gcash:
                stop.gcashReference === undefined
                  ? undefined
                  : {
                      referenceNumber: stop.gcashReference,
                      senderName: "Demo Field Payer",
                      senderGcashNumber: demoPhoneNumber(2),
                    },
            },
            collectorActor
          );
          continue;
        }

        await recordCollection(batch.id, serviceAccountId, { result: stop.result }, collectorActor);
      }

      const submitted = await submitBatch(batch.id, collectorActor);
      const remittanceTotalCentavos = submitted.expectedRemittanceCentavos;
      const gcashRemittedCentavos = Math.min(gcashCollectedCentavos, remittanceTotalCentavos);

      await recordBatchRemittance(
        batch.id,
        {
          amountCentavos: remittanceTotalCentavos,
          cashAmountCentavos: remittanceTotalCentavos - gcashRemittedCentavos,
          gcashAmountCentavos: gcashRemittedCentavos,
          notes: "Demo remittance",
        },
        officeActor
      );

      if (step.through === "closed") {
        await reconcileBatch(batch.id, undefined, officeActor);
        await closeBatch(batch.id, officeActor);
      }
      return;
    }
  }
}

/** Resolves a relative payment amount from the account's real outstanding balance. */
async function resolvePaymentAmount(
  reference: DemoReferenceData,
  accountIndex: number,
  kind: "outstanding" | "half_outstanding" | "outstanding_plus_one_month"
): Promise<number> {
  const serviceAccountId = accountIdAt(reference, accountIndex);
  const outstandingCentavos = await loadOutstandingCentavos(serviceAccountId);

  switch (kind) {
    case "outstanding":
      return outstandingCentavos;
    case "half_outstanding":
      return Math.floor(outstandingCentavos / 2);
    case "outstanding_plus_one_month":
      return outstandingCentavos + (reference.monthlyRateCentavosByAccountIndex[accountIndex] ?? 0);
  }
}

/** The sum of the account's outstanding invoice balances, in centavos. */
async function loadOutstandingCentavos(serviceAccountId: string): Promise<number> {
  const rows = await db
    .select({ remainingCentavos: invoices.remainingBalanceCentavos })
    .from(invoices)
    .where(
      and(
        eq(invoices.serviceAccountId, serviceAccountId),
        inArray(invoices.status, [...OUTSTANDING_INVOICE_STATUSES])
      )
    );

  return rows.reduce((total, row) => total + row.remainingCentavos, 0);
}

// ─── Reporting ────────────────────────────────────────────────────────────────

/** Every demo service-account id. */
async function loadDemoAccountIds(): Promise<string[]> {
  const demoSubscriberIds = await db
    .select({ id: subscribers.id })
    .from(subscribers)
    .where(like(subscribers.internalNotes, `${DEMO_MARKER}%`))
    .then((rows) => rows.map((row) => row.id));

  if (demoSubscriberIds.length === 0) {
    return [];
  }

  return db
    .select({ id: serviceAccounts.id })
    .from(serviceAccounts)
    .where(inArray(serviceAccounts.subscriberId, demoSubscriberIds))
    .then((rows) => rows.map((row) => row.id));
}

/**
 * Counts and totals the demo dataset by QUERYING THE DATABASE, not by replaying the
 * plan's own bookkeeping. A summary that trusted the plan could agree with itself
 * while disagreeing with what was actually written.
 */
export async function summarizeDemoDataset(): Promise<{
  counts: DemoDatasetCounts;
  totals: DemoDatasetTotals;
}> {
  const accountIds = await loadDemoAccountIds();

  const demoSubscriberCount = await countSubscribers();
  const demoUserCount = await countUsers(like(users.username, `${DEMO_USERNAME_PREFIX}%`));
  const demoCollectorCount = await countUsers(
    and(like(users.username, `${DEMO_USERNAME_PREFIX}collector.%`), eq(users.role, "collector"))
  );
  const demoAreaCount = await countAreas();

  const planRows = await db
    .select({ serviceType: subscriptionPlans.serviceType })
    .from(subscriptionPlans)
    .where(like(subscriptionPlans.name, "Demo %"));

  const accountRows =
    accountIds.length === 0
      ? []
      : await db
          .select({ serviceType: subscriptionPlans.serviceType })
          .from(serviceAccounts)
          .innerJoin(subscriptionPlans, eq(serviceAccounts.planId, subscriptionPlans.id))
          .where(inArray(serviceAccounts.id, accountIds));

  const invoiceRows =
    accountIds.length === 0
      ? []
      : await db
          .select({
            serviceAccountId: invoices.serviceAccountId,
            totalAmountCentavos: invoices.totalAmountCentavos,
            remainingBalanceCentavos: invoices.remainingBalanceCentavos,
            status: invoices.status,
            billingPeriodYear: invoices.billingPeriodYear,
            billingPeriodMonth: invoices.billingPeriodMonth,
          })
          .from(invoices)
          .where(inArray(invoices.serviceAccountId, accountIds));

  const paymentRows =
    accountIds.length === 0
      ? []
      : await db
          .select({
            id: payments.id,
            paymentMethod: payments.paymentMethod,
            status: payments.status,
            amountCentavos: payments.amountCentavos,
            advanceCreditCentavos: payments.advanceCreditCentavos,
          })
          .from(payments)
          .where(inArray(payments.serviceAccountId, accountIds));

  const paymentIds = paymentRows.map((row) => row.id);

  const gcashRows =
    paymentIds.length === 0
      ? []
      : await db
          .select({
            paymentId: gcashPayments.paymentId,
            verifiedAt: gcashPayments.verifiedAt,
            rejectedAt: gcashPayments.rejectedAt,
          })
          .from(gcashPayments)
          .where(inArray(gcashPayments.paymentId, paymentIds));

  const partialPaymentRows =
    accountIds.length === 0
      ? []
      : await db
          .selectDistinct({ paymentId: paymentAllocations.paymentId })
          .from(paymentAllocations)
          .innerJoin(invoices, eq(paymentAllocations.invoiceId, invoices.id))
          .where(
            and(
              inArray(invoices.serviceAccountId, accountIds),
              eq(invoices.status, "partially_paid")
            )
          );

  const gcashByPaymentId = new Map(gcashRows.map((row) => [row.paymentId, row]));

  const suspensionCount = await countServiceControl(
    "suspension",
    accountIds
  );
  const reconnectionCount = await countServiceControl("reconnection", accountIds);
  const batchCount = await countCollectorBatches();

  const billingMonths = new Set(
    invoiceRows
      .filter((row) => row.billingPeriodYear !== null && row.billingPeriodMonth !== null)
      .map((row) => `${row.billingPeriodYear}-${row.billingPeriodMonth}`)
  ).size;

  const outstandingInvoices = invoiceRows.filter(
    (row) =>
      (OUTSTANDING_INVOICE_STATUSES as readonly string[]).includes(row.status) &&
      row.remainingBalanceCentavos > 0
  );

  const overdueAccountIds = new Set(outstandingInvoices.map((row) => row.serviceAccountId));

  return {
    counts: {
      users: demoUserCount,
      areas: demoAreaCount,
      plans: planRows.length,
      internetPlans: planRows.filter((row) => row.serviceType === "internet").length,
      cablePlans: planRows.filter((row) => row.serviceType === "cable_tv").length,
      comboPlans: planRows.filter((row) => row.serviceType === "bundle").length,
      subscribers: demoSubscriberCount,
      serviceAccounts: accountRows.length,
      internetAccounts: accountRows.filter((row) => row.serviceType === "internet").length,
      cableAccounts: accountRows.filter((row) => row.serviceType === "cable_tv").length,
      comboAccounts: accountRows.filter((row) => row.serviceType === "bundle").length,
      collectors: demoCollectorCount,
      billingMonths,
      invoices: invoiceRows.length,
      payments: paymentRows.length,
      cashPayments: paymentRows.filter((row) => row.paymentMethod === "cash").length,
      gcashPayments: paymentRows.filter((row) => row.paymentMethod === "gcash").length,
      verifiedGcashPayments: [...gcashByPaymentId.values()].filter(
        (row) => row.verifiedAt !== null
      ).length,
      pendingGcashPayments: paymentRows.filter(
        (row) => row.status === "pending_verification" && gcashByPaymentId.has(row.id)
      ).length,
      rejectedGcashPayments: [...gcashByPaymentId.values()].filter(
        (row) => row.rejectedAt !== null
      ).length,
      reversedPayments: paymentRows.filter((row) => row.status === "reversed").length,
      partialPayments: partialPaymentRows.length,
      advanceCreditPayments: paymentRows.filter((row) => row.advanceCreditCentavos > 0).length,
      overdueAccounts: overdueAccountIds.size,
      suspensionRecords: suspensionCount,
      reconnectionRecords: reconnectionCount,
      collectorBatches: batchCount,
    },
    totals: {
      invoicedCentavos: invoiceRows.reduce((total, row) => total + row.totalAmountCentavos, 0),
      collectedCentavos: paymentRows
        .filter((row) => row.status === "posted")
        .reduce((total, row) => total + row.amountCentavos, 0),
      outstandingCentavos: outstandingInvoices.reduce(
        (total, row) => total + row.remainingBalanceCentavos,
        0
      ),
      ledgerNetCentavos: await loadDemoLedgerNetCentavos(accountIds),
    },
  };
}

/** Counts demo subscribers by their marker note. */
async function countSubscribers(): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(subscribers)
    .where(like(subscribers.internalNotes, `${DEMO_MARKER}%`));
  return row?.value ?? 0;
}

/** Counts users matching a condition. */
async function countUsers(
  condition: ReturnType<typeof and> | ReturnType<typeof like>
): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(users)
    .where(condition);
  return row?.value ?? 0;
}

/** Counts demo collection areas. */
async function countAreas(): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(collectionAreas)
    .where(like(collectionAreas.code, "DEMO-%"));
  return row?.value ?? 0;
}

/** Counts suspension or reconnection records for the demo service accounts. */
async function countServiceControl(
  kind: "suspension" | "reconnection",
  accountIds: readonly string[]
): Promise<number> {
  if (accountIds.length === 0) {
    return 0;
  }

  if (kind === "suspension") {
    const [row] = await db
      .select({ value: sql<number>`count(*)::int` })
      .from(suspensionRecords)
      .where(inArray(suspensionRecords.serviceAccountId, [...accountIds]));
    return row?.value ?? 0;
  }

  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(reconnectionRecords)
    .where(inArray(reconnectionRecords.serviceAccountId, [...accountIds]));
  return row?.value ?? 0;
}

/** Counts the collector batches held by the demo collectors. */
async function countCollectorBatches(): Promise<number> {
  const collectorIds = await db
    .select({ id: users.id })
    .from(users)
    .where(like(users.username, `${DEMO_USERNAME_PREFIX}collector.%`))
    .then((rows) => rows.map((row) => row.id));

  if (collectorIds.length === 0) {
    return 0;
  }

  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(collectorBatches)
    .where(inArray(collectorBatches.collectorId, collectorIds));
  return row?.value ?? 0;
}

/** The demo dataset's ledger net: sum of debits minus sum of credits. */
async function loadDemoLedgerNetCentavos(accountIds: readonly string[]): Promise<number> {
  if (accountIds.length === 0) {
    return 0;
  }

  const rows = await db
    .select({
      entryType: ledgerEntries.entryType,
      amountCentavos: ledgerEntries.amountCentavos,
    })
    .from(ledgerEntries)
    .where(inArray(ledgerEntries.serviceAccountId, [...accountIds]));

  return rows.reduce((total, row) => {
    const isDebit = (DEBIT_ENTRY_TYPES as readonly string[]).includes(row.entryType);
    return total + (isDebit ? row.amountCentavos : -row.amountCentavos);
  }, 0);
}

/** A required array entry, or a loud error naming what was missing. */
function requireIndex<T>(values: readonly T[], index: number, label: string): T {
  const value = values[index];
  if (value === undefined) {
    throw new Error(`Demo plan refers to ${label} ${index}, which does not exist`);
  }
  return value;
}

/** A required map entry, or a loud error naming what was missing. */
function requireUserId(map: ReadonlyMap<string, string>, username: string): string {
  const value = map.get(username);
  if (value === undefined) {
    throw new Error(`Demo user "${username}" was not created`);
  }
  return value;
}

/** The service-account id at a plan index. */
function accountIdAt(reference: DemoReferenceData, accountIndex: number): string {
  return requireIndex(reference.serviceAccountIds, accountIndex, "service account");
}
