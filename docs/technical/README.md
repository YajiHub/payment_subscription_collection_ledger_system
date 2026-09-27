# BCIS Subscription Billing and Collection System — Technical Documentation

This document explains what the system is, how it is put together, and why it was
built that way. It is written for a developer or reviewer who has never seen the
code before.

The requirements for each phase live in `specs/`. This document describes the
system that was actually built from them.

---

## 1. System Overview

Three office PCs share one database. PC-1 runs the API server and PostgreSQL.
Every PC runs the desktop client.

```
                    Office LAN (no internet access required)

  PC-1 ──────────────────────────────────────────────────────────────
  ┌───────────────────────────┐        ┌───────────────────────────┐
  │  BCIS desktop client      │        │  Fastify API server        │
  │  (Electron + React)       │  HTTP  │  node + TypeScript         │
  │                           │ ─────► │  http://0.0.0.0:3003       │
  └───────────────────────────┘        │                            │
                                       │  Drizzle ORM               │
  PC-2 / PC-3                          │        │                   │
  ┌───────────────────────────┐        │        ▼                   │
  │  BCIS desktop client      │  HTTP  │  ┌──────────────────────┐  │
  │  (Electron + React)       │ ─────► │  │   PostgreSQL 16      │  │
  └───────────────────────────┘        │  │   database: bcis_db  │  │
                                       │  └──────────────────────┘  │
                                       └───────────────────────────┘
```

Only the API server touches PostgreSQL. The desktop client never opens a database
connection and never issues its own HTTP request outside
`apps/client/src/lib/api-client.ts`. The Electron **main** process is reserved for
OS-level features (file dialogs, printing, the run-time config file); the
**renderer** is a sandboxed web page.

### Tech stack

| Layer          | Choice                        | Why it is here                                                            |
| -------------- | ----------------------------- | ------------------------------------------------------------------------- |
| Desktop shell  | Electron 32                   | Native window, file dialogs, and printing on plain Windows PCs            |
| UI             | React 18 + TypeScript         | Component model with compile-time checked props                           |
| UI state       | Zustand                       | Small stores for the session and API status; no Redux boilerplate          |
| Build tooling  | electron-vite + Vite 5        | One command builds main, preload, and renderer                            |
| API server     | Fastify 5                     | Fast schema validation, predictable error handling, high throughput       |
| Validation     | Zod (via fastify-type-provider-zod) | One schema validates the request and types the handler              |
| ORM            | Drizzle ORM                   | Typed SQL, readable migrations, no hidden query magic                     |
| Database       | PostgreSQL 16                 | Row-level locking for several writers at once (see §4)                    |
| Auth           | `jsonwebtoken` + bcrypt       | Stateless bearer tokens; passwords hashed with a cost factor of 12+        |
| Reports        | `pdf-lib`, dependency-free XLSX writer | Reports need no native binaries on the office PCs                |
| Packaging      | electron-builder              | NSIS installer for Windows                                                |
| Tests          | Vitest                        | Fast unit and HTTP-level tests; most run without PostgreSQL               |

---

## 2. Project Structure

pnpm workspace with three packages.

```
subscription_and_collection_ledger_system/
├── apps/
│   ├── client/                        Electron + React desktop client
│   │   ├── electron/
│   │   │   ├── main.ts                OS features only: window, dialogs, print, config.json
│   │   │   └── preload.ts             the contextBridge whitelist (capability list)
│   │   ├── src/
│   │   │   ├── lib/api-client.ts      the ONLY place the renderer performs HTTP
│   │   │   ├── lib/constants.ts       build-time API URL and poll intervals
│   │   │   ├── lib/format.ts          centavos → ₱ formatting
│   │   │   ├── components/            ProtectedRoute, ApiStatusBadge, pickers
│   │   │   ├── pages/                 one file per screen (login, billing, payments, …)
│   │   │   ├── stores/                Zustand: auth session, API status
│   │   │   └── types/electron.d.ts    types for the preload bridge
│   │   ├── electron-builder.config.js Windows installer configuration
│   │   ├── config.example.json        template for %APPDATA%\BCIS\config.json
│   │   └── build-resources/           icon and licence placeholders
│   └── server/                        Fastify API + Drizzle ORM
│       ├── src/
│       │   ├── config.ts              the ONLY file that reads process.env
│       │   ├── index.ts               builds Fastify, registers modules, listens
│       │   ├── db/
│       │   │   ├── connection.ts      the pg pool and `db` handle
│       │   │   ├── seed.ts            default settings + first Administrator
│       │   │   ├── schema/            one file per domain, barrel in index.ts
│       │   │   └── migrations/        generated SQL, applied by drizzle-kit
│       │   ├── modules/<domain>/      <domain>.routes.ts + <domain>.handler.ts
│       │   │                          (auth, users, plans, subscribers, service-accounts,
│       │   │                           billing, payments, ledger, collections,
│       │   │                           receivables, dashboard, reports, audit, system)
│       │   └── shared/
│       │       ├── middleware/        authenticate.ts, authorize.ts
│       │       ├── errors.ts          AppError subclasses → HTTP status codes
│       │       ├── response.ts        the success/error envelope
│       │       ├── plugins/           helmet, CORS, rate limit, validation
│       │       ├── audit/             append-only audit logger
│       │       ├── pdf/, xlsx/        report renderers
│       │       └── password.ts        the single bcrypt hash helper
│       └── test/                      Vitest suites (see §10)
├── packages/shared/                   types and constants shared by both apps
│   └── src/
│       ├── constants/                 roles, permissions, statuses, defaults
│       └── types/                     request/response shapes, money types
├── docs/                              technical, user-manual, deployment, limits
├── scripts/                           backup.sh, restore.sh, build-submission.sh
└── specs/                             the authoritative per-phase requirements
```

