// HTTP security hardening, applied once to the whole server.
//
//   • helmet               — security headers (CSP, clickjacking, MIME sniffing);
//   • @fastify/rate-limit  — a per-IP request ceiling that blunts brute force and
//     runaway clients (the login endpoint registers a stricter limit of its own);
//   • @fastify/cors        — only the configured desktop client origin may call the API.
//
// This function is awaited from the application plugin in index.ts, so these
// encapsulation-broken plugins install their hooks BEFORE any route is compiled
// and therefore protect every route. Registering them without awaiting lets the
// routes compile first, which silently leaves the global rate limit unapplied.
//
// The JSON body size limit is set on the Fastify constructor in index.ts: Fastify
// already owns the `application/json` parser and `bodyLimit` is the supported way
// to cap the payload. A GCash screenshot never travels as raw JSON.

import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance } from "fastify";

import { config } from "../../config";

export interface SecurityPluginOptions {
  /** Overrides config.RATE_LIMIT_MAX — used by tests that need a small ceiling. */
  rateLimitMax?: number;
  /** Overrides the allowed browser origins — used by tests that need a fixed list. */
  allowedOrigins?: readonly string[];
}

/**
 * Splits the comma-separated `CORS_ORIGIN` into the list of allowed origins.
 *
 * A list rather than a single value because a deployment serves more than one
 * caller: the Vite dev server during development, and a packaged Electron
 * renderer, which loads from `file://` and reports its origin as the literal
 * string "null". Both entries are needed on the same server.
 */
export function parseAllowedOrigins(configuredOrigins: string): readonly string[] {
  return configuredOrigins
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

export async function securityPlugin(
  server: FastifyInstance,
  options: SecurityPluginOptions = {}
): Promise<void> {
  await server.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
      },
    },
  });

  await server.register(rateLimit, {
    max: options.rateLimitMax ?? config.RATE_LIMIT_MAX,
    timeWindow: "1 minute",
  });

  const allowedOrigins = options.allowedOrigins ?? parseAllowedOrigins(config.CORS_ORIGIN);

  await server.register(cors, {
    origin: (requestOrigin, callback) => {
      // No Origin header means the request did not come from a browser page
      // (a script, pm2's health check, curl). CORS does not apply to it.
      if (requestOrigin === undefined) {
        callback(null, true);
        return;
      }

      // A known origin is echoed back; anything else is refused, so the browser
      // blocks the response. The server never echoes an attacker's origin.
      callback(null, allowedOrigins.includes(requestOrigin));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE"],
  });
}
