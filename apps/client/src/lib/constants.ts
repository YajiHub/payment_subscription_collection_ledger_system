// Values that the renderer needs but must not invent on its own.
// Environment-specific settings come from Vite at build time (VITE_* prefix).

import { DEFAULT_API_BASE_URL } from "@bcis/shared";

// The build-time default. An installed copy may override it at run time with the
// API server named in %APPDATA%\BCIS\config.json — see configureApiBaseUrl in
// api-client.ts and docs/deployment/README.md.
export const API_BASE_URL: string = import.meta.env.VITE_API_BASE_URL ?? DEFAULT_API_BASE_URL;

/** How often the client re-checks whether the API server is reachable. */
export const HEALTH_CHECK_INTERVAL_MS = 5_000;

/** A health request that takes longer than this is treated as "offline". */
export const HTTP_TIMEOUT_MS = 4_000;