**One domain per folder.** A module's routes file declares paths and permissions;
its handler file validates input and calls service functions. Database queries
live in services, never in handlers or the renderer.

---

## 3. Database Schema

Nineteen tables. Every monetary column is an `integer` number of **centavos**
(`PHP 150.50` → `15050`); no monetary value is ever a float.

```
users ──┬─< login_audit_log
        ├─< revoked_tokens
        ├─< subscription_plans
        ├─< subscribers ──< service_accounts ──┬─< service_status_history
        │                                      ├─< invoices ──< invoice_line_items
        │                                      ├─< payments ──┬─< gcash_payments
        │                                      │             ├─< payment_allocations
        │                                      │             └─< payment_reversals
        │                                      ├─< ledger_entries
        │                                      └─< batch_assignments >─ collector_batches
        ├─< billing_runs
        ├─< collector_batches
        ├─< audit_logs
        └─< system_settings
```

### Identity

| Table              | Purpose                                                                 |
| ------------------ | ----------------------------------------------------------------------- |
| `users`            | One row per staff account: name, username, bcrypt hash, role, active flag |
| `login_audit_log`  | Every login attempt (success or failure) with the IP address             |
| `revoked_tokens`   | JWT ids logged out before they expired, so a stolen token stops working  |

### Subscribers and service

| Table                   | Purpose                                                                  |
| ----------------------- | ------------------------------------------------------------------------ |
| `subscription_plans`    | What is sold and at what price. A price change creates a **new** plan     |
| `subscribers`           | A customer/household: name, phones, service address                       |
| `service_accounts`      | One service for one subscriber (Internet, Cable TV, bundle). Billing, ledger, and payments attach here, not to the subscriber |
| `service_status_history`| Every status change (active → suspended → active …) with its reason       |

### Billing

| Table               | Purpose                                                                    |
| ------------------- | -------------------------------------------------------------------------- |
| `invoices`          | A financial obligation. `(service_account_id, billing_period_year, billing_period_month)` is the duplicate check |
| `invoice_line_items`| The lines shown on the printed invoice                                      |
| `billing_runs`      | A log of every monthly billing job: processed, generated, skipped, total    |

### Payments

| Table                 | Purpose                                                                  |
| --------------------- | ------------------------------------------------------------------------ |
| `payments`            | One row per payment: receipt number, method, amount, allocated vs advance |
| `gcash_payments`      | GCash reference number (UNIQUE system-wide, stored normalized), sender, screenshot path, verification (`verified_at`/`verified_by`, `rejected_at`/`rejected_by`/`rejection_reason`) |
| `payment_allocations` | Exactly how a payment was spread across invoices — the audit trail of the allocation algorithm |
| `payment_reversals`   | When a payment is undone: reason, reversal receipt number, who and when   |

### Ledger

| Table            | Purpose                                                                       |
| ---------------- | ----------------------------------------------------------------------------- |
| `ledger_entries` | Every financial event in order, one chain per service account. Immutable: a correction is a new offsetting row. `sequence_number` is unique per account |

`balance = SUM(debits) − SUM(credits)`. Amounts are always positive; the entry
type decides the direction. `running_balance_centavos` caches the balance after
the entry and can always be recomputed from the rows.

### Field collection

| Table               | Purpose                                                                     |
| ------------------- | --------------------------------------------------------------------------- |
| `collector_batches` | One collection run for one collector, with expected/actual/variance amounts  |
| `batch_assignments` | Which accounts were in the batch and what the collector found at each        |

### System

| Table             | Purpose                                                                    |
| ----------------- | -------------------------------------------------------------------------- |
| `audit_logs`      | Append-only record of consequential actions. A database trigger refuses UPDATE and DELETE |
| `system_settings` | Configurable business rules as text key/value rows (late fee, due day, …)   |

---

## 4. Key Design Decisions

**Why PostgreSQL instead of SQLite?**
Three PCs write at the same time — two cashiers can post payments in the same
second. SQLite serializes writers behind a whole-file lock, so one payment waits
for the other and a crash mid-write risks the file. PostgreSQL locks individual
rows and transactions, so concurrent writers do not corrupt each other's data.
The ledger also relies on `FOR UPDATE` row locks and advisory locks, which SQLite
does not offer.

**Why Drizzle ORM instead of raw SQL or a heavier ORM?**
Drizzle keeps queries in TypeScript next to their types, and generates plain,
readable SQL migrations that can be reviewed before they run. There is no
hidden lazy-loading behaviour and no query magic, which matters for financial
code where "what exactly does this touch?" must always be answerable.

