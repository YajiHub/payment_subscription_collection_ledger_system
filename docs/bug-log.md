# Bug log

Real defects found and fixed while bringing this repository to the activity's
requirements. Each entry records the symptom, how it was found, the root cause
with the file and line, the fix, and the regression test that now guards it. The
entries are ordered most severe first.

Every commit, file and test name below is real and can be checked in this
repository's history and source. Nothing here is reconstructed from memory.

---

## 1. The client did not compile (79 TS2307 errors) — blocking

**Symptom.** `pnpm typecheck` failed in `apps/client`: 79 `TS2307` "cannot find
module" errors. `pnpm build` could not produce a renderer, so no demo, no
installer, and no submission were possible as the tree stood.

**How it was found.** The Part 1 audit ran the verification commands and captured
the failure; the audit recorded it as the rubric-E blocking finding
(`audit/part1-audit-findings.md`, "Client build" and the verification table). The
pattern was exact: eighteen page modules each import
`../components/layout/AppShell` and `../components/ui/{Button,Card,Badge,EmptyState,Modal}`,
and **none of those six files existed on disk**. The refactor had been started
and left unfinished (pages were migrated onto components that were never written).

**Root cause.** Missing modules, not a wrong import. For example
`apps/client/src/pages/ReportsCenterPage.tsx:34-39` imports `Card`, `Button`
and `EmptyState` from `../components/ui/…`; `git ls-files apps/client/src/components/ui`
listed none of them. All 79 errors are the same six unresolved module specifiers.

**Fix.** Commit `d7f7df8` (`feat(client): rebuild the interface on shared
primitives, design tokens and data tables`) created the six modules with the prop
surfaces the existing pages already use:
`apps/client/src/components/layout/AppShell.tsx`,
`apps/client/src/components/ui/{Button,Card,Badge,EmptyState,Modal}.tsx`.
`Modal.tsx` implements focus trapping, Escape to close and focus restore
(S0-4). `pnpm typecheck` now exits 0.

**Regression test.**
- `apps/client/src/components/ui/Modal.test.tsx` — 12 tests, including
  "moves focus into the dialog when it opens", "calls onClose when Escape is
  pressed", "wraps Tab from the last focusable element back to the first",
  "returns focus to the trigger when it closes".
- `apps/client/src/components/AppNavigation.test.tsx` — "lists every section of
  section 4.2 in order, Dashboard first", "withholds the screens a role may not open".
- The build gate itself: `pnpm typecheck` is part of the definition of done and
  now exits 0 for all three workspace projects.

---

## 2. Voiding a draft invoice credited money that was never debited

**Symptom.** Voiding a draft invoice wrote a ledger credit for the invoice's full
total even though posting that draft had never debited anything. The account's
ledger balance fell below what it owed before the invoice existed and could be
driven negative — the exact corruption the append-only ledger was meant to
prevent.

**How it was found.** Reviewing the void path during the WP2 ledger work: the
void credit amount came from the invoice's own `totalAmountCentavos` while the
matching debit only exists once the invoice is posted. A draft that was never
posted therefore had a credit with no debit, and a draft paid down by an advance
credit had debited only the credited amount, not the whole total.

**Root cause.** `recordInvoiceVoided` in
`apps/server/src/modules/ledger/ledger.service.ts` (now line 345) credited
`invoice.totalAmountCentavos`. The invoice total says what the invoice *would*
cost, not what the ledger actually recorded.

**Fix.** Commit `36224c8` (`feat(server): bring the API to the activity's
requirements`). `recordInvoiceVoided` now reads what the invoice really debited
via `getInvoiceDebitedCentavos` (same file, line 415, summing the invoice's
`invoice_posted`, `advance_credit_applied` and `late_fee` entries) and returns
without writing any entry when that amount is `<= 0`. A never-posted draft is
voided with no ledger entry; a draft an advance credit settled is credited back
exactly what was debited. `apps/server/src/modules/billing/void-invoice.service.ts:35`
routes the void through this path.

**Regression test.**
- `apps/server/test/billing-engine.postgres.test.ts` — "voids a plain draft
  WITHOUT writing a ledger entry, because it never debited one" and "voids a
  draft an advance credit already settled, crediting exactly what was debited".
- `apps/server/test/billing.routes.test.ts` — "voids a draft without writing a
  ledger entry, because a draft never debited one" and "credits a draft only the
  amount an advance credit already debited".
