# Part 3 — Implementation Plan

Work packages derived from `part2-spec.md`. Each package lists its spec IDs, the files it owns, the
agent that executes it, and the gate that must pass before it is called done.

Agents (project-level definitions in `.pi/agents/`, all pinned to opencode-go):

- **builder** — `.pi/agents/expressive-dev.md`, model `opencode-go/deepseek-v4.1-flash`
- **reviewer** — `.pi/agents/hygiene-reviewer.md`, model `opencode-go/glm-5.3-flash`

Universal gate for every package: `pnpm typecheck && pnpm lint && pnpm test` all pass, the package's
new tests failed before the change, and the reviewer has no blocking finding. Review is never
skipped, and a package is never marked done on a builder's self-report alone — the diff is read.

## Sequencing

```
Wave 1   WP0 (restore build)                ── blocks all client work
Wave 2   WP1 (schema + migrations)          ── blocks all domain work
Wave 3   WP2 billing   WP3 payments   WP4 collections   WP5 security   WP7 UI
Wave 4   WP6 reports   WP8 reliability (folds into WP2)  WP9 demo dataset
Wave 5   WP10 tests + evidence   WP11 stack alignment (last, gated)
```

WP2–WP5 and WP7 touch mostly disjoint files, so they can run in parallel. Within a wave, migrations
are serialized through WP1's file to avoid conflicting migration numbering.

---

## WP0 — Restore the client build

- **Spec:** S0-1 … S0-4. **Agent:** builder → reviewer.
- **Files:** `apps/client/src/components/layout/AppShell.tsx`,
  `apps/client/src/components/ui/{Button,Card,Badge,EmptyState,Modal}.tsx`, plus tests.
- **Why first:** 79 TS2307 errors; nothing client-side can be verified until this lands.
- **Approach:** read 3–4 of the 18 importing pages to extract the exact prop surfaces already in use,
  then implement the primitives once, in the style of the existing `ErrorBanner.tsx`/`Skeleton.tsx`.
- **Gate:** `pnpm typecheck` exits 0; focus-trap and Escape tests on `Modal`; badge renders text plus
  colour.

## WP1 — Schema, constraints, migrations

- **Spec:** S1-1 … S1-11, with S12-2, S12-3, S12-4, S12-6. **Agent:** builder → reviewer.
- **Files:** `apps/server/src/db/schema/*.ts`, new `apps/server/src/db/migrations/0009_*.sql` onward,
  `packages/shared/src/constants/*`, `packages/shared/src/types/*`.
- **Approach:** one migration per concept, `db:generate` then read the SQL. RBAC tables plus a data
  migration mapping the existing role enum. Partial unique index for the invoice period key. Ledger
  append-only trigger. New tables: `collection_areas`, `collector_remittances`,
  `suspension_records`, `reconnection_records`, `backup_history`, `subscriber_addresses`.
  `pg_trgm` indexes, invoice due-date index, per-account billing start/day.
- **Gate:** migration applies to a clean database; the raw-SQL duplicate insert is rejected; a
  ledger UPDATE raises; RBAC data migration preserves every existing user's effective permissions.
- **Risk:** the role enum → tables migration. Verify by listing each user's permissions before and
  after.

## WP2 — Billing engine (+ reliability)

- **Spec:** S2-1 … S2-6, S8-2, S12-1, S12-3. **Agent:** builder → reviewer.
- **Files:** `apps/server/src/modules/billing/*`, `apps/server/src/db/schema/billing.ts`,
  `packages/shared/src/constants/{billing,statuses}.ts`.
- **Approach:** complete the state set (add `CREDITED`, reconcile `posted` with `UNPAID`), add
  discount and installation-fee line items with the documented rounding rule, swap invoice numbering
  to advisory-lock allocation, make `runMonthlyBilling` atomic and idempotent.
- **Gate:** AT-11 plus a two-concurrent-run numbering test (AT-09); a forced mid-run failure leaves
  no invoices and no run record; line-item tests for discount, installation fee and rounding.
- **Dependency:** WP1's period-key index is the DB half of AT-11.

## WP3 — Payments, allocation, GCash verification