**Why Fastify instead of Express?**
Fastify validates a request against a JSON schema (here, Zod) before the handler
runs, has one predictable error handler, and ships security plugins
(`@fastify/helmet`, `@fastify/cors`, `@fastify/rate-limit`) as first-class
citizens. Less glue code means fewer places for authorization to be forgotten.

**Why Electron instead of a browser app?**
The office needs native printing for receipts and reports, and a file dialog for
GCash screenshots, on Windows PCs without a developer toolchain. Electron
provides both, while keeping the UI a normal React application.

**Why is all business logic on the server?**
Billing, allocation, and reversal rules live in service modules
(`billing.service.ts`, `payments.service.ts`, `ledger.service.ts`). The renderer
only collects input and displays results. One auditable implementation means a
rule can never be enforced differently on one PC than another. Hiding a button is
a convenience; the server's `authorize()` check is the actual gate.

**Why integer centavos?**
Floating-point arithmetic cannot represent `0.1` exactly. Summing floats loses
centavos. Integer arithmetic is exact, and a ledger that does not reconcile to
the centavo is worthless.

---

## 5. Authentication & Authorization

### JWT flow

```
POST /api/auth/login { username, password }
        │
        ├─ bcrypt.compare against the stored hash (always runs, even for an
        │  unknown username, so response time cannot reveal which accounts exist)
        ├─ write the attempt to login_audit_log
        └─ sign a JWT: { sub: userId, role, jti, iat, exp }   (expires in 8 hours)

Every later request:  Authorization: Bearer <token>
        │
        ├─ authenticate  — verifies the signature and expiry, and checks the jti is
        │                  not in revoked_tokens → 401 when invalid
        └─ authorize(permission) — resolves the caller's effective permissions → 403
                                   when they do not hold that permission

POST /api/auth/logout → writes the jti to revoked_tokens, so the token is dead
                         immediately rather than at expiry.
```

The role is embedded in the token but is **not** trusted on its own. `authorize()`
resolves the caller's permissions on every protected route.

### How permissions are resolved (S1-2, S12-9)

Permissions come from the four RBAC tables (`roles`, `permissions`,
`role_permissions`, `user_roles`), so changing a grant takes effect **without a
code deploy**. The compiled `ROLE_PERMISSIONS` matrix in
`packages/shared/src/constants/permissions.ts` is kept as a documented **fallback**.

The resolver lives in `apps/server/src/shared/rbac/permission-resolver.ts` and:

- caches the resolved matrix in memory for `RBAC_PERMISSION_CACHE_TTL_MS` (default
  30 s), because authorization runs on every request;
- exposes `invalidatePermissionCache()`, the real invalidation path called whenever
  roles, grants or a user's role change. It moves the cache to "unloaded", which
  **denies until re-resolved**, so no caller is ever answered from a stale or
  compiled source in the gap; the caller kicks off a refresh immediately;
- **resolves on demand** when the cache is not loaded, and **denies** if that
  resolution fails — an unresolved cache is never answered from the compiled
  matrix;
- **fails closed** on a database failure: every check is refused until a refresh
  succeeds;
- **denies a user with no resolved grants.** Deleting every `user_roles` row or
  revoking every permission must not silently fall back to the compiled role set;
- selects the compiled matrix **only** when the seeded switch
  `system_settings.rbac_permissions_in_database` is the explicit string `"false"`.
  A missing row, a garbage value or a settings row lost in a partial restore all
  mean the DATABASE is the authority.

A monotonic epoch guards against a stale resurrection: a refresh captures the epoch
when it starts and discards its snapshot if an invalidation landed meanwhile, so an
in-flight read can never overwrite newer authority. `startServer` AWAITS the initial
load before it listens, so there is no boot window in which authorization is
unresolved. Users created or role-changed through the API write `user_roles` in the
same transaction, so the tables are the single source of truth for them too.

### Permission matrix

| Permission                     | Admin | Billing Clerk | Cashier | Collector | Manager |
| ------------------------------ | :---: | :-----------: | :-----: | :-------: | :-----: |
| `users:create/read/update/deactivate` | ✓ | | | | |
| `subscribers:create/update`    | ✓ | ✓ | | | |
| `subscribers:suspend`          | ✓ | ✓ | | | |
| `subscribers:reconnect`        | ✓ | ✓ | | | |
| `subscribers:read`             | ✓ | ✓ | ✓ | ✓ | ✓ |
| `plans:create/update`          | ✓ | ✓ | | | |
| `plans:read`                   | ✓ | ✓ | | | ✓ |
| `invoices:generate`            | ✓ | ✓ | | | |
| `invoices:void` (also guards a draft discount) | ✓ | | | | |
| `invoices:read`                | ✓ | ✓ | ✓ | ✓ | ✓ |
| `payments:post`                | ✓ | | ✓ | | |
| `payments:reverse`             | ✓ | | | | |
| `payments:read`                | ✓ | ✓ | ✓ | ✓ | ✓ |
| `receipts:print`               | ✓ | ✓ | ✓ | | |
| `ledger:read`                  | ✓ | ✓ | ✓ | | ✓ |
| `ledger:verify` / `ledger:adjust` | ✓ | | | | |
| `collector_batches:create`     | ✓ | ✓ | | | |
| `collector_batches:read`       | ✓ | | ✓ | ✓ | ✓ |
| `collector_batches:remit`      | ✓ | | | ✓ | |
| `collector_batches:reconcile`  | ✓ | | ✓ | | |
| `reports:view`                 | ✓ | ✓ | ✓ | ✓ | ✓ |
| `reports:management_view`      | ✓ | ✓ | | | ✓ |
| `reports:export`               | ✓ | | | | ✓ |
| `system:settings` / `system:backup` | ✓ | | | | |
| `backup:create` / `backup:restore` (owner / administrator only) | ✓ | | | | |
| `payments:verify_gcash` / `payments:reject_gcash` | ✓ | | ✓ | | |
| `payments:allocate_manually` | ✓ | | ✓ | | |
| `audit:read`                   | ✓ | | | | |

