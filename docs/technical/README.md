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
  │                           │ ─────► │  http://0.0.0.0:3001       │
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
| `gcash_payments`      | GCash reference number (UNIQUE system-wide), sender, screenshot path      |
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
        └─ authorize(permission) — looks the role up in the permission matrix → 403
                                   when the role does not hold that permission

POST /api/auth/logout → writes the jti to revoked_tokens, so the token is dead
                         immediately rather than at expiry.
```

The role is embedded in the token but is **not** trusted on its own: `authorize()`
resolves it through the matrix in `packages/shared/src/constants/permissions.ts`
on every protected route.

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
| `invoices:void`                | ✓ | | | | |
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
| `audit:read`                   | ✓ | | | | |

Notable consequences, all enforced on the server:

- A **Cashier** may post and read payments but cannot generate invoices or create
  subscribers, and cannot remit a collector batch.
- A **Collector** works their own batches and remits cash, but cannot create a
  batch and cannot post an office payment — `payments:post` is not granted.
- A **Manager** is read-only: no create, update, or delete permission at all.
- Only an **Admin** may reverse a payment, adjust the ledger, change system
  settings, or read the audit trail.

Wrong role → **HTTP 403** from the server, regardless of what the UI shows.

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

### Partial, exact, and advance payments

| Case             | `allocated` | `advance` | Invoice status after |
| ---------------- | ----------- | --------- | -------------------- |
| Partial          | < amount    | 0         | `partially_paid`     |
| Exact            | = amount    | 0         | `paid`               |
| Overpayment      | = open debt | > 0       | invoices `paid`, credit held |

### Corrections never delete

A posted payment is never deleted. Reversing it writes a `payment_reversals` row,
sets the payment's status to `reversed`, and adds a **debit** ledger entry of the
same amount. The original row and its ledger credit remain visible forever. The
same pattern applies to a voided invoice.

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
| `PORT`                  | `3001`                      | The port the API listens on                                      |
| `DATABASE_URL`          | *(required)*                | PostgreSQL connection string, e.g. `postgresql://user:pw@host:5432/bcis_db` |
| `JWT_SECRET`            | *(required, ≥ 32 chars)*    | Signing key for session tokens. Generate a fresh random string    |
| `CORS_ORIGIN`           | `http://localhost:5173`     | Comma-separated browser origins allowed to call the API           |
| `BCRYPT_ROUNDS`         | `12`                        | Password hashing cost factor. Never lower it in production        |
| `RATE_LIMIT_MAX`        | `100`                       | Requests per minute per client IP                                 |
| `LOGIN_RATE_LIMIT_MAX`  | `10`                        | Stricter login limit per client IP, per 5 minutes                 |
| `UPLOADS_DIR`           | `uploads`                   | Where GCash proof screenshots are written                         |
| `SEED_ADMIN_USERNAME`   | `admin`                     | Username `pnpm db:seed` creates when it is absent                  |
| `SEED_ADMIN_PASSWORD`   | `Admin@1234!`               | Password for that account. **Change it after the first login**    |
| `VITE_API_BASE_URL`     | `http://localhost:3001`     | API URL compiled into the client; overridable per install (below) |

The renderer's API URL is resolved in this order:

1. `%APPDATA%\BCIS\config.json` → `{ "apiBaseUrl": "http://192.168.1.100:3001" }`
2. `VITE_API_BASE_URL` (build time)
3. `http://localhost:3001`

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