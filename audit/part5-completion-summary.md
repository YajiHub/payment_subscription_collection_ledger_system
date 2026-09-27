# Part 5 — Completion summary

Scope: bring the repository to compliance with
`BCIS_Subscription_Billing_and_Collection_Laboratory_Activity (1).pdf`.
Work packages, their spec IDs and their reviews live in `part3-implementation-plan.md`;
deferred items and reviewer findings live in `part4-follow-ups.md`.

## Verified state at hand-off

Commands run against the working tree, not reported by an agent:

| Command | Result |
| --- | --- |
| `pnpm typecheck` | exit 0 (shared, server, client) |
| `pnpm lint` | exit 0 |
| `pnpm test` | **862 tests**: 740 server across 65 files, 122 client across 22 files, 0 skipped |
| `pnpm test:e2e` | 1 Playwright Electron workflow test passes against the built app |
| `pnpm screenshots` | 9 images across the 7 screens section 9 D7 requires |
| `pnpm db:seed:demo` | section 8 minimums met; ledger nets to outstanding (PHP 179,402.50) |
| Migrations | 25 files, `0000`–`0008` byte-identical; no `DROP TABLE`, `DROP COLUMN`, `DELETE FROM` or data `TRUNCATE` |

The PostgreSQL-gated suites run live (PostgreSQL 16); none of them silently skip.

## Requirements closed in this pass

- **Rubric B — schema and integrity.** RBAC as tables, a partial unique index making
  duplicate billing a database invariant, append-only triggers on the ledger covering
  `UPDATE`, `DELETE` and `TRUNCATE`, trigram search indexes, and the missing domain tables.
- **Rubric C — billing, ledger and payments.** The seven section 3.4 invoice states including
  `CREDITED`, discount and installation fee as first-class line items with an integer rounding
  rule, advisory-locked invoice numbering, an atomic and idempotent monthly run, all five
  payment methods, and GCash as a claim that only verification settles.
- **Rubric D — collections and receivables.** The six-state batch lifecycle with a remittance
  history and a separate close, a printable route sheet, a per-method batch summary, the
  missing overdue fields and filters, enforced suspension threshold, and reconnection records.
- **Rubric E — UI/UX.** The section 4.1 palette as tokens, Inter bundled for an offline
  install, right-aligned tabular financial values, a print layout with no application chrome,
  the section 4.2 navigation including Services, sticky sortable paginated tables, inline
  field validation, and the GCash verification screen.
- **Rubric F — security, RBAC and audit.** Permissions resolved from the database and failing
  closed, per-account login lockout that cannot be extended by hammering, an idle session lock
  that revokes the token, backup and restore as an application feature, audit coverage for the
  consequential actions, and an authorization matrix derived from the real route table.
- **Rubric G — reports and dashboard.** 18 report families with their filters reaching SQL,
  formatted money in exports, genuinely paginated invoice and payment lists, and a visible
  export row cap.
- **Rubrics H and I — testing and evidence.** AT-01…AT-12 traceability, a raw committed test
  report, a bug log with root causes verified against git history, and screenshots of the
  required screens.
- **Rubric J — demonstration.** A deterministic synthetic dataset meeting every section 8
  minimum, so the section 11.1 sequence can actually be performed.

## Remaining gaps, stated plainly

| Gap | Detail | Why it was not closed |
| --- | --- | --- |
| **AT-09 PARTIAL** | Concurrency is proven on one database (concurrent postings, concurrent invoice numbering, concurrent billing runs, per-collector isolation) but not across three workstations. | Three PCs are not available in this environment; the capability is proven where it can be. |
| **AT-12 PARTIAL** | The backup path is tested, including refusing an unverified or corrupt archive, but through a fake script runner. No automated `pg_dump` → mutate → `pg_restore` → integrity round trip exists. | A destructive restore cannot run against the development database unattended; the manual procedure is documented. |
| **WP11 not done** | Electron 32 (not 44), React 18 (not 19.2), Zod 3 (not 4). | The PDF calls this stack *recommended*; the installed versions work, and `part2-spec.md` §12 records each substitution with its rationale. Lowest value per unit of risk. |
| **Follow-ups F1–F9** | Thin coverage of the database-resolved permission path at route level, lockout scan window, backup gzip-bomb and symlink hardening, a missing lockout boundary test, a deactivated-account oracle, the Services navigation alias. | Listed with owners in `part4-follow-ups.md`. |
| **Installer** | No Windows `.exe` was built. | Requires a Windows host; the packaging configuration exists and Linux directory packaging was validated. |

## Policies the owner decided

- **GCash stays a single-person control** (a Cashier may record and verify), matching sections
  3.1 and 3.7. The detective controls are reference uniqueness, retained verifier identity and
  the audit trail.
- **The operational settings endpoint stays open** to any signed-in role; its values are not
  secrets and every change is audited.
- **The evidence pack was produced in full** (traceability, bug log, screenshots).

## How to verify this yourself

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm test          # 862 tests, 0 skipped
pnpm db:migrate                                    # 25 migrations on a fresh database
pnpm db:seed:demo                                  # section 8 dataset, prints the demo logins
pnpm dev                                           # API on 3003, Electron client
pnpm test:e2e                                      # Playwright against the built app
pnpm screenshots                                   # regenerate the section 9 D7 evidence
pnpm submission                                    # assemble the submission folder
```

## Process note

Every work package was reviewed by a model that had not written it, and three reviews rejected
the work outright. The rejections were the valuable part: the audit reviewer found five
fail-open paths in the authorization rewrite (a user missing from `user_roles` recovered the
full compiled permission set), and the money reviewer found that voiding a draft invoice
credited money that was never debited, driving the ledger negative. Both were reported as
passing by the builders that wrote them. Every claim in this document was re-verified against
the working tree before it was written down.
