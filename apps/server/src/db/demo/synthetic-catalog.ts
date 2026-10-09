// The fixed vocabulary the demo dataset draws from.
//
// Everything here is deliberately fictional: the names are invented, the streets
// are "Demo Street", the mobile numbers use the reserved-looking `0900` prefix and
// the GCash references are literally spelled "DEMO". Nothing in this file should
// ever resemble a real person, address, phone number or GCash transfer (S9-2).
//
// The plan definitions and collection areas are fixed rather than random so the
// section 8 minimums (3 Internet + 2 Cable + 2 Combo plans, 3 areas) hold for
// every seed, not just most of them.

import type { ServiceType, SystemRole, UserRole } from "@bcis/shared";

// ─── Markers ──────────────────────────────────────────────────────────────────

/**
 * The tag every demo row carries, so the guard can tell a demo database from a
 * real one and so an operator can see at a glance that the data is synthetic.
 */
export const DEMO_MARKER = "DEMO-DATA";

/** Demo user accounts are `demo.<role>`, which no real account is named. */
export const DEMO_USERNAME_PREFIX = "demo.";

// The password every demo account shares is NOT defined here. It comes from
// configuration (`SEED_DEMO_PASSWORD`, default `password`) so the demo seed, the
// documented logins and `pnpm db:reset-passwords` all write the same value.

/** Demo GCash references start with this, so they read as obviously synthetic. */
export const DEMO_GCASH_REFERENCE_PREFIX = "DEMOGCASH";

// ─── Users ────────────────────────────────────────────────────────────────────
//
// `legacyRole` fills the `users.role` enum the account is created through;
// `systemRoles` is the authoritative RBAC grant written to `user_roles`. The two
// differ for the roles that only exist in the new model (Owner, Accounting,
// Technician), which is exactly why the grant is set explicitly.

export interface DemoUserDefinition {
  username: string;
  fullName: string;
  legacyRole: UserRole;
  systemRoles: SystemRole[];
}

export const DEMO_USERS: readonly DemoUserDefinition[] = [
  {
    username: `${DEMO_USERNAME_PREFIX}owner`,
    fullName: "Olivia Owner (DEMO)",
    legacyRole: "admin",
    systemRoles: ["owner", "administrator"],
  },
  {
    username: `${DEMO_USERNAME_PREFIX}cashier`,
    fullName: "Carlo Cashier (DEMO)",
    legacyRole: "cashier",
    systemRoles: ["cashier"],
  },
  {
    username: `${DEMO_USERNAME_PREFIX}supervisor`,
    fullName: "Sofia Supervisor (DEMO)",
    legacyRole: "manager",
    systemRoles: ["collection_supervisor", "read_only_viewer"],
  },
  {
    username: `${DEMO_USERNAME_PREFIX}collector.one`,
    fullName: "Dante Collector One (DEMO)",
    legacyRole: "collector",
    systemRoles: ["collection_supervisor"],
  },
  {
    username: `${DEMO_USERNAME_PREFIX}collector.two`,
    fullName: "Divina Collector Two (DEMO)",
    legacyRole: "collector",
    systemRoles: ["collection_supervisor"],
  },
  {
    username: `${DEMO_USERNAME_PREFIX}auditor`,
    fullName: "Alma Auditor (DEMO)",
    legacyRole: "manager",
    systemRoles: ["accounting_auditor", "read_only_viewer"],
  },
  {
    username: `${DEMO_USERNAME_PREFIX}technician`,
    fullName: "Tomas Technician (DEMO)",
    legacyRole: "manager",
    systemRoles: ["technician", "read_only_viewer"],
  },
] as const;

/** The demo users that may hold a collector batch (legacy `collector` role). */
export const DEMO_COLLECTOR_USERNAMES = [
  `${DEMO_USERNAME_PREFIX}collector.one`,
  `${DEMO_USERNAME_PREFIX}collector.two`,
] as const;

// ─── Collection areas ─────────────────────────────────────────────────────────

export interface DemoAreaDefinition {
  code: string;
  name: string;
  description: string;
}

export const DEMO_AREAS: readonly DemoAreaDefinition[] = [
  {
    code: "DEMO-AREA-N",
    name: "Demo Route North",
    description: "Synthetic route — northern barangays of Synthetic City",
  },
  {
    code: "DEMO-AREA-S",
    name: "Demo Route South",
    description: "Synthetic route — southern barangays of Synthetic City",
  },
  {
    code: "DEMO-AREA-E",
    name: "Demo Route East",
    description: "Synthetic route — eastern barangays of Synthetic City",
  },
] as const;

// ─── Plans ────────────────────────────────────────────────────────────────────

export interface DemoPlanDefinition {
  name: string;
  serviceType: ServiceType;
  speedMbps: number | null;
  cablePackageDescription: string | null;
  monthlyRateCentavos: number;
  reconnectionFeeCentavos: number;
}

/** PHP 500.00. Every demo plan charges the same reconnection fee. */
const DEMO_RECONNECTION_FEE_CENTAVOS = 50_000;

