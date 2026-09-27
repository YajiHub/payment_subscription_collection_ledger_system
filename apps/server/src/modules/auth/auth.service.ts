// All authentication logic is isolated here.
// Route handlers call these functions — they do not implement auth logic themselves.
//
// Keeping the queries and the bcrypt/JWT work in one place means there is a
// single spot to review when asking "how do we decide someone is who they claim?"

import { randomUUID } from "node:crypto";

import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";

import { config } from "../../config";
import { db } from "../../db/connection";
import { loginAuditLog, revokedTokens, users } from "../../db/schema/users";
import { audit } from "../../shared/audit/audit-logger";
import {
  ForbiddenError,
  NotFoundError,
  TooManyRequestsError,
  UnauthorizedError,
} from "../../shared/errors";
import {
  evaluateLoginLockout,
  getLoginLockoutPolicy,
  getRecentFailureState,
} from "./login-lockout.service";
import type { UserRole } from "@bcis/shared";

// A real bcrypt hash (cost 12) of a value nobody can log in with.
// When the username does not exist we still run bcrypt.compare against this hash.
// Without it, an unknown username would return faster than a known one with a wrong
// password, and that timing difference alone would reveal which accounts exist.
// It must stay a VALID bcrypt hash: an invalid one makes compare throw or return
// immediately, which reintroduces the very timing leak this constant prevents.
const TIMING_EQUALIZER_PASSWORD_HASH =
  "$2b$12$OMlJdIjzDLp3Jfn.9NR3qOBmwx5aLVRkyrFhSH6e5J1g.kCBMSeJe";

// What we embed in the JWT — keep it small (no sensitive data).
export interface JwtPayload {
  sub: string; // user ID
  role: UserRole; // role — the server validates this, not the client
  jti: string; // unique token ID, used for revocation
  iat: number;
  exp: number;
}

export interface AuthenticatedUserSummary {
  id: string;
  fullName: string;
  role: UserRole;
}

/** Covers a single working day; users must log in again the next morning. */
const TOKEN_EXPIRY = "8h";

/**
 * Verifies a username/password pair and issues a signed token.
 *
 * Every attempt — success or failure — is written to the audit log before the
 * function returns. The bcrypt comparison runs even when the username is
 * unknown, so the response time does not reveal whether the account exists.
 */
export async function loginUser(
  username: string,
  password: string,
  ipAddress: string
): Promise<{ token: string; user: AuthenticatedUserSummary }> {
  const user = await db
    .select()
    .from(users)
    .where(eq(users.username, username))
    .limit(1)
    .then((rows) => rows[0]);

  // S5-5: refuse a locked account BEFORE the password is verified. The lookup has
  // already happened, but the lockout is keyed on the username alone, so an unknown
  // username takes the same path and is refused with the same message — the lockout
  // never reveals whether an account exists.
  const policy = await getLoginLockoutPolicy();
  const failureState = await getRecentFailureState(username, policy.threshold, policy.cooldownMs);
  const lockout = evaluateLoginLockout(failureState, policy, new Date());

  if (lockout.locked) {
    await db.insert(loginAuditLog).values({ username, success: false, ipAddress });
    await audit.loginFailed(username, ipAddress, "account temporarily locked");

    const minutesRemaining = Math.max(1, Math.ceil(lockout.retryAfterSeconds / 60));
    throw new TooManyRequestsError(
      `Too many failed login attempts. Try again in ${minutesRemaining} minute(s).`
    );
  }

  // Compare unconditionally: a missing user must cost the same as a wrong password.
  const passwordHash = user?.passwordHash ?? TIMING_EQUALIZER_PASSWORD_HASH;
  const isValidPassword = await bcrypt.compare(password, passwordHash);

  await db.insert(loginAuditLog).values({
    username,
    success: isValidPassword && user?.isActive === true,
    ipAddress,
    userId: isValidPassword ? user?.id : undefined,
  });

  if (user === undefined || !isValidPassword) {
    // Phase 9 §2: a failed login is a security event, so it is written to the
    // audit trail as well as the login log. The reason is deliberately generic
    // in the description the caller sees; the audit trail records the real one.
    await audit.loginFailed(username, ipAddress, "invalid credentials");
    throw new UnauthorizedError("Invalid username or password");
  }

  if (!user.isActive) {
    await audit.loginFailed(username, ipAddress, "account deactivated");
    throw new ForbiddenError("Account is deactivated. Contact your administrator.");
  }

  const jti = randomUUID();
  const payload = { sub: user.id, role: user.role, jti };
  const token = jwt.sign(payload, config.JWT_SECRET, { expiresIn: TOKEN_EXPIRY });

  // A successful login is a security event worth recording alongside failures.
  await audit.loginSucceeded(user.id, username, ipAddress);

  return { token, user: { id: user.id, fullName: user.fullName, role: user.role } };
}

/**
 * Records a logout so the bearer token stops working before its natural expiry.
 * We store the jti and its expiry; the revocation row can be pruned after that.
 */
export async function logoutUser(jti: string, userId: string, expiresAt: Date): Promise<void> {
  await db.insert(revokedTokens).values({ jti, userId, expiresAt });
}

/** Loads the profile shown by GET /api/auth/me. Throws when the account vanished. */
export async function getUserProfile(userId: string) {
  const user = await db
    .select({
      id: users.id,
      fullName: users.fullName,
      username: users.username,
      role: users.role,
      isActive: users.isActive,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
    .then((rows) => rows[0]);

  if (user === undefined) {
    throw new NotFoundError("The authenticated user no longer exists");
  }

  return user;
}
