# Phase 2 — Authentication and RBAC

> **Prompt template for AI-assisted implementation:**
> "I am building the BCIS Subscription Billing and Collection System. The architecture uses
> Electron + React clients connecting to a Fastify API server with PostgreSQL via Drizzle ORM.
> Implement Phase 2: Authentication and RBAC. Create the Drizzle schema for users and roles,
> implement bcrypt password hashing, JWT-based login/logout, and Fastify middleware that enforces
> role-based permissions on every protected route. The system supports five roles: Admin, Cashier,
> Collector, Billing Clerk, and Manager. Use the spec at specs/phase2-auth-rbac.md."

---

## 1. Overview

Authentication answers: **who are you?**
RBAC (Role-Based Access Control) answers: **what are you allowed to do?**

Both must be enforced **on the server**. Hiding buttons in the UI is not authorization —
it is a UX hint. A user with the Cashier role who somehow calls a billing endpoint directly
must be rejected by the server, not just by missing buttons.

**Instructor checkpoint:** CP2 — Core Data

---

## 2. User Roles

| Role | What they do | Critical restrictions |
|------|-------------|----------------------|
| **Admin** | Full system access; manages users, system settings, plans | Can do everything; only Admin can manage users |
| **Billing Clerk** | Creates/manages subscriber accounts, generates invoices | Cannot post payments or manage users |
| **Cashier** | Posts payments, issues receipts, processes GCash | Cannot manage subscribers or generate invoices |
| **Collector** | Manages field collection batches, remits cash | Cannot post office payments; manages only assigned batches |
| **Manager** | View-only dashboard and all reports | Cannot create, edit, or delete any record |

> **Design principle:** When in doubt about whether a role should have access, deny it.
> It is easier to grant access than to discover a security hole in production.

---

## 3. Database Schema

```typescript
// apps/server/src/db/schema/users.ts
// All authentication and user management tables live here.

import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  timestamp,
  pgEnum,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// The five roles defined by the lab specification.
// Adding a new role requires updating this enum AND the permission matrix below.
export const userRoleEnum = pgEnum("user_role", [
  "admin",
  "billing_clerk",
  "cashier",
  "collector",
  "manager",
]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),

  // Display name shown in the UI and printed on receipts
  fullName: varchar("full_name", { length: 100 }).notNull(),

  // Used for login — must be unique across the system
  username: varchar("username", { length: 50 }).notNull().unique(),

  // bcrypt hash — NEVER stored in plaintext
  passwordHash: text("password_hash").notNull(),

  role: userRoleEnum("role").notNull(),

  // Soft-disable an account without deleting it.
  // Deleted users' names still appear on old receipts and audit logs.
  isActive: boolean("is_active").notNull().default(true),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),

  // Who created this user account — links to users.id (self-referential)
  createdBy: uuid("created_by"),
});

// Tracks every login attempt — successful or failed.
// Used for security monitoring and audit trail.
export const loginAuditLog = pgTable("login_audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  username: varchar("username", { length: 50 }).notNull(),
  success: boolean("success").notNull(),

  // IP address of the machine that attempted login.
  // In a LAN environment this identifies which PC made the attempt.
  ipAddress: varchar("ip_address", { length: 45 }),

  attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull().defaultNow(),

  // Only populated on successful logins
  userId: uuid("user_id").references(() => users.id),
});

// Tracks JWT tokens that have been explicitly logged out.
// Without this, a stolen token would remain valid until expiry.
export const revokedTokens = pgTable("revoked_tokens", {
  // We store the JWT "jti" (JWT ID) claim, not the full token
  jti: uuid("jti").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id),
  revokedAt: timestamp("revoked_at", { withTimezone: true }).notNull().defaultNow(),

  // Tokens expire, so we can clean up old rows after expiry
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

// Relations make it easy to query users with their audit log in one go
export const usersRelations = relations(users, ({ many }) => ({
  loginAttempts: many(loginAuditLog),
}));
```

