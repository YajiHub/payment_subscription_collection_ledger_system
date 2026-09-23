# Phase 9 — Security, Audit Trail, and Testing

> **Prompt template for AI-assisted implementation:**
> "I am building the BCIS Subscription Billing and Collection System (Electron + React, Fastify,
> PostgreSQL, Drizzle ORM). Implement Phase 9: Security Hardening, Audit Trail, and Testing.
> Create the audit_log table that records every create/update/delete action with who did it, what
> changed, and when. Implement Fastify input validation on all routes using Zod. Add rate limiting,
> request size limits, and CORS lockdown. Write acceptance tests covering the required financial
> scenarios: billing, payment allocation, reversal, and AR aging. Use the spec at
> specs/phase9-security-audit-testing.md."

---

## 1. Overview

Security is not a feature added at the end — but this phase formalizes and hardens what was
started in Phase 2. The audit trail ensures that every consequential action is permanently
recorded with enough detail to answer: who did this, what did they change, and when?

Testing gives confidence that the financial rules (the hardest to get right) work correctly.

**Instructor checkpoint:** CP5 — Reports/Security; CP6 — Final QA

---

## 2. Audit Trail

### What to Audit

Not every database operation needs an audit entry. Focus on **consequential** actions:

| Action | Audit? | Reason |
|--------|--------|--------|
| Invoice posted | ✅ | Financial event |
| Invoice voided | ✅ | Financial event, irreversible |
| Payment posted | ✅ | Financial event |
| Payment reversed | ✅ | Financial event, needs justification |
| Subscriber created | ✅ | Data creation |
| Subscriber modified | ✅ | May affect billing |
| Service account suspended | ✅ | Service control |
| User account created | ✅ | Security |
| User role changed | ✅ | Security — privilege change |
| User password changed | ✅ | Security |
| User deactivated | ✅ | Security |
| Monthly billing run | ✅ | Bulk financial action |
| Failed login attempt | ✅ | Security monitoring |
| Subscriber viewed | ❌ | Too noisy — defeats audit trail purpose |
| Report generated | ❌ | Too noisy |

### Audit Log Schema

```typescript
// apps/server/src/db/schema/audit.ts

import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  timestamp,
} from "drizzle-orm/pg-core";
import { users } from "./users";

export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").primaryKey().defaultRandom(),

  // What type of action was performed
  action: varchar("action", { length: 100 }).notNull(),
  // Examples: "invoice.posted", "payment.reversed", "user.role_changed", "subscriber.suspended"
  // Dot notation: domain.verb — easy to filter by domain or by action type

  // What entity was affected
  entityType: varchar("entity_type", { length: 50 }).notNull(),
  // Examples: "invoice", "payment", "subscriber", "service_account", "user"

  entityId: uuid("entity_id").notNull(),
  // The primary key of the affected row

  // The state of the entity BEFORE the change (JSON snapshot)
  // null for CREATE operations
  previousState: jsonb("previous_state"),

  // The state of the entity AFTER the change (or the new record for CREATE)
  // null for DELETE operations (we don't delete, so this is rare)
  newState: jsonb("new_state"),

  // Human-readable summary of what changed
  // e.g., "Invoice INV-2025-01-000042 voided. Reason: Entered incorrect amount"
  description: text("description").notNull(),

  // Who performed the action
  performedBy: uuid("performed_by").references(() => users.id),
  // null for system-generated actions (e.g., automatic billing run)
  performedByUsername: varchar("performed_by_username", { length: 50 }),

  // Which PC/client made the request
  clientIpAddress: varchar("client_ip_address", { length: 45 }),

  performedAt: timestamp("performed_at", { withTimezone: true }).notNull().defaultNow(),
});
```

### Audit Logger Service

```typescript
// apps/server/src/shared/audit/audit-logger.ts
// Call this from route handlers after successful operations.
// Never let audit logging failure abort the main operation — log the failure separately.

import { db } from "../../db/connection";
import { auditLogs } from "../../db/schema/audit";

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId: string;
  previousState?: Record<string, unknown> | null;
  newState?: Record<string, unknown> | null;
  description: string;
  performedBy?: string;
  performedByUsername?: string;
  clientIpAddress?: string;
}

export async function logAuditEntry(entry: AuditEntry): Promise<void> {
  try {
    await db.insert(auditLogs).values(entry);
  } catch (error) {
    // Audit log failure should NEVER crash the main operation.
    // Log the failure to the server console — ops team can investigate.
    console.error("[AUDIT] Failed to write audit log entry:", error);
    console.error("[AUDIT] Entry that failed:", JSON.stringify(entry));
  }
}

// Convenience wrappers for common actions
export const audit = {
  invoicePosted: (invoice: Record<string, unknown>, userId: string, ip: string) =>
    logAuditEntry({
      action: "invoice.posted",
      entityType: "invoice",
      entityId: invoice.id as string,
      newState: invoice,
      description: `Invoice ${invoice.invoiceNumber} posted to ledger`,
      performedBy: userId,
      clientIpAddress: ip,
    }),

  paymentReversed: (
    payment: Record<string, unknown>,
    reason: string,
    userId: string,
    ip: string
  ) =>
    logAuditEntry({
      action: "payment.reversed",
      entityType: "payment",
      entityId: payment.id as string,
      previousState: { ...payment, status: "posted" },
      newState: { ...payment, status: "reversed" },
      description: `Payment ${payment.receiptNumber} reversed. Reason: ${reason}`,
      performedBy: userId,
      clientIpAddress: ip,
    }),
};
```

