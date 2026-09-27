// Collection areas: the routes the field collectors walk (S1-5, section 3.8).
//
// Until now an "area" was only the free-text `subscribers.service_barangay`
// string, so no one could create, list or assign a route at runtime and no
// report could group by area. This table makes the area an entity.
//
// The barangay string stays on the subscriber as denormalized data: it is what
// was recorded when the account was opened, it is printed on documents, and it
// must survive a later change to the area's name or code.

import { relations } from "drizzle-orm";
import { boolean, index, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

import { users } from "./users";

export const collectionAreas = pgTable(
  "collection_areas",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Short stable code used on the printable route sheet, e.g. "BRGY-01".
    code: varchar("code", { length: 30 }).notNull().unique(),
    name: varchar("name", { length: 100 }).notNull(),
    description: text("description"),

    // false = retired. The area keeps its history but takes no new assignments.
    isActive: boolean("is_active").notNull().default(true),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
  },
  (table) => [
    // The area list screen shows active areas first and the route-sheet picker
    // only offers active ones.
    index("collection_areas_is_active_idx").on(table.isActive),
  ]
);

export const collectionAreasRelations = relations(collectionAreas, ({ one }) => ({
  createdByUser: one(users, {
    fields: [collectionAreas.createdBy],
    references: [users.id],
  }),
}));

export type CollectionArea = typeof collectionAreas.$inferSelect;
export type NewCollectionArea = typeof collectionAreas.$inferInsert;
