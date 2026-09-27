// Handlers for the system settings and the extended health check.

import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { SYSTEM_SETTING_KEYS } from "@bcis/shared";
import { audit, requestActor } from "../../shared/audit/audit-logger";
import { sendSuccess } from "../../shared/response";
import { parseOrThrow } from "../../shared/validate";
import { invalidatePermissionCache, refreshPermissionCache } from "../../shared/rbac/permission-resolver";
import { getExtendedHealth } from "./system-health.service";
import { getSystemSettingsMap, listSystemSettings, updateSystemSettings } from "./system-settings.service";

// Exported so the route table can declare it as the route's Zod schema, which
// makes Fastify reject an invalid body before this handler runs.
export const updateSystemSettingsBodySchema = z.object({
  settings: z
    .array(
      z.object({
        key: z.string().trim().min(1).max(100),
        value: z.string().max(1000),
      })
    )
    .min(1, "Provide at least one setting to update"),
});

/** GET /api/system/settings — every configurable business rule. */
export async function getSystemSettingsHandler(
  _request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const items = await listSystemSettings();
  return sendSuccess(reply, { items });
}

/** PUT /api/system/settings — updates one or more settings (Admin only). */
export async function putSystemSettingsHandler(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const body = parseOrThrow(updateSystemSettingsBodySchema, request.body);
  const updatedByUserId = request.user?.id ?? "";

  // Snapshot the current values so the audit trail can record old AND new for
  // each changed setting (S5-6).
  const previousValues = await getSystemSettingsMap();

  const items = await updateSystemSettings(body.settings, updatedByUserId);

  for (const update of body.settings) {
    const previousValue = previousValues[update.key] ?? null;
    if (previousValue !== update.value) {
      await audit.systemSettingUpdated(update.key, previousValue, update.value, requestActor(request));
    }

    // S12-9: flipping the rollback switch must take effect immediately, not on the
    // next TTL tick. Clearing the cache re-resolves from the new source of truth.
    if (update.key === SYSTEM_SETTING_KEYS.rbacPermissionsInDatabase) {
      invalidatePermissionCache();
      void refreshPermissionCache({ force: true });
    }
  }

  return sendSuccess(reply, { items });
}

/** GET /api/system/health/extended — database health and table counts (Admin only). */
export async function getExtendedHealthHandler(
  _request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  return sendSuccess(reply, await getExtendedHealth());
}