---

## 4. Permission Matrix

```typescript
// packages/shared/src/constants/permissions.ts
// The source of truth for what each role can do.
// Any change to permissions requires updating ONLY this file.
// The server middleware reads from here — no permission logic is scattered in route handlers.

export type UserRole = "admin" | "billing_clerk" | "cashier" | "collector" | "manager";

// Every permission in the system has a name.
// Routes declare which permission they require.
// The auth middleware checks if the user's role has that permission.
export type Permission =
  // User management
  | "users:create"
  | "users:read"
  | "users:update"
  | "users:deactivate"
  // Subscriber management
  | "subscribers:create"
  | "subscribers:read"
  | "subscribers:update"
  | "subscribers:suspend"
  | "subscribers:reconnect"
  // Plans and packages
  | "plans:create"
  | "plans:read"
  | "plans:update"
  // Billing
  | "invoices:generate"
  | "invoices:read"
  | "invoices:void"
  // Payments
  | "payments:post"
  | "payments:read"
  | "payments:reverse"
  | "receipts:print"
  // Collector operations
  | "collector_batches:create"
  | "collector_batches:read"
  | "collector_batches:remit"
  | "collector_batches:reconcile"
  // Reports
  | "reports:view"
  | "reports:export"
  // System
  | "system:backup"
  | "system:settings";

// The permission matrix: what each role is allowed to do.
// If a permission is not listed for a role, access is denied.
export const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  admin: [
    "users:create", "users:read", "users:update", "users:deactivate",
    "subscribers:create", "subscribers:read", "subscribers:update",
    "subscribers:suspend", "subscribers:reconnect",
    "plans:create", "plans:read", "plans:update",
    "invoices:generate", "invoices:read", "invoices:void",
    "payments:post", "payments:read", "payments:reverse",
    "receipts:print",
    "collector_batches:create", "collector_batches:read",
    "collector_batches:remit", "collector_batches:reconcile",
    "reports:view", "reports:export",
    "system:backup", "system:settings",
  ],

  billing_clerk: [
    "subscribers:create", "subscribers:read", "subscribers:update",
    "subscribers:suspend", "subscribers:reconnect",
    "plans:read",
    "invoices:generate", "invoices:read",
    "payments:read",
    "receipts:print",
    "reports:view",
  ],

  cashier: [
    "subscribers:read",
    "invoices:read",
    "payments:post", "payments:read",
    "receipts:print",
    "reports:view",
  ],

  collector: [
    "subscribers:read",
    "invoices:read",
    "payments:read",
    "collector_batches:create", "collector_batches:read",
    "collector_batches:remit",
    "reports:view",
  ],

  manager: [
    "subscribers:read",
    "plans:read",
    "invoices:read",
    "payments:read",
    "collector_batches:read",
    "reports:view", "reports:export",
  ],
};

// Utility: check if a role has a specific permission
export function roleHasPermission(role: UserRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
```

---

## 5. API Endpoints

### Authentication Routes

```
POST /api/auth/login
  Body: { username: string, password: string }
  Response: { token: string, user: { id, fullName, role } }
  Errors: 401 (invalid credentials), 403 (account inactive)

POST /api/auth/logout
  Headers: Authorization: Bearer <token>
  Response: { success: true }
  Action: Adds JWT's jti to revoked_tokens table

GET /api/auth/me
  Headers: Authorization: Bearer <token>
  Response: { id, fullName, username, role, isActive }
```

### User Management Routes (Admin only)

```
GET  /api/users              → List all users (paginated)
POST /api/users              → Create user
GET  /api/users/:id          → Get single user
PUT  /api/users/:id          → Update user (name, role)
PUT  /api/users/:id/password → Change user password (admin resets)
PUT  /api/users/:id/deactivate → Soft-disable account
```

---

## 6. JWT Implementation

