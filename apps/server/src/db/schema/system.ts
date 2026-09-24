// System settings: the configurable business rules, stored as text key/value rows.
//
// A value is text because a setting may be a number, an address, or a sentence.
// The code that reads a numeric setting parses it explicitly (see
// `parseIntSetting` in the shared package), so a hand-edited row can never leak a
// `NaN` into a calculation.
//
// `updated_by` records who last changed a setting; the change itself is also
// written to the audit trail.

import { pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

import { users } from "./users";

export const systemSettings = pgTable("system_settings", {
  key: varchar("key", { length: 100 }).primaryKey(),
  value: text("value").notNull(),
  description: text("description").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid("updated_by").references(() => users.id),
});

export type SystemSetting = typeof systemSettings.$inferSelect;
export type NewSystemSetting = typeof systemSettings.$inferInsert;
