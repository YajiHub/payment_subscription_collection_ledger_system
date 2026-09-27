# Part 1 — Audit Findings (repo vs laboratory activity)

Baseline: working tree of this repository (uncommitted client refactor included).
Requirement source: `BCIS_Subscription_Billing_and_Collection_Laboratory_Activity (1).pdf`.

Verdict scale: `PASS` (requirement met, evidence cited) · `PARTIAL` (met in part, or met with a
material caveat) · `FAIL` (not met). Every line cites `file:line` or a command result.

Grading context: section 10 rubric totals 100 points. Section 10.1 lists critical-failure
conditions that let the instructor cap or void the score.

---

## Summary table

| # | Rubric area | Pts | Verdict | Headline issues |
| --- | --- | --- | --- | --- |
| A | Requirements & architecture | 10 | PARTIAL | Playwright E2E absent; React 18 / Electron 32 / Zod 3 substitutions; invoices and payments unpaginated; missing subscriber + due-date indexes |
| B | Database & data integrity | 15 | PARTIAL | No RBAC tables; no unique (service account, period) constraint; invoice numbering unlocked; missing entities |
| C | Billing, ledger & payment correctness | 20 | PARTIAL | Invoice states diverge (no `CREDITED`); GCash never verified; only 2 of 5 methods postable; no discount or installation-fee line; billing run not atomic |
| D | Collection & receivables | 12 | PARTIAL | No route sheet; no collection areas; 4-state batch lifecycle; no suspension threshold; aging/overdue filters and fields missing |
| E | UI/UX & professional design | 12 | **FAIL** | Client does not build (79 TS2307); no design tokens; no Inter/Geist; no sticky headers; GCash verification screen absent |
| F | Security, RBAC & audit | 10 | PARTIAL | 5 of 7 roles; RBAC in code not tables; no session lock; batch/ledger/settings mutations unaudited |
| G | Reports & dashboard | 8 | PARTIAL | 6 of ~15 report families exist; no revenue-by-plan/area; dashboard lacks method summary and collector performance |
| H | Testing & quality | 8 | PARTIAL | 441 tests pass incl. live PostgreSQL; no Playwright; no renderer tests; AT-09 and AT-12 partial |
| I | Documentation & deployment | 3 | PARTIAL | Technical docs and manual are strong; no D6 samples, no installer build, no test-report artifact |
| J | Demonstration & code understanding | 2 | UNVERIFIED | No demo dataset and no D8 defense material; demo would have no data to show |

Verified commands: `pnpm test` = 44 files / 441 tests / 0 failed, 0 skipped (live PostgreSQL 16 present).
`pnpm lint` = pass. `pnpm typecheck` = **fail** (client only).

Critical-failure exposure: **no backup/restore feature in the application** (section 10.1, and
AT-12 is only script-tested), plus a self-inflicted **client build failure** that would make the
submission undeliverable.

---

## Section 3.1 + 4.4 — Security, RBAC, audit (rubric F, 10 pts)

### 1. Roles and permissions

- `FAIL` Seven required roles (3.1) — `packages/shared/src/constants/roles.ts:3` — only five
  exist: `admin`, `billing_clerk`, `cashier`, `collector`, `manager`. Missing: Owner/Super Admin,
  Technician, Accounting/Auditor. Collection Supervisor is merged into `billing_clerk`/`cashier`
  (`collector_batches:create`); Read-only Viewer is approximated by `manager`.
- `PARTIAL` Granular permissions — `packages/shared/src/constants/permissions.ts:21-63` — all the
  named concepts exist under different spellings: `subscribers:read` (subscriber.view),
  `invoices:generate` (billing.generate), `payments:post` (payment.create), `payments:reverse`
  (payment.reverse), `collector_batches:reconcile` (collection.reconcile), `reports:export`
  (report.export), `users:create/update/deactivate` (user.manage).
- `FAIL` `backup.restore` is dead — `permissions.ts:62` declares `system:backup`, but no server
  code references it: there is no backup module and no backup route.
- `FAIL` No separation of Owner/Super Admin from Administrator — `admin` is the single apex role;
  no approval/configuration-only tier.

### 2. Role → permission storage

- `FAIL` Required RBAC tables — `apps/server/src/db/schema/users.ts:11-16` — role is a `pgEnum`
  column on `users`; there is no `roles`, `permissions`, `role_permissions` or `user_roles` table.
  The matrix lives in code: `ROLE_PERMISSIONS` at `permissions.ts:66`.
- Consequence: changing a role or a permission requires a code deploy. The schema comment admits
  it (`users.ts:12`). Section 5 requires these as tables, and section 4.4 requires RBAC.

### 3. Authentication

- `PASS` bcrypt ≥ 12 rounds — `apps/server/src/config.ts:17` (`BCRYPT_ROUNDS`, default 12);
  asserted by `apps/server/test/security-hardening.test.ts:361`.
- `PASS` No plaintext password path — `apps/server/src/shared/password.ts:9` hashes only; login
  never returns the hash (`security-hardening.test.ts:331`).
- `PASS` Timing-equalized login + inactive-account rejection — `auth.service.ts:34-38, 66-70`.
- `PARTIAL` Failed-login handling — IP rate limit only (`auth.routes.ts:17-22`,
  `security-hardening.test.ts:377`). No per-account failed-attempt counter or lockout.
- `PASS` Token revocation — `revoked_tokens` keyed by `jti` (`users.ts:55-71`,
  `authenticate.ts:31-37`); tests `security-hardening.test.ts:124`, `auth.routes.test.ts:205`.
- `PASS` Login audit log — every attempt stored with username, success flag, IP, timestamp
  (`users.ts:39-52`); failures audited too (`auth.service.ts:63-71`).
- `FAIL` Session lock — section 4.4 requires "session lock/logout". Only logout exists; no
  lock/idle-lock anywhere in `apps/client/src` or the server.

### 4. Server-side authorization

- `PASS` Every mutating route is guarded — `invoices.routes.ts:23-25`, `payments.routes.ts:28-34`,
  `collector-batches.routes.ts:39-58`, `users.routes.ts:22-35`, `system.routes.ts:28-41`,
  `receivables.routes.ts:31`. No unguarded POST/PUT/PATCH/DELETE found.
- `PASS` Guard width mostly matches the action — invoice void requires `invoices:void` (admin),
  payment reversal requires `payments:reverse` (admin), manual ledger entry requires
  `ledger:adjust` (admin).
- `PARTIAL` Two broad guards — `GET /api/collector-batches/collectors` needs
  `collector_batches:create` (a write permission on a read), and the GCash screenshot upload uses
  the full `payments:post`. `GET /api/system/settings` is auth-only by intent
  (`system.routes.ts:8-11`).
- `FAIL` Backup/restore routes do not exist, so the `system:backup` permission protects nothing.

### 5. AT-10 (authorization cannot be bypassed by calling the API)

- `PASS` Lower-privilege direct API rejection — `apps/server/test/rbac-matrix.test.ts:304-325`
  sweeps every permissioned route with a token for a role lacking the permission and asserts
  `403 FORBIDDEN`; `security-hardening.test.ts:164, 180, 196, 211` covers cashier→role change,
  manager→deactivate, collector→export, billing_clerk→payment post.
