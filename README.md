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
pnpm dev                      # starts the API server and the Electron client together
```

## Commands

| Command            | What it does                                                    |
| ------------------ | --------------------------------------------------------------- |
| `pnpm dev`         | Starts Fastify (`:3001`) and the Electron client together        |
| `pnpm dev:server`  | API server only                                                  |
| `pnpm dev:client`  | Electron client only                                             |
| `pnpm typecheck`   | TypeScript strict check in every workspace                       |
| `pnpm lint`        | ESLint (flat config) across the monorepo                         |
| `pnpm format`      | Prettier write                                                   |
| `pnpm db:generate` | Generate SQL migrations from the Drizzle schema                  |
| `pnpm db:migrate`  | Apply migrations to the database in `DATABASE_URL`               |
| `pnpm db:studio`   | Drizzle Studio (browse data)                                     |

## Health endpoints

| Endpoint       | Response                                                          |
| -------------- | ----------------------------------------------------------------- |
| `GET /health`  | `{ "status": "ok", "timestamp": "...", "version": "0.1.0" }`       |
| `GET /health/db` | `{ "status": "ok", "latency_ms": 3 }` — or `503 { "status": "error", ... }` when PostgreSQL is unreachable |

`/health/db` never crashes the server: an unreachable database is reported honestly.

## Environment

All server configuration is read in exactly one place, `apps/server/src/config.ts`,
which validates the environment with Zod and fails fast on a missing or malformed variable.
`.env` is git-ignored; `.env.example` is committed and contains no real secrets.

## Money

All monetary amounts are integers in **centavos** (`PHP 150.50` → `15050`).
See `Centavos` in `packages/shared/src/types/money.ts`. Never store money as a float.

## Further reading

- `specs/` — one file per project phase, the authoritative requirements
- `CLAUDE.md` — rules for AI-assisted development