---

## 3. Input Validation

Every Fastify route must declare a JSON schema (or use Zod with a Fastify plugin).
Unvalidated inputs reaching the database is a critical vulnerability.

```typescript
// apps/server/src/shared/plugins/validation.plugin.ts
// Uses fastify-type-provider-zod for automatic Zod validation on all routes.

import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";

export async function validationPlugin(fastify: FastifyInstance) {
  fastify.setValidatorCompiler(validatorCompiler);
  fastify.setSerializerCompiler(serializerCompiler);
}

// Usage in a route — Zod schema validates the request body automatically:
// fastify.post("/api/payments", {
//   schema: { body: postPaymentSchema },
// }, postPaymentHandler);
//
// If body fails validation → Fastify returns 400 with clear error message
// before the handler is ever called.
```

### Validation Rules

```typescript
// apps/server/src/shared/validation/common.ts
// Reusable validators used across schemas

// Money amounts — prevents zero or negative payments
export const positiveAmountCentavos = z
  .number()
  .int("Amount must be a whole number (centavos)")
  .positive("Amount must be greater than zero");

// Philippine phone numbers (local format)
export const philippinePhone = z
  .string()
  .regex(/^(09|\+639)\d{9}$/, "Must be a valid Philippine mobile number (09XXXXXXXXX)");

// GCash reference numbers — alphanumeric, typically 13 digits
export const gcashReferenceNumber = z
  .string()
  .regex(/^\d{13}$/, "GCash reference number must be 13 digits");

// Date strings in YYYY-MM-DD format
export const isoDateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format");
```

---

## 4. API Security Hardening

```typescript
// apps/server/src/shared/plugins/security.plugin.ts

import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import cors from "@fastify/cors";
import { config } from "../../config";

export async function securityPlugin(fastify: FastifyInstance) {
  // HTTP security headers — prevents XSS, clickjacking, etc.
  await fastify.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
      },
    },
  });

  // Rate limiting — prevents brute force attacks on the login endpoint
  await fastify.register(rateLimit, {
    max: 100,               // 100 requests per minute per IP (general)
    timeWindow: "1 minute",
  });

  // Stricter rate limit on login endpoint
  // Registered separately in the auth routes:
  // { preHandler: [ rateLimit({ max: 10, timeWindow: "5 minutes" }) ] }

  // CORS — only allow requests from the Electron app (localhost in production)
  await fastify.register(cors, {
    origin: config.CORS_ORIGIN,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE"],
  });

  // Request body size limit — prevents large payload attacks
  // GCash screenshots are uploaded separately via multipart — not JSON body
  fastify.addContentTypeParser(
    "application/json",
    { bodyLimit: 1_048_576 }, // 1MB max JSON body
    fastify.getDefaultJsonParser()
  );
}
```

---

## 5. File Upload Security

```typescript
// GCash screenshot upload rules
const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

export async function validateUploadedFile(file: MultipartFile): Promise<void> {
  if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    throw new ValidationError(
      `File type ${file.mimetype} not allowed. Only JPEG, PNG, and WebP are accepted.`
    );
  }

  // Read first N bytes to verify file signature (magic bytes)
  // This prevents someone from renaming a .exe to .jpg and uploading it
  const buffer = await file.toBuffer();
  if (buffer.length > MAX_FILE_SIZE_BYTES) {
    throw new ValidationError(`File exceeds maximum size of 5MB`);
  }

  const isValidImage = isValidImageMagicBytes(buffer);
  if (!isValidImage) {
    throw new ValidationError("File content does not match a valid image format");
  }
}
```

---

## 6. Testing Strategy

### What to Test (Priority Order)

1. **Financial calculation tests** — The most critical. If billing math is wrong, everything is wrong.
2. **Integration tests** — Full workflow from API call to database state
3. **Authorization tests** — Every protected endpoint rejects wrong roles
4. **Duplicate prevention tests** — Billing job, GCash reference, receipt numbers

### Test File Organization