- `PARTIAL` Exhaustiveness — the route sweep picks exactly one denied role per permission
  (`rbac-matrix.test.ts:105-112`), and `permissions.test.ts` is spot checks. There is no
  exhaustive role×permission assertion.

### 6. Audit trail

- `PASS` Schema and append-only enforcement — `db/schema/audit.ts` stores actor, action, entity,
  old+new JSONB, description, IP, timestamp; migration `0008_smooth_magus.sql:33-40` adds a
  trigger blocking UPDATE and DELETE. Only a GET route exists (`audit.routes.ts:13`).
- `PASS` Financial mutations audited with reason — invoice void (`audit-logger.ts:100-113`),
  payment posted, payment reversed with a ≥10-character reason enforced
  (`reverse-payment.service.ts:62`).
- `PARTIAL` Coverage gaps — no audit calls in collector batches, ledger, plans, system or
  receivables handlers. Batch submit/reconcile and system-settings changes leave no audit record,
  although reconciliation is a core financial workflow (section 4.4).
- `PASS` Test assertions — `audit.routes.test.ts:135-164` checks field presence, absence of
  `passwordHash`, failed-login rows without credentials; `:116` asserts cashier gets 403.

### 7. Payment-proof attachment safety

- `PASS` `gcash-screenshot.service.ts:69-93, 121-125` sniffs magic bytes and rejects a declared
  MIME that disagrees with the detected type; 5 MB cap (`:58`); MIME allowlist (`:52-55`);
  server-generated filename, client filename ignored (`:132-134`); path containment on read-back
  (`:157-160`); served through an authenticated route requiring `payments:read`
  (`payments.routes.ts:29`). Tests `gcash-screenshot.test.ts:25-71` include a renamed non-image.

### 8. Section 4.4 miscellany

- `PASS` No secrets in logs — grep found no `password`/`token` in logging calls; 1 MB body limit,
  helmet CSP and rate limits in `security.plugin.ts:41-56` (`security-hardening.test.ts:377-424`).
- `PASS` CORS allow-list — origin callback echoes only configured origins
  (`security.plugin.ts:70-79`, `config.ts:16`; `cors-origins.test.ts`, `:437-450`).
- `FAIL` Session lock, as above.

### 9. Client + documentation

- `PASS` Permission-aware navigation — `AppNavigation.tsx:15-28, 55` filters by
  `roleHasPermission`; `ProtectedRoute.tsx:1-2` documents that the client check is UX-only.
- `PARTIAL` Documentation accuracy — `docs/technical/README.md:253-310` describes the JWT flow and
  the `authorize()` matrix accurately, but omits the absent backup/restore feature and the
  code-based role model.

---

## Section 3.2 / 3.8 / 3.9 / 3.10 — Collections, receivables, service control (rubric D, 12 pts)

### 1. Subscriber management (3.2)

- `PASS` Identity fields — `db/schema/subscribers.ts:79-101` (unique `accountNumber`, name parts,
  phones, email, address quad, notes); migration `0002_brown_triton.sql:30`.
- `FAIL` Subscriber-level status, assigned collector and billing/due day —
  `subscribers.ts:76-104` has no `status`, `assignedCollectorId` or billing-day column. A
  subscriber-status constant exists but is unused (`packages/shared/src/constants/statuses.ts:4`).
  The due day is one global setting, `invoice_due_day_of_month` (`constants/system.ts:10`).
- `PASS` One subscriber, many service accounts — `subscribers.ts:186-189`; proven end-to-end in
  `subscriber-lifecycle.integration.test.ts:95`.
- `FAIL` Multiple service addresses per subscriber — no `subscriber_addresses` table; one
  subscriber-level `serviceAddress` (`subscribers.ts:91-94`) and no per-account installation
  address.
- `PASS` No destructive delete — `subscribers.routes.ts:1-35` registers only POST/PUT/GET; service
  accounts are never deleted (`service-accounts.service.ts:4-5`).
- `PARTIAL` Global search — 6 conditions only: first/middle/last name, account number, primary
  and secondary phone (`subscribers.service.ts:99-105`). Address, receipt number, invoice number
  and GCash reference are not searchable; the UI copy agrees
  (`SubscriberListPage.tsx:114`).

### 2. Plans and service accounts (3.3)

- `PASS` Per-account plan, activation date, status, assigned collector — `subscribers.ts:106-143`;
  `types/subscriber.types.ts:83-91`.
- `FAIL` Per-account installation address — absent.
- `FAIL` Billing start date and per-account billing/due day — only `activationDate`
  (`subscribers.ts:128`).
- `PARTIAL` Current rate — no per-account rate column; the rate always comes from the plan
  (`billing/invoice-calculations.ts:49-50`), so a price change needs a new plan record
  (`subscriber.types.ts:59-63`).
- `PASS` Status history with reason and actor — `serviceStatusHistory` (`subscribers.ts:158-173`),
  written transactionally (`service-accounts.service.ts:308-313, 350-364`).
- `PARTIAL` Plan attributes — Internet speed is an integer `speedMbps` (`subscribers.ts:49`); cable
  is a free-text `cablePackageDescription` (`subscribers.ts:53`) with no channel count.
- `PASS` Service types internet/cable_tv/bundle — `subscribers.ts:28`.

### 3. House-to-house collection (3.8)

- `FAIL` Collection areas/routes as entities — only a `serviceBarangay` string
  (`subscribers.ts:92`); no `collection_areas` table in any migration, and no way to create or
  edit an area at runtime.
- `PASS` Collector assignment — `serviceAccounts.assignedCollectorId` (`subscribers.ts:132`) plus
  batch `collectorId` (`collections.ts:71`).
- `FAIL` Six-state batch lifecycle — the enum has four: `open/submitted/reconciled/cancelled`
  (`collections.ts:30-35`, `constants/collections.ts:33`). `IN_PROGRESS`, a distinct `REMITTED`,
  and `CLOSED` are absent; `reconciled` fuses three required states.
- `PASS` Illegal transitions rejected — record only while open (`collector-batches.service.ts:503-504`),
  submit only from open (`:647-648`), reconcile only from submitted (`:700-701`), cancel only from
  open (`:755-756`), double-record and void conflicts (`:514-517, 586-590`), all under
  `SELECT FOR UPDATE` plus advisory locks (`:149-156`).
- `FAIL` Printable route sheet — no route sheet report or print surface
  (`CollectorBatchDetailPage.tsx` has no print); the reports module emits only R5 remittance
  (`reports/handler.ts:92`). Batch detail lists account number and outstanding balance
  (`collector-batches.service.ts:84-97`) but no address and no current-bill vs arrears split.
- `PARTIAL` Batch summary — expected remittance, collected total and outstanding total exist
  (`:73-74, 995-1013`); there is no per-method (cash vs GCash) aggregate even though the amounts
  are stored per assignment (`collections.ts:107-108`).
- `PASS` Per-account collection posts a real payment + ledger credit in one transaction
  (`collector-batches.service.ts:533-549`; `collections.postgres.test.ts:226-290`).
