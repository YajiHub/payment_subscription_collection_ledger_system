# Acceptance-test traceability — AT-01 … AT-12

This document maps each mandatory acceptance test in **section 7** of
`BCIS_Subscription_Billing_and_Collection_Laboratory_Activity (1).pdf` to the
test(s) that actually prove it in this repository. Every mapping below was built
by reading the suite in `apps/server/test/**` and `apps/client/src/**`, not
copied from another document. Where a test proves only part of the scenario, the
verdict says so in plain words instead of claiming a pass.

- **Repository revision:** `daed2aa` (`feat(server): seed a synthetic demo dataset meeting section 8`)
- **Run date:** 2026-09-27
- **Command:** `pnpm test` (see `docs/testing/test-report.txt` for the raw output)
- **Result:** 738 server tests in 65 files and 116 client tests in 20 files, all passing.
  The `.postgres.test.ts` suites ran against a live PostgreSQL 16.15 `bcis_test` database;
  none were skipped.

Verdicts used: **PASS** (the scenario's expected result is asserted),
**PARTIAL** (only part of the scenario is exercised), **UNCOVERED** (no test).

| AT | Scenario quoted from the activity | Expected result (activity) | Proving test (file — exact test name) | Verdict |
| --- | --- | --- | --- | --- |
| AT-01 | Exact payment | "receipt created." | `apps/server/test/payments.postgres.test.ts` — "posts a payment oldest-first, then reverses it and restores the invoice balances" asserts `posted.payment.receiptNumber` matches `^OR-\d{4}-\d{6}$`; `apps/server/test/payments.routes.test.ts` — "marks an invoice PAID when the payment covers it exactly" asserts status `paid` with `remainingBalanceCentavos: 0`; "issues receipt numbers in OR-YYYY-XXXXXX format, one past the highest existing" asserts the returned and stored `receiptNumber`. | PASS |
| AT-02 | Partial payment | "ledger correct." | `apps/server/test/payments.routes.test.ts` — "posts a cash payment and allocates it oldest-invoice-first" asserts a partial cover leaves the newest invoice `partially_paid`; `apps/server/test/payment-allocation.test.ts` — "applies a partial payment and leaves the rest on the invoice" and "marks a fully covered invoice paid and a partially covered one partially paid". | PASS |
| AT-03 | Advance payment | "Allocation/credit follows documented policy without losing value." | `apps/server/test/payments.routes.test.ts` — "turns the amount beyond every invoice into an advance credit"; `apps/server/test/payments.postgres.test.ts` — "applies an advance credit to the next generated monthly invoice" (asserts the value is not lost across periods); `apps/server/test/billing.routes.test.ts` — "posts a fully credit-covered draft as CREDITED without a new ledger debit"; `apps/server/test/billing-engine.postgres.test.ts` — "marks an invoice CREDITED when advance credit fully settles it". | PASS |
| AT-04 | Oldest-first arrears | *(the activity's Expected Result cell is blank for this row)* | `apps/server/test/payments.routes.test.ts` — "posts a cash payment and allocates it oldest-invoice-first" asserts the allocation array is `[oldest, newest]` and settles the oldest first; `apps/server/test/payment-allocation.test.ts` — "fills the oldest invoice first, then the next". | PASS |
| AT-05 | Duplicate GCash reference — Test data: "Post an already-used verified GCash reference" | "System blocks or explicitly warns according to documented verification policy." | `apps/server/test/payments.routes.test.ts` — "rejects a duplicate GCash reference number with a 409, not a 500" and "blocks a duplicate GCash reference however it is formatted (S12-7)"; `apps/server/test/payments.postgres.test.ts` — "rejects a duplicate GCash reference number with a 409"; `apps/server/test/gcash-verification.test.ts` — "treats a reformatted reference as the same transfer". The policy itself is documented in `docs/technical/README.md`. | PASS |
| AT-06 | Payment reversal — Test data: "Reverse an incorrectly posted payment" | "Original remains visible; linked reversal exists; balances restore; actor/reason audited." | `apps/server/test/payments.routes.test.ts` — "reverses a payment: the original row is kept, a reversal is recorded, a debit cancels the credit", "rejects a reversal reason shorter than 10 characters", "keeps reversed payments in the history"; `apps/server/test/payments.postgres.test.ts` — "posts a payment oldest-first, then reverses it and restores the invoice balances" asserts `reversalReceiptNumber` matches `^RV-\d{4}-\d{6}$` and the invoice balances return. | PASS |
| AT-07 | Collector balanced remittance | *(the activity's Expected Result cell is blank for this row)* | `apps/server/test/collections.routes.test.ts` — "submits an in-progress batch as its own step, then records an exact remittance" (asserts `varianceCentavos: 0` and a stored remittance row) and "reconciles an exact remitted batch and reports that the ledger agrees"; `apps/server/test/collections.postgres.test.ts` — "keeps the batch total exact as collections are added and voided". | PASS |
| AT-08 | Collector shortage | "500 shortage displayed; cannot silently close as balanced." | `apps/server/test/collections.routes.test.ts` — "stores a shortage as a negative variance at remittance, never absorbing it" (asserts `varianceCentavos: -5000` on a 45 000 remittance against a 50 000 expectation), "requires variance notes when reconciling a variance", "stores an overage as a positive variance", "refuses to close a batch that was not reconciled first". | PASS |
| AT-09 | Concurrent users — Test data: "Two/three PCs post/read different valid operations" | "No data corruption, duplicate numbering or unauthorized cross-session effect." | Server-side concurrency is proven: `apps/server/test/ledger.postgres.test.ts` — "serializes two concurrent postings for the same account"; `apps/server/test/collections.postgres.test.ts` — "generates unique batch numbers concurrently for the same date" and "isolates one collector's batch from another collector"; `apps/server/test/billing-engine.postgres.test.ts` — "allocates distinct invoice numbers for two concurrent allocations in one period" and "serializes two concurrent monthly billing runs for one period". **See the honest caveat below.** | PARTIAL |
| AT-10 | Authorization — Test data: "Cashier attempts admin-only user/backup operation" | "Server rejects operation even if API is called directly." | `apps/server/test/rbac-matrix.test.ts` — "allows and denies every role on every permissioned route exactly as the matrix says" and "allows and denies the seven stored roles via the database-resolved path" (both sweep *every* route through `server.inject`, i.e. the API called directly, bypassing the UI); `apps/server/test/users.routes.test.ts` — "returns 403 when a non-admin tries to create a user" and "returns 403 when a Cashier calls POST /api/invoices/generate"; `apps/server/test/security-hardening.test.ts` — "denies a Cashier changing any user's role to administrator" and "denies a Manager deactivating a user account"; `apps/server/test/audit.routes.test.ts` — "denies a Cashier the audit trail with 403". | PASS |
| AT-11 | Duplicate billing — Test data: "Run billing generation twice for same period" | "No duplicate finalized invoice for same service account/period." | `apps/server/test/billing.routes.test.ts` — "is idempotent: re-running a billed period bills nobody twice and writes nothing new"; `apps/server/test/billing-engine.postgres.test.ts` — "runs monthly billing atomically and idempotently for a period", "bills a service account activated after the period had already been run" (the run does what the preview promised instead of repeating an earlier run's totals) and "serializes two concurrent monthly billing runs for one period"; `apps/server/test/wp1-schema.postgres.test.ts` — "rejects a second live invoice for the same service account and period" proves the partial unique index is a database invariant, not just a service-level check. | PASS |
| AT-12 | Backup/restore — Test data: "Create test backup, change data, restore approved backup" | "Restored database passes integrity check and expected records return." | `apps/server/test/backup.routes.test.ts` — "creates a backup, verifies it, and records it in backup_history", "refuses to restore an archive that has not been verified, without running pg_restore", "restores a verified archive by running restore.sh with an explicit confirmation"; `apps/server/test/deployment-artifacts.test.ts` — "ships the backup and restore scripts, wired to pnpm". **See the honest caveat below.** | PARTIAL |

## Coverage caveats (stated plainly)

- **AT-09 is only partly covered.** Every concurrency proof runs inside a single
  Vitest process against one PostgreSQL connection pool. Nothing here exercises
  two or three separate workstation clients, and nothing simulates a genuinely
  independent session writing at the same time. The server-side invariants
  (advisory-locked numbering, the unique period index, the append-only ledger
  trigger) are the mechanism that would protect three PCs, and they are tested —
  but the letter of the AT ("Two/three PCs post/read different valid
  operations") is not met by an automated test. The three-client demo is manual.

- **AT-12 is not a true end-to-end restore.** The automated suite proves the
  application's backup and restore *workflow*: it creates and verifies an
  archive, refuses an unverified or corrupt one, and runs the shipped
  `scripts/restore.sh` with the explicit confirmation. But the test injects a
  recording runner in place of the shell script, so no real `pg_restore` runs,
  nothing is mutated, and no integrity check reads back expected records. The
  real backup → mutate → restore → verify sequence was run by hand and is
  recorded in `docs/known-limitations.md` §4. Treat AT-12 as **PARTIAL**: the
  application path is tested; the database round trip is manual evidence.

- **Two tests are the only place a row's expected result is blank.** AT-04 and
  AT-07 have no Expected Result in the activity table. For AT-04 the mapping
  asserts the oldest-first allocation order itself; for AT-07 it asserts a
  zero-variance exact remittance. Both mark PASS on the scenario, not on a
  missing expected text.

## Summary

| Verdict | Count |
| --- | --- |
| PASS | 10 |
| PARTIAL | 2 (AT-09, AT-12) |
| UNCOVERED | 0 |

No acceptance test is fully uncovered. The two partials are partial for the
reasons above and are not hidden behind a PASS.