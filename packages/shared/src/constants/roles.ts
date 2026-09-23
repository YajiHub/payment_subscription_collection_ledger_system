// The five roles defined by the lab specification.
// Adding a role requires updating this list and the Phase 2 permission matrix.

export const USER_ROLES = ["admin", "billing_clerk", "cashier", "collector", "manager"] as const;

export type UserRole = (typeof USER_ROLES)[number];

/** Human-readable names for each role, used in the UI and on printed documents. */
export const USER_ROLE_LABELS = {
  admin: "Administrator",
  billing_clerk: "Billing Clerk",
  cashier: "Cashier",
  collector: "Collector",
  manager: "Manager",
} as const satisfies Record<UserRole, string>;