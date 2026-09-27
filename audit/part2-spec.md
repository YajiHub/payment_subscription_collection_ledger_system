# Part 2 — Specification

Tight specification for every change required to bring this repository to compliance with
`BCIS_Subscription_Billing_and_Collection_Laboratory_Activity (1).pdf`. Derived from
`part1-audit-findings.md`; every item below traces to an audit finding.

## 0. Decisions already taken

| Decision | Choice |
| --- | --- |
| Broken client build | Rebuild the missing shared UI components and finish the existing refactor; do not revert |
| Implementation agents | `expressive-dev` on `opencode-go/deepseek-v4.1-flash`, `hygiene-reviewer` on `opencode-go/glm-5.3-flash` |
| Scope | Everything in the PDF |
| Extra artifacts | Demo dataset (section 8). D6 samples, D7 screenshots, checkpoint tags and D8 defense material are **not** in this pass |

Every requirement carries an ID (`S<workstream>-<n>`). The implementation plan
(`part3-implementation-plan.md`) groups these into work packages.

Verification for every work package: `pnpm typecheck && pnpm lint && pnpm test` must pass, and the
new tests named in the item must exist and fail before the change.

---

## 1. S0 — Restore the client build (blocking)

| ID | Requirement | Acceptance |
| --- | --- | --- |
| S0-1 | Create `apps/client/src/components/layout/AppShell.tsx`: the authenticated page frame — navigation, page title area, content slot, API-status affordance. Must accept the props the 18 pages already pass. | `pnpm typecheck` reports no TS2307 for `AppShell` |
| S0-2 | Create `apps/client/src/components/ui/Button.tsx`, `Card.tsx`, `Badge.tsx`, `EmptyState.tsx`, `Modal.tsx` with the exact prop surfaces the existing pages already use (variants, sizes, `asChild`-free API, focus-visible states, `aria` attributes). | `pnpm typecheck` exits 0 |
| S0-3 | `Badge` renders status as **text plus colour**, never colour alone (section 4.1). | Visual + code review |
| S0-4 | `Modal` traps focus, closes on Escape, and restores focus to the trigger. | Client test |

Reference implementation style: match the existing `ErrorBanner.tsx` and `Skeleton.tsx` so the
component layer stays consistent. No new dependency is needed for this workstream.

## 2. S1 — Schema, constraints, migrations (rubric B, 15 pts)

| ID | Requirement | Acceptance |
| --- | --- | --- |
| S1-1 | Add `roles`, `permissions`, `role_permissions`, `user_roles` tables. Seed the seven section 3.1 roles and the existing permission set; migrate each user's current enum value into `user_roles`. | Migration applies to a clean database; every existing user has the equivalent role after migrating; authorization tests still pass |
| S1-2 | Keep the compiled `ROLE_PERMISSIONS` matrix as a **fallback**, but resolve permissions from the database at authentication time. | Changing a row in `role_permissions` changes an API caller's effective permissions without a redeploy (integration test) |
| S1-3 | Add a **partial unique index** on `invoices (service_account_id, billing_period)` `WHERE status <> 'void'`, closing the AT-11 gap that is currently application-only. | Raw SQL duplicate insert is rejected |
| S1-4 | Add a database trigger on `ledger_entries` blocking `UPDATE` and `DELETE`, mirroring the `audit_logs` trigger in `0008_smooth_magus.sql:33-40`. | Attempted update/delete raises an exception (integration test) |
| S1-5 | Add `collection_areas` (code, name, description, active) and reference it from subscribers/service accounts, keeping the existing barangay string as denormalized data. Provide CRUD routes and a management screen. | Area can be created, listed and assigned at runtime |
| S1-6 | Add `collector_remittances` (batch, amount, method split, remitted_by, remitted_at, notes) so a batch can have multiple or corrected remittances instead of one column. | Two remittances against one batch are both stored and both appear in the report |
| S1-7 | Add `suspension_records` and `reconnection_records` with reason, effective date, approved by, fee, technician, request date, completion date. Keep writing `service_status_history`. | Suspend + reconnect produce rows in both tables and in the history |
| S1-8 | Add `backup_history` (filename, size, checksum, created_by, created_at, verified_at, restore_tested_at). | Every application backup appends a row |
| S1-9 | Add `subscriber_addresses` so one subscriber can hold several addresses, and a per-service-account installation address. Migrate the existing subscriber address into the new table. | One subscriber with two addresses and two service accounts (integration test) |
| S1-10 | Add the missing required indexes: invoice **due date**; subscriber name and contact. Use `pg_trgm` GIN indexes for the name, address and contact searches. | `EXPLAIN` shows index usage on the search query; indexes present in migration SQL |
| S1-11 | Add per-account `billing_start_date` and optional per-account `billing_day`/`due_day` overrides, defaulting to the global setting. | Invoice due date honours the account override |