- `PARTIAL` Remittance record — no `collector_remittances` table; a single
  `actualRemittanceCentavos` column per batch (`collections.ts:86-89`) with one submission and no
  history, so a partial or corrected remittance is impossible.
- `PASS` Shortage/overage never silently balanced — `varianceCentavos` is stored
  (`collections.ts:90-96`) and variance notes are mandatory at reconcile (`:720-726`).
- `PASS` No destructive delete — `collections-immutability.test.ts:30-61` scans the source for
  deletes against batches and assignments.
- `PARTIAL` Close confirmation — reconcile is role-gated by `collector_batches:reconcile`
  (`collector-batches.routes.ts:33, 57`), but there is no separate confirm-then-close step.

### 4. Receivables and overdue monitoring (3.9)

- `PARTIAL` Dashboard totals — outstanding AR and aging-derived overdue exist
  (`dashboard.service.ts:183-198`); "current receivable" is the aging current bucket; there is no
  explicit follow-up/suspension-candidate KPI, only a `suspendedAccounts` count (`:192`).
- `PASS` Five aging buckets with correct boundaries — `classifyInvoiceAge`
  (`constants/collections.ts:157-175`); boundaries pinned in `ar-aging.test.ts:42-48`.
- `PASS` Bucket totals reconcile to outstanding balances — `ar-aging.test.ts:53-127` plus a live
  PostgreSQL check `collections.postgres.test.ts:435-470`.
- `PARTIAL` Overdue list fields — subscriber, service, plan, months unpaid, total overdue,
  collector, last payment (`overdue-accounts.service.ts:47-57`); **area** and **oldest unpaid
  invoice number** are missing.
- `FAIL` Required filters — overdue supports only `noPaymentInDays` and
  `minConsecutiveOverdueMonths` (`types/collection.types.ts:151-157`);
  `ar-aging` supports only `asOfDate` and `format` (`:140-147`). No collector, area, plan or
  service-type filter.

### 5. Suspension and reconnection (3.10)

- `PASS` Suspend/reconnect endpoints with separate permissions —
  `service-accounts.routes.ts:33-35`, `:24-25`.
- `PASS` Reason, effective date and approver — reason required ≥10 chars
  (`subscriber.types.ts:89-97`), `suspensionDate` set (`service-accounts.service.ts:347-352`),
  actor in `serviceStatusHistory.changedBy` (`:357-361`).
- `PASS` Reconnection fee — fee from the plan (`:428`), posted as a fee entry plus a reconnection
  invoice (`:392-444`; client `SubscriberDetailPage.tsx:257-268`).
- `PARTIAL` Service history — all changes recorded (`recordStatusChange` `:308-313`), but there is
  no `suspension_records` or `reconnection_records` table; history is the generic status log.
- `FAIL` Configurable grace period and suspension threshold — `suspension_after_days` is seeded
  (migration `0008:47`) but nothing reads it except `system-settings.service.ts:81`, so no
  automatic suspension happens at the threshold.
- `FAIL` Technician assignment, reconnection request date, completion date — no matches anywhere
  in the repository.
- `PARTIAL` Client surface — there is no "Services" navigation section
  (`AppNavigation.tsx:15-28`); controls are buttons inside `SubscriberDetailPage.tsx:131-148` and
  bulk suspend in `OverdueAccountsPage.tsx:70-141`.

### 6. AT-09 (concurrent clients)

- `PARTIAL` Server-side concurrency proven, multi-PC not — `Promise.all` races show unique
  concurrent batch numbers (`collections.postgres.test.ts:368-399`) and serialized duplicate
  sequence postings (`ledger.postgres.test.ts:276-300`). `scripts/verify-electron-gui.cjs` is a
  single-session navigation smoke test. All three `*.postgres.test.ts` files skip when no database
  is reachable (`skipIf(!databaseIsReachable)`), so this evidence disappears without a live
  PostgreSQL. Cross-session isolation tested is role-based
  (`collections.postgres.test.ts:401-433`), not two or three workstations.

### 7. Test mapping for this area

- Fake in-memory Drizzle stand-in (`apps/server/test/support/fake-database.ts`) means route and
  calculation tests need no live PostgreSQL; `*.postgres.test.ts` do.
- `AT-07` balanced remittance — COVERED (`collections.postgres.test.ts:226`,
  `collections.routes.test.ts:558-671`).
- `AT-08` 500 shortage not silently closed — COVERED (`collections.routes.test.ts:576` stores
  −5000; notes forced at reconcile `:632-650`).
- `AT-09` two or three PCs — PARTIAL/UNCOVERED at the letter of the spec; see above.

---

## Section 2 + 4.5 + 5 + 5.2 — Architecture, stack, data model, reliability (rubrics A, 10 pts; B, 15 pts)

### 1. Electron security surface (2.1, 2.3)

- `PASS` contextIsolation / nodeIntegration / sandbox — `apps/client/electron/main.ts:85-87`,
  repeated for the print-preview window at `:169-171`.
- `PASS` No renderer → PostgreSQL path — client dependencies are axios/zustand/router only
  (`apps/client/package.json:10-18`); `pg` and `drizzle` are absent from the client; all renderer
  data flows through `apps/client/src/lib/api-client.ts:1-25`.
- `PASS` Narrow typed preload — `apps/client/electron/preload.ts:15-46` exposes 5 fixed channels
  (file picker, print, print-preview, app version, app config), typed at
  `apps/client/src/types/electron.d.ts:15`.
- `PARTIAL` No arbitrary IPC — all five `ipcMain.handle` registrations are fixed-capability
  (`main.ts:141-173`), but `open-print-preview` (`:163-173`) loads renderer-supplied HTML through
  a `data:` URL. The window is sandboxed, so exposure is limited, but the channel accepts
  unbounded content.

### 2. Recommended stack (section 2.2)

| Layer | Required | Status | Evidence |
| --- | --- | --- | --- |
| Desktop shell | Electron 44.x | MISSING | `^32.2.5`, installed 32.3.3 — `apps/client/package.json:31` |
| | electron-vite | PASS | `apps/client/package.json:8, 33` |
| | electron-builder | PASS | `:32` + `electron-builder.config.js` |
| UI | React 19.2 | SUBSTITUTED | React `^18.3.1` — `:19-20` |
| | Tailwind CSS 4 | PASS | `:25, 32` |
| | shadcn/ui | SUBSTITUTED | hand-rolled `apps/client/src/components/ui/*`; no radix/cva/clsx |
| Tables / data | TanStack Table + Query | SUBSTITUTED | absent; zustand + custom hooks (`package.json:22`, `src/stores`, `src/hooks`) |
| API | Fastify 5 | PASS | `apps/server/package.json:20` |
| Database | PostgreSQL | PASS | `pg ^8.13.1` — `:21` |
| ORM | Drizzle | PASS | `drizzle-orm ^0.44.0` — `:23`, `drizzle.config.ts` |
| Validation | Zod 4 | SUBSTITUTED | zod `^3.23.8` (3.25.76 installed) — server + shared |
| Forms | React Hook Form | MISSING | absent from client deps and lockfile |
| Reports | ExcelJS | SUBSTITUTED | dependency-free ZIP/XML writer — `shared/xlsx/xlsx-writer.ts:1-9` |
| | pdfmake | SUBSTITUTED | `pdf-lib ^1.17.1` — `apps/server/package.json:24` |
| Testing | Vitest + API integration tests | PASS | 45 test files incl. `payments.postgres.test.ts`, `collections.postgres.test.ts` |
| | Playwright Electron | MISSING | zero references; only `scripts/verify-electron-gui.cjs` |
| Logging | Pino | PASS | `apps/server/src/index.ts:41-43` + `pino-pretty` |

