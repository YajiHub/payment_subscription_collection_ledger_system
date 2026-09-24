// System settings: the configurable business rules that are NOT hardcoded in
// application code. A setting is stored as text in the `system_settings` table
// and read back by key; a value that represents a number is parsed explicitly.
//
// Every value here is a default that is seeded into a fresh database. The
// settings screen can change a value later without a code change.

export const SYSTEM_SETTING_KEYS = {
  lateFeeCentavos: "late_fee_centavos",
  invoiceDueDayOfMonth: "invoice_due_day_of_month",
  suspensionAfterDays: "suspension_after_days",
  companyName: "company_name",
  companyAddress: "company_address",
  companyPhone: "company_phone",
  receiptFooterText: "receipt_footer_text",
} as const;

export type SystemSettingKey = (typeof SYSTEM_SETTING_KEYS)[keyof typeof SYSTEM_SETTING_KEYS];

export interface SystemSettingDefault {
  key: SystemSettingKey;
  value: string;
  description: string;
}

/**
 * The defaults seeded into a new database.
 *
 * `late_fee_centavos` is "5000" — PHP 50.00 stored as integer centavos, exactly
 * like every other monetary value in the system.
 */
export const DEFAULT_SYSTEM_SETTINGS: readonly SystemSettingDefault[] = [
  {
    key: SYSTEM_SETTING_KEYS.lateFeeCentavos,
    value: "5000",
    description: "Late fee charged to an overdue invoice, in centavos (5000 = PHP 50.00)",
  },
  {
    key: SYSTEM_SETTING_KEYS.invoiceDueDayOfMonth,
    value: "15",
    description: "Day of the following month on which a monthly invoice falls due",
  },
  {
    key: SYSTEM_SETTING_KEYS.suspensionAfterDays,
    value: "30",
    description: "Days past due before an account may be auto-suspended",
  },
  {
    key: SYSTEM_SETTING_KEYS.companyName,
    value: "My ISP",
    description: "Company name printed on receipts and reports",
  },
  {
    key: SYSTEM_SETTING_KEYS.companyAddress,
    value: "...",
    description: "Company address printed on receipts and reports",
  },
  {
    key: SYSTEM_SETTING_KEYS.companyPhone,
    value: "...",
    description: "Company phone number printed on receipts",
  },
  {
    key: SYSTEM_SETTING_KEYS.receiptFooterText,
    value: "Thank you for your payment!",
    description: "Message printed at the bottom of an Official Receipt",
  },
];

/**
 * Reads an integer setting, falling back when the stored value is missing or not
 * a whole number. Settings are text, so a hand-edited row must never be able to
 * turn a monetary amount into `NaN` deep inside a calculation.
 */
export function parseIntSetting(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}