### Spec-name → permission-spelling equivalence (S5-2)

The lab specification names some permissions in `domain.verb` form; this repository
spells them `domain:verb`. The equivalent is never renamed — every live route guard
keeps working — and the mapping is documented in the code too:

| Specification name | Permission in this repository |
| ------------------ | ----------------------------- |
| `subscriber.view` | `subscribers:read` |
| `billing.generate` | `invoices:generate` |
| `payment.create` | `payments:post` |
| `payment.reverse` | `payments:reverse` |
| `collection.reconcile` | `collector_batches:reconcile` |
| `report.export` | `reports:export` |
| `user.manage` | `users:create` / `users:update` / `users:deactivate` |
| `backup.restore` | `backup:restore` (legacy: `system:backup`) |
| `backup.create` | `backup:create` (legacy: `system:backup`) |

GCash verification and manual allocation had no earlier equivalent, so
`payments:verify_gcash`, `payments:reject_gcash` and `payments:allocate_manually`
are new. They are held by the Owner, Administrator and Cashier; a Technician and a
Read-only Viewer hold none of them.

Notable consequences, all enforced on the server:

- A **Cashier** may post and read payments but cannot generate invoices or create
  subscribers, and cannot remit a collector batch.
- A **Collector** works their own batches and remits cash, but cannot create a
  batch and cannot post an office payment — `payments:post` is not granted.
- A **Manager** is read-only: no create, update, or delete permission at all.
- Only an **Admin** may reverse a payment, adjust the ledger, change system
  settings, or read the audit trail.

Wrong role → **HTTP 403** from the server, regardless of what the UI shows.

Guard width: a read endpoint requires a read permission. `GET
/api/collector-batches/collectors` used to demand `collector_batches:create` and now
requires `collector_batches:read` (S5-8); proof/screenshot retrieval stays on
`payments:read`.

### Failed-login lockout (S5-5)

In addition to the per-IP rate limit, an account locks after
`LOGIN_LOCKOUT_THRESHOLD` consecutive failures (default 5) for
`LOGIN_LOCKOUT_COOLDOWN_MINUTES` (default 15). Both are read from `system_settings`
(`login_lockout_threshold`, `login_lockout_cooldown_minutes`) with the `config.ts`
values as the bootstrap default. The counter is **derived**: it counts failures
recorded in `login_audit_log` since the account's last success, so a successful
login clears it without deleting a row. A locked account is refused (HTTP 429)
before the password is verified, the refusal is written to `login_audit_log` and the
audit trail, and a real and an unknown username receive the identical message.

The lock is **anchored to the moment the failure count reached the threshold**, not
to the most recent failure. Further requests while locked cannot push the unlock
out, so an attacker cannot keep an account locked forever with one request per
cooldown. After the cooldown elapses the streak is spent and the next failure starts
a fresh streak, so brute-force protection resumes without a successful login.

### Backup and restore (S5-3)

Backup as an application feature is Owner/Administrator only (`backup:create` to
create, list and verify; `backup:restore` to restore). The endpoints run the shipped
`scripts/backup.sh` / `scripts/restore.sh`, then apply the checks the application
owns: an archive is verified (size, gzip integrity, decompressed size and a sha256
checksum) before it is published to `backup_history` with `verified_at`; a restore
re-verifies the archive, refuses an unverified or corrupt one, and never runs
without the explicit `{ "confirm": true }` body. Every backup and restore appends a
`backup_history` row; a successful restore also stamps `restore_tested_at`.

---

## 6. Financial Model

Invoices, the ledger, and payments describe the same money from three angles. The
ledger is the single source of truth for what a service account owes.

```
  Invoices                                              Ledger (per service account)
  ─────────────────────────────                         ────────────────────────────
  monthly invoice ──── posted ──────────────►  DEBIT   invoice_posted    +amount
  invoice voided  ─────────────────────────►  CREDIT  invoice_void      −amount
  late fee charged ────────────────────────►  DEBIT   late_fee          +amount
  payment received ────────────────────────►  CREDIT  payment_received  −amount
  payment reversed ────────────────────────►  DEBIT   payment_reversal  +amount
  overpayment held ────────────────────────►  CREDIT  advance_credit    −amount
  advance used on a new invoice ───────────►  DEBIT   advance_credit_applied +amount

  balance_centavos = SUM(debits) − SUM(credits)      → positive: owes money
                                                     → negative: holds credit
```

