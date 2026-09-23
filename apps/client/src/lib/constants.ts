// Values that the renderer needs but must not invent on its own.
// Environment-specific settings come from Vite at build time (VITE_* prefix).

export const API_BASE_URL: string = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3001";

/** How often the client re-checks whether the API server is reachable. */
export const HEALTH_CHECK_INTERVAL_MS = 5_000;

/** A health request that takes longer than this is treated as "offline". */
export const HTTP_TIMEOUT_MS = 4_000;