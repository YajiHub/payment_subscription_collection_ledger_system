# Known Limitations

This system implements the ten phases in `specs/`. It is complete enough to
demonstrate and to run on an office LAN, but it is **not** presented as a
finished commercial product. Everything still open is listed here honestly, so a
reviewer is never misled by a document that claims more than the code does.

---

## 1. The desktop GUI is smoke-checked, not exhaustively tested

**What this means.** The graphical application runs and is checked automatically,
but nobody has walked every screen by hand. `pnpm verify:gui` launches Electron,
signs in through the real login form, screenshots the main screens, and asserts
that the navigation menu offers each role exactly the screens its permissions
allow. It passes here (24/24 checks, including a non-administrator role).

**What that covers.** The window opens, the renderer loads, login works, the
menu is permission-correct per role, and User Management offers its Add User and
per-row actions. It would have caught the bug where the dashboard gave the
Administrator no route to User Management while every API test still passed.

**What it does not cover.** The visual detail and step-by-step flow of every
screen. Printing, report export dialogs, and the receipt preview are still only
verified by code inspection. Treat a first walk through the User Manual as a QA
pass.

**Linux/WSLg caveat.** Entering fullscreen hangs the WSLg compositor, so the
window is created with `fullscreenable: false` on Linux; maximize through the
window manager instead. Windows fullscreen is unaffected.

## 2. The renderer has a smoke check but no unit tests

There are no component tests and no browser-level end-to-end suite. `pnpm
verify:gui` checks navigation and the login flow through Electron, but it asserts
wiring, not rendering detail: a broken layout, a mislabelled field, or a wrong
amount formatting would not be caught. The automated suite covers the API,
Drizzle queries, money maths, permissions, and the HTTP surface.

## 3. The Windows installer has not been built or run here

`apps/client/electron-builder.config.js` and the `pnpm build:installer` script are
present and correct against the current build layout (`out/`), and
electron-builder 25 is installed. But producing an NSIS `.exe` needs Windows (a
Linux cross-build needs Wine, which is not part of the toolchain), so
`installer/BCIS-Setup-<version>.exe` does not exist in this repository. The
configuration itself was validated here by packaging an unpacked Linux build
(`electron-builder --linux dir`), which loaded the config and produced an app
directory. The installer icon and licence text are also still the electron-builder
defaults; see `apps/client/build-resources/README.md`.

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

## 5. The development password is `password`, and it must be changed before deployment

Every account in this development/demo environment uses the password `password`: the
bootstrap Administrator `pnpm db:seed` creates and every synthetic account
`pnpm db:seed:demo` creates. It is overridable with `SEED_ADMIN_PASSWORD` and
`SEED_DEMO_PASSWORD`, and `pnpm db:reset-passwords -- --confirm` rewrites every
existing account back to it.

This is a convenience for synthetic lab data and it is written down rather than
implied: the value is published here and in the Deployment Guide, so it is not a
secret and it grants access to every account to anyone who has read this file.
**Change it — and the Administrator's own password — before any real deployment.**
The reset script refuses to run when `NODE_ENV=production` for exactly this reason.

The seed itself never resets an existing account: it only creates the Administrator
when the username is absent, so a deliberate password change survives later seeds.

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