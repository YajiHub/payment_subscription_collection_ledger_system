-- WP2 §S2-3 — the installation fee is a first-class invoice type.
--
-- Like a reconnection fee, an installation fee is billed as its own one-off
-- invoice with an `installation_fee` line item. Adding the enum label here keeps
-- the type list aligned with INVOICE_TYPES in packages/shared; existing rows are
-- untouched because the new label is appended before `adjustment`.
ALTER TYPE "public"."invoice_type" ADD VALUE IF NOT EXISTS 'installation_fee' BEFORE 'adjustment';
