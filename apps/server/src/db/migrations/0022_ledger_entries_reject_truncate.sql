-- WP2 §5 (S8-2 companion) — extend the ledger append-only guard to TRUNCATE.
--
-- 0011_ledger_entries_append_only.sql rejects UPDATE and DELETE on ledger_entries,
-- but TRUNCATE slips past: PostgreSQL allows a TRUNCATE trigger only at STATEMENT
-- level, while the existing trigger is FOR EACH ROW, so a single
-- `TRUNCATE ledger_entries` could still erase every balance in the system.
--
-- This adds the missing statement-level trigger using the same function and the
-- same message style. The function is CREATE OR REPLACE and the trigger is dropped
-- first, so the migration is safe on a fresh database and on one where the trigger
-- already exists.
CREATE OR REPLACE FUNCTION bcis_prevent_ledger_entry_mutation() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'ledger_entries is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS ledger_entries_append_only_truncate ON "ledger_entries";--> statement-breakpoint
CREATE TRIGGER ledger_entries_append_only_truncate
	BEFORE TRUNCATE ON "ledger_entries"
	FOR EACH STATEMENT EXECUTE FUNCTION bcis_prevent_ledger_entry_mutation();