### A payment, step by step

```
  Cashier posts PHP 1,500.00 (150000 centavos) for an account with two open invoices

  1. Validate and lock the service account row for update (inside a transaction)
  2. Allocate oldest invoice first:
         Invoice A remaining 100000  → allocate 100000  (status becomes paid)
         Invoice B remaining  80000  → allocate  50000  (status partially_paid)
     allocated = 150000, advance = 0
     money check: allocated + advance === amount          (always)
  3. Insert `payments` (receipt number OR-YYYY-XXXXXX, unique forever)
     Insert one `payment_allocations` row per invoice touched
  4. Insert one CREDIT `ledger_entries` row of 150000
  5. Update each invoice's paid/remaining totals and status
  6. Write an `audit_logs` row
  7. COMMIT — any failure rolls the whole thing back, so no partial payment exists
```

If the amount is larger than every open invoice, the remainder becomes an
**advance credit** (`advance_credit_centavos > 0`). The next monthly invoice
automatically consumes it via an `advance_credit_applied` debit, so the subscriber
is never billed twice for money already held.

### Payment methods (S3-1)

The five methods section 3.6 requires are all postable, and the three lists that
describe them are the same five values: `PAYMENT_METHODS` in
`packages/shared/src/constants/statuses.ts`, `POSTABLE_PAYMENT_METHODS` in
`packages/shared/src/constants/payments.ts`, and the `payment_method` enum in
`apps/server/src/db/schema/payments.ts`.

| Stored value    | Shown as      | How it posts                                    |
| --------------- | ------------- | ----------------------------------------------- |
| `cash`          | Cash          | Immediately                                     |
| `gcash`         | GCash         | Only when a verifier confirms it (see below)     |
| `bank_transfer` | Bank Transfer | Immediately                                     |
| `check`         | Cheque        | Immediately                                     |
| `other`         | Other         | Immediately                                     |

`check` keeps its stored spelling from migration 0004 and is labelled "Cheque" in
the interface; the enum, the label table and the API therefore need no translation
layer. The allocation algorithm does not care how the money arrived: all five run
the same oldest-invoice-first split, the same receipt numbering and the same ledger
credits.

**Totals.** `summarizePayments` in `apps/server/src/modules/reports/daily-collection.service.ts`
counts a payment only when its status is `posted`. That rule is what makes the
GCash workflow below safe: a pending or rejected claim is excluded from the daily
collection figure, and a reversed payment is excluded from every figure.

### GCash: the duplicate-reference policy (S3-4)

**One GCash transfer may be recorded once.** The reference number is the only thing
that ties a claim to a single transfer in the GCash app, so the same reference can
never be recorded twice.

Where it is enforced, in order:

1. **Normalize first (S12-7).** `normalizeGcashReference` in
   `apps/server/src/modules/payments/gcash-reference.ts` trims the ends, removes
   every whitespace character inside, and uppercases. Only whitespace changes: a
   reference may legitimately contain digits, letters and hyphens, so nothing else
   is stripped. The normalized value is what gets **stored**, which is why every
   later lookup compares like with like.
2. **Pre-check.** `postPaymentWithinTransaction` rejects a normalized reference
   that already exists with `409 CONFLICT` and a readable message naming the
   reference. The caller never sees a raw database error.
3. **Database backstop.** `gcash_payments.gcash_reference_number` is `UNIQUE`
   (migration 0004). A race that passes the pre-check is caught by the constraint
   and turned into the same `409`, never a `500`.

Consequences worth knowing:

- A reference that differs only in case or spacing is **the same reference** and is
  refused: `"0031 234 567"`, `"  0031234567 "` and `"0031234567"` collide.
- A reference that differs by a visible character is a **different** reference
  (`"GCASH-OK-001"` and `"GCASH OK 001"` do not collide), because the rule strips
  whitespace only. That is deliberate: stripping punctuation would make genuinely
  different transfers look alike.
- A rejected or reversed GCash payment keeps its reference number reserved. Its
  claim was recorded, and the reference must not silently become reusable.

### GCash verification workflow (S3-2, S3-3)

Section 3.7 splits a GCash payment in two: staff record the transfer, and an
authorized person confirms it. **An uploaded screenshot is proof of a claim, never
proof of payment** — it is stored beside the payment and has no effect on any
balance.

```text
  recorded            verify                    reject
  ────────            ──────                    ──────
  payments.status     payments.status           payments.status
  = pending_           = posted                  = rejected
    verification      allocated + ledgered      invoice untouched
  no allocations      gcash_payments:           gcash_payments:
  no ledger entry     verified_at, verified_by  rejected_at, rejected_by,
  invoice untouched                             rejection_reason
                      audit: payment.gcash_      audit: payment.gcash_
                      verified                    rejected (with the reason)
```

- **`payments.status` is the single authority.** `posted` means the money counts.
  The names S3-2 uses are reported alongside it and derived from it by
  `gcashVerificationStatus` (`packages/shared` is not the only vocabulary):
  `pending_verification` → `pending_verification`, `posted` → **`VERIFIED`**,
  `rejected` → `rejected`, `reversed` → `reversed`. There is no second copy of the
  state to drift out of step.
