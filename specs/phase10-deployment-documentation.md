# Phase 10 — Documentation, Deployment, and Final QA

> **Prompt template for AI-assisted implementation:**
> "I am building the BCIS Subscription Billing and Collection System (Electron + React, Fastify,
> PostgreSQL, Drizzle ORM). This is Phase 10: Documentation, Deployment, and Final QA. Write the
> technical documentation, user manual, and deployment guide. Create the Electron installer build
> configuration (electron-builder). Create the PostgreSQL backup and restore scripts. Run the full
> acceptance test suite and fix any failures. Prepare the final submission folder structure.
> Use the spec at specs/phase10-deployment-documentation.md."

---

## 1. Overview

Phase 10 turns a working application into a **releasable product**. The goal is that someone
who has never seen this codebase before can:
1. Read the README and understand what the system does
2. Read the deployment guide and get it running on a fresh machine
3. Read the user manual and operate the system without asking for help
4. Restore from backup after a failure

**Instructor checkpoint:** CP6 — Final QA (Summative)

---

## 2. Required Documentation

### D1 — Technical Documentation (`docs/technical/README.md`)
The architecture, design decisions, and how the codebase is organized.

**Sections:**
1. System Overview (architecture diagram, tech stack table)
2. Project Structure (annotated folder tree)
3. Database Schema (ERD diagram + description of each table and its purpose)
4. Key Design Decisions (why PostgreSQL, why Drizzle, why Fastify, why Electron)
5. Authentication & Authorization (JWT flow, permission matrix)
6. Financial Model (how invoices, ledger, payments relate — with diagrams)
7. Collection Workflow (batch lifecycle diagram)
8. Configuration (all environment variables and what they do)
9. Running in Development
10. Running Tests

### D2 — User Manual (`docs/user-manual/README.md`)
Step-by-step instructions for each role. Written for non-technical users.

**Sections by role:**
- **Admin:** System setup, user management, system settings, backup
- **Billing Clerk:** Creating subscribers, adding service accounts, generating invoices, suspension/reconnection
- **Cashier:** Posting cash payments, posting GCash payments, printing receipts, viewing ledger
- **Collector:** Creating collection batches, recording collections, submitting remittance
- **Manager:** Viewing dashboard, generating and exporting reports

**Format:** Each section has numbered steps with screenshots (or placeholder notes for screenshots).

### D3 — Deployment Guide (`docs/deployment/README.md`)
How to set up the system from scratch on office computers.

**See Section 4 below.**

### D4 — Backup and Restore Guide (`docs/deployment/backup-restore.md`)
**See Section 5 below.**

---

## 3. Submission Folder Structure

Per the lab specification requirement:

```
BCIS-Subscription-Billing-System/
├── documentation.pdf           ← Technical documentation (exported from docs/technical/)
├── manual.pdf                  ← User manual (exported from docs/user-manual/)
├── guide.md                    ← Quick-start guide (the README.md)
├── test-report.pdf             ← Output from running the test suite
├── samples/
│   ├── sample-receipt.pdf
│   ├── sample-invoice.pdf
│   ├── sample-statement-of-account.pdf
│   ├── sample-ar-aging-report.xlsx
│   └── sample-daily-collection.xlsx
├── source/                     ← Full source code (git archive)
└── installer/
    └── BCIS-Setup-1.0.0.exe    ← Electron installer for Windows
```

---

## 4. Deployment Guide

```markdown
# BCIS System — Deployment Guide

## Prerequisites
- Windows 10/11 (64-bit) on all three office PCs
- One PC designated as the server (PC-1)
- All PCs connected to the same local area network (LAN)
- PostgreSQL 16 installed on PC-1

## Step 1: Install PostgreSQL on PC-1

1. Download PostgreSQL 16 from https://www.postgresql.org/download/windows/
2. Install with default options. Remember the password you set for the "postgres" superuser.
3. Open pgAdmin or psql and run:

   CREATE USER bcis_user WITH PASSWORD 'choose_a_strong_password';
   CREATE DATABASE bcis_db OWNER bcis_user;
   GRANT ALL PRIVILEGES ON DATABASE bcis_db TO bcis_user;

## Step 2: Configure the API Server on PC-1

1. Copy the `server/` folder to PC-1 (or clone the repository)
2. Create a `.env` file in the server folder:

   NODE_ENV=production
   PORT=3001
   DATABASE_URL=postgresql://bcis_user:your_password@localhost:5432/bcis_db
   JWT_SECRET=a_long_random_string_at_least_32_characters
   CORS_ORIGIN=http://localhost:5173  # Will be replaced by Electron origin

3. Run database migrations:
   pnpm db:migrate

4. Seed initial data (admin user + default settings):
   pnpm db:seed

5. Start the API server:
   pnpm start

   Or to run as a Windows service (recommended for production):
   Install pm2: npm install -g pm2
   pm2 start "pnpm start" --name bcis-api
   pm2 startup
   pm2 save

## Step 3: Find PC-1's Local IP Address

On PC-1, open Command Prompt and run:
  ipconfig

Note the IPv4 address under "Ethernet adapter" (e.g., 192.168.1.100)

## Step 4: Install the Electron App on All PCs

1. Copy `installer/BCIS-Setup-1.0.0.exe` to each PC
2. Run the installer (double-click, follow prompts)
3. After installation, before first launch:

   On PC-1: The app will connect to http://localhost:3001 automatically.
   On PC-2 and PC-3: Open C:\Users\[username]\AppData\Roaming\BCIS\config.json
   and set:
   { "apiBaseUrl": "http://192.168.1.100:3001" }
   (Replace 192.168.1.100 with PC-1's actual IP address)

## Step 5: First Login

Default admin account (created by seed):
  Username: admin
  Password: Admin@1234!

⚠️  CHANGE THE ADMIN PASSWORD IMMEDIATELY after first login.

## Firewall Configuration (if clients cannot reach the server)

On PC-1, allow inbound connections on port 3001:
  Windows Defender Firewall → Advanced Settings → Inbound Rules → New Rule
  Port → TCP → 3001 → Allow the connection → All profiles → Name: "BCIS API"
```