- **Spec:** S3-1 … S3-6, S12-7. **Agent:** builder → reviewer.
- **Files:** `apps/server/src/modules/payments/*`, `apps/server/src/db/schema/payments.ts`,
  `packages/shared/src/constants/{payments,statuses}.ts`,
  `apps/client/src/pages/{PaymentDetailPage,PostPaymentPage}.tsx`, new GCash verification page.
- **Approach:** five postable methods; GCash pending/verified/rejected lifecycle with `verifiedAt`/
  `verifiedBy` actually written; normalized reference before the duplicate check; manual allocation
  endpoint behind its own permission.
- **Gate:** a GCash payment does not move balances until verified; verify and reject both retain
  identity and timestamp; manual allocation is audited; reversal reverses verification state.
- **Interacts with:** WP7's GCash screen (S7-6) — the API lands here, the screen there.

## WP4 — Collections, receivables, service control

- **Spec:** S4-1 … S4-9, S1-5, S1-6, S1-7. **Agent:** builder → reviewer.
- **Files:** `apps/server/src/modules/{collections,receivables,service-accounts,reports}/*`,
  `apps/client/src/pages/Collector*Page.tsx`, `OverdueAccountsPage.tsx`,
  `ReceivablesAgingPage.tsx`, `SubscriberDetailPage.tsx`.
- **Approach:** six-state batch lifecycle with a distinct remit and close step writing
  `collector_remittances`; printable route sheet; per-method batch summary; area and plan filters plus
  the missing overdue fields; suspension-threshold enforcement and the reconnection detail fields.
- **Gate:** AT-07 and AT-08 still pass at the new lifecycle; every illegal transition rejected;
  aging totals still reconcile after the new filters; route sheet renders from a seeded batch.

## WP5 — Security, RBAC, audit, backup/restore

- **Spec:** S5-1 … S5-8, S1-1, S1-2, S1-8, S12-9. **Agent:** builder → reviewer.
- **Files:** `packages/shared/src/constants/{roles,permissions}.ts`,
  `apps/server/src/modules/{auth,users,system,audit}/*`,
  `apps/server/src/shared/middleware/*`, new backup module, client auth store and lock screen.
- **Approach:** seven roles and the permission catalogue; permissions resolved from the database with
  the compiled matrix as fallback; in-application backup/restore writing `backup_history`; session
  lock with re-authentication; per-account login lockout; audit coverage for batches, ledger, plans
  and settings.
- **Gate:** AT-10 and AT-12 pass; a `role_permissions` row change takes effect without redeploy;
  exhaustive role × permission matrix test; lockout boundary test.
- **Risk:** highest-consequence package — the reviewer must read the authorization diff line by line.

## WP6 — Reports and dashboard

- **Spec:** S6-1 … S6-6, S8-1. **Agent:** builder → reviewer.
- **Files:** `apps/server/src/modules/{reports,dashboard}/*`,
  `apps/server/src/shared/{xlsx,pdf}/*`, `apps/client/src/pages/ReportsCenterPage.tsx`,
  `DashboardPage.tsx`, `lib/report-views.ts`.
- **Approach:** add the nine missing report families with real filtered math; dashboard
  payment-method and collector-performance blocks; Excel pesonumber formatting; paginate
  `/api/invoices` and `/api/payments`; bound large exports.
- **Gate:** one calculation test per new report proving the math against hand-computed fixture values;
  every report honours its filters; exported XLSX shows readable pesos.

## WP7 — UI/UX conformance

- **Spec:** S7-1 … S7-8, S11-1, S11-2. **Agent:** builder → reviewer.
- **Files:** `apps/client/src/styles.css`, `index.html`, `components/**`, all `pages/**`, new GCash
  verification page.
- **Approach:** declare the section 4.1 tokens as CSS variables and drive Tailwind from them; bundle
  Inter locally; align financial values right with `tabular-nums` everywhere; adopt TanStack Table
  for sticky headers, sorting and pagination; adopt React Hook Form for inline validation; add
  `@media print`; fix the navigation order and add the Services section (S4-9).
- **Gate:** token grep shows single-source definitions; no `pageSize: 100` dumps remain; print route
  renders without navigation; nav test matches section 4.2.
- **Dependency:** WP0 (primitives must exist first).

## WP8 — Reliability and scale