- **Recording** (`POST /api/payments`, permission `payments:post`) writes the
  payment row in `pending_verification` with `allocated_centavos = 0` and
  `advance_credit_centavos = 0`, plus the GCash detail row. No invoice balance, no
  allocation and no ledger entry is touched, so a pending claim cannot appear in
  the daily collection total or in any outstanding balance.
- **Verifying** (`POST /api/payments/gcash/:id/verify`, permission
  `payments:verify_gcash`) loads the payment `FOR UPDATE`, requires
  `pending_verification`, allocates oldest-invoice-first exactly as cash does,
  writes `verified_at` and `verified_by` on the GCash detail row, posts the ledger
  credit, and writes a `payment.gcash_verified` audit row with the actor.
- **Rejecting** (`POST /api/payments/gcash/:id/reject`, permission
  `payments:reject_gcash`) requires a reason of at least 10 characters, sets the
  status to `rejected`, records `rejected_at` / `rejected_by` / `rejection_reason`,
  and writes a `payment.gcash_rejected` audit row carrying the reason. The invoice
  is not touched, because there was nothing to undo.
- **`verified_at` / `verified_by` are provenance.** They are written by the verify
  step and kept afterwards — a later reversal does not erase the fact that this
  person confirmed the transfer, because the audit trail must still be able to show
  it.
- **The receipt number is reserved when the claim is recorded.**
  `postPaymentWithinTransaction` allocates the `OR-YYYY-XXXXXX` number as it always
  has, so the pending row is a complete payment from the moment it exists. The
  receipt is not *issued* — nothing is printed and no balance moves — until the
  payment is verified. A claim that is rejected therefore keeps a reserved number
  that is never printed and never reused, which is the same guarantee the receipt
  book already gives for a reversed receipt: a number is never handed out twice.

### Reversing a verified GCash payment (S3-6)

A verified GCash payment is reversed exactly like cash: `payments.status` becomes
`reversed`, a `payment_reversals` row records who reversed it and why, the invoice
balances are restored, and a debit cancels the credit. Because every read of "money
received" keys off `status = posted`, a reversed payment cannot still read as
verified-and-posted: `gcashVerificationStatus` reports it as `reversed`.

A GCash payment that **no verifier confirmed** is refused instead, with `409` and a
message naming the workflow step that does apply:

- it never posted, so there is no credit for `recordPaymentReversed` to cancel, and
  running it would invent a debit out of nothing;
- its own step is **reject**, which is already recorded with a reason.

Reversing an already-**rejected** GCash payment is refused for the same reason.

### Manual allocation (S3-5)

`POST /api/payments/manual-allocation`, permission `payments:allocate_manually`
(half of the resolvable set: it is granted to the Administrator and the Cashier),
posts a payment whose money is already in hand and directs it at the invoices the
operator chose instead of the default oldest-unpaid-first sweep.

The request carries the payment, a mandatory `reason` of at least 10 characters, and
`manualAllocation: { allocations[], advanceCreditCentavos }`. **The operator must
account for every centavo:**

```text
  SUM(allocations) + advanceCreditCentavos === amountCentavos
```

The server refuses, with 400 and a message naming the offending invoice, when:

- the chosen amounts plus the declared credit do not equal the payment — an
  **under-allocated** or **over-allocated** split;