Migration rules: one migration per concept, reviewed SQL, no data loss, no edits to applied
migrations. Never delete financial rows — every new table follows soft-delete or status semantics.

## 3. S2 — Billing engine (rubric C, 20 pts)

| ID | Requirement | Acceptance |
| --- | --- | --- |
| S2-1 | Complete the invoice state set: `DRAFT`, `UNPAID`, `PARTIALLY_PAID`, `PAID`, `OVERDUE`, `VOID`, `CREDITED`. Keep `posted` as an alias only if a migration mapping is needed; otherwise rename with a migration. | State enum matches section 3.4 exactly; transitions still tested |
| S2-2 | Assign `CREDITED` when an advance credit fully settles an invoice; make it visible in lists, the ledger and the SOA. | Advance-payment scenario shows `CREDITED` (AT-03) |
| S2-3 | Add **discount** and **installation fee** as first-class invoice line items with a documented integer-centavo rounding rule (round half away from zero, applied once per line, then summed). | Line-item tests cover both; rounding rule documented in `docs/technical/README.md` |
| S2-4 | Replace `max()+1` invoice numbering with the same advisory-lock sequence allocation used for receipts in `receipt-number.service.ts:70-94`. | Two concurrent billing runs produce no number collision (AT-09 test) |
| S2-5 | Make `runMonthlyBilling` atomic: the run record and every generated invoice commit together, or nothing does. Idempotent per period. | A forced failure mid-run leaves zero invoices and no run record; a re-run produces the same result (AT-11) |
| S2-6 | Guard posting so a finalized invoice is immutable outside the void and adjustment workflows, and keep the draft-only guard. | Billing test suite unchanged and green |

## 4. S3 — Payments and GCash verification (rubric C, 20 pts)

| ID | Requirement | Acceptance |
| --- | --- | --- |
| S3-1 | Support five methods end to end: Cash, GCash, Bank Transfer, Cheque, Other. Remove the `POSTABLE_PAYMENT_METHODS` restriction that blocks Bank Transfer and Cheque. | Each method posts successfully (AT-01 variants) |
| S3-2 | GCash verification workflow: statuses `PENDING_VERIFICATION`, `VERIFIED`, `REJECTED`. A GCash payment is recorded as pending, only a verifier with the verification permission makes it posted-and-allocated, and rejection records a reason. | GCash payment does not affect balances until verified (AT-05 companion test) |
| S3-3 | Persist `verifiedAt` and `verifiedBy` (columns exist and are currently never written) and retain the verifier identity on verify and reject. | Audit + row assertion |
| S3-4 | Document the duplicate-reference policy in the technical docs and keep the blocking 409 behaviour. | Docs section added |
| S3-5 | Add an explicit authorized **manual allocation** endpoint: an operator with the manual-allocation permission can direct a payment to chosen invoices, with the allocation recorded and audited; default remains oldest-first. | Manual allocation test; audit row present |
| S3-6 | Keep reversal instead of edit; ensure a reversal of a GCash payment also reverses verification state. | Reversal test extension |

## 5. S4 — Collections and receivables (rubric D, 12 pts)

| ID | Requirement | Acceptance |
| --- | --- | --- |
| S4-1 | Full batch lifecycle `OPEN → IN_PROGRESS → SUBMITTED → REMITTED → RECONCILED → CLOSED`, with every illegal transition rejected. Migrate existing `open/submitted/reconciled/cancelled` values. | State-machine test covers all transitions, including rejections |
| S4-2 | Distinct remittance step (writes `collector_remittances`), distinct reconciliation step (variance), and a separate authorized close confirmation. | Lifecycle test asserts each step's preconditions (AT-07, AT-08) |
| S4-3 | **Printable route sheet** per batch/area: account number, name, address, current bill, arrears, total due, collector, area. Server report endpoint + clean print layout. | Route sheet renders for a seeded batch; print CSS applies |
| S4-4 | Batch summary splits expected receivable, Cash collected, non-cash (GCash/other) collected, and uncollected. | Report test asserts the split |
| S4-5 | Overdue list gains **area** and **oldest unpaid invoice number**, and filters by collector, area, plan, service type and delinquency age. | Filter tests per dimension |
| S4-6 | AR aging gains the same collector/area/plan/service-type filters while keeping bucket totals reconciling to outstanding balances. | Existing reconciliation test still passes; new filter tests |
| S4-7 | Enforce the configurable grace period and `suspension_after_days` threshold: a scheduled or on-demand job identifies and suspends qualifying accounts using the section 3.10 rules. | Threshold test with boundary accounts |
| S4-8 | Reconnection records the technician, request date and completion date alongside the existing fee invoice. | Reconnection test |
| S4-9 | Add the **Services** navigation section (§4.2) covering service accounts, suspension and reconnection operations. | Nav test / GUI smoke assertion |

