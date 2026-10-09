# UI screenshots — section 9 deliverable D7

Seven screens, captured from the running application against the synthetic demo
dataset (`pnpm db:seed:demo`). Every image shows real seeded rows and balances;
none is an empty state.

| File | Screen | Demo account | Route |
| --- | --- | --- | --- |
| `01-dashboard.png` | Management Dashboard (KPI cards, AR aging, recent payments) | `demo.owner` | `#/dashboard` |
| `02-subscriber-profile.png` | Subscriber profile with its service accounts and payment history | `demo.owner` | `#/subscribers/:id` |
| `03-receive-payment.png` | Receive Payment — account selected, outstanding invoices and balance shown | `demo.cashier` | `#/payments/new` |
| `04-gcash-verification-queue.png` | GCash verification queue: payment history filtered to `GCash` + `Pending Verification` | `demo.owner` | `#/payments` |
| `05-gcash-payment-detail.png` | A pending GCash payment with its reference number and sender | `demo.owner` | `#/payments/:id` |
| `06-collector-reconciliation.png` | Collector batch reconciliation: lifecycle, expected/remitted/variance, per-account results | `demo.owner` | `#/collector-batches/:id` |
| `07-overdue-accounts.png` | Overdue accounts with area, overdue months and oldest unpaid invoice | `demo.owner` | `#/receivables/overdue` |
| `08-ar-aging.png` | Accounts receivable aging by bucket | `demo.owner` | `#/receivables/aging` |
| `09-reports-center.png` | Reports Center with a generated report and the export controls | `demo.owner` | `#/reports` |

`overdue/aging` is one D7 screen; it is captured as both `07` and `08` because the
application presents the overdue list and the aging buckets as two screens.

## How to regenerate

The screenshots are produced by `scripts/capture-ui-screenshots.cjs`, which drives
the real Electron renderer (real login form, real pages) and only writes a file
once that screen is showing seeded data. Prerequisites, in order:

```bash
# 1. A demo database. This creates and fills bcis_demo; it never touches bcis_db.
createdb bcis_demo
DATABASE_URL=postgresql://bcis_user:change_this@localhost:5432/bcis_demo pnpm db:migrate
DATABASE_URL=postgresql://bcis_user:change_this@localhost:5432/bcis_demo pnpm db:seed:demo

# 2. The API against that database, on the port the built renderer expects.
DATABASE_URL=postgresql://bcis_user:change_this@localhost:5432/bcis_demo pnpm --filter server start

# 3. A built renderer, served statically.
pnpm --filter client build
(cd apps/client/out/renderer && python3 -m http.server 5173 --bind 127.0.0.1)

# 4. Capture.
pnpm screenshots
```

The command exits 0 only when all nine files were written. It prints each file and
its size, and fails a screen whose data never arrived rather than saving a picture
of a loading skeleton.

Environment overrides: `BCIS_UI_URL` (default `http://localhost:5173`),
`BCIS_API_URL` (default `http://localhost:3003`), `BCIS_SHOT_DIR` (default this
directory), `BCIS_OWNER_PASSWORD` (default the `password` the seed prints).

The accounts and shared password are the synthetic demo logins
`pnpm db:seed:demo` prints. No real credential is used or stored.

## Screens that are missing or degraded

Two observations from taking these pictures. Neither was worked around, and
neither is fixed here — both are reported, not patched.

1. **There is no GCash Verification screen.** Section 4.3 / S7-6 asks for a
   two-pane verification queue with proof preview and verify/reject controls. The
   API has `GET /api/payments/gcash/pending`, `POST /api/payments/gcash/:id/verify`
   and `.../reject`, but no renderer screen or `api-client` call exists for them.
   `04` and `05` are the closest real screens a verifier has today: the payment
   history filtered to pending GCash payments, and one such payment's detail.
   Verify and reject cannot be performed from the UI.
2. **The subscriber profile shows no balance.** `02` shows "Current balance —"
   for accounts that the Receive Payment screen values at ₱6,495.00. The
   subscriber-detail API returns `balanceCentavos: null` for every service
   account (`apps/server/src/modules/service-accounts/service-accounts.service.ts:66-69`),
   so the column can never show a number even though the ledger knows the balance.