```typescript
// apps/server/src/modules/auth/auth.service.ts
// All authentication logic is isolated here.
// Route handlers call these functions — they do not implement auth logic themselves.

import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { config } from "../../config";
import { db } from "../../db/connection";
import { users, revokedTokens, loginAuditLog } from "../../db/schema/users";
import { eq } from "drizzle-orm";
import type { UserRole } from "@bcis/shared";

// What we embed in the JWT — keep it small (no sensitive data)
export interface JwtPayload {
  sub: string;      // user ID
  role: UserRole;   // role — server validates this, not the client
  jti: string;      // unique token ID for revocation
  iat: number;
  exp: number;
}

const TOKEN_EXPIRY = "8h"; // covers a full working day

export async function loginUser(
  username: string,
  password: string,
  ipAddress: string
): Promise<{ token: string; user: { id: string; fullName: string; role: UserRole } }> {
  const user = await db
    .select()
    .from(users)
    .where(eq(users.username, username))
    .limit(1)
    .then((rows) => rows[0]);

  const isValidPassword = user
    ? await bcrypt.compare(password, user.passwordHash)
    : false; // always run bcrypt even if user not found — prevents timing attacks

  // Log every attempt before returning — even failed ones
  await db.insert(loginAuditLog).values({
    username,
    success: isValidPassword && user?.isActive === true,
    ipAddress,
    userId: isValidPassword ? user?.id : undefined,
  });

  if (!user || !isValidPassword) {
    throw new UnauthorizedError("Invalid username or password");
  }

  if (!user.isActive) {
    throw new ForbiddenError("Account is deactivated. Contact your administrator.");
  }

  const jti = crypto.randomUUID();
  const token = jwt.sign(
    { sub: user.id, role: user.role, jti },
    config.JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY }
  );

  return { token, user: { id: user.id, fullName: user.fullName, role: user.role } };
}

export async function logoutUser(jti: string, userId: string, expiresAt: Date): Promise<void> {
  await db.insert(revokedTokens).values({ jti, userId, expiresAt });
}
```

---

## 7. Auth Middleware

```typescript
// apps/server/src/shared/middleware/authenticate.ts
// This function runs on every protected route BEFORE the route handler.
// It verifies the JWT and attaches the user to the request.

import type { FastifyRequest, FastifyReply } from "fastify";
import jwt from "jsonwebtoken";
import { config } from "../../config";
import { db } from "../../db/connection";
import { revokedTokens } from "../../db/schema/users";
import { eq } from "drizzle-orm";
import type { JwtPayload } from "../modules/auth/auth.service";

export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return reply.status(401).send({ error: "Authentication required" });
  }

  const token = authHeader.slice(7);
  let payload: JwtPayload;

  try {
    payload = jwt.verify(token, config.JWT_SECRET) as JwtPayload;
  } catch {
    return reply.status(401).send({ error: "Invalid or expired token" });
  }

  // Check if this specific token was explicitly logged out
  const isRevoked = await db
    .select({ jti: revokedTokens.jti })
    .from(revokedTokens)
    .where(eq(revokedTokens.jti, payload.jti))
    .limit(1)
    .then((rows) => rows.length > 0);

  if (isRevoked) {
    return reply.status(401).send({ error: "Token has been revoked. Please log in again." });
  }

  // Attach to request so route handlers can read: request.user.role
  request.user = { id: payload.sub, role: payload.role, jti: payload.jti };
}
```

```typescript
// apps/server/src/shared/middleware/authorize.ts
// Usage in a route: preHandler: [authenticate, authorize("payments:post")]
// If user role does not have the required permission → 403 Forbidden

import type { FastifyRequest, FastifyReply } from "fastify";
import { roleHasPermission } from "@bcis/shared";
import type { Permission } from "@bcis/shared";

export function authorize(requiredPermission: Permission) {
  return async function (request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return reply.status(401).send({ error: "Authentication required" });
    }

    const hasPermission = roleHasPermission(request.user.role, requiredPermission);
    if (!hasPermission) {
      return reply.status(403).send({
        error: `Access denied. Your role (${request.user.role}) cannot perform: ${requiredPermission}`,
      });
    }
  };
}
```

