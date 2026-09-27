// Polls the API server and keeps the shared status store up to date.

import { useEffect } from "react";

import { fetchDatabaseHealth, fetchServiceHealth } from "../lib/api-client";
import { HEALTH_CHECK_INTERVAL_MS } from "../lib/constants";
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

    async function checkApiHealth(): Promise<void> {
      try {
        const serviceHealth = await fetchServiceHealth();
        if (isCancelled) {
          return;
        }
        consecutiveFailures = 0;
        markReachable(serviceHealth.version);

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
      void checkApiHealth();
    }, HEALTH_CHECK_INTERVAL_MS);

    return () => {
      isCancelled = true;
      clearInterval(intervalHandle);
    };
  }, [markReachable, markUnreachable, setDatabaseStatus]);
}