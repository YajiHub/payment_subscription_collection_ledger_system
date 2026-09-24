# Known Limitations

This system implements the ten phases in `specs/`. It is complete enough to
demonstrate and to run on an office LAN, but it is **not** presented as a
finished commercial product. Everything still open is listed here honestly, so a
reviewer is never misled by a document that claims more than the code does.

---

## 1. The desktop GUI was never launched in this environment

**What this means.** All development and verification happened on a headless
Linux machine. `pnpm dev:client` starts an Electron window, which needs a
display, so the graphical application has not been opened or clicked through
here. The Electron main process, the preload bridge, and every React screen are
type-checked, but their on-screen behaviour was not observed.

**What *was* verified.** `pnpm typecheck` covers `apps/client` (main, preload,
renderer, and the Vite config). The server, which owns all business logic, is
covered by the automated test suite.

**Still to do.** Launch the client on Windows (or a Linux desktop), log in as each
role, and walk the User Manual. Treat the first run as a QA pass.

## 2. No automated tests for the renderer

There are no unit or end-to-end tests for the React code: no component tests, no
Playwright/Electron smoke test. The automated suite covers the API, Drizzle
queries, money maths, permissions, and the HTTP surface. A renderer regression
would only be caught by hand.

## 3. The Windows installer has not been built or run here

`apps/client/electron-builder.config.js` and the `pnpm build:installer` script are
present and correct against the current build layout (`out/`), and
electron-builder 25 is installed. But producing an NSIS `.exe` needs Windows (a
Linux cross-build needs Wine, which is not part of the toolchain), so
`installer/BCIS-Setup-1.0.0.exe` does not exist in this repository. The installer
icon and licence text are also still the electron-builder defaults; see
`apps/client/build-resources/README.md`.

## 4. Database setup: what was verified against PostgreSQL, and how

A live PostgreSQL 16 server (16.15) was reachable during this work, so the database
steps **were** executed, not merely reviewed:

- `pnpm db:migrate` was run against a brand-new, empty database. It created all 19
  tables, 46 indexes, 40 foreign keys, and the append-only trigger on `audit_logs`.
- `pnpm db:seed` was run against that database and created the default settings and
  the Administrator; running it a second time left both unchanged, proving idempotence.
- `pnpm backup` produced a timestamped `.sql.gz` file, and `pnpm restore` loaded it
  into a second empty database whose table, index, foreign-key, settings, and user
  counts matched the source exactly.

One caveat about **how** the backup scripts were run here: this machine had no
`pg_dump` or `pg_restore` on its `PATH` (only the database server, in a container,
had them). The scripts were therefore run with those two binaries supplied from the
PostgreSQL container. The scripts themselves are unchanged, but on PC-1 you must
have PostgreSQL's `bin` directory on `PATH` for `pnpm backup` and `pnpm restore` to
find them — the scripts run `pg_dump` and `pg_restore` by name.

The PostgreSQL-backed Vitest suites also ran against a live database in this
environment rather than skipping.

## 5. The bootstrap Administrator password is a documented default

`pnpm db:seed` creates `admin` / `Admin@1234!` (or whatever `SEED_ADMIN_PASSWORD`
is set to) on a database with no such user. This is a documented bootstrap
credential, not a stored secret, and it is identical on every fresh install until
it is changed. **Change it immediately after the first login.** The seed never
resets an existing account, so the change is permanent.

## 6. Session and configuration details worth knowing

- Tokens last 8 hours and are revoked on logout, but there is no refresh-token
  rotation and no forced sign-out of other devices when a password changes.
- The client reads `%APPDATA%\BCIS\config.json` at startup only; after editing the
  file the app must be restarted.
- `CORS_ORIGIN` must list the literal `null` for packaged clients; forgetting it
  produces a browser-level failure that looks like "API offline".
- Payment methods `check` and `bank_transfer` exist in the database enum but are
  **not** accepted by the API today. Only Cash and GCash can be posted.

## 7. Deliberately out of scope

These were never part of the ten phases and are not implemented:

- SMS or email notifications to subscribers;
- online payment gateways or automatic GCash reconciliation;
- a self-service subscriber portal;
- multi-branch or multi-company tenancy;
- automatic scheduled billing (the billing run is started by a person);
- automatic database backups (the script exists, but scheduling is a Windows Task
  Scheduler step the office performs).

## 8. Phase nitpicks still open

- `system_settings` values are free text; only the numeric ones are validated on
  write. A hand-edited row that is not a number falls back to the documented
  default at read time rather than being rejected.
- The audit trail records who acted and from which IP, but there is no tamper
  detection beyond the append-only trigger — a database superuser could still
  disable the trigger (the test suite does exactly that, for cleanup).
- The AR aging report and the overdue list are computed on request; there is no
  nightly snapshot table, so historical aging can only be reconstructed as of a
  past date from the invoice and payment data.
- Report exports are generated in memory; a very large date range would produce a
  large response, and there is no streaming or pagination for exports.