---

## 8. React Auth Store

```typescript
// apps/client/src/stores/auth.store.ts
// The single source of truth for the logged-in user on the client side.
// Components read from here; they never decode JWTs themselves.

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { UserRole } from "@bcis/shared";

interface AuthState {
  token: string | null;
  user: { id: string; fullName: string; role: UserRole } | null;
  isAuthenticated: boolean;
  login: (token: string, user: AuthState["user"]) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      isAuthenticated: false,
      login: (token, user) => set({ token, user, isAuthenticated: true }),
      logout: () => set({ token: null, user: null, isAuthenticated: false }),
    }),
    {
      name: "bcis-auth",  // localStorage key
      partialize: (state) => ({ token: state.token, user: state.user }),
    }
  )
);
```

---

## 9. Protected Route Component

```typescript
// apps/client/src/components/ProtectedRoute.tsx
// Wraps any page that requires authentication or a specific permission.
// This is a UX guard — the server also enforces permissions independently.

import { Navigate } from "react-router-dom";
import { useAuthStore } from "../stores/auth.store";
import { roleHasPermission } from "@bcis/shared";
import type { Permission } from "@bcis/shared";

interface Props {
  children: React.ReactNode;
  requiredPermission?: Permission;
}

export function ProtectedRoute({ children, requiredPermission }: Props) {
  const { isAuthenticated, user } = useAuthStore();

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  if (requiredPermission && user && !roleHasPermission(user.role, requiredPermission)) {
    return <Navigate to="/unauthorized" replace />;
  }

  return <>{children}</>;
}
```

---

## 10. UI Screens

### Login Screen
- Username input + Password input
- "Login" button
- Show error message on invalid credentials
- Show "Account is deactivated" message for inactive users
- No "Remember me" — 8-hour sessions per working day

### User Management Screen (Admin only)
- Table: Full Name | Username | Role | Status | Created At | Actions
- "Add User" button → modal form
- Per-row: Edit | Deactivate/Activate
- Cannot delete users — only deactivate (financial records need user references)

---

## 11. Security Requirements

1. **Passwords** — bcrypt with 12 rounds minimum. Hash stored, never the plain password.
2. **JWT secret** — minimum 32 characters, from environment variable, never committed to git.
3. **Token expiry** — 8 hours. Users must re-login each working day.
4. **Token revocation** — logout adds the token's `jti` to `revoked_tokens` table.
5. **Brute-force protection** — log all failed attempts with IP; admin can audit suspicious activity.
6. **No role escalation** — only Admin can change user roles. A Cashier cannot promote themselves.
7. **Timing-safe comparison** — always run `bcrypt.compare` even when user is not found (prevents username enumeration via timing).

---

## 12. Acceptance Criteria

- [ ] `POST /api/auth/login` with correct credentials returns a JWT
- [ ] `POST /api/auth/login` with wrong password returns 401
- [ ] `POST /api/auth/login` for inactive account returns 403
- [ ] `GET /api/auth/me` with valid token returns current user
- [ ] `GET /api/auth/me` with expired token returns 401
- [ ] `POST /api/auth/logout` adds token to revoked list; subsequent requests with same token return 401
- [ ] Admin can create, edit, and deactivate users
- [ ] Non-admin role returns 403 when calling `POST /api/users`
- [ ] Cashier returns 403 when calling `POST /api/invoices/generate`
- [ ] Login audit log records successful and failed login attempts
- [ ] Passwords stored as bcrypt hash (verify: no plaintext in database)
- [ ] `pnpm typecheck` and `pnpm lint` pass
