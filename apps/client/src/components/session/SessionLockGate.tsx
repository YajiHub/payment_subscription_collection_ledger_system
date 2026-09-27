// S5-4: the gate every signed-in screen sits behind.
//
// It decides whether the workstation is locked, and when it is, the application is
// not rendered at all — the router, the shell, the page and every table on it are
// unmounted. That is what makes the lock more than a covering sheet: nothing
// sensitive is in the DOM to read, and no page keeps polling the API behind it.

import type { ReactNode } from "react";
import { useEffect, useState } from "react";

import {
  DEFAULT_SESSION_IDLE_TIMEOUT_MINUTES,
  SYSTEM_SETTING_KEYS,
  parseIntSetting,
} from "@bcis/shared";
import { getSystemSettings } from "../../lib/api-client";
import { lockWorkstation } from "../../lib/session-lock";
import { useIdleLock } from "../../hooks/useIdleLock";
import { useAuthStore } from "../../stores/auth.store";
import { SessionLockScreen } from "./SessionLockScreen";

const MILLISECONDS_PER_MINUTE = 60_000;

const DEFAULT_IDLE_TIMEOUT_MS = DEFAULT_SESSION_IDLE_TIMEOUT_MINUTES * MILLISECONDS_PER_MINUTE;

/**
 * The idle period in force, in milliseconds.
 *
 * The value lives in `session_settings` so an administrator can shorten it from the
 * System Settings screen without a rebuild, and it is read through the ordinary
 * settings endpoint, which any signed-in user may call. A missing value — an older
 * server that has not seeded it yet — or a nonsensical one falls back to the
 * compiled default rather than disabling the lock.
 */
function useSessionIdleTimeoutMs(isSignedIn: boolean): number {
  const [timeoutMs, setTimeoutMs] = useState(DEFAULT_IDLE_TIMEOUT_MS);

  useEffect(() => {
    if (!isSignedIn) {
      setTimeoutMs(DEFAULT_IDLE_TIMEOUT_MS);
      return;
    }

    let isCancelled = false;

    void getSystemSettings()
      .then((settings) => {
        if (isCancelled) {
          return;
        }

        const stored = settings.find(
          (setting) => setting.key === SYSTEM_SETTING_KEYS.sessionIdleTimeoutMinutes
        )?.value;
        const minutes = parseIntSetting(stored, DEFAULT_SESSION_IDLE_TIMEOUT_MINUTES);

        // A zero or negative period would mean "never lock", which is not a setting
        // this system offers, so it is treated as malformed and ignored.
        if (minutes >= 1) {
          setTimeoutMs(minutes * MILLISECONDS_PER_MINUTE);
        }
      })
      .catch(() => {
        // Unreachable server: the compiled default still locks the workstation.
      });

    return () => {
      isCancelled = true;
    };
  }, [isSignedIn]);

  return timeoutMs;
}

/**
 * Wraps the router. While the workstation is locked the children are not rendered;
 * unlocking re-renders them, and the hash router restores whatever screen was open.
 */
export function SessionLockGate({ children }: { children: ReactNode }): ReactNode {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const lockedSession = useAuthStore((state) => state.lockedSession);

  const timeoutMs = useSessionIdleTimeoutMs(isAuthenticated);
  const isLocked = lockedSession !== null;

  // The timer runs only for a live session. Once the overlay is up there is nothing
  // left to lock, and the listeners must not be fed by typing on the lock screen.
  useIdleLock({
    timeoutMs,
    enabled: isAuthenticated && !isLocked,
    onIdle: lockWorkstation,
  });

  if (isLocked) {
    return <SessionLockScreen />;
  }

  return <>{children}</>;
}
