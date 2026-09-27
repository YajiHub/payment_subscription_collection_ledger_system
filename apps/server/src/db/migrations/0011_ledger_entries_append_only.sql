-- WP1 §3 — the ledger is append-only at the DATABASE level (S1-4).
--
-- The service layer never updates or deletes a ledger entry; a correction is a
-- new, offsetting entry. Only audit_logs had a database backstop (see
-- 0008_smooth_magus.sql), so any code path that bypassed the service could still
-- silently rewrite a balance. This migration mirrors that trigger for
-- ledger_entries.
--
-- The function is CREATE OR REPLACE and the trigger is dropped first, so the
-- migration is safe to apply to a fresh database and to one where the trigger
-- already exists.
CREATE OR REPLACE FUNCTION bcis_prevent_ledger_entry_mutation() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'ledger_entries is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS ledger_entries_append_only ON "ledger_entries";--> statement-breakpoint
CREATE TRIGGER ledger_entries_append_only
	BEFORE UPDATE OR DELETE ON "ledger_entries"
	FOR EACH ROW EXECUTE FUNCTION bcis_prevent_ledger_entry_mutation();
