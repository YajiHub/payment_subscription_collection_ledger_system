// The shape of an audit-log row as it travels over the API.
//
// Dates are ISO-8601 strings on the wire; `previousState` and `newState` are
// JSON snapshots of the affected record before and after the action.

import type { AuditAction, AuditEntityType } from "../constants/audit";

export interface AuditLogEntry {
  id: string;
  action: AuditAction | string;
  entityType: AuditEntityType | string;
  entityId: string;
  previousState: Record<string, unknown> | null;
  newState: Record<string, unknown> | null;
  description: string;
  performedBy: string | null;
  performedByUsername: string | null;
  clientIpAddress: string | null;
  performedAt: string;
}

export interface ListAuditLogsQuery {
  page?: number;
  pageSize?: number;
  action?: string;
  entityType?: string;
  entityId?: string;
  performedBy?: string;
}

export interface PaginatedAuditLogs {
  items: AuditLogEntry[];
  page: number;
  pageSize: number;
  total: number;
}