```
apps/server/src/
├── modules/
│   ├── billing/
│   │   ├── monthly-billing.service.ts
│   │   ├── monthly-billing.service.test.ts  ← unit tests alongside the source
│   │   └── billing.routes.test.ts           ← integration tests
│   ├── payments/
│   │   ├── post-payment.service.test.ts
│   │   └── payment-allocation.test.ts
│   └── ledger/
│       └── ledger-integrity.test.ts
└── tests/
    └── integration/
        ├── setup.ts                          ← test database setup
        ├── billing-workflow.test.ts          ← end-to-end billing scenarios
        └── payment-workflow.test.ts
```

### Required Test Scenarios

```typescript
// Financial calculation unit tests — must all pass

describe("Payment allocation", () => {
  it("applies payment to oldest invoice first", ...)
  it("handles partial payment correctly", ...)
  it("handles exact payment — invoice marked as PAID", ...)
  it("creates advance credit when payment exceeds all invoices", ...)
  it("applies advance credit to next invoice", ...)
})

describe("Monthly billing", () => {
  it("generates exactly one invoice per active account", ...)
  it("does NOT generate invoice for suspended accounts", ...)
  it("does NOT create duplicate invoice when run twice", ...)
  it("invoice total equals plan monthly rate", ...)
  it("billing run logs are written to billing_runs table", ...)
})

describe("Invoice voiding", () => {
  it("creates a credit ledger entry", ...)
  it("does NOT delete the original invoice", ...)
  it("cannot void an already-paid invoice", ...)
  it("cannot void an already-voided invoice", ...)
})

describe("Payment reversal", () => {
  it("restores invoice balances", ...)
  it("creates a debit ledger entry", ...)
  it("does NOT delete the original payment", ...)
  it("marks original payment as reversed", ...)
})

describe("Ledger integrity", () => {
  it("running balance always equals cumulative debit - credit", ...)
  it("verifyLedgerIntegrity returns valid for clean test scenarios", ...)
})

describe("AR Aging", () => {
  it("classifies invoices into correct aging buckets", ...)
  it("grand total equals sum of all outstanding invoice balances", ...)
})

describe("Authorization", () => {
  it("Cashier cannot void invoices", ...)
  it("Collector cannot post office payments", ...)
  it("Manager cannot create subscribers", ...)
  it("Admin can perform all actions", ...)
  it("unauthenticated request returns 401", ...)
})

describe("Duplicate prevention", () => {
  it("rejects GCash payment with duplicate reference number", ...)
  it("billing job produces 0 new invoices when re-run in same period", ...)
  it("receipt numbers are never reused", ...)
})
```

---

## 7. API Endpoints

```
GET  /api/audit-logs                          → List audit logs (Admin only, paginated)
GET  /api/audit-logs?entityType=&entityId=    → Audit trail for a specific entity
GET  /api/audit-logs?action=                  → Filter by action type
GET  /api/audit-logs?performedBy=             → Filter by user

GET  /api/system/settings                     → Get system settings (late fee amount, etc.)
PUT  /api/system/settings                     → Update system settings (Admin only)
GET  /api/system/health/extended              → Extended health check (Admin only)
```

---

## 8. System Settings Schema

```typescript
// apps/server/src/db/schema/system.ts
// Stores configurable business rules — not hardcoded in application code.

export const systemSettings = pgTable("system_settings", {
  key: varchar("key", { length: 100 }).primaryKey(),
  value: text("value").notNull(),
  description: text("description").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid("updated_by").references(() => users.id),
});

// Default settings to seed:
// late_fee_centavos          = "5000"    (PHP 50.00)
// invoice_due_day_of_month   = "15"      (invoices due on the 15th)
// suspension_after_days      = "30"      (auto-suspend after 30 days overdue)
// company_name               = "My ISP"
// company_address            = "..."
// company_phone              = "..."
// receipt_footer_text        = "Thank you for your payment!"
```

---

## 9. Acceptance Criteria

- [ ] Audit log records all financial events (invoice posted, payment posted, reversal, void)
- [ ] Audit log records all security events (login, user role change, password change)
- [ ] Audit log entries are NEVER deleted or modified
- [ ] Every API route validates inputs with Zod — invalid inputs return 400 before handler runs
- [ ] Login endpoint is rate-limited to 10 attempts per 5 minutes per IP
- [ ] GCash file upload validates MIME type AND magic bytes
- [ ] All financial calculation unit tests pass
- [ ] Authorization tests: each role is correctly denied access to operations outside their scope
- [ ] Duplicate prevention tests pass for billing, GCash references, and receipt numbers
- [ ] Ledger integrity check test passes for all financial workflow scenarios
- [ ] `pnpm test` runs and produces a passing test report
- [ ] System settings are seeded with correct defaults