TypeScript strict mode passes: `strict: true` and `noUncheckedIndexedAccess` in
`tsconfig.base.json:9, 14`, extended by all four project tsconfigs.

### 3. Architectural rules (section 2.3)

- `PASS` Zod validation of all external input — `shared/plugins/validation.plugin.ts:22-25` compiles
  route schemas; `parseOrThrow` (`shared/validate.ts:7-16`) is used 103 times across handlers, with
  per-module `z.object` schemas in all 14 handler files.
- `PASS` Business rules in services, not components — handlers are thin (parse → service →
  `sendSuccess`, e.g. `payments.handler.ts:71-100`); the client only formats money for display
  (`lib/format.ts:10-11`).
- `PASS` `db.transaction` for multi-step money posting — post payment (`post-payment.service.ts:124`),
  reversal (`reverse-payment.service.ts:38`), invoice void (`void-invoice.service.ts:26`), monthly
  billing (`monthly-billing.service.ts:104`), late fees (`late-fee.service.ts:118`), reconnection-fee
  invoice (`invoices.service.ts:284`), manual ledger entry (`ledger.handler.ts:93`), collector
  collection recording (via `postPaymentWithinTransaction`). No money-posting service skips a
  transaction; advance credit deliberately runs inside the caller's transaction
  (`advance-credit.service.ts:9`).
- `PASS` Integer centavos — branded `Centavos` type (`packages/shared/src/types/money.ts:1-10`); no
  `parseFloat` or `/100` in billing, ledger or payment services (only display formatting and
  `Number.parseInt` of a receipt sequence at `receipt-number.service.ts:51`).
- `PASS` Migration-only schema change — `drizzle.config.ts` points at
  `apps/server/src/db/migrations/` (9 SQL files); no ad-hoc DDL in application code.
- `PASS` Posted records reversed, never deleted — no `db.delete`/`DELETE` in
  `apps/server/src/modules`; payment status becomes `reversed` with a `payment_reversals` row
  (`db/schema/payments.ts:5-6`), invoices use `void` plus `voided_at`/`voided_by`, batches use void
  columns (migration `0006_narrow_shape.sql`).

### 4. Minimum data model (section 5)

19 tables confirmed as `CREATE TABLE` in the migrations. Concepts with **no dedicated table**, and
where the concept actually lives:

| Required concept | Where it lives today | Verdict |
| --- | --- | --- |
| roles, permissions, role_permissions, user_roles | `users.role` enum + code matrix — `0000_sloppy_scourge.sql:1, 7`, `constants/roles.ts:4`, `permissions.ts` | SUBSTITUTED |
| billing_cycles | `invoice_due_day_of_month` setting + invoice period columns — `constants/system.ts:11` | SUBSTITUTED |
| adjustments | `manual_debit`/`manual_credit` ledger entries — `db/schema/ledger.ts:37, 45`, `ledger.service.ts:483` | SUBSTITUTED |
| payment_proofs | `gcash_payments.screenshot_file_path` — `db/schema/payments.ts:117` | SUBSTITUTED |
| receipts | `payments.receipt_number` + `payment_reversals.reversal_receipt_number` — `0004_square_tattoo.sql:31, 49` | SUBSTITUTED |
| collection_areas | `subscribers.service_barangay/municipality` strings — `0002_brown_triton.sql:40` | SUBSTITUTED |
| collector_assignments | `service_accounts.assigned_collector_id` — `0002_brown_triton.sql:66` | SUBSTITUTED |
| collector_remittances | `collector_batches.expected/actual/variance` — `db/schema/collections.ts:82-88` | SUBSTITUTED |
| suspension_records, reconnection_records | `service_status_history` with previous/new status + reason — `db/schema/subscribers.ts:158-163` | SUBSTITUTED |
| application_settings | `system_settings` — `0008_smooth_magus.sql:15` | SUBSTITUTED |
| subscriber_addresses | denormalized columns on `subscribers` | SUBSTITUTED |
| service_types | `subscription_plans.service_type` enum | SUBSTITUTED |
| service_events/devices | nothing — closest is status-only `service_status_history` | **MISSING** |
| backup_history | nothing; backups exist only as shell output, the database has no record | **MISSING** |

### 5. Minimum constraints and indexes (section 5.2)

- `PASS` Unique subscriber account number — `0002_brown_triton.sql:48`.
- `PASS` Unique service account number — `0002_brown_triton.sql:17`.
- `PASS` Unique invoice number — `0003_broken_lake.sql:50`.
- `PARTIAL` Duplicate service-account + billing-period protection — `invoices_service_account_period_idx`
  is deliberately non-unique (`0003_broken_lake.sql:75`, rationale in `db/schema/billing.ts:105-110`).
  Protection is a service-level row lock plus status-aware check
  (`monthly-billing.service.ts:104-122`), so the guarantee is application-level only and there is no
  database constraint for a defense question about duplicates.
- `PASS` Unique receipt number with voided numbers reserved — `payments_receipt_number_unique`
  (`0004_square_tattoo.sql:49`) plus unique reversal numbers (`:31`); rows are never deleted, and the
  sequence is allocated under an advisory lock (`receipt-number.service.ts:72`).
- `PASS` GCash reference uniqueness — `gcash_payments_gcash_reference_number_unique`
  (`0004_square_tattoo.sql:13`) plus an application check (`post-payment.service.ts:98-108`).
- `PASS` Foreign keys on owned records — every migration adds FKs with `ON DELETE no action`.
- `PARTIAL` Required indexes — present: payment date, collector, invoice date/period. Missing at the
  SQL level: subscriber name and contact (search is `ILIKE`, `subscribers.service.ts:97-99`), invoice
  **due date** (only `invoice_date` exists, `0007_broad_human_fly.sql:1`), and any collection-area
  index because no area entity exists.

### 6. Reliability and performance (section 4.5)

- `PARTIAL` Server-side pagination — subscribers, ledger, audit and batches paginate with a maximum
  page size of 100; **invoices** (`invoices.service.ts:153-175`) and **payments**
  (`payments.service.ts:154-187`) have no `LIMIT` and ship the full dataset to the renderer, which
  contradicts section 4.5 at the stated target of 500,000 rows.
- `PASS` Transactional critical operations — see rule 3 above.
- `PASS` Backup verification and restore workflow — `scripts/backup.sh:49-60` verifies gzip
  integrity and a minimum size before atomically publishing; `scripts/restore.sh:42-51` validates the
  archive and contents before the destructive `pg_restore --clean` at `:69`.