## 6. S5 — Security, RBAC and audit (rubric F, 10 pts)

| ID | Requirement | Acceptance |
| --- | --- | --- |
| S5-1 | Seven roles: Owner/Super Admin, Administrator, Cashier, Collection Supervisor, Accounting/Auditor, Technician, Read-only Viewer. Keep existing roles as permission-compatible subsets where they map cleanly. | Role matrix in `packages/shared` and docs matches section 3.1 |
| S5-2 | Permission catalogue covers `subscriber.view`, `billing.generate`, `payment.create`, `payment.reverse`, `collection.reconcile`, `report.export`, `user.manage`, `backup.restore`, plus GCash verify and manual allocation. | Permission test asserts each exists and is assigned |
| S5-3 | Implement an in-application **backup and restore** feature: create a verified backup, list `backup_history`, and restore an approved backup with server-side `backup.restore` authorization. This removes the section 10.1 risk and satisfies AT-12. | AT-12 automated test: back up, mutate, restore, integrity-check |
| S5-4 | **Session lock**: idle-timeout lock with re-authentication to unlock, plus explicit lock and logout. | Client test + API test for the re-auth path |
| S5-5 | **Per-account failed-login lockout** with a configurable threshold and cooldown, in addition to the existing IP rate limit. | Lockout test: N failures lock the account, cooldown releases it |
| S5-6 | Extend audit coverage to collector batch submit/remit/reconcile/close, manual ledger entries, plan changes, system-settings changes and GCash verify/reject, with actor, action, reason and old/new values. | Audit test asserts a row per action |
| S5-7 | Exhaustive role × permission authorization test: for every role and every permissioned route, assert the allowed and denied outcome. | Test iterates the full matrix rather than one denied role per permission |
| S5-8 | Narrow guard width where a read endpoint currently requires a write permission (batch collectors list), and keep `payments:read` for proof retrieval. | Route test per endpoint |

## 7. S6 — Reports and dashboard (rubric G, 8 pts)

| ID | Requirement | Acceptance |
| --- | --- | --- |
| S6-1 | Add the missing reports: **weekly** and **annual** collection; **revenue by plan**, **by service type**, **by area**; **collector assignment**; **collector performance**; **payment adjustment/reversal**; **voided receipt**; **user activity**; **subscriber master list** (with export). | Each has a server endpoint, a Reports Center entry, and a calculation test |
| S6-2 | Every report honours its own filters (date range, collector, area, plan, service type). | Filter tests per report |
| S6-3 | Dashboard gains the **payment-method summary** and **collector performance** blocks (§4.3), keeping KPIs within the required 4–6 compact cards. | Dashboard test + GUI smoke |
| S6-4 | Format money in XLSX exports as human-readable peso values with a number format, instead of raw centavos with a "(centavos)" header. Keep integer centavos as the internal representation. | Exported file inspected; writer test asserts number format |
| S6-5 | Audit log becomes an exported report inside Reports Center as well as a filtered screen. | Export test |
| S6-6 | Large report exports stay bounded (stream or paginate) rather than loading an unbounded result set into memory. | Documented limit + test on a large seeded dataset |

## 8. S7 — UI/UX conformance (rubric E, 12 pts)

