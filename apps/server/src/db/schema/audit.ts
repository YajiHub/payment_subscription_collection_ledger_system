// The audit trail: a permanent record of every consequential action.
//
// Audit rows are APPEND-ONLY. Once written, a row is never updated and never
// deleted — that is what makes the trail trustworthy. The service layer only
// ever inserts, and the migration installs a database trigger that refuses an
// UPDATE or a DELETE outright, so even a careless raw statement cannot rewrite
// history.
//
// `action` uses dot notation (`domain.verb`), so a query can filter by domain or
// by the exact action. `previous_state` and `new_state` are JSON snapshots: null
// for a create, and both sides present for a change. `description` is the
// human-readable one-liner an auditor reads first.
//
// `performed_by` is null for system-generated events (an automatic billing run);
// `performed_by_username` is denormalized so the trail still reads correctly if
// the user row is later deactivated.

import { index, jsonb, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

import { users } from "./users";

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // What type of action was performed.
    // Examples: "invoice.posted", "payment.reversed", "user.role_changed".
    action: varchar("action", { length: 100 }).notNull(),

    // What entity was affected. Examples: "invoice", "payment", "user".
    entityType: varchar("entity_type", { length: 50 }).notNull(),

    // The primary key of the affected row. A system event with no single row uses
    // the nil UUID (see AUDIT_NO_ENTITY_ID in the shared package).
    entityId: uuid("entity_id").notNull(),

    // The state of the entity BEFORE the change (JSON snapshot). Null for create.
    previousState: jsonb("previous_state"),

    // The state of the entity AFTER the change. Null when the row disappeared,
    // which does not happen here — financial rows are never deleted.
    newState: jsonb("new_state"),

    // Human-readable summary, e.g.
    // "Invoice INV-2025-01-000042 voided. Reason: Entered incorrect amount".
    description: text("description").notNull(),

    // Who performed the action. Null for system-generated actions.
    performedBy: uuid("performed_by").references(() => users.id),

    // Kept alongside the id so the trail reads correctly even after the user row
    // is deactivated or the user is renamed.
    performedByUsername: varchar("performed_by_username", { length: 50 }),

    // Which PC/client made the request — useful in a 3-PC office.
    clientIpAddress: varchar("client_ip_address", { length: 45 }),

    performedAt: timestamp("performed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The audit page filters by entity ("show this invoice's history") and every
    // filter is served by its own index.
    index("audit_logs_entity_idx").on(table.entityType, table.entityId),
    index("audit_logs_action_idx").on(table.action),
    index("audit_logs_performed_by_idx").on(table.performedBy),
    index("audit_logs_performed_at_idx").on(table.performedAt),
  ]
);

export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;