---

## 5. Backup and Restore Scripts

```bash
#!/bin/bash
# scripts/backup.sh
# Run this daily on PC-1 (the server).
# Backs up the PostgreSQL database to a timestamped file.
# Keep at least 7 days of backups.

BACKUP_DIR="/backups/bcis"
DATE=$(date +"%Y-%m-%d_%H-%M-%S")
BACKUP_FILE="$BACKUP_DIR/bcis_backup_$DATE.sql.gz"

# Create backup directory if it doesn't exist
mkdir -p "$BACKUP_DIR"

# Dump the database and compress it
PGPASSWORD="$DB_PASSWORD" pg_dump \
  -h localhost \
  -U bcis_user \
  -d bcis_db \
  --no-password \
  --format=custom \
  | gzip > "$BACKUP_FILE"

echo "Backup created: $BACKUP_FILE"
echo "Size: $(du -sh "$BACKUP_FILE" | cut -f1)"

# Delete backups older than 30 days
find "$BACKUP_DIR" -name "bcis_backup_*.sql.gz" -mtime +30 -delete
echo "Old backups cleaned up."
```

```bash
#!/bin/bash
# scripts/restore.sh
# CAUTION: This will OVERWRITE the current database.
# Use only when restoring from a backup after data loss.

BACKUP_FILE="$1"

if [ -z "$BACKUP_FILE" ]; then
  echo "Usage: ./restore.sh /path/to/bcis_backup_YYYY-MM-DD.sql.gz"
  exit 1
fi

echo "⚠️  WARNING: This will replace all current data in bcis_db with the backup."
echo "Backup file: $BACKUP_FILE"
read -p "Type 'yes' to confirm: " CONFIRM

if [ "$CONFIRM" != "yes" ]; then
  echo "Restore cancelled."
  exit 0
fi

# Stop the API server first to prevent writes during restore
# (If using pm2: pm2 stop bcis-api)

# Drop and recreate the database
PGPASSWORD="$DB_PASSWORD" psql -U bcis_user -d postgres \
  -c "DROP DATABASE IF EXISTS bcis_db;" \
  -c "CREATE DATABASE bcis_db OWNER bcis_user;"

# Restore from backup
gunzip -c "$BACKUP_FILE" | PGPASSWORD="$DB_PASSWORD" pg_restore \
  -h localhost \
  -U bcis_user \
  -d bcis_db \
  --no-password

echo "✅ Restore complete. Start the API server."
```

```json
// package.json scripts (added to root)
{
  "scripts": {
    "backup": "bash scripts/backup.sh",
    "restore": "bash scripts/restore.sh"
  }
}
```

