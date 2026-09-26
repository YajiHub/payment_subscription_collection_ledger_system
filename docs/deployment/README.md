# BCIS System — Deployment Guide

How to install the system on three office PCs that share one local network. PC-1
runs the database and the API server; all three PCs run the desktop client.

Every command below was run during development against this repository. Where a
step cannot be completed on this machine (building a Windows installer), that is
said plainly rather than glossed over — see `docs/known-limitations.md`.

---

## Prerequisites

| Item                                   | Where             | Notes                                     |
| -------------------------------------- | ----------------- | ----------------------------------------- |
| Windows 10 or 11 (64-bit)              | all three PCs     |                                           |
| Node.js 22 (LTS)                       | PC-1              | Runs the API server from source           |
| pnpm 10 (`corepack enable pnpm`)       | PC-1              | The workspace package manager             |
| PostgreSQL 16                          | PC-1              | Stores every table                        |
| The BCIS desktop installer             | PC-2 and PC-3     | Built on a Windows machine (see Step 5)   |
| All PCs on the same LAN                | —                 | One office switch/router is enough        |

The database and API server are **only** needed on PC-1. PC-2 and PC-3 need only
the installed desktop app.

---

## Step 1: Install PostgreSQL on PC-1

1. Download PostgreSQL 16 from <https://www.postgresql.org/download/windows/>.
2. Install with the default options, and remember the password you set for the
   `postgres` superuser.
3. Open pgAdmin or `psql` and run:

   ```sql
   CREATE USER bcis_user WITH PASSWORD 'choose_a_strong_password';
   CREATE DATABASE bcis_db OWNER bcis_user;
   CREATE DATABASE bcis_test OWNER bcis_user;   -- optional, for the integration tests
   GRANT ALL PRIVILEGES ON DATABASE bcis_db TO bcis_user;
   ```

4. Confirm the server is reachable:

   ```bash
   psql "postgresql://bcis_user:choose_a_strong_password@localhost:5432/bcis_db" -c "SELECT 1;"
   ```

---

## Step 2: Set up the API server on PC-1

1. Copy the whole repository to PC-1 (a `git clone`, or a ZIP of the source).
   The API server is one workspace inside the repository, so the **repository
   root** is what gets copied, not just `apps/server`.
2. From the repository root, install dependencies:

   ```bash
   corepack enable pnpm
   pnpm install
   ```

3. Create the server's `.env` file by copying `.env.example` and editing it:

   ```dotenv
   NODE_ENV=production
   PORT=3003
   DATABASE_URL=postgresql://bcis_user:choose_a_strong_password@localhost:5432/bcis_db
   JWT_SECRET=a_long_random_string_at_least_32_characters_long
   # Development browser origin, plus "null" for the packaged desktop clients.
   CORS_ORIGIN=http://localhost:5173,null
   BCRYPT_ROUNDS=12
   ```

   `.env` is git-ignored and must never be committed. Every variable is validated
   in `apps/server/src/config.ts`; the full list is in `.env.example` and in the
   technical documentation §8.

4. Create the tables by applying the committed migrations:

   ```bash
   pnpm db:migrate
   ```

   The `drizzle-kit` configuration reads `DATABASE_URL` from the repository root
   `.env`. Running this against an empty database creates all nineteen tables,
   their indexes, their foreign keys, the enums, and the append-only trigger on
   the audit trail.

5. Create the default business rules and the first Administrator:

   ```bash
   pnpm db:seed
   ```

   It is safe to re-run: it never overwrites a setting you changed and never
   resets the Administrator's password. It reports whether it created the account
   or left an existing one alone.

6. Start the API server:

   ```bash
   pnpm start
   ```

   To keep it running after you close the terminal, use pm2:

   ```bash
   npm install -g pm2
   pm2 start "pnpm start" --name bcis-api
   pm2 save
   pm2 startup        # follow the printed instructions to register autostart
   ```

7. Check it answers:

   ```bash
   curl http://localhost:3003/health
   curl http://localhost:3003/health/db
   ```

   The second command returns `200` when PostgreSQL is reachable, and `503` with
   an explanation when it is not. A `503` here is a database problem, not a
   server problem.

---

## Step 3: Find PC-1's local IP address

1. On PC-1, open Command Prompt and run `ipconfig`.
2. Note the IPv4 address under the active adapter (for example `192.168.1.100`).
3. This is the address PC-2 and PC-3 use in the next step.

---

