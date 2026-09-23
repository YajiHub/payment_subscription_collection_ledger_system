// Polls the API server and keeps the shared status store up to date.

import { useEffect } from "react";

import { fetchDatabaseHealth, fetchServiceHealth } from "../lib/api-client";
import { HEALTH_CHECK_INTERVAL_MS } from "../lib/constants";
import { useApiStatusStore } from "../stores/api-status.store";

export function useApiHealth(): void {
  const markReachable = useApiStatusStore((state) => state.markReachable);
  const markUnreachable = useApiStatusStore((state) => state.markUnreachable);
  const setDatabaseStatus = useApiStatusStore((state) => state.setDatabaseStatus);

  useEffect(() => {
    let isCancelled = false;

    async function checkApiHealth(): Promise<void> {
      try {
        const serviceHealth = await fetchServiceHealth();
        if (isCancelled) {
          return;
        }
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
        if (!isCancelled) {
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