- `apps/server/test/ledger.postgres.test.ts` — "posts invoice → payment →
  reversal and keeps the ledger chain sound" checks the balance never falls below
  the pre-invoice level.

---

## 3. The database-backed permission resolver fell open

**Symptom.** When permissions began resolving from `user_roles` instead of the
compiled `ROLE_PERMISSIONS` matrix, two fail-open paths appeared:

1. a user who had **no** `user_roles` rows (all grants revoked, or a user created
   but never granted) regained the **full compiled permission set** of their
   legacy `users.role`; and
2. after an invalidation, the cache could keep answering from the compiled matrix
   for up to the cache TTL (`RBAC_PERMISSION_CACHE_TTL_MS`, default 30 s).

**How it was found.** Writing the RBAC tests: the "revoke every grant" case
granted administrator capabilities instead of denying them, and a role change
through the API did not take effect on the next request until the TTL elapsed.
Both are privilege-escalation windows in a system whose whole point is
server-side RBAC.

**Root cause.** The resolver used the compiled matrix as a general fallback
rather than only as the explicit rollback switch, and an invalidation left a
stale compiled snapshot usable until the TTL. The relevant logic is
`apps/server/src/shared/rbac/permission-resolver.ts`.

*Honest note on the history:* the database-backed resolver and its fail-closed
hardening landed in the **same** commit (`36224c8`), so there is no separate
pre-fix commit to point at — before that commit authorization used the compiled
matrix only (`apps/server/src/shared/middleware/authorize.ts` at `36224c8^`,
`roleHasPermission(...)`). The fail-open design was caught while writing the deny
cases, which were required to fail before the module was accepted; the test names
below record what would have happened.

**Fix.** Commit `36224c8`.
- `callerHasPermission` (line 190) resolves on demand when the cache is
  `"unloaded"` and **denies** a user absent from the resolved grants (line 206,
  `?? false`); it never falls back to the compiled role set.
- The compiled matrix is used **only** when the `rbac_permissions_in_database`
  setting is the explicit string `"false"` (rollback switch). A missing or
  garbage setting, a database error, and an empty grant set all deny.
- `invalidatePermissionCache` (line 81) always resets to `"unloaded"` and bumps a
  monotonic epoch; `refreshPermissionCache` captures the epoch at start (line 113)
  and discards its result if an invalidation landed meanwhile (lines 146 and
  166), so an in-flight refresh cannot resurrect old authority.
- A database failure during a refresh moves the cache to `"denied"` (fail
  closed) rather than compiled.

**Regression test.**
- `apps/server/test/permission-resolver.test.ts` — "DENIES a user with no
  resolved grants instead of using the compiled matrix", "falls back to the
  compiled matrix only for the explicit 'false' switch", "treats a MISSING switch
  row as database authority (not compiled)", "treats a GARBAGE switch value as
  database authority (not compiled)", "FAILS CLOSED when the database is
  unavailable during a refresh", "discards an in-flight refresh that an
  invalidation superseded".
- `apps/server/test/rbac-permission-cache.postgres.test.ts` — "denies a user
  whose user_roles rows are all deleted (no compiled fallback)", "honours a
  role_permissions change after the real invalidation path", "revokes the
  previous role's permissions on the next request after an API role change".
- `apps/server/test/rbac-matrix.test.ts` — "allows and denies the seven stored
  roles via the database-resolved path".

---

## 4. Audit helpers recorded hardcoded status literals

**Symptom.** The audit trail could name a state transition that never happened.
Remitting a batch wrote `open → submitted` when the truth was `submitted →
remitted`; reconciling wrote `submitted → reconciled`; a second retire of a plan
still recorded `isActive: true → false`; a payment reversal and a GCash
verification/rejection assumed a fixed prior status. Section 11.1 asks the
operator to demonstrate a reversal *and its audit trail*, so a row that misreports
the change is worse than no row.

**How it was found.** While adding audit coverage for the operations section 5
requires (S5-6), the new tests asserted the *literal* the helper wrote instead of
the real prior state, and the literals did not match the transitions the service
performed. Comparing the audit row against the row the service had just locked
made the mismatch obvious.

**Root cause.** `apps/server/src/shared/audit/audit-logger.ts` computed
`previousState` from constants rather than from the record it was changing:
`paymentReversed` assumed `status: "posted"`, `gcashPaymentVerified` /
`gcashPaymentRejected` assumed `"pending_verification"`, `planRetired` assumed
`isActive: true`, and `collectorBatchSubmitted` assumed `status: "open"`.