- `PASS` Understandable user errors, technical detail to logs — `apps/server/src/index.ts:85-97`
  returns a generic 500 message and logs the detail; `api-client.ts:60-77` maps failures to human
  text.

---

## Section 3.3–3.7 — Billing, ledger, payments, receipts, GCash (rubric C, 20 pts)

### 1. Billing engine (3.3, 3.4)

- `FAIL` Invoice state set — `packages/shared/src/constants/statuses.ts:19-27` and the enum in
  migration `0003_broken_lake.sql:1` — the repo uses `posted` where the spec says `UNPAID`, and has
  **no `CREDITED` state** at all; advance credit exists only as a negative ledger balance.
- `PASS` Monthly generation for active service accounts — `monthly-billing.service.ts:44-54`, one
  DRAFT per account (`:90-172`, run `:182-247`).
- `PASS` Subscription charge line item — `invoice-calculations.ts:40-49`.
- `PARTIAL` Other line items — reconnection fee exists (`invoices.service.ts:262-341`) but there is
  **no installation-fee path**; **discount is entirely absent** (`grep discount apps/server/src` = 0
  hits, so no rounding rule exists for it either); penalty exists (`late-fee.service.ts:104-155`);
  debit/credit adjustments exist only as manual ledger entries (`ledger.service.ts:483-513`), not as
  invoice adjustments.
- Status transitions today: draft→posted (or paid when credit covers it)
  (`invoices.service.ts:213-248`); →partially_paid/paid (`payment-allocation.ts:123-125`); →overdue
  (`late-fee.service.ts:143`); →void (`void-invoice.service.ts:63-71`).
- `PARTIAL` AT-11 duplicate billing — there is **no SQL constraint** on (service account, period);
  `invoices_service_account_period_idx` is deliberately non-unique (`0003_broken_lake.sql:75`).
  Protection is a `SELECT … FOR UPDATE` on the service-account row plus a status≠void re-check
  (`monthly-billing.service.ts:105-124`). This holds for the concurrent case, but the database has no
  backstop on the period key.
- `PARTIAL` Invoice numbering — `max()+1` with **no lock** (`invoice-number.service.ts:63-81`), with
  only `invoices_invoice_number_unique` (`0003:50`) to catch collisions. Two concurrent same-period
  runs for *different* accounts read the same MAX, so the second insert hits the unique violation and
  the whole billing run rolls back. Receipt numbering does take an advisory lock; invoice numbering
  does not (AT-09 risk).
- `PASS` Finalized-invoice immutability — only drafts can be posted (`invoices.service.ts:230-232`)
  and voiding replaces deletion (`void-invoice.service.ts:63-71`). Code-enforced only: there is no
  database trigger on `invoices`.
- `PASS` Plan price changes affect only future billing — the billed rate is copied onto the line item
  at generation (`invoice-calculations.ts:40-49`, `monthly-billing.service.ts:128-159`) and never
  re-read live.

### 2. Money handling (2.3, 3.4)

- `PASS` Integer centavos end-to-end — branded `Centavos` type (`packages/shared/src/types/money.ts`),
  integer columns in `schema/billing.ts:79-83`, `schema/ledger.ts`, `schema/payments.ts:71-76, 141`;
  no numeric/float/double anywhere. Asserted by `phase9-invariants.postgres.test.ts:85, 99`.
- `PASS` No precision loss on authoritative paths — no `parseFloat`, `toFixed`, `/100`, `*100` or
  `Math.round` in billing, ledger or payment code; `Number()` is applied only to integer aggregates
  (`ledger.service.ts:96, 132, 157`).
- `PARTIAL` Rounding rule — undefined and untested, because discounts and percentage math do not
  exist; the late fee is a fixed integer (`DEFAULT_LATE_FEE_CENTAVOS`).

### 3. Ledger (3.5)

- `PASS` Reproducible running balance — derived at write time by
  `computeRunningBalanceCentavos` (`ledger-integrity.ts:47-54`) and recomputable
  (`ledger.service.ts:112-133`); `ledger-integrity.test.ts` asserts the recompute and
  `ledger.postgres.test.ts:184` the full flow. `runningBalanceCentavos` is stored as a cache, not as
  the authority.
- `PASS` Debit/credit directions — the debit set is declared at `constants/ledger.ts`
  (`DEBIT_LEDGER_ENTRY_TYPES`); posting debits the remaining balance (`ledger.service.ts:333-355`),
  payment credits allocations plus advance (`:420-476`), reversal debits the full amount (`:478-500`),
  void credits the total (`:363-385`).
- `PARTIAL` Append-only — enforced by a source-scan test (`ledger-immutability.test.ts:30-55`) but
  there is **no database trigger** on `ledger_entries`; only `audit_logs` has one
  (`0008_smooth_magus.sql:38`), so any code path that bypasses the service can mutate balances.
- `PASS` Whole-ledger reconciliation exists — `phase9-invariants.postgres.test.ts:162` asserts the
  last balance equals debits − credits, and `:145` asserts a contiguous sequence.

### 4. Payments (3.6, 3.7)

- `FAIL` Payment methods — `statuses.ts:56` defines only `cash`, `gcash`, `bank_transfer`, `check`
  (four of the required five, no "Other"), and `POSTABLE_PAYMENT_METHODS = ["cash", "gcash"]`
  (`constants/payments.ts:33`) means **Bank Transfer and Cheque cannot be posted at all**.
- `PASS` Captured fields — date, amount, receipt number, actor, method, reference, notes and proof
  (`schema/payments.ts:61-117`, `post-payment.service.ts:185-235`).
- `PASS` Exact, partial and advance payments — `payment-allocation.ts:47-79`;
  `payments.routes.test.ts:221, 248`.
- `PASS` Oldest-unpaid-first default allocation — `post-payment.service.ts:76-100`
  (`orderBy invoiceDate, id`).
- `PARTIAL` Authorized manual allocation — the only control is the `payments:post` permission
  (`payments.routes.ts:24`); there is no explicit manual per-invoice allocation endpoint.
- `PASS` Reversal instead of edit — the original row survives with status `reversed`
  (`reverse-payment.service.ts:52-72`), a linked `payment_reversals` row is written (`:100-106`),
  balances are restored (`:116-160`) and actor plus reason are audited (`:108-114`);
  `payments.routes.test.ts:416`.
- `PASS` Receipt uniqueness with voided numbers reserved — `payments_receipt_number_unique`
  (`0004_square_tattoo.sql:49`) and `getNextReceiptNumber` under `pg_advisory_xact_lock`
  (`receipt-number.service.ts:70-94`); reversals use their own `RV` prefix.
- `PASS` GCash duplicate reference — **blocked** with 409 by a pre-check plus the unique constraint
  (`post-payment.service.ts:104-114, 258-277`; `0004:13`); policy documented at
  `specs/phase5-payment-processing.md:119`.
- `FAIL` GCash verification workflow (3.7 steps 4-6) — `verifiedAt` and `verifiedBy` columns exist
  (`schema/payments.ts:119-120`) but are **never written** (only a read at `payments.service.ts:252`);
  there is no verify/reject endpoint, and `postPayment` posts GCash immediately
  (`post-payment.service.ts:126-235`). "An image alone never marks the account paid" still holds
  because the upload store is separate (`gcash-screenshot.service.ts`), but "only verified payments
  are posted" and "verification identity and timestamp retained" both fail.

