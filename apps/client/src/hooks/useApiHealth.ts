// Polls the API server and keeps the shared status store up to date.

import { useEffect } from "react";

import { fetchDatabaseHealth, fetchServiceHealth } from "../lib/api-client";
import { DATABASE_HEALTH_EVERY_N_POLLS, HEALTH_CHECK_INTERVAL_MS } from "../lib/constants";
import { useApiStatusStore } from "../stores/api-status.store";

/**
 * How many checks must fail in a row before the UI calls the API unreachable.
 *
 * One failed poll means almost nothing: a `tsx watch` restart takes the server
 * down for a second or two, a slow render can push a request past its timeout,
 * and a laptop waking up drops whatever was in flight. Requiring consecutive
 * failures keeps a two-second restart from flashing "Connection Lost" at an
 * operator who is mid-transaction, while a real outage still surfaces within
 * two poll intervals.
 */
const CONSECUTIVE_FAILURES_BEFORE_OFFLINE = 2;

export function useApiHealth(): void {
  const markReachable = useApiStatusStore((state) => state.markReachable);
  const markUnreachable = useApiStatusStore((state) => state.markUnreachable);
  const setDatabaseStatus = useApiStatusStore((state) => state.setDatabaseStatus);

  useEffect(() => {
    let isCancelled = false;
    let consecutiveFailures = 0;
    let pollCount = 0;

    async function checkApiHealth(): Promise<void> {
      try {
        const serviceHealth = await fetchServiceHealth();
        if (isCancelled) {
          return;
        }
        consecutiveFailures = 0;
        markReachable(serviceHealth.version);

        // The database probe is the heavier of the two and its answer changes far
        // less often, so it runs on the first poll and then only every few polls.
        // Probing both on every tick is what doubled the request volume.
        pollCount += 1;
        if (pollCount !== 1 && pollCount % DATABASE_HEALTH_EVERY_N_POLLS !== 0) {
          return;
        }

        try {
          const databaseHealth = await fetchDatabaseHealth();
          if (isCancelled) {
            return;
          }
          setDatabaseStatus(databaseHealth.latency_ms, databaseHealth.error ?? null);
        } catch {
          // The API answered but the database probe failed — the store keeps the message.
          if (!isCancelled) {
            setDatabaseStatus(null, "Database health probe failed");
          }
        }
      } catch {
        if (isCancelled) {
          return;
        }
        consecutiveFailures += 1;
        if (consecutiveFailures >= CONSECUTIVE_FAILURES_BEFORE_OFFLINE) {
          markUnreachable();
        }
      }
    }

    void checkApiHealth();
    const intervalHandle = setInterval(() => {
      // A hidden window is nobody's problem: the operator is not looking at the
      // badge, and a minimised terminal should not keep spending the server's
      // request budget on a status nobody can see.
      if (document.visibilityState === "hidden") {
        return;
      }
      void checkApiHealth();
    }, HEALTH_CHECK_INTERVAL_MS);

    // Returning to the window should not wait a whole interval for an answer.
    function handleVisibilityChange(): void {
      if (document.visibilityState === "visible") {
        void checkApiHealth();
      }
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      isCancelled = true;
      clearInterval(intervalHandle);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [markReachable, markUnreachable, setDatabaseStatus]);
}