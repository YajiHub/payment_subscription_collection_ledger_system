# BCIS Subscription Billing and Collection System

Subscription billing and collection ledger for a cable/internet ISP.
Desktop clients talk to one Fastify API server, which owns the PostgreSQL database.

> **Architectural rule:** the React renderer never touches the database and never opens
> its own sockets. Every request goes through `apps/client/src/lib/api-client.ts` to the
> Fastify API. Electron main process is reserved for OS features (file dialogs, printing).

## Workspaces

| Path              | What it is                                                        |
| ----------------- | ----------------------------------------------------------------- |
| `apps/client`     | Electron + React (Vite) desktop client                            |
| `apps/server`     | Fastify API server + Drizzle ORM (`src/db/schema` holds the tables) |
| `packages/shared` | Types and constants shared by client and server (no logic)         |

## Requirements

- Node.js 22 (LTS)
- pnpm 10 via Corepack (`corepack enable pnpm`)
- PostgreSQL 16 reachable at `DATABASE_URL`

## First run

```bash
corepack enable pnpm
cp .env.example .env          # then edit DATABASE_URL / JWT_SECRET
pnpm install
pnpm db:migrate               # create the tables
pnpm db:seed                  # default settings + the first Administrator
pnpm dev                      # starts the API server and the Electron client together
```

The seed creates one Administrator (`admin` / `Admin@1234!` unless `SEED_ADMIN_PASSWORD`
is set). **Change that password immediately after the first login.**

## Commands

| Command                 | What it does                                                          |
| ----------------------- | --------------------------------------------------------------------- |
| `pnpm dev`              | Starts Fastify (`:3003`) and the Electron client together              |
| `pnpm dev:server`       | API server only                                                        |
| `pnpm dev:client`       | Electron client only                                                   |
| `pnpm start`            | Runs the API server without watch mode (for production / pm2)          |
| `pnpm typecheck`        | TypeScript strict check in every workspace                             |
| `pnpm lint`             | ESLint (flat config) across the monorepo                               |
| `pnpm test`             | Vitest in every workspace (PostgreSQL suites skip when no DB answers)  |
| `pnpm verify:gui`       | Launches Electron and smoke-checks the GUI (needs the renderer served) |
| `pnpm format`           | Prettier write                                                         |
| `pnpm build`            | Compiles the client bundles (main, preload, renderer) into `apps/client/out` |
| `pnpm build:installer`  | Builds the Windows `.exe` installer (run on Windows)                   |
| `pnpm db:generate`      | Generate SQL migrations from the Drizzle schema                        |
| `pnpm db:migrate`       | Apply migrations to the database in `DATABASE_URL`                     |
| `pnpm db:seed`          | Create default settings and the first Administrator                    |
| `pnpm db:studio`        | Drizzle Studio (browse data)                                           |
| `pnpm backup`           | Dump the database to a timestamped file (`scripts/backup.sh`)          |
| `pnpm restore <file>`   | Replace the database from a backup (`scripts/restore.sh`)              |
| `pnpm submission`       | Assemble the submission folder (`scripts/build-submission.sh`)         |

## Health endpoints

| Endpoint       | Response                                                          |
| -------------- | ----------------------------------------------------------------- |
| `GET /health`  | `{ "status": "ok", "timestamp": "...", "version": "0.1.0" }`       |
| `GET /health/db` | `{ "status": "ok", "latency_ms": 3 }` — or `503 { "status": "error", ... }` when PostgreSQL is unreachable |

`/health/db` never crashes the server: an unreachable database is reported honestly.

## Configuration

All server configuration is read in exactly one place, `apps/server/src/config.ts`,
which validates the environment with Zod and fails fast on a missing or malformed variable.
`.env` is git-ignored; `.env.example` is committed, lists every variable, and contains no
real secrets. See `.env.example` for the annotated list.

An installed desktop client can also be pointed at another PC's API server without a
rebuild, by editing `%APPDATA%\BCIS\config.json` → `{ "apiBaseUrl": "http://192.168.1.100:3003" }`.

## Money

All monetary amounts are integers in **centavos** (`PHP 150.50` → `15050`).
See `Centavos` in `packages/shared/src/types/money.ts`. Never store money as a float.

## Documentation

| Document                                  | Contents                                                        |
| ----------------------------------------- | --------------------------------------------------------------- |
| `docs/technical/README.md`                | Architecture, schema, design decisions, permissions, config      |
| `docs/user-manual/README.md`              | Step-by-step instructions for all five roles                     |
| `docs/deployment/README.md`               | Installing the system on three office PCs                        |
| `docs/deployment/backup-restore.md`       | Backing up and restoring the database                            |
| `docs/known-limitations.md`               | What is **not** finished or verified — read this before trusting it |
| `specs/`                                  | One file per project phase, the authoritative requirements       |
| `CLAUDE.md`                               | Rules for AI-assisted development                                |

## Status

The ten phases in `specs/` are implemented: auth/RBAC, subscribers and service accounts,
billing and invoices, payments and receipts, the ledger and statements, field collection
and receivables, reports and the dashboard, and the audit trail and system settings.
This repository is a lab submission and is **not** a finished commercial product — see
`docs/known-limitations.md` for the honest list of what remains.