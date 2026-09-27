# Testing evidence

This directory holds the UI evidence section 9 asks for. The automated suites
themselves live with the code they cover (`apps/server/src/**/*.test.ts`,
`apps/client/src/**/*.test.tsx`) and are run with `pnpm test`.

| Evidence | Where | Produced by |
| --- | --- | --- |
| Section 9 D7 screenshot set (seven screens) | `screenshots/` | `pnpm screenshots` |
| Electron end-to-end flow (S10-1) | `apps/client/e2e/` | `pnpm test:e2e` |

Both need the **same running environment**: the API serving the synthetic demo
dataset, and the renderer built and served. See `screenshots/README.md` for the
full command list; in short:

```bash
# demo database, once
createdb bcis_demo
DATABASE_URL=postgresql://bcis_user:change_this@localhost:5432/bcis_demo pnpm db:migrate
DATABASE_URL=postgresql://bcis_user:change_this@localhost:5432/bcis_demo pnpm db:seed:demo

# API + renderer, each in its own terminal
DATABASE_URL=postgresql://bcis_user:change_this@localhost:5432/bcis_demo pnpm --filter server start
pnpm --filter client build
(cd apps/client/out/renderer && python3 -m http.server 5173 --bind 127.0.0.1)

# evidence
pnpm screenshots      # writes docs/testing/screenshots/*.png
pnpm test:e2e         # Playwright drives the built Electron app
```

## The end-to-end suite

`apps/client/e2e/demo-flow.spec.ts` launches the built Electron application with
Playwright's Electron support (`_electron.launch`), signs in through the real
login form as `demo.cashier`, opens a subscriber with a service account, opens
that account's ledger and asserts its invoice debit, posts a ₱100.00 cash
payment, and confirms the printed receipt.

It posts a **real payment** into the demo database on every run, so the demo
dataset drifts by ₱100 per run and the aging/overdue totals move with it. Re-run
`pnpm db:seed:demo` (and then `pnpm screenshots`) to get a pristine set of
figures. This is deliberate: a payment flow that did not write anything would
not be evidence that the flow works.

Playwright needs no downloaded browser — Electron is already a dependency — so
`playwright install` is not required.
