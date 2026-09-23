// Service types and service-account lifecycle values, shared by client and server.
//
// The database enums must use exactly these strings, so no translation layer is
// needed anywhere between the schema, the API, and the UI.

// The kinds of service the ISP sells. Extensible: a future VoIP or IP-camera
// offering means adding a value here and to the database enum.
export const SERVICE_TYPES = ["internet", "cable_tv", "bundle"] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];

/** Human-readable service names, used in badges and plan tables. */
export const SERVICE_TYPE_LABELS = {
  internet: "Internet",
  cable_tv: "Cable TV",
  bundle: "Internet + Cable TV",
} as const satisfies Record<ServiceType, string>;

// The lifecycle states of a service account.
// "pending" means a new account whose installation is not finished yet.
export const SERVICE_ACCOUNT_STATUSES = ["active", "suspended", "terminated", "pending"] as const;
export type ServiceAccountStatus = (typeof SERVICE_ACCOUNT_STATUSES)[number];

/** Human-readable status names, used in badges and filters. */
export const SERVICE_ACCOUNT_STATUS_LABELS = {
  active: "Active",
  suspended: "Suspended",
  terminated: "Terminated",
  pending: "Pending",
} as const satisfies Record<ServiceAccountStatus, string>;
