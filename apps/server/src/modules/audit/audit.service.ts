// Database queries for the audit trail.
//
// The audit table is append-only, so this module only ever reads; the only write
// path is the audit logger in shared/audit.

import { and, count, desc, eq, type SQL } from "drizzle-orm";

import { db } from "../../db/connection";
import { auditLogs } from "../../db/schema/audit";

export interface ListAuditLogFilters {
  action?: string;
  entityType?: string;
  entityId?: string;
  performedBy?: string;
  page: number;
  pageSize: number;
}

export interface AuditLogPage {
  items: (typeof auditLogs.$inferSelect)[];
  page: number;
  pageSize: number;
  total: number;
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
