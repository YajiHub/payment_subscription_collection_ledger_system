# Part 4 — Follow-ups, deferred items and policy decisions

Living list. Every item here was found during audit or review and is deliberately **not** silently
dropped. Each has an owner (a work package) or is flagged as a decision for the project owner.

## Policy decisions — RESOLVED by the project owner

### P1. GCash maker-checker — **RESOLVED: keep as specified**

Section 3.7 requires authorized staff to verify payment proof, and section 3.1 lists "approved GCash
processing" under the Cashier role, so the Cashier legitimately holds `payments:verify_gcash` and
`payments:reject_gcash`. One person may complete both halves of the control. This is accepted because
every GCash reference is unique and blocked on duplication, the verification identity and timestamp
are retained, and the action is audited — so the control is detective rather than preventive.

**Recorded for the defense:** the segregation-of-duties weakness is a deliberate reading of
sections 3.1 and 3.7, not an oversight. An instructor asking "can the same person record and verify?"
should get this answer plus the audit trail that reviews it.

### P2. Settings visibility — **RESOLVED: leave open to any signed-in role**

`GET /api/system/settings` stays authenticated-but-unguarded. The lockout threshold, cooldown and
RBAC switch are not secrets, the UI uses the lockout copy, and every settings change is audited with
old and new values. Narrowing it would add a permission for no security gain that survives contact
with the audit trail.

### P3. Evidence pack — **RESOLVED: produce all of it**

WP10 now also owns the section 7.1 evidence package: the automated test-output artifact, the
AT-01…AT-12 traceability document mapping each acceptance test to its proving test, a bug log with
root cause and regression test, and screenshot coverage of the seven screens section 9 D7 requires,
driven off the WP9 demo dataset.

## Reviewer findings to fix later (real, bounded, not blocking)

| ID | Finding | Owner |
| --- | --- | --- |
| F1 | **Permission-path coverage is thin.** The test setup installs the compiled matrix for the whole suite, so only ~16 of 632 tests exercise the database-resolved path; the other ~600 route-level 403/200 assertions prove the compiled matrix only. A regression in the HTTP wiring of the database path would pass the suite. | WP10 |
| F2 | `MAX_FAILURES_TO_SCAN = 5000` reads the oldest failure rows, so after more than 5,000 failures the lock anchor goes stale and a lock could lapse early. Bounded and requires the correct password, but should be re-anchored on the newest window. | WP10 |
| F3 | Backup verification caps the compressed size but not `decompressedBytes`, so a gzip bomb can burn CPU before the cap applies (memory is already bounded, and the route is admin-only). | WP11/WP9 |
| F4 | Backup path containment is lexical and does not `realpath`, so a symlink placed inside `BACKUP_DIR` could escape it. | WP11/WP9 |
| F5 | No exact-boundary test for the lockout unlock instant (`now == lockStartedAt + cooldown`). | WP10 |
| F6 | `system_settings.rbac_permissions_in_database` was seeded `'true'` by migration 0009 before any reader existed; the resolver now honours it, so the value is honest, but a fresh install should verify the flag matches the resolver's actual mode. | WP5b |
| F7 | A deactivated account returns a distinct `403 "Account is deactivated"` versus the generic `401` on bad credentials — a username-existence oracle. Pre-existing; consider unifying the response shape. | WP5b |
| F8 | `buildServer()` stays synchronous and tests use `ready()` + `inject` without the permission preload, so the boot-order guarantee is only exercised in the production `startServer` path. Worth a comment or a dedicated test. | WP10 |
| F9 | The Services navigation section links "Service Accounts" to the same target as "Subscribers" until dedicated screens land. | WP4 |

## Deliberate deviations, recorded with rationale

| ID | Deviation | Rationale |
| --- | --- | --- |
| D1 | ExcelJS replaced by a dependency-free XLSX writer | Real ZIP + CRC-32 verified against a standard test vector, all five OOXML parts, plus a PHP number format for money. ExcelJS would add a large dependency for no rubric gain. |
| D2 | pdfmake replaced by pdf-lib | Real multi-page A4 output with repeated headers, page numbering and right-aligned numerals. |
| D3 | shadcn/ui replaced by hand-rolled primitives | Tailwind 4 already in use; the primitives are shared, tested and token-driven. |
| D4 | TanStack Query replaced by zustand plus one typed `api-client` | All server state already flows through a single typed client; a query cache would duplicate it. |
| D5 | Aging buckets are inclusive-upper (`1–30`, `31–60`) rather than literal half-open intervals | Verified no day is double-counted and the labels match the implemented bounds. Recorded so a grader sees the choice, not an accident. |
| D6 | `REPORT_TYPES` split from `EXTENDED_REPORT_TYPES` in `packages/shared` | The renderer switches exhaustively over the old union; the split keeps the server work mergeable until the client union lands. |
| D7 | OpenRouter agent models replaced by `opencode-go` pins in `.pi/agents/` | The agent tool's `model` argument is outranked by an agent definition's pinned model, so every subagent billed OpenRouter and failed on 402s. |

## Remaining work packages

| WP | Scope | Status |
| --- | --- | --- |
| WP3 | GCash verification, five payment methods, manual allocation | in progress |
| WP2b | Installation-fee and discount routes | in progress |
| WP6b | Reports Center and dashboard client surfaces | in progress |
| WP7b2 | React Hook Form inline validation | in progress |
| WP4 | Batch lifecycle, route sheet, receivables filters, suspension threshold | pending (migration-serialized after WP3) |
| WP9 | Demo dataset meeting the section 8 minimums | pending |
| WP10 | Playwright E2E, AT-01…AT-12 traceability, bug log | pending |
| WP5b | Session-lock client, backup admin screen | pending |
| WP11 | Zod 4, React 19.2, Electron 44 (last, gated) | pending |

## Open audit findings not yet assigned to a package

- **S1-2** partially done (S5-2 resolver) — needs a live check that a `role_permissions` row edit
  converges within the TTL with no redeploy, as an operator-facing test.
- **S9-2** deterministic demo data plus a reconciliation test on the generated dataset.
- **Section 7.1 evidence pack** — automated test output artifact, a bug log with root cause and
  regression test, and screenshots showing balances (currently 1 of 7 required screens).