### Backup Schedule (Windows Task Scheduler)
- Daily at 11:59 PM — full database backup
- Store backups in `D:\BCIS-Backups\` (separate drive if available)
- Copy weekly backup to a USB drive or network share

---

## 6. Electron Installer Build

```javascript
// electron-builder.config.js
module.exports = {
  appId: "com.bcis.subscription-billing",
  productName: "BCIS Subscription Billing System",
  copyright: `Copyright © ${new Date().getFullYear()} BCIS`,

  directories: {
    output: "installer",
    buildResources: "build-resources",
  },

  files: [
    "dist/**/*",
    "electron/dist/**/*",
    "node_modules/**/*",
    "!node_modules/**/test*",
    "!node_modules/**/*.md",
  ],

  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    icon: "build-resources/icon.ico",
  },

  nsis: {
    oneClick: false,             // Shows installation wizard
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: "BCIS Billing",
    installerIcon: "build-resources/icon.ico",
    uninstallerIcon: "build-resources/icon.ico",
    license: "LICENSE.txt",
  },

  // The Electron app connects to the API over HTTP (not bundled)
  // The server runs separately on PC-1
  extraResources: [
    { from: ".env.example", to: "config.example.env" },
  ],
};
```

---

## 7. Final QA Checklist

This mirrors the lab submission checklist exactly.

### Application Startup
- [ ] Application starts without development-only manual edits
- [ ] No hardcoded secrets in committed code
- [ ] `.env` is in `.gitignore`; `.env.example` is committed

### Multi-Client
- [ ] PC-2 and PC-3 can connect to API running on PC-1
- [ ] Two cashiers posting payments simultaneously does not cause data corruption

### Database
- [ ] Migrations run on a clean (empty) PostgreSQL database: `pnpm db:migrate`
- [ ] Seed data is synthetic (no real subscriber data): `pnpm db:seed`
- [ ] All tables have correct indexes and foreign key constraints

### RBAC and Security
- [ ] Admin can do everything
- [ ] Cashier cannot access billing management routes
- [ ] Collector cannot post office payments
- [ ] Manager cannot create or modify any records
- [ ] Server returns 403 (not just hidden UI) for unauthorized routes

### Billing Correctness
- [ ] Monthly billing does not create duplicate invoices
- [ ] Partial payment case is correct (invoice balance updated, status = partially_paid)
- [ ] Exact payment case is correct (invoice status = paid)
- [ ] Advance payment case is correct (advance_credit_centavos > 0)
- [ ] Advance credit applied to next invoice automatically

### Payment Integrity
- [ ] Payment reversal preserves history and audit trail
- [ ] Receipt numbers are unique; voided numbers are not reused
- [ ] Duplicate GCash reference numbers are rejected

### Collection
- [ ] Collector shortage/overage is visible and not silently balanced
- [ ] AR aging totals reconcile to outstanding invoice balances

### Reports
- [ ] PDF and XLSX reports calculate correctly
- [ ] Reports handle empty data without crashing

### Backup
- [ ] `pnpm backup` produces a valid database backup file
- [ ] `pnpm restore backup_file.sql.gz` successfully restores the database
- [ ] Restore was tested on a clean database

### Testing
- [ ] `pnpm test` runs and all tests pass
- [ ] Test report PDF is generated

### Documentation
- [ ] Technical documentation is complete and accurate
- [ ] User manual covers all five roles
- [ ] Deployment guide was tested on a fresh machine (or WSL environment)
- [ ] README explains how to run the project from scratch

### Final Release
- [ ] `pnpm build` produces the Electron installer
- [ ] Installer runs on Windows without developer tools installed
- [ ] Submission folder structure matches the required format

---

## 8. Defense Preparation

The lab specifies these defense questions — have clear, concise answers ready:

| Question | Key Answer Points |
|----------|------------------|
| Why PostgreSQL instead of SQLite? | SQLite file-locking prevents true concurrent multi-client writes; PostgreSQL uses row-level locking for concurrency. |
| Where does billing/payment logic live, and why? | In Fastify API services (`billing.service.ts`, `payments.service.ts`). Never in the Electron renderer. Keeps business rules in one auditable place. |
| How do you prevent duplicate invoices? | `billing_period_year + billing_period_month + service_account_id` checked before insert; billing job skips existing entries. |
| How is a partial payment represented? | `payments.allocated_centavos`, `invoices.paid_amount_centavos`, and `invoices.remaining_balance_centavos`. Allocation records in `payment_allocations`. |
| Why are posted payments reversed instead of deleted? | Financial history must be preserved for audit. Deletion loses the paper trail. Reversal creates an offsetting entry — the original is always visible. |
| How do you prove the ledger balance is correct? | `verifyLedgerIntegrity()` recomputes the running balance from scratch and compares to stored values. Ledger balance = sum(debits) - sum(credits). |
| What happens if API crashes mid-payment? | All payment posting logic is wrapped in a database transaction. If any step fails, the entire transaction rolls back. No partial state is committed. |
| How does server-side auth differ from hiding UI buttons? | The server checks `request.user.role` via `authorize()` middleware on every route. A user with the wrong role calling the API directly gets 403. The UI button is just a convenience — not the security gate. |
| How are backups validated and restored? | `pg_dump --format=custom` creates the backup. `pg_restore` is tested by restoring to a test database and verifying table counts and balances. |
| Future mobile/PWA for collectors? | Collector domain is already isolated (`/api/collector-batches`). A PWA would authenticate with the same JWT, hit the same API. Offline queue would need a sync endpoint. Architecture is already service-oriented. |
