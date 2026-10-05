// Values that the renderer needs but must not invent on its own.
// Environment-specific settings come from Vite at build time (VITE_* prefix).

import { DEFAULT_API_BASE_URL } from "@bcis/shared";

// The build-time default. An installed copy may override it at run time with the
// API server named in %APPDATA%\BCIS\config.json — see configureApiBaseUrl in
// api-client.ts and docs/deployment/README.md.
export const API_BASE_URL: string = import.meta.env.VITE_API_BASE_URL ?? DEFAULT_API_BASE_URL;

/**
 * How often the client re-checks whether the API server is reachable.
 *
 * Liveness is a background courtesy, not user work: the status badge is the only
 * thing it feeds, and an operator who actually acts on a dead API finds out from
 * the failed request itself. Polling it every five seconds spent a quarter of the
 * server's per-IP request budget on asking whether the server was up, which is
 * what made a busy screen exhaust the rate limit and stall its own data. Fifteen
 * seconds still surfaces an outage within two polls, which is what the badge's
 * consecutive-failure rule needs.
 */
export const HEALTH_CHECK_INTERVAL_MS = 15_000;

/**
 * How often the database probe runs, counted in health polls rather than
 * seconds. The database moves far less often than the API process does, so
 * probing it on every poll would double the request volume for no extra signal.
 */
export const DATABASE_HEALTH_EVERY_N_POLLS = 4;

/** A health request that takes longer than this is treated as "offline". */
export const HTTP_TIMEOUT_MS = 4_000;