// Suspension and reconnection records (S1-7, section 3.10).
//
// `service_status_history` already records "the status changed from active to
// suspended, by this user, for this reason". That is enough for the audit trail
// but not for the operating paperwork: who approved the cut, which technician
// went out, when the reconnection was requested, when it was completed, and what
// it cost. Those live here.
//
// Both tables are additive history. Nothing is updated or deleted: a mistake is a
// corrected record beside the old one, and the service account's status is always
// the source of truth for its current state.

import { relations, sql } from "drizzle-orm";
import { check, date, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { invoices } from "./billing";
import { serviceAccounts } from "./subscribers";
import { users } from "./users";

// ─── Suspension Records ───────────────────────────────────────────────────────
export const suspensionRecords = pgTable(
  "suspension_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    serviceAccountId: uuid("service_account_id")
      .notNull()
      .references(() => serviceAccounts.id),

    // Why the service was cut. Required — a suspension without a reason is not
    // answerable to the subscriber or to the auditor.
    reason: text("reason").notNull(),

    // The date the cut takes effect. Also written to
    // service_accounts.suspension_date and to service_status_history.
    effectiveDate: date("effective_date").notNull(),

    // Who authorized the suspension.
    approvedBy: uuid("approved_by")
      .notNull()
      .references(() => users.id),

    // Any charge raised with the suspension (0 when there is none), in centavos.
    feeCentavos: integer("fee_centavos").notNull().default(0),

    // The field technician who performed the disconnection, when one was assigned.
    technicianId: uuid("technician_id").references(() => users.id),

    // Workflow dates: when the suspension was requested and when the technician
    // completed it. Both nullable — an office-only suspension may have neither.
    requestDate: date("request_date"),
    completionDate: date("completion_date"),

    notes: text("notes"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
  },
  (table) => [
    index("suspension_records_service_account_idx").on(table.serviceAccountId),
    index("suspension_records_effective_date_idx").on(table.effectiveDate),
    index("suspension_records_technician_idx").on(table.technicianId),
    check("suspension_records_fee_check", sql`${table.feeCentavos} >= 0`),
  ]
);

// ─── Reconnection Records ─────────────────────────────────────────────────────
export const reconnectionRecords = pgTable(
  "reconnection_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    serviceAccountId: uuid("service_account_id")
      .notNull()
      .references(() => serviceAccounts.id),

    reason: text("reason").notNull(),

    // The date service resumes. Also written to service_accounts.suspension_date
    // (cleared) and to service_status_history.
    effectiveDate: date("effective_date").notNull(),

    approvedBy: uuid("approved_by")
      .notNull()
      .references(() => users.id),

    // The reconnection fee actually charged, in centavos. It comes from the plan
    // (subscription_plans.reconnection_fee_centavos) and is billed on invoice.
    feeCentavos: integer("fee_centavos").notNull().default(0),

    technicianId: uuid("technician_id").references(() => users.id),
    requestDate: date("request_date"),
    completionDate: date("completion_date"),

    // The reconnection-fee invoice raised with this reconnection, when one was
    // raised. Null for a waived fee. The invoice itself is the financial record.
    invoiceId: uuid("invoice_id").references(() => invoices.id),

    notes: text("notes"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
  },
  (table) => [
    index("reconnection_records_service_account_idx").on(table.serviceAccountId),
    index("reconnection_records_effective_date_idx").on(table.effectiveDate),
    index("reconnection_records_technician_idx").on(table.technicianId),
    check("reconnection_records_fee_check", sql`${table.feeCentavos} >= 0`),
  ]
);

// ─── Relations ───────────────────────────────────────────────────────────────
export const suspensionRecordsRelations = relations(suspensionRecords, ({ one }) => ({
  serviceAccount: one(serviceAccounts, {
    fields: [suspensionRecords.serviceAccountId],
    references: [serviceAccounts.id],
  }),
  approvedByUser: one(users, {
    fields: [suspensionRecords.approvedBy],
    references: [users.id],
  }),
  technician: one(users, {
    fields: [suspensionRecords.technicianId],
    references: [users.id],
  }),
}));

export const reconnectionRecordsRelations = relations(reconnectionRecords, ({ one }) => ({
  serviceAccount: one(serviceAccounts, {
    fields: [reconnectionRecords.serviceAccountId],
    references: [serviceAccounts.id],
  }),
  approvedByUser: one(users, {
    fields: [reconnectionRecords.approvedBy],
    references: [users.id],
  }),
  technician: one(users, {
    fields: [reconnectionRecords.technicianId],
    references: [users.id],
  }),
  invoice: one(invoices, {
    fields: [reconnectionRecords.invoiceId],
    references: [invoices.id],
  }),
}));

export type SuspensionRecord = typeof suspensionRecords.$inferSelect;
export type NewSuspensionRecord = typeof suspensionRecords.$inferInsert;
export type ReconnectionRecord = typeof reconnectionRecords.$inferSelect;
export type NewReconnectionRecord = typeof reconnectionRecords.$inferInsert;
