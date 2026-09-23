// The single source of truth for API reachability in the renderer.
// Components read from this store; the polling hook writes to it.

import { create } from "zustand";

export interface ApiStatusState {
  isReachable: boolean;
  serviceVersion: string | null;
  databaseLatencyMs: number | null;
  databaseErrorMessage: string | null;
  lastCheckedAt: Date | null;
  markReachable: (serviceVersion: string) => void;
  markUnreachable: () => void;
  setDatabaseStatus: (latencyMs: number | null, errorMessage: string | null) => void;
}

export const useApiStatusStore = create<ApiStatusState>((set) => ({
  isReachable: false,
  serviceVersion: null,
  databaseLatencyMs: null,
  databaseErrorMessage: null,
  lastCheckedAt: null,

  markReachable: (serviceVersion) =>
    set({ isReachable: true, serviceVersion, lastCheckedAt: new Date() }),

  markUnreachable: () =>
    set({
      isReachable: false,
      databaseLatencyMs: null,
      databaseErrorMessage: null,
      lastCheckedAt: new Date(),
    }),

  setDatabaseStatus: (latencyMs, errorMessage) =>
    set({ databaseLatencyMs: latencyMs, databaseErrorMessage: errorMessage }),
}));