## Step 4: Install the desktop app on every PC

1. Build the installer **once, on a Windows machine** (see Step 5), or use an
   installer already provided with the submission.
2. Copy `BCIS-Setup-<version>.exe` (for example `BCIS-Setup-0.1.0.exe`) to each PC
   and run it. The wizard lets you choose the installation folder and creates
   desktop and Start Menu shortcuts.
3. On **first launch**, the app writes a starter configuration file to:

   ```
   C:\Users\<username>\AppData\Roaming\BCIS\config.json
   ```

4. On PC-1 the default is correct and can stay as it is:

   ```json
   { "apiBaseUrl": "http://localhost:3003" }
   ```

5. On PC-2 and PC-3, close the app and edit that file to PC-1's address:

   ```json
   { "apiBaseUrl": "http://192.168.1.100:3003" }
   ```

6. Start the app again. It reads `config.json` at startup, so a change takes
   effect on the next launch.
7. Confirm the badge in the app says **API reachable**. Hovering over it shows
   the server it is using. If it says **API offline**, check the firewall step
   below and that PC-1's server is running.

The client's API URL is resolved in this order: `config.json` → the URL compiled
into the build → `http://localhost:3003`. A value that is not a full `http` or
`https` URL is ignored, so a typo falls back rather than breaking the app.

---

## Step 5: Build the Windows installer (on Windows)

The installer packages the Electron app only. The API server is not bundled; it
keeps running on PC-1.

1. On a Windows machine with Node.js 22 and pnpm:

   ```bash
   pnpm install
   pnpm build           # compiles main, preload, and renderer into apps/client/out/
   pnpm build:installer # runs electron-builder → apps/client/installer/BCIS-Setup-*.exe
   ```

2. The installer appears in `apps/client/installer/`. Its name comes from
   `productName` and `version` in `apps/client/electron-builder.config.js` and
   `package.json`.

Cross-building a Windows NSIS installer from Linux or macOS requires Wine and is
not part of this project's toolchain, so it cannot be produced on a Linux
machine. Before a real release, add an application icon at
`apps/client/build-resources/icon.ico`; see that folder's README.

---

## Step 6: First login

The seed script creates one Administrator account:

```
Username: admin
Password: Admin@1234!      (or whatever SEED_ADMIN_PASSWORD was set to)
```

> **Change this password immediately** after the first login (Users → your
> account → Change password). The bootstrap password is documented in this guide
> and is therefore not a secret. If you prefer, set `SEED_ADMIN_PASSWORD` in
> `.env` to your own value before running `pnpm db:seed` on a fresh database.

Then create the Billing Clerk, Cashier, Collector, and Manager accounts (see the
User Manual §1.4).

---

## Multi-PC notes

- The API server listens on `0.0.0.0:3003`, so other PCs can reach it.
- Two cashiers may post payments at the same time. Payment posting runs inside a
  database transaction and locks the service account row, so one waits for the
  other rather than corrupting the balance.
- The `CORS_ORIGIN` value must include the literal `null` for packaged desktop
  clients, because a page loaded from `file://` reports its origin as `null`.
  Development builds served by Vite use `http://localhost:5173`.

### Firewall

If PC-2 or PC-3 cannot reach the server, allow inbound TCP 3003 on PC-1:

```
Windows Defender Firewall → Advanced settings → Inbound Rules → New Rule
Port → TCP → 3003 → Allow the connection → All profiles → Name: "BCIS API"
```

---

## Backups

Back up the database daily and store a copy off PC-1. The next document explains
the scripts, the schedule, and how to restore:

- `docs/deployment/backup-restore.md`

---

## Troubleshooting

| Symptom                              | Likely cause and fix                                                        |
| ------------------------------------ | --------------------------------------------------------------------------- |
| App badge says **API offline**       | PC-1's server is stopped, or the firewall blocks port 3003, or `config.json` has the wrong IP |
| `/health/db` returns `503`           | PostgreSQL is stopped on PC-1, or `DATABASE_URL` is wrong                    |
| Login fails with "invalid credentials" | Wrong password, or the account is deactivated (Admin → Users)               |
| Server exits immediately at startup  | `.env` is missing or malformed; the error message names the variable         |
| Browser blocks a request (CORS)      | `CORS_ORIGIN` does not list the caller's origin — add `null` for packaged clients |
| Installer build fails on Linux       | NSIS packaging needs Windows (or Wine); build it on Windows                  |