// Validation schemas for subscribers, service accounts, and plans.
//
// The server validates every request body with these schemas; the client uses the
// same shapes to disable a Save button before a round trip. The server is still
// the authority — the client check is only there to make mistakes obvious sooner.
//
// Money is always an integer number of centavos (see types/money.ts).

import { z } from "zod";

import { SERVICE_TYPES } from "../constants/service-accounts";

// Philippine phone numbers are typed with digits, spaces, dashes, parentheses,
// and an optional leading +63. Keep the pattern permissive: clerks paste numbers
// in several formats and rejecting a valid one is worse than accepting an odd one.
const phoneNumberSchema = z.string().regex(/^[0-9+\-\s()]{7,20}$/, "Invalid phone number");

// ─── Subscribers ──────────────────────────────────────────────────────────────

export const createSubscriberSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  middleName: z.string().trim().max(100).optional(),
  primaryPhone: phoneNumberSchema,
  secondaryPhone: phoneNumberSchema.optional(),
  emailAddress: z.string().email().optional(),
  serviceAddress: z.string().trim().min(5).max(500),
  serviceBarangay: z.string().trim().min(1).max(100),
  serviceMunicipality: z.string().trim().min(1).max(100),
  serviceProvince: z.string().trim().min(1).max(100),
  internalNotes: z.string().trim().max(1000).optional(),
});
export type CreateSubscriberFields = z.infer<typeof createSubscriberSchema>;

export const updateSubscriberSchema = createSubscriberSchema
  .partial()
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: "Provide at least one field to update",
  });
export type UpdateSubscriberFields = z.infer<typeof updateSubscriberSchema>;

// ─── Plans ────────────────────────────────────────────────────────────────────
// A plan price is fixed for the life of the plan. Changing the monthly rate means
// creating a new plan, so existing accounts are never silently re-priced.

export const createPlanSchema = z.object({
  name: z.string().trim().min(1).max(100),
  serviceType: z.enum(SERVICE_TYPES),
  speedMbps: z.number().int().positive().max(100_000).optional(),
  cablePackageDescription: z.string().trim().max(1000).optional(),
  monthlyRateCentavos: z.number().int().nonnegative(),
  reconnectionFeeCentavos: z.number().int().nonnegative().default(0),
});
export type CreatePlanFields = z.infer<typeof createPlanSchema>;

// Only descriptive fields may change. monthlyRateCentavos is deliberately absent:
// a price change creates a new plan record instead of rewriting this one.
export const updatePlanSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    speedMbps: z.number().int().positive().max(100_000).nullable().optional(),
    cablePackageDescription: z.string().trim().max(1000).nullable().optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: "Provide at least one field to update",
  });
export type UpdatePlanFields = z.infer<typeof updatePlanSchema>;

// ─── Service Accounts ─────────────────────────────────────────────────────────

export const createServiceAccountSchema = z.object({
  planId: z.string().uuid(),
  // Supplying the activation date means service has started, so the account is
  // created "active". Leaving it out means installation is pending.
  activationDate: z.string().date().optional(),
  assignedCollectorId: z.string().uuid().optional(),
});
export type CreateServiceAccountFields = z.infer<typeof createServiceAccountSchema>;

// A subscriber is saved together with its first service account: the Add Subscriber
// form cannot be submitted with no service at all.
export const createSubscriberWithServiceAccountSchema = createSubscriberSchema.extend({
  serviceAccount: createServiceAccountSchema,
});
export type CreateSubscriberWithServiceAccountFields = z.infer<
  typeof createSubscriberWithServiceAccountSchema
>;

export const suspendServiceAccountSchema = z.object({
  reason: z.string().trim().min(10, "Suspension reason must be at least 10 characters"),
});
export type SuspendServiceAccountFields = z.infer<typeof suspendServiceAccountSchema>;

export const reconnectServiceAccountSchema = z.object({
  reason: z.string().trim().min(10, "Reconnection reason must be at least 10 characters").optional(),
});
export type ReconnectServiceAccountFields = z.infer<typeof reconnectServiceAccountSchema>;

export const terminateServiceAccountSchema = z.object({
  reason: z.string().trim().min(10, "Termination reason must be at least 10 characters"),
});
export type TerminateServiceAccountFields = z.infer<typeof terminateServiceAccountSchema>;

export const changeServiceAccountPlanSchema = z.object({
  planId: z.string().uuid(),
});
export type ChangeServiceAccountPlanFields = z.infer<typeof changeServiceAccountPlanSchema>;

export const assignCollectorSchema = z.object({
  // null unassigns the account so it becomes office-payment-only.
  assignedCollectorId: z.string().uuid().nullable(),
});
export type AssignCollectorFields = z.infer<typeof assignCollectorSchema>;