- one invoice would receive more than it still owes;
- an invoice is named twice;
- an invoice is not outstanding for that account (already settled, void, or another
  account's).

The same invariant therefore holds on both paths: `allocated + advance === amount`.
The split and the reason are audited with the payment (`payment.posted` with
`manualAllocation: { reason, allocations }` in the new state), so an auditor sees
which invoices were chosen and why.

**GCash is not one of the methods here.** A GCash payment is allocated when a
verifier confirms it, and the verifier applies the default oldest-first split. An
operator who needs a GCash transfer aimed at particular invoices must record it,
let it verify, and correct the allocation through the ledger adjustment workflow
instead. This is a known boundary rather than an oversight: allowing a split on a
claim that has not been confirmed would let an unverified payment decide which debt
is settled.

### Partial, exact, and advance payments

| Case             | `allocated` | `advance` | Invoice status after |
| ---------------- | ----------- | --------- | -------------------- |
| Partial          | < amount    | 0         | `partially_paid`     |
| Exact            | = amount    | 0         | `paid`               |
| Overpayment      | = open debt | > 0       | invoices `paid`, credit held |

### Invoice statuses

An invoice uses exactly the state set of the specification:

`draft → unpaid / partially_paid / paid / overdue`, plus the terminal `void` and
`credited`.

- `unpaid` is the stored spelling. Migration `0020` renamed the old `posted` value
  to `unpaid`; for **one release** the API still accepts `posted` as an input alias
  (see `LEGACY_INVOICE_STATUS_ALIASES`) and normalizes it to `unpaid`, so an older
  client keeps working. The old spelling is never stored and never returned.
- `credited` is set when an **advance credit**, not a payment, fully settles an
  invoice while it is still a draft. Posting such an invoice writes no new
  `invoice_posted` debit — `advance_credit_applied` already recorded what was owed —
  so a `credited` invoice is never a debt. It is therefore refused by the void
  workflow, exactly like a `paid` invoice.

### Rounding rule for percentage line items

Line amounts are integer centavos, and the rule is applied **once per line**:

1. compute the exact line amount in centavos, then
2. round it **half away from zero** to the nearest centavo, then
3. sum the already-rounded line totals.

A rate is an integer number of basis points (1% = 100 bp), so
`amount = amountCentavos × basisPoints ÷ 10000`, and the division is rounded half
away from zero entirely in integer arithmetic (`divideRoundingHalfAwayFromZero`).
No float ever touches a money value, so the same inputs produce the same cents on
every machine. E.g. 3.33% of `99999` centavos is `3329.9667` → `3330`.

A **discount** is a first-class line item stored with a NEGATIVE total; an
**installation fee** is a first-class line item like a reconnection fee. Because a
posted invoice is immutable, a discount can be added to a `draft` only.

### Invoice adjustments: installation fee and discount (S2-3)

Both adjustments are first-class invoice line items, and both cross the HTTP
boundary as **integer centavos** — the server schemas reject a float.

| Operation                 | Route                             | Permission           | Roles that hold it |
| ------------------------- | --------------------------------- | -------------------- | ------------------ |
| Charge an installation fee | `POST /api/invoices/installation-fee` | `invoices:generate` | Admin, Billing Clerk |
| Discount a draft invoice  | `POST /api/invoices/:id/discount` | `invoices:void`      | Admin              |

**Charge an installation fee** takes
`{ serviceAccountId, installationFeeCentavos, reason? }`. It creates a NEW
`draft` invoice of type `installation_fee` whose single line is
`Installation Fee — <plan name>`, so the fee feeds the invoice total and — once
the invoice is posted — the ledger debit. Any advance credit the subscriber holds
is applied to it, exactly like a reconnection fee.

**Discount a draft invoice** takes `{ reason, discountCentavos |
discountRateBasisPoints }` — exactly one of the two forms. A percentage is an
integer **basis-point count** (1% = 100 bp), never a float. The service:

- refuses anything that is not a `draft` with **HTTP 409** (a finalized invoice is
  immutable outside the void and adjustment workflows), so a posted, paid or
  credited invoice cannot be discounted silently;
- refuses a discount that would take the invoice **below zero**, or below the
  amount still unpaid (an advance credit can pay a draft down before it is ever
  discounted), with **HTTP 400**;
- stores the discount as a negative line item, so the total always equals the sum
  of the line items, and rounds a percentage **half away from zero, once per line,
  before the lines are summed** (see the rounding rule above).

Both operations write an `audit_logs` row with the acting user, the mandatory
reason and the **old and new totals** (`invoice.installation_fee_charged`,
`invoice.discount_applied`), because a discount or a fee waiver is exactly the
action an auditor asks about.

### Corrections never delete

A posted payment is never deleted. Reversing it writes a `payment_reversals` row,
sets the payment's status to `reversed`, and adds a **debit** ledger entry of the
same amount. The original row and its ledger credit remain visible forever. The
same pattern applies to a voided invoice, and a GCash payment's verification state
is reversed with it (see *Reversing a verified GCash payment* above).

---

## 7. Collection Workflow

One batch is one collector's run in the field.

```
  Billing Clerk                         Collector                    Cashier
  ─────────────                         ─────────                    ───────
  create batch (collector + date
  + accounts with balances)
  status: open
                                        work each assignment:
                                          collected / partial / no_response /
                                          refused / promise
                                        (a "collected" visit creates a payment
                                         and a ledger credit immediately)
                                        status: open
                                        submit remittance:
                                          declare the cash handed in
                                        status: submitted
                                                                     reconcile:
                                                                       compare actual
                                                                       vs expected;
                                                                       variance stored,
                                                                       never zeroed
                                                                     status: reconciled

  A batch can also be cancelled while still open (reason recorded).
  A wrong collection is VOIDED: the payment it created is reversed and the
  assignment keeps its row with voided_at / void_reason set.
```

`expected_remittance_centavos` is the sum of the batch's recorded collections,
recomputed inside the same transaction as every collection write, so it can never
drift from the assignments. `variance_centavos = actual − expected`: positive is
an overage, negative is a shortage, and it is shown to the reconciler rather than
absorbed.

---

## 8. Configuration

Every environment variable is read in exactly one place,
`apps/server/src/config.ts`, validated with Zod. A missing or malformed value
stops the server immediately with a readable message instead of failing later.

| Variable                | Default                     | Meaning                                                          |
| ----------------------- | --------------------------- | ---------------------------------------------------------------- |
| `NODE_ENV`              | `development`               | `development` \| `production` \| `test`. Controls SQL/pretty logs |
| `PORT`                  | `3003`                      | The port the API listens on                                      |
| `DATABASE_URL`          | *(required)*                | PostgreSQL connection string, e.g. `postgresql://user:pw@host:5432/bcis_db` |
| `JWT_SECRET`            | *(required, ≥ 32 chars)*    | Signing key for session tokens. Generate a fresh random string    |
| `CORS_ORIGIN`           | `http://localhost:5173`     | Comma-separated browser origins allowed to call the API           |
| `BCRYPT_ROUNDS`         | `12`                        | Password hashing cost factor. Never lower it in production        |
| `RATE_LIMIT_MAX`        | `100`                       | Requests per minute per client IP                                 |
| `LOGIN_RATE_LIMIT_MAX`  | `10`                        | Stricter login limit per client IP, per 5 minutes                 |
| `UPLOADS_DIR`           | `uploads`                   | Where GCash proof screenshots are written                         |
| `SEED_ADMIN_USERNAME`   | `admin`                     | Username `pnpm db:seed` creates when it is absent                  |
| `SEED_ADMIN_PASSWORD`   | `Admin@1234!`               | Password for that account. **Change it after the first login**    |
| `VITE_API_BASE_URL`     | `http://localhost:3003`     | API URL compiled into the client; overridable per install (below) |

The renderer's API URL is resolved in this order:

1. `%APPDATA%\BCIS\config.json` → `{ "apiBaseUrl": "http://192.168.1.100:3003" }`
2. `VITE_API_BASE_URL` (build time)
3. `http://localhost:3003`

A config value that is not an absolute `http`/`https` URL is ignored, so a typo
cannot point the app at nothing. See `docs/deployment/README.md`.

`.env` is git-ignored; `.env.example` is committed and contains no real secrets.

---

## 9. Running in Development

```bash
corepack enable pnpm
cp .env.example .env          # then edit DATABASE_URL and JWT_SECRET
pnpm install
pnpm db:migrate               # create every table
pnpm db:seed                  # default settings + the first Administrator
pnpm dev                      # API server and Electron client together
```

`pnpm dev:server` runs only the API; `pnpm dev:client` runs only the client.

The API answers two health endpoints:

| Endpoint        | Meaning                                                             |
| --------------- | ------------------------------------------------------------------- |
| `GET /health`   | The process is alive                                                |
| `GET /health/db`| PostgreSQL answered — or `503` when it did not, without crashing     |

### Demo dataset (activity section 8)

The production bootstrap above stays minimal on purpose: it seeds the settings and
one Administrator, nothing else. A separate, explicitly-invoked script builds a
full **synthetic demo dataset** for the section 11.1 walkthrough:

```bash
pnpm db:seed:demo                 # into a fresh/demo-only database
pnpm db:seed:demo --seed=42       # a different, still deterministic dataset
pnpm db:seed:demo --confirm       # also when the database already holds non-demo rows
```

What it produces (all of it deterministic from the seed):

- 7 demo users covering Owner/Administrator, Cashier, Collection Supervisor,
  Accounting/Auditor, Read-only Viewer and Technician — all with the shared
  password `DemoPassword1!` and usernames `demo.owner`, `demo.cashier`, …;
- 7 plans (3 Internet + 2 Cable TV + 2 Combo), 3 collection areas, 2 collectors;
- 50 subscribers and 60+ service accounts spread across all three service types;
- five months of billing, with payments mixing Cash, GCash (verified, pending and
  rejected), partial, exact and advance credit;
- 10+ overdue accounts spanning the aging buckets, one approved payment reversal,
  two suspension/reconnection scenarios and two collector batches (one CLOSED,
  one REMITTED).

Every amount is created by **driving the real domain services** — monthly billing,
payment posting, GCash verification/rejection, reversal, suspension/reconnection
and the batch lifecycle — never by raw `INSERT`s, so the ledger, the invoice states,
the receipt numbers and the AR aging are consistent by construction.

Everything is obviously synthetic (names end in "(DEMO)", phones use the
reserved-looking `0900` prefix, addresses say "Demo Street", GCash references start
`DEMOGCASH-`). The script **refuses to run** against a database that already holds
a demo dataset, and against any database that holds subscribers which are not demo
data unless `--confirm` is passed — so a real office database cannot be polluted by
accident. It is the same guard the PostgreSQL suite tests.

The demo generator spans three files: `apps/server/src/db/demo/demo-plan.ts` builds a
pure, deterministic plan from a seed; `apps/server/src/db/demo/demo-dataset.ts`
applies it through the services; `apps/server/src/db/seed-demo.ts` is the entry
script. Verification lives in `test/demo-plan.test.ts` (determinism and structural
minimums, no database) and `test/demo-dataset.postgres.test.ts` (the section 8
counts, ledger/aging reconciliation and two-run determinism, against PostgreSQL).

---

## 10. Running Tests

```bash
pnpm test        # Vitest, every workspace
pnpm typecheck   # tsc --noEmit in every workspace
pnpm lint        # ESLint flat config across the monorepo
```

The suites in `apps/server/test/` fall into three kinds:

- **Pure unit tests** — money calculations, number generators, date handling,
  permission matrix. No database, no network.
- **HTTP tests** — the real Fastify app driven through `app.inject()` with the
  database mocked by an in-memory stand-in. These exercise middleware,
  authorization, validation, and handlers.
- **PostgreSQL integration tests** — marked `.postgres.test.ts`. They connect to
  `DATABASE_URL` and **skip themselves** when no server answers, so the suite
  stays green on a machine without PostgreSQL while still proving the
  transactional invariants where a database exists.

There are currently **no automated tests for the React renderer**; see
`docs/known-limitations.md`.