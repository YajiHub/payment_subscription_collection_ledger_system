// Validation schemas for the ledger, balance, and statement-of-account endpoints.
//
// The server validates every request with these schemas; the client uses the same
// shapes to disable a button or show a hint before a round trip. The server remains
// the authority.
//
// Money is always an integer number of centavos (see types/money.ts).

import { z } from "zod";

import { LEDGER_ENTRY_TYPES, MANUAL_LEDGER_ENTRY_TYPES } from "../constants/ledger";

/** The filters the ledger page may apply. Dates are inclusive calendar days. */
export const listLedgerQuerySchema = z.object({
  fromDate: z.string().date("Start date must be a calendar date (YYYY-MM-DD)").optional(),
  toDate: z.string().date("End date must be a calendar date (YYYY-MM-DD)").optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListLedgerQuery = z.infer<typeof listLedgerQuerySchema>;

/** The period a statement covers. Both bounds are optional; omitting them shows all. */
export const statementQuerySchema = z.object({
  fromDate: z.string().date("Start date must be a calendar date (YYYY-MM-DD)").optional(),
  toDate: z.string().date("End date must be a calendar date (YYYY-MM-DD)").optional(),
});
export type StatementQuery = z.infer<typeof statementQuerySchema>;

/** A ledger entry type path/query filter, used by the listing endpoint. */
export const ledgerEntryTypeSchema = z.enum(LEDGER_ENTRY_TYPES);

/**
 * A manual debit or credit.
 *
 * Only the two manual types are accepted here: every other entry type is derived
 * from a document. `reason` is required and is the entry's description on the
 * statement, so there are no unexplained adjustments.
 */
export const manualLedgerEntrySchema = z.object({
  serviceAccountId: z.string().uuid("A valid service account id is required"),
  entryType: z.enum(MANUAL_LEDGER_ENTRY_TYPES),
  amountCentavos: z
    .number()
    .int("The amount must be a whole number of centavos")
    .positive("The amount must be greater than zero"),
  reason: z
    .string()
    .trim()
    .min(10, "Justification must be at least 10 characters")
    .max(500, "Justification must be at most 500 characters"),
});
export type ManualLedgerEntryFields = z.infer<typeof manualLedgerEntrySchema>;
