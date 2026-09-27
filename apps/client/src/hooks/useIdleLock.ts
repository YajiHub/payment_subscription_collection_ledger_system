// S5-4: the inactivity timer behind the session lock.
//
// The hook owns exactly one thing — deciding that a workstation has gone quiet —
// and calls back when the configured period has passed with no sign of a human.
// What "locking" then means is the caller's business, so this stays testable and
// free of any credential logic.

import { useEffect, useRef } from "react";

/**
 * What counts as a human being at the keyboard.
 *
 * `mousemove` alone fires hundreds of times a second while a hand rests on the
 * mouse, so the listener below throttles it; every other event is cheap enough to
 * act on directly. `focus`/`blur` are deliberately absent: leaving and returning to
 * the window is not activity, so a workstation that spent the last hour behind
 * another window locks rather than being woken up by a click on its title bar.
 */
const ACTIVITY_EVENT_NAMES = [
  "mousedown",
  "keydown",
  "wheel",
  "touchstart",
  "pointerdown",
  "mousemove",
] as const;

/** The most often a burst of mouse movement may push the deadline out again. */
const MOUSE_MOVE_THROTTLE_MS = 1_000;

export interface IdleLockOptions {
  /** Inactivity before `onIdle` runs, in milliseconds. */
  timeoutMs: number;
  /** False disables the timer entirely — nobody is signed in, or the lock is already up. */
  enabled: boolean;
  /** Runs once when the period elapses with no activity. */
  onIdle: () => void;
}

/**
 * Calls `onIdle` after `timeoutMs` without keyboard, mouse or touch activity.
 *
 * The timer is re-armed by the same events that a person generates, and it also
 * re-checks the clock when it fires: a suspended laptop resumes with an overdue
 * timer, and that must lock rather than be forgiven for having being asleep.
 */
export function useIdleLock({ timeoutMs, enabled, onIdle }: IdleLockOptions): void {
  // Held in refs so a new inline callback on every render does not tear down and
  // re-register the window listeners.
  const onIdleRef = useRef(onIdle);
  const enabledRef = useRef(enabled);

  useEffect(() => {
    onIdleRef.current = onIdle;
    enabledRef.current = enabled;
  }, [onIdle, enabled]);

  useEffect(() => {
    if (!enabled || timeoutMs <= 0) {
      return;
    }

    let timerHandle: ReturnType<typeof setTimeout> | undefined;
    let lastActivityAtMs = Date.now();
    let lastMouseMoveAtMs = 0;

    function disarmed(): boolean {
      return !enabledRef.current;
    }

    function fireOrRearm(): void {
      if (disarmed()) {
        return;
      }

      const idleForMs = Date.now() - lastActivityAtMs;

      // The timer can arrive late — a throttled background tab, a sleeping laptop —
      // so the deadline is confirmed against the clock before locking.
      if (idleForMs < timeoutMs) {
        arm(timeoutMs - idleForMs);
        return;
      }

      onIdleRef.current();
    }

    function arm(delayMs: number): void {
      if (timerHandle !== undefined) {
        clearTimeout(timerHandle);
      }
      timerHandle = setTimeout(fireOrRearm, delayMs);
    }

    function noteActivity(event: Event): void {
      if (disarmed()) {
        return;
      }

      if (event.type === "mousemove") {
        const nowMs = Date.now();
        if (nowMs - lastMouseMoveAtMs < MOUSE_MOVE_THROTTLE_MS) {
          return;
        }
        lastMouseMoveAtMs = nowMs;
      }

      lastActivityAtMs = Date.now();
      arm(timeoutMs);
    }

    arm(timeoutMs);

    for (const eventName of ACTIVITY_EVENT_NAMES) {
      window.addEventListener(eventName, noteActivity, { passive: true });
    }

    return () => {
      if (timerHandle !== undefined) {
        clearTimeout(timerHandle);
      }
      for (const eventName of ACTIVITY_EVENT_NAMES) {
        window.removeEventListener(eventName, noteActivity);
      }
    };
  }, [enabled, timeoutMs]);
}