### 5. Transactions (2.3)

Inside `db.transaction`: invoice posting (`invoices.service.ts:186`), per-account monthly generation
(`monthly-billing.service.ts:101`), late fee per invoice (`late-fee.service.ts:119`), payment posting
(`post-payment.service.ts:126`), reversal (`reverse-payment.service.ts:43`), void
(`void-invoice.service.ts:31`).

- `PARTIAL` **Not** transactional — `runMonthlyBilling` loops accounts in separate transactions and
  writes its `billing_runs` row outside any transaction (`monthly-billing.service.ts:205-247`), so a
  crash mid-run leaves partial billing with no run record. `postAllDraftInvoices` posts invoice by
  invoice (`:270-293`), so a batch post is not atomic.

### 6. Tests for this area

Unit or fake-database (no PostgreSQL needed): `invoice-calculations`, `payment-allocation`,
`invoice-number`, `receipt-number`, `ledger-directions` (`test/support/fake-database.ts`),
`ledger-immutability` (source scan), `ledger-integrity`, `billing.routes`, `payments.routes`,
`collections-immutability`. Require a live PostgreSQL and self-skip otherwise
(`describe.skipIf(!databaseIsReachable)`, `DATABASE_URL`): `payments.postgres.test.ts:36`,
`ledger.postgres.test.ts:38`, `phase9-invariants.postgres.test.ts:41`.

### 7. Acceptance-test traceability

| AT | Proving test | Verdict |
| --- | --- | --- |
| AT-01 exact payment + receipt | `payments.routes.test.ts:221` | PASS |
| AT-02 partial payment | `payments.routes.test.ts:148`, `payment-allocation.test.ts` | PASS |
| AT-03 advance payment | `payments.routes.test.ts:248`, `payments.postgres.test.ts:253` | PASS |
| AT-04 oldest-first arrears | `payments.routes.test.ts:148`, `payment-allocation.test.ts` | PASS |
| AT-05 duplicate GCash reference | `payments.postgres.test.ts:356`, `payments.routes.test.ts:280` | PASS |
| AT-06 payment reversal | `payments.routes.test.ts:416`, `payments.postgres.test.ts:172` | PASS |
| AT-11 duplicate billing | `billing.routes.test.ts:278` | PASS single-process, PARTIAL under concurrency |

- `FAIL` No AT-by-AT acceptance-evidence artifact exists on disk. `specs/phase*.md` are build specs,
  and `audit/README.md:21-23` mentions AT ids only as audit scope. There is no test-report or
  traceability document.

---

## Section 3.11 + 4.1–4.3 + 9 D6/D7 — Reports, dashboard, UI/UX, print (rubrics E, 12 pts; G, 8 pts)

### 0. Blocking: the working tree does not build

- `FAIL` Client build — 18 page files import `../components/layout/AppShell` and
  `../components/ui/{Button,Card,Badge,EmptyState,Modal}`, none of which exist on disk
  (`apps/client/src/components/layout/` is an empty directory; `apps/client/src/components/ui/`
  contains only `ErrorBanner.tsx` and `Skeleton.tsx`). `npx tsc --noEmit -p apps/client/tsconfig.json`
  reports **79 errors, all TS2307**. Evidence: `pages/ReportsCenterPage.tsx:34-39`, `git ls-files
  apps/client/src/components` (4 tracked files). The application cannot build or be submitted until
  this is resolved; the last good bundle at `apps/client/out/` predates the refactor (26 Sep 09:13).

### 1. Required reports (3.11)

| Report | Status | Evidence |
| --- | --- | --- |
| Daily collection | EXISTS | `reports/daily-collection.service.ts:114-155` — real date-filtered posted-only query with cash/GCash/grand totals; math is pure and tested |
| Weekly, annual collection | **MISSING** | `grep -r "weekly\|annual"` across server and client: zero hits |
| Monthly collection | PARTIAL | `reports/monthly-billing.service.ts:100-186` is invoice-based (billed/paid/outstanding), not collections-by-month |
| Cash/GCash/payment-method summary | EXISTS | `daily-collection.service.ts:97-99`, `dashboard.service.ts:143` |
| Billing versus collection | PARTIAL | dashboard cards only (`DashboardPage.tsx:184-196`); no dedicated report |
| Revenue by plan / service type / area | **MISSING** | no endpoint, no view |
| AR reports | EXISTS | `receivables.routes.ts:29-31`, bucket math tested |
| Subscriber master list | PARTIAL | search screen (`SubscriberListPage.tsx:117+`), not a report and no export |
| Subscriber ledger, SOA | EXISTS | `statement-of-account.service.ts`, `StatementOfAccountPage.tsx:40+`, `subscriber_soa` export type |
| Collector remittance / shortage-overage | EXISTS | `collector-remittance.service.ts:45-83`, variance labels `lib/report-views.ts:229-239` |
| Collector assignment | **MISSING** | absent |
| Collector performance | **MISSING** | absent (only outstanding-by-collector, `outstanding-by-collector.service.ts`) |
| Payment adjustment, reversal, voided receipt | **MISSING** | no dedicated endpoints; voided items appear only as lines inside the remittance report (`collector-remittance.service.ts:53`) |
| User activity / audit | PARTIAL | `audit.service.ts:26+` log screen, not in Reports Center, no export |

Only 6 of roughly 15 required report families exist (`packages/shared/src/constants/reports.ts:16-24`).
All six implemented reports do respect their own filters — no placeholder data was found.

### 2. PDF/XLSX export and print (3.11, D6, 4.3)

- `PASS` XLSX writer is real — `shared/xlsx/xlsx-writer.ts:66-127` builds a correct stored-ZIP
  (local headers, central directory, EOCD, CRC-32 validated against a standard test vector in
  `xlsx-writer.test.ts:13-16`), emits all five OOXML parts (`:185-193`), escapes the five XML
  metacharacters (`:141`), writes numbers as numeric cells (`:160`) and sanitizes sheet names
  (`:172-175`). Residual risks: output is uncompressed (valid but larger), and money is exported as
  raw centavos with "(centavos)" in the header (`shared/xlsx/report-generator.ts:12-19`), which a
  grader opening the file may read as wrong.
- `PASS` PDF writer is real — `shared/pdf/report-generator.ts` uses pdf-lib with A4 portrait and
  landscape (`:14-15`), multi-page output with repeated headers (`:186-197`), right-aligned numerals
  (`:117-119`) and "Page N of M" numbering (`:219-224`). Risks: the peso sign is replaced with
  `PHP ` (`:26`), and fixed 2:1 column weights (`:91-97`) can truncate wide tables through `fitText`.
- `PASS` Export wiring — all six report types dispatch through one read-only path
  (`report-export.service.ts:76-136`); the client exposes per-report Export PDF/XLSX buttons gated by
  `reports:export` (`ReportsCenterPage.tsx:466-487`); AR aging also has a dedicated XLSX route
  (`receivables.routes.ts:27`).