export const DEMO_PLANS: readonly DemoPlanDefinition[] = [
  // 3 Internet plans.
  {
    name: "Demo Fiber 50 Mbps",
    serviceType: "internet",
    speedMbps: 50,
    cablePackageDescription: null,
    monthlyRateCentavos: 129_900, // PHP 1,299.00
    reconnectionFeeCentavos: DEMO_RECONNECTION_FEE_CENTAVOS,
  },
  {
    name: "Demo Fiber 100 Mbps",
    serviceType: "internet",
    speedMbps: 100,
    cablePackageDescription: null,
    monthlyRateCentavos: 169_900, // PHP 1,699.00
    reconnectionFeeCentavos: DEMO_RECONNECTION_FEE_CENTAVOS,
  },
  {
    name: "Demo Fiber 200 Mbps",
    serviceType: "internet",
    speedMbps: 200,
    cablePackageDescription: null,
    monthlyRateCentavos: 219_900, // PHP 2,199.00
    reconnectionFeeCentavos: DEMO_RECONNECTION_FEE_CENTAVOS,
  },
  // 2 Cable TV plans.
  {
    name: "Demo Cable Basic",
    serviceType: "cable_tv",
    speedMbps: null,
    cablePackageDescription: "80 channels — Demo lineup",
    monthlyRateCentavos: 55_000, // PHP 550.00
    reconnectionFeeCentavos: DEMO_RECONNECTION_FEE_CENTAVOS,
  },
  {
    name: "Demo Cable Premium",
    serviceType: "cable_tv",
    speedMbps: null,
    cablePackageDescription: "150 channels + Demo HD pack",
    monthlyRateCentavos: 85_000, // PHP 850.00
    reconnectionFeeCentavos: DEMO_RECONNECTION_FEE_CENTAVOS,
  },
  // 2 Combo plans.
  {
    name: "Demo Combo Starter (Fiber + Cable)",
    serviceType: "bundle",
    speedMbps: 50,
    cablePackageDescription: "Demo Fiber 50 with 80-channel cable",
    monthlyRateCentavos: 199_900, // PHP 1,999.00
    reconnectionFeeCentavos: DEMO_RECONNECTION_FEE_CENTAVOS,
  },
  {
    name: "Demo Combo Max (Fiber + Cable)",
    serviceType: "bundle",
    speedMbps: 200,
    cablePackageDescription: "Demo Fiber 200 with 150-channel cable",
    monthlyRateCentavos: 289_900, // PHP 2,899.00
    reconnectionFeeCentavos: DEMO_RECONNECTION_FEE_CENTAVOS,
  },
] as const;

/** The plan indexes of each service type, so accounts can be spread across all three. */
export const DEMO_PLAN_INDEXES_BY_SERVICE_TYPE: Record<ServiceType, readonly number[]> = {
  internet: [0, 1, 2],
  cable_tv: [3, 4],
  bundle: [5, 6],
};

// ─── People and places ────────────────────────────────────────────────────────

/** Invented given names. None of these is a claim about a real person. */
export const DEMO_FIRST_NAMES: readonly string[] = [
  "Amihan",
  "Bituin",
  "Catori",
  "Dalisay",
  "Emilio",
  "Farrah",
  "Ginto",
  "Hiraya",
  "Isagani",
  "Juliana",
  "Kalayo",
  "Lakambini",
  "Malaya",
  "Narra",
  "Olivia",
  "Pinuno",
  "Quezon",
  "Rizalia",
  "Sampaguita",
  "Tala",
  "Ulap",
  "Verano",
  "Wakas",
  "Yumi",
] as const;

/** Invented surnames. Every subscriber is "Firstname Surname (DEMO)". */
export const DEMO_LAST_NAMES: readonly string[] = [
  "Bukidnon",
  "Dagatnon",
  "Gubatnon",
  "Ilaya",
  "Kapatagan",
  "Loakan",
  "Marikina",
  "Nueva",
  "Pagsanjan",
  "Sierra",
  "Tagalog",
  "Ubay",
] as const;

export const DEMO_MIDDLE_NAMES: readonly string[] = [
  "Demo",
  "Sample",
  "Specimen",
  "Testcase",
] as const;

/**
 * A synthetic mobile number. `0900` is not a live Philippine mobile prefix, and
 * the last four digits are the subscriber's index, so no number here can ring.
 */
export function demoPhoneNumber(subscriberIndex: number): string {
  const suffix = String(subscriberIndex).padStart(4, "0");
  return `0900 000 ${suffix}`;
}

/** A synthetic GCash reference. The "DEMO" spelling makes it unmistakable. */
export function demoGcashReference(label: string, sequence: number): string {
  return `${DEMO_GCASH_REFERENCE_PREFIX}-${label}-${String(sequence).padStart(5, "0")}`;
}

/** The synthetic street address of a subscriber. */
export function demoServiceAddress(subscriberIndex: number): string {
  return `${subscriberIndex + 1} Demo Street, Demo Subdivision, Synthetic City`;
}
