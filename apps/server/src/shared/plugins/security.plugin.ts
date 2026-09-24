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

  await server.register(cors, {
    origin: config.CORS_ORIGIN,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE"],
  });
}
