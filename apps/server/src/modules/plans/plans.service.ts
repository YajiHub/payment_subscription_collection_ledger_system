// Database operations for subscription plans.
// Route handlers never touch the database directly — they call these functions.
//
// A plan's monthly rate is immutable. Raising a price means creating a new plan,
// which is how "plans are versioned" is enforced: existing service accounts keep
// pointing at the plan they signed up for.

import { and, asc, eq } from "drizzle-orm";

import { db } from "../../db/connection";
import { subscriptionPlans } from "../../db/schema/subscribers";
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors";
import type { ServiceType } from "@bcis/shared";
import type { CreatePlanFields, UpdatePlanFields } from "@bcis/shared";

// Everything a client needs to render a plan. Amounts are integer centavos.
export interface PlanSummary {
  id: string;
  name: string;
  serviceType: ServiceType;
  speedMbps: number | null;
  cablePackageDescription: string | null;
  monthlyRateCentavos: number;
  reconnectionFeeCentavos: number;
  isActive: boolean;
  createdAt: Date;
  createdBy: string;
}

export const planColumns = {
  id: subscriptionPlans.id,
  name: subscriptionPlans.name,
  serviceType: subscriptionPlans.serviceType,
  speedMbps: subscriptionPlans.speedMbps,
  cablePackageDescription: subscriptionPlans.cablePackageDescription,
  monthlyRateCentavos: subscriptionPlans.monthlyRateCentavos,
  reconnectionFeeCentavos: subscriptionPlans.reconnectionFeeCentavos,
  isActive: subscriptionPlans.isActive,
  createdAt: subscriptionPlans.createdAt,
  createdBy: subscriptionPlans.createdBy,
};

export interface ListPlansFilters {
  serviceType?: ServiceType;
  /** The plan management screen needs retired plans too; signup screens do not. */
  includeInactive?: boolean;
}

/** Lists plans, newest first. Active plans only unless the caller asks otherwise. */
export async function listPlans(filters: ListPlansFilters = {}): Promise<PlanSummary[]> {
  const conditions = [];

  if (filters.serviceType !== undefined) {
    conditions.push(eq(subscriptionPlans.serviceType, filters.serviceType));
  }

  if (filters.includeInactive !== true) {
    conditions.push(eq(subscriptionPlans.isActive, true));
  }

  return db
    .select(planColumns)
    .from(subscriptionPlans)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(subscriptionPlans.monthlyRateCentavos));
}

/** Loads a single plan, or throws NotFoundError so the route returns 404. */
export async function getPlanById(planId: string): Promise<PlanSummary> {
  const plan = await db
    .select(planColumns)
    .from(subscriptionPlans)
    .where(eq(subscriptionPlans.id, planId))
    .limit(1)
    .then((rows) => rows[0]);

  if (plan === undefined) {
    throw new NotFoundError("Plan not found");
  }

  return plan;
}

/**
 * Loads a plan that may be assigned to a new service account.
 * A retired plan still exists but must not take new signups.
 */
export async function requireAssignablePlan(planId: string): Promise<PlanSummary> {
  const plan = await getPlanById(planId);

  if (!plan.isActive) {
    throw new ValidationError(`Plan "${plan.name}" is retired and cannot be assigned`);
  }

  return plan;
}

export interface CreatePlanInput extends CreatePlanFields {
  createdBy: string;
}

/** Creates a plan. Rejects a duplicate name so the picker stays unambiguous. */
export async function createPlan(input: CreatePlanInput): Promise<PlanSummary> {
  const existing = await db
    .select({ id: subscriptionPlans.id })
    .from(subscriptionPlans)
    .where(eq(subscriptionPlans.name, input.name))
    .limit(1)
    .then((rows) => rows[0]);

  if (existing !== undefined) {
    throw new ConflictError("A plan with that name already exists");
  }

  const created = await db
    .insert(subscriptionPlans)
    .values({
      name: input.name,
      serviceType: input.serviceType,
      speedMbps: input.speedMbps ?? null,
      cablePackageDescription: input.cablePackageDescription ?? null,
      monthlyRateCentavos: input.monthlyRateCentavos,
      reconnectionFeeCentavos: input.reconnectionFeeCentavos,
      createdBy: input.createdBy,
    })
    .returning(planColumns)
    .then((rows) => rows[0]);

  // `.returning()` always yields the inserted row; the guard keeps types honest.
  if (created === undefined) {
    throw new NotFoundError("Plan could not be created");
  }

  return created;
}

/**
 * Updates a plan's descriptive fields only.
 * The monthly rate and reconnection fee are intentionally not updatable: a price
 * change is a new plan, so no existing account is re-priced behind the clerk's back.
 */
export async function updatePlan(planId: string, input: UpdatePlanFields): Promise<PlanSummary> {
  // Build the update explicitly: an omitted field must never be written as undefined.
  const planChanges: UpdatePlanFields = {};

  if (input.name !== undefined) {
    planChanges.name = input.name;
  }
  if (input.speedMbps !== undefined) {
    planChanges.speedMbps = input.speedMbps;
  }
  if (input.cablePackageDescription !== undefined) {
    planChanges.cablePackageDescription = input.cablePackageDescription;
  }

  const updated = await db
    .update(subscriptionPlans)
    .set(planChanges)
    .where(eq(subscriptionPlans.id, planId))
    .returning(planColumns)
    .then((rows) => rows[0]);

  if (updated === undefined) {
    throw new NotFoundError("Plan not found");
  }

  return updated;
}

/**
 * Retires a plan so it takes no new signups.
 * The row is never deleted: service accounts still reference it, and history must
 * stay readable.
 */
export async function retirePlan(planId: string): Promise<PlanSummary> {
  const retired = await db
    .update(subscriptionPlans)
    .set({ isActive: false })
    .where(eq(subscriptionPlans.id, planId))
    .returning(planColumns)
    .then((rows) => rows[0]);

  if (retired === undefined) {
    throw new NotFoundError("Plan not found");
  }

  return retired;
}
