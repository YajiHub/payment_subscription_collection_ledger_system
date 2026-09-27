// Per-account failed-login lockout (S5-5).
//
// The IP rate limit in security.plugin.ts stops one machine hammering the login
// endpoint. It does not stop a slow, distributed guess against ONE account, which
// is what this module adds: after a configurable number of consecutive failures an
// account is locked for a configurable cooldown.
//
// Design choices that matter:
//
//   • The counter is DERIVED, never stored. A login attempt only ever appends to
//     `login_audit_log`; counting failures since the account's last success means a
//     successful login clears the counter without deleting or rewriting an audit
//     row. The audit trail stays append-only.
//   • The lock is ANCHORED to the moment the failure count reached the threshold,
//     NOT to the most recent failure. Without that anchor, every request while an
//     account is locked pushes `lastFailureAt` forward and the account can be kept
//     locked forever with one request per cooldown — an indefinite denial of service
//     any attacker can sustain. With the anchor, further attempts cannot extend it.
//   • After the cooldown elapses the streak is SPENT: the next failure starts a
//     fresh streak, so brute-force protection resumes without a success.
//   • The policy (threshold, cooldown) is read from `system_settings`, falling back
//     to the config.ts defaults, so it is changeable without a redeploy.
//   • The check runs BEFORE the password is verified, but AFTER the username lookup,
//     and both a real and an unknown username take the same path with the same
//     message — so a lockout never reveals whether an account exists.

import { parseIntSetting, SYSTEM_SETTING_KEYS } from "@bcis/shared";
import { asc, sql } from "drizzle-orm";

import { config } from "../../config";
import { db } from "../../db/connection";
import { loginAuditLog } from "../../db/schema/users";
import { getSystemSettingsMap } from "../system/system-settings.service";

export interface LoginLockoutPolicy {
  /** Consecutive failures that lock the account. */
  threshold: number;
  /** How long the account stays locked after the failure count reached threshold. */
  cooldownMs: number;
}

export interface LoginFailureState {
  /** Failures in the CURRENT streak (since the last success or the last spent lock). */
  failureCount: number;
  /** The newest failure in the current streak. */
  lastFailureAt: Date | null;
  /** When the current streak reached the threshold; the lock window starts here. */
  lockStartedAt: Date | null;
}

export interface LockoutDecision {
  locked: boolean;
  failureCount: number;
  /** Whole seconds until the account unlocks; 0 when it is not locked. */
  retryAfterSeconds: number;
  /** Failures still allowed before the account locks; 0 once locked. */
  remainingAttempts: number;
}

/**
 * How many recent failures to read when reconstructing the streak. Bounded so a
 * spammed account cannot make the login path read an unbounded result set. The
 * earliest rows are kept (ASC) because the lock anchor is at the START of the
 * streak.
 */
const MAX_FAILURES_TO_SCAN = 5_000;

/** Reads the threshold and cooldown, preferring the runtime settings over config. */
export async function getLoginLockoutPolicy(): Promise<LoginLockoutPolicy> {
  const settings = await getSystemSettingsMap();

  const threshold = Math.max(
    1,
    parseIntSetting(settings[SYSTEM_SETTING_KEYS.loginLockoutThreshold], config.LOGIN_LOCKOUT_THRESHOLD)
  );
  const cooldownMinutes = Math.max(
    0,
    parseIntSetting(
      settings[SYSTEM_SETTING_KEYS.loginLockoutCooldownMinutes],
      config.LOGIN_LOCKOUT_COOLDOWN_MINUTES
    )
  );

  return { threshold, cooldownMs: cooldownMinutes * 60_000 };
}

/**
 * Reconstructs the current failure streak from the ordered failure times.
 *
 * A run of failures that reaches the threshold starts a lock at the moment the
 * threshold was reached. When the NEXT failure happens at or after that lock's
 * expiry, the run is spent and a fresh streak begins — so the lock cannot be
 * extended by hammering, and a new lock still forms after the cooldown.
 *
 * Pure, so the boundary (N-1 failures allow login, N lock it, cooldown releases
 * it, hammering cannot extend it) is unit-testable without a database.
 */
export function summarizeFailureStreak(
  failureTimes: readonly Date[],
  threshold: number,
  cooldownMs: number
): LoginFailureState {
  let streak: Date[] = [];

  for (const at of failureTimes) {
    if (streak.length >= threshold) {
      const anchor = streak[threshold - 1];
      if (anchor !== undefined && at.getTime() >= anchor.getTime() + cooldownMs) {
        // The previous lock had expired before this failure: start a fresh streak.
        streak = [];
      }
    }
    streak.push(at);
  }

  const lockStartedAt = streak.length >= threshold ? streak[threshold - 1] ?? null : null;

  return {
    failureCount: streak.length,
    lastFailureAt: streak.length > 0 ? streak[streak.length - 1] ?? null : null,
    lockStartedAt,
  };
}

/**
 * This account's failures since its last successful login, oldest first, reduced
 * to the current streak. Both real and unknown usernames are counted, which is
 * what keeps the lockout from leaking account existence.
 */
export async function getRecentFailureState(
  username: string,
  threshold: number,
  cooldownMs: number
): Promise<LoginFailureState> {
  const rows = await db
    .select({ attemptedAt: loginAuditLog.attemptedAt })
    .from(loginAuditLog)
    .where(
      sql`${loginAuditLog.username} = ${username}
        AND ${loginAuditLog.success} = false
        AND ${loginAuditLog.attemptedAt} > COALESCE(
          (SELECT max(attempted_at) FROM login_audit_log WHERE username = ${username} AND success = true),
          TIMESTAMPTZ 'epoch'
        )`
    )
    .orderBy(asc(loginAuditLog.attemptedAt))
    .limit(MAX_FAILURES_TO_SCAN);

  const failureTimes = rows.map((row) =>
    row.attemptedAt instanceof Date ? row.attemptedAt : new Date(row.attemptedAt)
  );

  return summarizeFailureStreak(failureTimes, threshold, cooldownMs);
}

/**
 * Decides whether an account is locked, anchored to when the streak reached the
 * threshold. Further attempts cannot move that anchor.
 */
export function evaluateLoginLockout(
  state: LoginFailureState,
  policy: LoginLockoutPolicy,
  now: Date
): LockoutDecision {
  if (state.failureCount >= policy.threshold && state.lockStartedAt !== null) {
    const unlocksAtMs = state.lockStartedAt.getTime() + policy.cooldownMs;
    if (now.getTime() < unlocksAtMs) {
      return {
        locked: true,
        failureCount: state.failureCount,
        retryAfterSeconds: Math.ceil((unlocksAtMs - now.getTime()) / 1000),
        remainingAttempts: 0,
      };
    }

    // The lock window has elapsed: a fresh streak begins, so the account is open
    // and the next wrong password has a full allowance again.
    return {
      locked: false,
      failureCount: state.failureCount,
      retryAfterSeconds: 0,
      remainingAttempts: policy.threshold,
    };
  }

  return {
    locked: false,
    failureCount: state.failureCount,
    retryAfterSeconds: 0,
    remainingAttempts: Math.max(0, policy.threshold - state.failureCount),
  };
}
