// Database queries for the audit trail.
//
// The audit table is append-only, so this module only ever reads; the only write
// path is the audit logger in shared/audit.

import { and, count, desc, eq, ilike, inArray, or, type SQL } from "drizzle-orm";

import { db } from "../../db/connection";
import { auditLogs } from "../../db/schema/audit";
import { users } from "../../db/schema/users";

export interface ListAuditLogFilters {
  action?: string;
  entityType?: string;
  entityId?: string;
  performedBy?: string;
  performedByUsername?: string;
  page: number;
  pageSize: number;
}

export interface AuditLogPage {
  items: (typeof auditLogs.$inferSelect)[];
  page: number;
  pageSize: number;
  total: number;
}

/**
 * Escapes the LIKE wildcards in a value the operator typed.
 *
 * Without this, a stray `%` in the box would quietly match every row instead of
 * narrowing anything — a filter that appears to work and does not.
 */
function escapeLikeWildcards(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/** One page of audit entries, newest first, narrowed by whichever filters were supplied. */
export async function listAuditLogs(filters: ListAuditLogFilters): Promise<AuditLogPage> {
  const conditions: SQL[] = [];

  if (filters.action !== undefined) {
    conditions.push(eq(auditLogs.action, filters.action));
  }
  if (filters.entityType !== undefined) {
    conditions.push(eq(auditLogs.entityType, filters.entityType));
  }
  if (filters.entityId !== undefined) {
    conditions.push(eq(auditLogs.entityId, filters.entityId));
  }
  if (filters.performedBy !== undefined) {
    conditions.push(eq(auditLogs.performedBy, filters.performedBy));
  }
  if (filters.performedByUsername !== undefined) {
    // The username is denormalized onto the row, so the common case needs no join. A
    // partial name is matched anywhere in it: "cashier" finds "demo.cashier".
    const pattern = `%${escapeLikeWildcards(filters.performedByUsername)}%`;

    // Match the name recorded on the row, OR the id of any user whose name matches.
    // Rows written before the name was denormalized onto the row — the demo seed, for
    // one — carry the id and no name at all, and they are that person's actions just
    // the same. Matching only the recorded name would hide 47 of a cashier's 48
    // entries and look like the filter simply worked.
    conditions.push(
      or(
        ilike(auditLogs.performedByUsername, pattern),
        inArray(
          auditLogs.performedBy,
          db.select({ id: users.id }).from(users).where(ilike(users.username, pattern))
        )
      ) as SQL
    );
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const offset = (filters.page - 1) * filters.pageSize;

  const items = await db
    .select()
    .from(auditLogs)
    .where(where)
    .orderBy(desc(auditLogs.performedAt))
    .limit(filters.pageSize)
    .offset(offset);

  const total = await db
    .select({ value: count() })
    .from(auditLogs)
    .where(where)
    .then((rows) => rows[0]?.value ?? 0);

  return { items, page: filters.page, pageSize: filters.pageSize, total };
}