| ID | Requirement | Acceptance |
| --- | --- | --- |
| S7-1 | Apply the section 4.1 design tokens exactly: Navy `#0F2747`, Accent `#2563EB`, Canvas `#F6F8FB`, Surface `#FFFFFF`, Text `#0F172A` / `#64748B`, Success `#059669`, Warning `#D97706`, Danger `#DC2626`. Declare them as CSS custom properties and consume them through Tailwind theme values; no raw hex in components. | Token grep finds the tokens defined once and used via variables |
| S7-2 | Typography becomes Inter (self-hosted or bundled, no external CDN dependency for an offline LAN install). | Font family applied; no network fetch |
| S7-3 | Right-align financial values and apply `tabular-nums` to every money cell and KPI number, including the dashboard cards that currently lack it. | Grep + visual check |
| S7-4 | Every operational table gets a sticky header, search, filters, sortable columns and real pagination (no `pageSize: 100` dumps). Adopt **TanStack Table** for the dense tables. | Table tests for sort/pagination; no full-dataset renders |
| S7-5 | Forms gain inline per-field validation (adopt **React Hook Form** with the shared Zod schemas as the resolver), keeping visible labels, required indicators and section grouping. | Form tests; invalid submit shows field-level errors |
| S7-6 | GCash Verification screen (§4.3): two-pane queue with proof preview and verify/reject controls. | Screen exists; GUI smoke asserts it for a verifier role |
| S7-7 | Add `@media print` rules for a clean print layout with no application navigation, used by the SOA, receipt, route sheet and report print paths. | Print stylesheet exists; print routes render without nav |
| S7-8 | Navigation order and grouping match section 4.2: Dashboard first, then Subscribers, Billing, Payments, Collections, Receivables, Services, Reports, Administration. | Nav test |

## 9. S8 — Reliability and scale (section 4.5)

| ID | Requirement | Acceptance |
| --- | --- | --- |
| S8-1 | Paginate `/api/invoices` and `/api/payments` like the other list endpoints (bounded page size, server-side filters). | Endpoint test asserts a limit is applied |
| S8-2 | Keep critical financial operations transactional; extend atomicity to the complete monthly billing run (S2-5) and to batch post-all-drafts. | Transaction tests |
| S8-3 | Backup, verification and restore workflow is available from the application (S5-3) and every run is recorded in `backup_history`. | AT-12 test |

## 10. S9 — Demo dataset (section 8)

| ID | Requirement | Acceptance |
| --- | --- | --- |
| S9-1 | Add a demo-dataset generator (separate from the minimal `seed.ts`, invoked by an explicit script) producing synthetic data only: 5+ users covering Admin, Cashier, Collection Supervisor, Auditor/Viewer and Technician; 3 Internet + 2 Cable + 2 Combo plans; 50 subscribers; 60+ service accounts across all three types; 2 collectors; 3 collection areas; invoices across ≥3 billing months; payments mixing Cash, GCash, partial, exact and advance; 10+ overdue accounts spanning multiple aging buckets; 1 approved reversal or void; 2 suspension/reconnection scenarios. | Generator test asserts each minimum; `pnpm db:seed:demo` populates a fresh database |
| S9-2 | Data is deterministic (fixed random seed) and clearly marked as synthetic. | Same seed produces identical counts |
| S9-3 | Ledger and AR remain consistent after generation: aging totals reconcile to outstanding balances. | Reconciliation test on the generated dataset |

## 11. S10 — Tests and evidence (sections 2.2, 7.1, 13)

| ID | Requirement | Acceptance |
| --- | --- | --- |
| S10-1 | Add **Playwright** Electron E2E covering the section 11.1 demo flow: login, subscriber with service account, invoice + ledger debit, payment + receipt, GCash verify with duplicate protection, ledger and SOA, overdue/aging filter, collector batch remit/reconcile, payment reversal with audit trail, report export, role restriction. | `pnpm test:e2e` runs against a built app and passes |
| S10-2 | Add renderer unit tests for money formatting, status badges and the allocation preview. | `pnpm --filter client test` passes |
| S10-3 | Commit an **AT-01…AT-12 traceability document** mapping each acceptance test to its proving test, with the raw run output. | File exists and matches the suite |
| S10-4 | Add a **bug log** recording at least one real defect with root cause, fix and regression test (the dashboard navigation fix is a genuine candidate). | File exists |
| S10-5 | Extend the PostgreSQL-gated suites so they cannot silently disappear: a missing database fails loudly in CI mode instead of skipping. | Guard is explicit and configurable |

## 12. S11 — Stack alignment (section 2.2)

Recommended technology stack, with the risk stated. Ordered by value per unit of risk:

| ID | Change | Rationale | Risk |
| --- | --- | --- | --- |
| S11-1 | Adopt **TanStack Table** for dense tables | Named in the stack table; directly serves S7-4 (sticky headers, sorting, pagination, virtualization) | Low |
| S11-2 | Adopt **React Hook Form** + Zod resolver | Named in the stack table; serves S7-5 inline validation | Low |
| S11-3 | Upgrade **Zod 3 → 4** | Named as Zod 4; shared schemas keep it contained | Medium |
| S11-4 | Upgrade **React 18 → 19.2** | Named as React 19.2 | Medium |
| S11-5 | Add **Playwright** | Named in the stack table; already required by S10-1 | Low |
| S11-6 | Upgrade **Electron 32 → 44.x** | Named as Electron 44.x | **High** — electron-vite, builder and the preload contract must be re-verified on Windows; do last, behind its own verification gate |
| S11-7 | Keep the dependency-free XLSX writer — **justified substitution** | `xlsx-writer.test.ts:13-16` validates CRC-32 and a real ZIP structure; ExcelJS would add a large dependency for a narrow gain. Fix the money formatting instead (S6-4) | None |
| S11-8 | Keep pdf-lib — **justified substitution** for pdfmake | Real multi-page A4 output with headers, page numbers and right-aligned numerals; pdfmake adds ~2 MB and a font-embedding step | None |
| S11-9 | Keep zustand for client state — **justified substitution** for TanStack Query | All server state already flows through a single typed `api-client`; adding a query cache would duplicate it. Revisit only if cache invalidation becomes a real problem | None |
| S11-10 | Keep the hand-rolled UI primitives — **justified substitution** for shadcn/ui | Tailwind 4 is already in use and the primitives are being rebuilt in S0; shadcn would be a large migration for no rubric gain | None |

## 13. Algorithm and design recommendations

| ID | Recommendation | Why it matters |
| --- | --- | --- |
| S12-1 | **Advisory-lock sequence allocation** for invoice and receipt numbers (mirror `receipt-number.service.ts:70-94`) | `max()+1` cannot survive three concurrent PCs; this is the concrete AT-09 fix |
| S12-2 | **Partial unique index** `WHERE status <> 'void'` for the invoice period key | Makes AT-11 a database invariant rather than a service-level convention |
| S12-3 | **Idempotency key per billing run** (`period` + run state inside the transaction) | A crashed or re-triggered run must be safe to repeat |
| S12-4 | **`pg_trgm` GIN indexes** for global subscriber search across name, address, contact, receipt, invoice and GCash reference | The current `ILIKE` scan will not hold at 20,000 subscribers |
| S12-5 | **Derived running balance plus an invariant reconciliation query** | Already the design; keep `runningBalanceCentavos` as a cache only and assert debits − credits against open balances in CI |
| S12-6 | **Half-open aging intervals** (`[0,30)`, `[30,60)`, `[60,90)`, `[90,∞)`) | Prevents the double-counting that inclusive bucket boundaries invite |
| S12-7 | **Normalized GCash reference** (trim, uppercase, strip spaces) before the uniqueness check | Prevents trivially bypassing duplicate detection |
| S12-8 | **Optimistic concurrency via `updated_at` guard** on mutable operational records | Two supervisors editing one batch should not silently overwrite each other |
| S12-9 | **Server-side permission resolution from the database** with a short-lived cache | Lets RBAC change without a deploy, as section 4.4 intends |

## 14. Explicitly out of scope for this pass

- D6 sample report files, D7 screenshot set, checkpoint tags CP1–CP6, D8 defense material
  (not selected; the test-report and AT traceability in S10-3 partially substitute for D5).
- Windows installer build (D2) — requires a Windows host; packaging config already exists.
- Optional enhancement tasks (section 15): mobile/PWA collector, SMS/email reminders,
  self-service portal, payment gateway, QR receipts, GIS, technician work orders, analytics.
- Rewriting the frontend onto shadcn/ui or TanStack Query (S11-9, S11-10 — justified substitutions).

## 15. Definition of done

A work package is done only when all of the following hold:

1. `pnpm typecheck`, `pnpm lint` and `pnpm test` pass (both `apps/server` and `apps/client`).
2. Every new behaviour has at least one test that failed before the change.
3. Any financial rule changed has a unit test on the calculation and an integration test on the
   posted flow.
4. Earlier migrations are untouched; new behaviour arrives as a new migration.
5. `hygiene-reviewer` has reviewed the diff with no blocking finding outstanding.
6. The relevant section 14 checklist item and AT id now pass, and part1's finding is updated.