- **Spec:** S8-1 … S8-3. **Agent:** builder → reviewer.
- **Note:** S8-2 and S8-3 fold into WP2 and WP5; S8-1 (pagination) is delivered inside WP6.

## WP9 — Demo dataset

- **Spec:** S9-1 … S9-3. **Agent:** builder → reviewer.
- **Files:** `apps/server/src/db/demo-dataset.ts`, `apps/server/src/db/seed-demo.ts`,
  `apps/server/package.json` script, test.
- **Approach:** deterministic synthetic generator meeting every section 8 minimum, invoked
  explicitly (`pnpm db:seed:demo`) and kept separate from the minimal `seed.ts`, which stays as the
  production bootstrap.
- **Gate:** generator test asserts every minimum; ledger and aging reconcile on the generated data;
  fixed seed reproduces identical counts.
- **Dependency:** WP1–WP5 (needs the new tables, states and lifecycle).

## WP10 — Tests and evidence

- **Spec:** S10-1 … S10-5. **Agent:** builder → reviewer.
- **Files:** `apps/client/test/**`, new `apps/client/e2e/**`, Playwright config, `docs/testing/**`,
  `docs/bug-log.md`.
- **Approach:** Playwright Electron flow covering the section 11.1 demo sequence; renderer unit tests;
  committed AT-01…AT-12 traceability with raw output; bug log; loud failure instead of silent skip
  when the database is absent.
- **Gate:** `pnpm test:e2e` passes on a built app; traceability file matches the actual suite.
- **Dependency:** WP2–WP5 (the flows must exist before they can be driven).

## WP11 — Stack alignment

- **Spec:** S11-1 … S11-10. **Agent:** builder → reviewer.
- **Order (ascending risk):** TanStack Table and React Hook Form arrive with WP7; then Zod 4; then
  React 19.2; then Playwright with WP10; **Electron 44 last**, behind its own verification gate.
- **Gate:** after each step, `pnpm typecheck`, `pnpm lint`, `pnpm test` and the GUI smoke all pass,
  and the preload contract is re-verified. Any step that cannot be verified is reverted rather than
  left half-migrated.

---

## Progress tracking

| WP | Packages | Status |
| --- | --- | --- |
| WP0 | Restore build (S0) | **done** — 6 components, `typecheck`/`lint` green, 12 Modal a11y tests, client test runner added |
| WP1 | Schema and migrations (S1) | **done** — 10 migrations `0009`–`0018`, 29 tables, 7 roles, 461 tests green; awaiting review verdict |
| WP5a | RBAC resolver, lockout, audit coverage, backup/restore (server) | in progress |
| WP6a | Report endpoints, filters, XLSX money, pagination (server) | in progress |
| WP7a | Design tokens, Inter, print CSS, navigation (client) | in progress |
| WP5b | Session-lock client, backup admin screen | pending |
| WP6b | Reports Center and dashboard client surfaces | pending |
| WP7b | TanStack Table, React Hook Form inline validation | pending |
| WP2 | Billing engine (states, CREDITED, discount/fee, locked numbering, atomic run) | pending — needs a migration, so serialized after WP5a/WP6a |
| WP3 | Payments and GCash verification | pending — migration, serialized |
| WP4 | Collections, receivables, service control | pending — migration, serialized |
| WP9 | Demo dataset | pending |
| WP10 | Playwright E2E, evidence, bug log | pending |
| WP11 | Stack alignment (Zod 4, React 19.2, Electron 44 last) | pending |

### Migration serialization rule

WP2, WP3 and WP4 each need a new migration, so they run **one at a time**, never concurrently, and
never at the same time as another package that writes `apps/server/src/db/**`. `meta/_journal.json`
and the per-migration snapshots are single-writer files. WP5a and WP6a are explicitly barred from
adding migrations, which is why they can run in parallel now.

### Client single-writer rule

The 22 page files are the client's contention point. Only one client work package runs at a time:
WP7a → WP7b → WP5b/WP6b. This is why the server halves (WP5a, WP6a) are split from their client
halves.

## Reporting rules for agents

1. The builder reports files changed and the exact verification command output, never a summary of
   intent.
2. The reviewer reads the real diff, checks the spec IDs claimed, and blocks on financial,
   authorization, or data-integrity regressions.
3. The main session verifies every claimed pass before marking a work package done.