**Fix.** Commit `249e23e` (`fix(server): record the real prior state in audit
snapshots`). Each helper now takes the real prior value as a parameter and the
callers thread it in from the locked row:
`paymentReversed` (audit-logger.ts:139, `previousStatus` at :145),
`gcashPaymentVerified` / `gcashPaymentRejected` (:293/:314, `previousStatus` at
:297), `planRetired` (:373, `previousIsActive` at :377), and
`collectorBatchSubmitted` (:407). The tests now assert recorded previous/next
values rather than the literals the code happens to write.

**Regression test.**
- `apps/server/test/audit-coverage.test.ts` — "records a collector batch
  remittance as submitted/remitted to remitted, never open/submitted", "records a
  payment reversal as posted to reversed, with the real prior status", "records
  the plan's real prior active flag on a retire, not a hardcoded true", "records a
  GCash rejection with the verifier identity, the real prior status and the
  reason".
- `apps/server/test/audit.routes.test.ts` — "records the invoice's real prior
  status on a void, whichever status it was".
- `apps/server/test/collections.routes.test.ts` — "submits an in-progress batch
  as its own step, then records an exact remittance" asserts the submitted audit
  row names `in_progress` (the real prior status), not `open`.

---

## 5. Login lockout could be extended indefinitely by hammering

**Symptom.** Per-account lockout (S5-5) could be kept alive forever. Every failed
attempt while an account was locked advanced the "last failure" timestamp
forward, so the cooldown never elapsed. An attacker who had locked an account
could keep a legitimate user locked out indefinitely by simply retrying.

**How it was found.** Writing the lockout boundary tests: the N-1 / N / cooldown
cases passed, but a test that hammered a locked account showed the unlock time
moving forward with each attempt instead of staying fixed.

**Root cause.** `apps/server/src/modules/auth/login-lockout.service.ts` anchored
the lock window to the *most recent* failure (`lastFailureAt`) rather than to the
failure that reached the threshold.

*Honest note on the history:* the per-account lockout feature and its anchor
landed in the **same** commit (`36224c8`); there is no earlier lockout file in the
tree. The sliding-window design was rejected while writing the "hammer the locked
account" test, which reported an unlock time that kept moving forward instead of
staying fixed.

**Fix.** Commit `36224c8`. `summarizeFailureStreak` (line 98) now records the
failure at index `threshold - 1` as `lockStartedAt` (lines 107 and 116) — the
instant the count reached the threshold — and `isAccountLocked` (line 165)
computes `unlocksAt` from that anchor (:166). Further attempts while locked cannot
move the anchor, and once the cooldown elapses a genuinely new failure streak may
form a fresh lock.

**Regression test.**
- `apps/server/test/login-lockout.test.ts` — "cannot be extended by hammering
  while locked", "unlocks on schedule however many attempts arrived", "forms a
  fresh lock after the cooldown, so protection resumes", "locks the account at N
  failures", "keeps the account open at N-1 failures".
- `apps/server/test/login-lockout.postgres.test.ts` — "counts three consecutive
  failures and anchors a lock", "clears the counter after a successful login,
  without deleting a row".

---

## Summary

| # | Defect | Severity | Fix commit | Guarded by |
| --- | --- | --- | --- | --- |
| 1 | Client did not compile (79 TS2307, six missing UI modules) | Blocking | `d7f7df8` | `Modal.test.tsx`, `AppNavigation.test.tsx`, `pnpm typecheck` |
| 2 | Voiding a draft credited money never debited → negative ledger | Financial integrity | `36224c8` | `billing-engine.postgres.test.ts`, `billing.routes.test.ts` |
| 3 | Permission resolver fell open (absent user, stale TTL) | Security | `36224c8` | `permission-resolver.test.ts`, `rbac-permission-cache.postgres.test.ts` |
| 4 | Audit helpers recorded hardcoded status literals | Audit integrity | `249e23e` | `audit-coverage.test.ts`, `audit.routes.test.ts` |
| 5 | Login lockout extendable by hammering | Security / availability | `36224c8` | `login-lockout.test.ts`, `login-lockout.postgres.test.ts` |

Five entries, each with symptom, discovery, root cause, fix and a regression
test. The activity's section 7.1 asks for "at least discovered issue, root cause,
fix and regression test"; this log exceeds that minimum.