- `PARTIAL` Print layout — `styles.css` has **no `@media print` rules at all** (11 lines total).
  Three pages use Tailwind `print:hidden`, a dedicated Electron preview window exists
  (`electron/main.ts:160-163`, `preload.ts:31`), and Reports Center builds standalone print HTML
  (`ReportsCenterPage.tsx:504-540`); but SOA and receipt printing render inside the missing
  `AppShell`, so "clean print layout without application navigation" is only partly realized.

### 3. Dashboard (4.3)

`dashboard.service.ts:88-141` computes 16 real KPIs; `dashboard-kpis.test.ts` has 14 pure tests
including month boundaries and void/reversal exclusion.

- `PASS` 4–6 compact KPIs — 8 cards rendered (`DashboardPage.tsx:180-220`), slightly over the range.
- `PASS` AR aging — `ArAgingMiniChart` (`:59-105`).
- `PASS` Recent payments — table with right-aligned amounts (`:242-283`).
- `PASS` Billing versus collection — invoiced/collected/rate cards.
- `FAIL` Payment-method summary block — absent from the dashboard.
- `FAIL` Collector-performance block — absent (only batch-count hints).
- `PARTIAL` Overdue alerts — KPI cards plus a submitted-batch banner (`:157-167`); no overdue
  account alert feed on the dashboard itself.

### 4. UI/UX conformance (4.1, 4.2, 4.3)

- `FAIL` Design tokens — grep for `0F2747`, `2563EB`, `F6F8FB`, `059669`, `D97706`, `DC2626` returns
  **zero matches**. `styles.css:3-11` defines only `#f8fafc` and `#0f172a`; all status colours are
  Tailwind emerald/amber/rose approximations. The specified navy and accent blue are never used.
- `FAIL` Typography — `styles.css:5` sets `"Segoe UI", system-ui`, not Inter or Geist, and no webfont
  is loaded in `index.html`.
- `PARTIAL` Tabular numerals and right alignment — `tabular-nums` appears 54 times across 14 pages,
  but `DashboardPage.tsx` KPI cards have none and several list pages have none.
- `PASS` Status shown as text plus colour — e.g. `SubscriberListPage.tsx:19-24`,
  `CollectorBatchDetailPage.tsx:49-59`.
- `PARTIAL` Navigation (4.2) — `AppNavigation.tsx:16-30` covers Subscribers, Billing, Payments,
  Collector Batches (≈Collections), AR Aging/Overdue (≈Receivables), Reports, Users/Settings
  (≈Administration) and Dashboard, but **the "Services" section is missing** (only "Plans"), the
  Dashboard is not first, and the menu is a flat link list rather than grouped top-level sections.
- `FAIL` Operational tables (4.3) — `grep sticky` returns **zero hits** anywhere; no list page supports
  column sorting; pagination exists only in the audit log (25/page) with `pageSize: 100` dumps
  elsewhere (`InvoiceListPage.tsx:155`, `CollectorBatchListPage.tsx:80`); no virtualization; export
  is only in Reports Center, not per table. Search, filters and badges are present and good.
- `PARTIAL` Forms — visible labels, `required` attributes and section grouping exist
  (`AddSubscriberPage.tsx` has 13 labels, 8 required), but validation surfaces as one top banner
  rather than inline per field.
- `PASS` Receive Payment cashier flow — search (`PostPaymentPage.tsx:120`) → balance summary → amount
  → method → allocation preview (`previewAllocation`, `:41-64`) → post → print receipt (`:252-255`).
- `FAIL` GCash Verification screen — there is no verification workflow: payment statuses are only
  `posted|reversed` (`db/schema/payments.ts:11`), and the screenshot is uploaded and displayed
  statically (`PaymentDetailPage.tsx:170-192`). No two-pane queue, no proof preview pane, no
  verify/reject controls (also demo step 5 and 3.7 steps 4-6).
- `PASS` Collector Reconciliation — expected/actual/variance (`CollectorBatchDetailPage.tsx:344-368`),
  method column for non-cash, accounts and exceptions via variance notes.
- `PASS` Anti-patterns absent — no gradients, no animated counters, no decorative effects; only an
  `animate-pulse` skeleton. The interface is clean and information-dense.

---

## Section 6–9 + 11–14 — Tests, acceptance evidence, seed data, deliverables, process (rubrics H, 8 pts; I, 3 pts; J, 2 pts)

### 0. Verification commands (raw results)

| Command | Result |
| --- | --- |
| `pnpm typecheck` | **FAIL** — `apps/client` TS2307 missing `Button`, `Card`, `Badge`, `EmptyState`, `Modal`, `AppShell`; `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL client@0.1.0 typecheck` |
| `pnpm lint` | PASS — `eslint .` exit 0, no output |
| `pnpm test` | PASS — **44 files, 441 tests, 0 failed, 0 skipped**, 24.34 s |

The PostgreSQL suites did **not** silently skip: a live PostgreSQL 16 answered
(default `DATABASE_URL` in `apps/server/vitest.config.ts:20`), and
`ledger.postgres.test.ts`, `payments.postgres.test.ts`, `collections.postgres.test.ts`,
`subscribers.postgres.test.ts`, `sql-injection.postgres.test.ts` and
`phase9-invariants.postgres.test.ts` all executed. The guard is
`describe.skipIf(!databaseIsReachable)` with a `SELECT 1` probe
(`phase9-invariants.postgres.test.ts:20-29`). One genuine `it.skip` placeholder exists at
`subscribers.postgres.test.ts:271`. **The renderer has no unit tests at all** — `apps/client` and
`packages/shared` define no `test` script and there is no `apps/client/test/`.

### 1. E2E (section 2.2, rubric H)

- `FAIL` Playwright — not installed anywhere; `grep -r playwright` across the workspace returns
  nothing.
- `PARTIAL` `scripts/verify-electron-gui.cjs` (266 lines) is more than a screenshot tool: it launches
  real Electron, loads the real renderer, signs in through the real login form, captures 3 PNGs and
  makes 13 `check()` assertions on per-role navigation (admin menu at `:176`, User Management at
  `:193-196`, non-admin menu withholding admin links at `:217`). But it is login/navigation smoke,
  not workflow E2E: no payment, billing, GCash or collection flow runs through the GUI, and there are
  no visual assertions. It also requires a manually built renderer plus a static server on port 5173.
  `docs/known-limitations.md` §1-2 admits this.

### 2. Acceptance tests AT-01 to AT-12 (section 7)

