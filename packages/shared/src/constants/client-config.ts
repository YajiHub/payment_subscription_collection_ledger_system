// How an installed desktop client decides which API server to talk to.
//
// The URL compiled into the renderer at build time is only a starting point. A
// deployed copy also reads a small `config.json` beside the application's data
// (see docs/deployment/README.md), so one office PC can be pointed at another
// PC's API server without rebuilding the app.
//
// That file is untrusted input typed by a human: a value that is not an absolute
// http(s) URL is ignored rather than silently sending every request nowhere.

/** The shape of the client's `config.json`. */
export interface ClientConfigFile {
  apiBaseUrl?: unknown;
}

/** The API server a client uses when no run-time value is configured. */
export const DEFAULT_API_BASE_URL = "http://localhost:3001";

/**
 * Returns the API base URL named by a parsed `config.json`, or `fallback` when
 * the file has no usable `apiBaseUrl`.
 *
 * A usable value is a non-empty absolute URL whose protocol is http or https. A
 * trailing slash is trimmed so request paths concatenate cleanly (`/api/...`
 * would otherwise become `//api/...`).
 */
export function resolveApiBaseUrl(configFile: unknown, fallback: string): string {
  if (typeof configFile !== "object" || configFile === null) {
    return fallback;
  }

  const candidate = (configFile as ClientConfigFile).apiBaseUrl;

  if (typeof candidate !== "string") {
    return fallback;
  }

  const trimmedCandidate = candidate.trim();

  if (trimmedCandidate.length === 0) {
    return fallback;
  }

  let parsedCandidate: URL;

  try {
    parsedCandidate = new URL(trimmedCandidate);
  } catch {
    // Not an absolute URL at all (for example "192.168.1.100:3001").
    return fallback;
  }

  if (parsedCandidate.protocol !== "http:" && parsedCandidate.protocol !== "https:") {
    return fallback;
  }

  return trimmedCandidate.replace(/\/+$/, "");
}