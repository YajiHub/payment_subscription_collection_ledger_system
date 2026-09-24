// Reads and writes the configurable business rules in `system_settings`.
//
// A setting is stored as text; the values the code cares about numerically are
// validated here before they are stored, so a bad value is rejected at the edge
// rather than discovered later inside a calculation.

import { DEFAULT_SYSTEM_SETTINGS, SYSTEM_SETTING_KEYS } from "@bcis/shared";
import { asc, eq } from "drizzle-orm";

import { db } from "../../db/connection";
import { systemSettings } from "../../db/schema/system";
import { ValidationError } from "../../shared/errors";
import { positiveAmountCentavos } from "../../shared/validation/common";

/** The known setting keys, as a set for a fast membership check. */
const knownSettingKeys = new Set<string>(Object.values(SYSTEM_SETTING_KEYS));

/**
 * Inserts any missing default settings.
 *
 * Idempotent: `ON CONFLICT DO NOTHING` means a value an administrator has already
 * changed is never overwritten. Called on server start and by the test suite.
 */
export async function ensureSystemSettingsSeeded(): Promise<void> {
  await db
    .insert(systemSettings)
    .values(
      DEFAULT_SYSTEM_SETTINGS.map((setting) => ({
        key: setting.key,
        value: setting.value,
        description: setting.description,
      }))
    )
    .onConflictDoNothing({ target: systemSettings.key });
}

/** Every setting, ordered by key, for the settings screen. */
export async function listSystemSettings(): Promise<(typeof systemSettings.$inferSelect)[]> {
  return db.select().from(systemSettings).orderBy(asc(systemSettings.key));
}

/** Every setting as a plain key → value map, for code that only needs the values. */
export async function getSystemSettingsMap(): Promise<Record<string, string>> {
  const rows = await listSystemSettings();
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

export interface SystemSettingUpdate {
  key: string;
  value: string;
}

/**
 * Rejects a value that is malformed for the setting it belongs to.
 *
 * Only settings with a numeric meaning are checked; a free-text setting accepts
 * any non-empty string.
 */
function assertSettingValueIsValid(key: string, value: string): void {
  if (key === SYSTEM_SETTING_KEYS.lateFeeCentavos) {
    const parsed = positiveAmountCentavos.safeParse(Number(value));
    if (!parsed.success) {
      throw new ValidationError(
        "late_fee_centavos must be a positive whole number of centavos (for example 5000)"
      );
    }
  }

  if (key === SYSTEM_SETTING_KEYS.invoiceDueDayOfMonth) {
    const day = Number(value);
    if (!Number.isInteger(day) || day < 1 || day > 28) {
      throw new ValidationError(
        "invoice_due_day_of_month must be a whole number between 1 and 28 so every month has that day"
      );
    }
  }

  if (key === SYSTEM_SETTING_KEYS.suspensionAfterDays) {
    const days = Number(value);
    if (!Number.isInteger(days) || days < 1) {
      throw new ValidationError("suspension_after_days must be a whole number of days");
    }
  }
}

/**
 * Updates one or more settings in a single transaction. An unknown key is
 * rejected so a typo cannot silently create an unused row.
 */
export async function updateSystemSettings(
  updates: readonly SystemSettingUpdate[],
  updatedByUserId: string
): Promise<(typeof systemSettings.$inferSelect)[]> {
  for (const update of updates) {
    if (!knownSettingKeys.has(update.key)) {
      throw new ValidationError(`Unknown system setting: ${update.key}`);
    }
    assertSettingValueIsValid(update.key, update.value);
  }

  const updatedAt = new Date();

  await db.transaction(async (tx) => {
    for (const update of updates) {
      await tx
        .update(systemSettings)
        .set({ value: update.value, updatedAt, updatedBy: updatedByUserId })
        .where(eq(systemSettings.key, update.key));
    }
  });

  return listSystemSettings();
}