| AT | Evidence | Verdict |
| --- | --- | --- |
| AT-01 exact payment | `payments.routes.test.ts:221`, `payments.postgres.test.ts:172` | PASS |
| AT-02 partial payment | `payments.routes.test.ts:187-198`, `payments.postgres.test.ts:206` | PASS |
| AT-03 advance payment | `payments.routes.test.ts:248`, `payments.postgres.test.ts:253`, `billing.routes.test.ts:147, 207, 244` | PASS |
| AT-04 oldest-first arrears | `payments.routes.test.ts:148`, `payments.postgres.test.ts:172` | PASS |
| AT-05 duplicate GCash reference | `payments.routes.test.ts:280` (409 not 500), `payments.postgres.test.ts:356` | PASS |
| AT-06 payment reversal | `payments.routes.test.ts:416, 483, 573`; reason ≥10 chars `:516` | PASS |
| AT-07 balanced remittance | `collections.routes.test.ts:558`, `:651` | PASS |
| AT-08 collector shortage | `collections.routes.test.ts:576, 599, 632` | PASS |
| AT-09 concurrent users | `ledger.postgres.test.ts:276`, `collections.postgres.test.ts:368` | PARTIAL — single-database concurrency only; no multi-PC or cross-session test |
| AT-10 authorization | `users.routes.test.ts:89, 110`, `rbac-matrix.test.ts`, `security-hardening.test.ts:164-196`, `audit.routes.test.ts:116` | PASS |
| AT-11 duplicate billing | `billing.routes.test.ts:278` | PASS single-process; concurrency relies on an app-level lock (see rubric C) |
| AT-12 backup/restore | `deployment-artifacts.test.ts:115` only asserts the scripts ship and are wired into `package.json` | PARTIAL — no automated restore test; `known-limitations.md` §4 documents a manual run |

### 3. Required test evidence on disk (section 7.1)

- `MISSING` Automated test-output artifact — produced only by `pnpm submission` into
  `submission/test-report.txt` (`scripts/build-submission.sh:47-52`); `submission/` is git-ignored and
  has never been built.
- `PASS` API/integration evidence — the seven live-PostgreSQL suites above.
- `PARTIAL` E2E or reproducible manual evidence — `verify-electron-gui.cjs` plus reproduction steps in
  its header and `known-limitations.md` §1.
- `MISSING` Screenshots or report files showing balances — `apps/client/out/gui-shots/` holds only
  `01-admin-dashboard.png`, `02-admin-users.png`, `03-role-home.png`, and the directory is git-ignored.
  Section 9 D7 requires seven screens; **1 of 7** is represented, and none shows financial balances.
- `MISSING` Bug log — no file recording issue → root cause → fix → regression test. One implicit
  example exists in history: `6764a0f fix(client): give the dashboard the full navigation menu`
  followed by `f31a49c test(client): add an Electron GUI smoke check`.

### 4. Seed and demo dataset (section 8)

`apps/server/src/db/seed.ts` (92 lines) seeds **system settings and one administrator only**
(`:42-70`); `seed.test.ts` has 4 idempotency/hash tests. No demo-dataset generator exists anywhere.

| Requirement | Minimum | Actual | Verdict |
| --- | --- | --- | --- |
| Users (Admin, Cashier, Supervisor, Auditor/Viewer) | 5 | 1 admin | FAIL |
| Plans (3 Internet, 2 Cable, 2 Combo) | 7 | 0 | FAIL |
| Subscribers | 50 | 0 | FAIL |
| Service accounts | 60+ | 0 | FAIL |
| Collectors | 2 | 0 | FAIL |
| Collection areas | 3 | 0 | FAIL |
| Invoices across 3 billing months | 3 months | 0 | FAIL |
| Payments (cash/GCash/partial/exact/advance mix) | mix | 0 | FAIL |
| Overdue accounts across aging buckets | 10 | 0 | FAIL |
| Reversal or void example | ≥1 | 0 | FAIL |
| Suspension and reconnection scenarios | ≥2 | 0 | FAIL |

This fails section 14 checklist item 5 and leaves the section 11.1 live demonstration without data.

### 5. Deliverables (section 9, 9.1)

| D | Item | Verdict |
| --- | --- | --- |
| D1 | Source repository | PASS — `README.md`, `.env.example` with no secrets, 19 migration files tracked, seed script, `.gitignore`, 85 commits |
| D2 | Working release | PARTIAL — `electron-builder.config.js` and `build:installer` exist, but no `.exe` was ever produced (`known-limitations.md` §3: needs Windows; only Linux directory packaging was validated) |
| D3 | Technical documentation | PASS with one gap — `docs/technical/README.md` (490 lines) covers structure, schema, design decisions, authorization matrix, financial model, collections, config, dev and tests; the ERD/data-dictionary sub-item is tables-in-prose rather than a diagram or dictionary |
| D4 | User manual | PASS — `docs/user-manual/README.md` (305 lines) |
| D5 | Testing package | PARTIAL — 441 real tests, but no committed test plan or defect evidence; the report is generated only at submission time |
| D6 | Sample reports | **MISSING** — no `docs/samples/`, no PDF/XLSX artifacts in the repo |
| D7 | UI evidence | **MISSING** — 1 of 7 required screens, in a git-ignored directory |
| D8 | Presentation / defense | **MISSING** — nothing beyond `docs/known-limitations.md` |
| 9.1 | Submission assembler | EXISTS — `scripts/build-submission.sh` (87 lines) builds the required folder layout and degrades honestly without pandoc, installer or samples; never run |

### 6. Development process (sections 12, 13, 14)

- `PASS` Conventional commits — 85 of 85 match `^(feat|fix|test|docs|chore|refactor|...)`.
- `FAIL` No checkpoint tags — `git tag` is empty; there are no CP1–CP6 markers or releases for a
  six-checkpoint activity, and the whole history spans three days (24–26 Sep).
- `PASS` `CLAUDE.md` present (45 lines, rules and phase status); no `.claude/` directory (the PDF
  suggests one for reusable rules, and this repo now uses `.pi/agents/` instead).
- `PASS` No secrets committed — only `.env.example` was ever added; `.gitignore` covers `.env`,
  `uploads/`, `backups/`, `submission/`, `out/` and agent state; enforced by
  `deployment-artifacts.test.ts:54, 61`.
- `PARTIAL` Migrations from a clean database — `known-limitations.md` §4 describes a verified run
  (19 tables, 46 indexes, 40 foreign keys, audit trigger) but no reproducible artifact is committed.
- `FAIL` Section 14 checklist items 5 (synthetic demo data — nothing exists), 12 and 13 are PARTIAL
  (no sample report files), 14 PARTIAL (no automated restore test), 15 PARTIAL (no real E2E), 17
  PARTIAL (no installer), 1 PARTIAL (client does not currently build), 2 PARTIAL (no multi-PC test),
  4 and 18 UNVERIFIED here. Items 3, 6, 7, 8, 9, 10, 11, 16 pass.

---

## Critical-failure exposure (section 10.1)

The instructor may cap the score or require rework for any of these. Current status:

| Critical condition | Status |
| --- | --- |
| Destructive deletion of posted payments | Not present — reversal pattern is correct |
| Obviously incorrect ledger balances | Not found — directions and reconciliation tests pass |
| Shared database file architecture | Not present — client/server via Fastify |
| Plaintext passwords | Not present — bcrypt ≥ 12 |
| Renderer direct database access | Not present |
| No authorization checks on the server | Not present — every mutating route is guarded |
| **Inability to restore a backup** | **AT RISK** — no backup/restore feature exists in the application, only shell scripts with no automated restore test |
| Only static UI/CRUD without the required financial workflows | Not present — financial workflows are real and tested |

An additional, self-inflicted risk sits outside the listed conditions: **the client does not build**
(79 TS2307 errors), which would make the submission undeliverable as it stands.

